"""
face_service/clusterer.py  (v2.1 — iterative refinement + temporal continuity)
================================================================================
HDBSCAN-based face clustering engine for Vault OS.

Pipeline (run_full_cluster):
  1.  Read all face embeddings from face_index.db (read-only SQLite)
  2.  L2-normalise embeddings (unit sphere → euclidean ≈ cosine distance)
  3.  Run HDBSCAN with min_cluster_size = 2
  4.  Re-assign noise points to nearest cluster centroid (Faiss or numpy)
  5.  Merge clusters whose centroids are cosine-similar (same person, split)
  6.  Iterative refinement: absorb small/noisy clusters into large ones
  7.  Temporal continuity: merge clusters sharing same-video faces within a time window
  8.  Second-pass merge: one more merge round at a slightly lower threshold
  9.  Build final ClusterResult with confidence-weighted centroids, cover faces, counts

Why each step:
  HDBSCAN        — density-based, order-independent, handles outliers explicitly
  Noise reassign — prevents faces being silently dropped from all people
  Merge (1st)    — catches "same person split into 2 clusters" from HDBSCAN seam
  Refinement     — tiny clusters (≤3 faces) often represent known people at odd angles;
                   absorbing them into the nearest large cluster reduces fragmentation
  Temporal merge — faces of the same person in the same video file should always
                   be in the same cluster; use lower similarity threshold when
                   there is strong temporal evidence
  Merge (2nd)    — mop up any remaining near-duplicates after refinement reshuffled centroids
  Weighted ctr.  — use det_score-weighted mean for centroids so high-quality (clear,
                   frontal) face embeddings dominate the centroid representation

Node.js face-worker calls this via the /cluster HTTP endpoint and then writes
the results (person rows + face assignments) into SQLite itself, preserving
the existing transaction logic.
"""

import os
import logging
import sqlite3
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

import numpy as np

log = logging.getLogger(__name__)

# ── Clustering parameters (env-overridable) ───────────────────────────────────
MIN_CLUSTER_SIZE    = int(  os.environ.get('FACE_HDBSCAN_MIN_CLUSTER',     '2'))
MIN_SAMPLES         = int(  os.environ.get('FACE_HDBSCAN_MIN_SAMPLES',     '1'))
CENTROID_MERGE_SIM  = float(os.environ.get('FACE_CENTROID_MERGE_SIM',      '0.72'))
NOISE_REASSIGN_DIST = float(os.environ.get('FACE_NOISE_REASSIGN_DIST',     '1.0'))

# Refinement — small clusters absorbed into larger ones
REFINE_SMALL_THRESH = int(  os.environ.get('FACE_REFINE_SMALL_THRESH',     '3'))    # clusters ≤ N faces
REFINE_ABSORB_SIM   = float(os.environ.get('FACE_REFINE_ABSORB_SIM',       '0.62')) # cosine sim to absorb

# Temporal continuity — same-video faces at nearby timestamps
TEMPORAL_WINDOW_MS  = int(  os.environ.get('FACE_TEMPORAL_WINDOW_MS',      '5000')) # 5 s
TEMPORAL_MERGE_SIM  = float(os.environ.get('FACE_TEMPORAL_MERGE_SIM',      '0.60')) # lower than normal

# Second-pass merge — slightly lower threshold to mop up post-refinement splits
MERGE2_SIM          = float(os.environ.get('FACE_MERGE2_SIM',              '0.68'))

# Confidence weighting — exponent applied to det_score when computing centroid
CENTROID_WEIGHT_PWR = float(os.environ.get('FACE_CENTROID_WEIGHT_PWR',     '1.5'))


# ─────────────────────────────────────────────────────────────────────────────
#  DATA STRUCTURES
# ─────────────────────────────────────────────────────────────────────────────

@dataclass
class FaceRecord:
    face_id:    int
    det_score:  float
    embedding:  np.ndarray   # (512,) float32, L2-normalised
    media_id:   int = 0      # foreign key into media_index
    frame_ms:   int = 0      # timestamp within video (0 for images)
    media_type: str = 'image'


@dataclass
class ClusterResult:
    # Per-face: face_id → cluster_id (-1 = unclustered noise)
    assignments:  Dict[int, int]        = field(default_factory=dict)
    # Per-cluster: cluster_id → L2-normalised centroid (512,) float32
    centroids:    Dict[int, List[float]] = field(default_factory=dict)
    # Per-cluster: cluster_id → face_id with highest det_score (cover image)
    cover_faces:  Dict[int, int]        = field(default_factory=dict)
    # Per-cluster: cluster_id → face count
    face_counts:  Dict[int, int]        = field(default_factory=dict)
    n_clusters:   int = 0
    n_noise:      int = 0
    n_total:      int = 0


# ─────────────────────────────────────────────────────────────────────────────
#  SQLITE READER  (read-only — Node.js owns all writes)
# ─────────────────────────────────────────────────────────────────────────────

def _read_faces_from_db(db_path: str) -> List[FaceRecord]:
    """
    Read every face embedding from face_index.db using a read-only connection.

    SQLite WAL mode allows this to coexist safely with the Node.js writer
    connection — readers get a consistent snapshot without blocking writes.

    Embeddings are stored as raw float32 BLOBs (512 × 4 bytes = 2 048 bytes).
    Also reads media_id, frame_ms, and media_type to support temporal continuity.

    Dedup: if two face rows have byte-identical embeddings (re-scanned file),
    only the highest det_score row is kept to prevent cloned clusters.
    """
    if not os.path.exists(db_path):
        raise FileNotFoundError(f'face_index.db not found at: {db_path}')

    con = sqlite3.connect(f'file:{db_path}?mode=ro', uri=True)
    try:
        con.execute('PRAGMA busy_timeout = 10000')
        cur = con.cursor()
        cur.execute(
            '''
            SELECT f.id, f.det_score, f.embedding, f.media_id, f.frame_ms,
                   COALESCE(m.media_type, 'image') AS media_type
            FROM   faces f
            LEFT JOIN media_index m ON m.id = f.media_id
            WHERE  f.embedding IS NOT NULL
            ORDER  BY f.det_score DESC
            '''
        )
        records: List[FaceRecord] = []
        seen_emb_hashes: dict = {}   # bytes hash → face_id already added

        for row_id, det_score, emb_blob, media_id, frame_ms, media_type in cur.fetchall():
            if emb_blob is None or len(emb_blob) < 4:
                continue
            emb = np.frombuffer(emb_blob, dtype=np.float32).copy()
            if emb.shape[0] != 512:
                log.warning('Face %d has unexpected embedding size %d — skipping', row_id, emb.shape[0])
                continue

            # Byte-level dedup: identical BLOB → duplicate face row, skip lower-scored one.
            # We sorted by det_score DESC so the first encounter is always the best.
            emb_key = bytes(emb_blob)
            if emb_key in seen_emb_hashes:
                log.debug('Skipping duplicate embedding on face %d (matches face %d)',
                          row_id, seen_emb_hashes[emb_key])
                continue
            seen_emb_hashes[emb_key] = row_id

            norm = np.linalg.norm(emb)
            if norm > 1e-8:
                emb = emb / norm
            records.append(FaceRecord(
                face_id=row_id,
                det_score=float(det_score or 0.5),
                embedding=emb,
                media_id=int(media_id or 0),
                frame_ms=int(frame_ms or 0),
                media_type=str(media_type or 'image'),
            ))

        n_raw   = len(seen_emb_hashes)
        n_dedup = n_raw - len(records) + (n_raw - len(seen_emb_hashes))
        log.info('Read %d face embeddings from %s (deduped %d byte-identical blobs)',
                 len(records), db_path, len(seen_emb_hashes) - len(records))
        return records
    finally:
        con.close()


# ─────────────────────────────────────────────────────────────────────────────
#  CLUSTERING UTILITIES
# ─────────────────────────────────────────────────────────────────────────────

def _l2_normalise(v: np.ndarray) -> np.ndarray:
    norm = float(np.linalg.norm(v))
    return v / norm if norm > 1e-8 else v


def _compute_centroids(
    embeddings: np.ndarray,
    labels:     np.ndarray,
    unique_ids: np.ndarray,
) -> Dict[int, np.ndarray]:
    """Compute L2-normalised mean centroid for each cluster ID."""
    centroids: Dict[int, np.ndarray] = {}
    for cid in unique_ids:
        mask     = labels == cid
        centroid = embeddings[mask].mean(axis=0)
        centroids[int(cid)] = _l2_normalise(centroid.astype(np.float32))
    return centroids


def _compute_weighted_centroids(
    embeddings:  np.ndarray,   # (N, 512) float32
    det_scores:  np.ndarray,   # (N,)     float32
    labels:      np.ndarray,   # (N,)     int32
    unique_ids,
    weight_power: float = CENTROID_WEIGHT_PWR,
) -> Dict[int, np.ndarray]:
    """
    Compute confidence-weighted centroids.

    High det_score faces (clear, frontal, high confidence) get more weight,
    so the centroid reflects the most representative faces rather than a
    flat average that blurs in occluded / partial / blurry faces.

    Weight = det_score ** weight_power, normalised to sum-to-1 per cluster.
    Falls back to unweighted mean if all weights are zero.
    """
    centroids: Dict[int, np.ndarray] = {}
    for cid in unique_ids:
        mask    = labels == cid
        embs    = embeddings[mask]              # (k, 512)
        scores  = det_scores[mask].astype(np.float64) ** weight_power  # (k,)
        total_w = float(scores.sum())
        if total_w < 1e-12:
            centroid = embs.mean(axis=0)
        else:
            weights  = scores / total_w         # normalise
            centroid = (embs * weights[:, np.newaxis]).sum(axis=0)
        centroids[int(cid)] = _l2_normalise(centroid.astype(np.float32))
    return centroids


def _reassign_noise(
    embeddings: np.ndarray,
    labels:     np.ndarray,
    centroids:  Dict[int, np.ndarray],
    max_dist:   float = NOISE_REASSIGN_DIST,
) -> np.ndarray:
    """
    For each noise point (label == -1), assign to nearest cluster centroid if
    within max_dist on the unit sphere.

    d=1.0 ↔ cosine_sim≈0.50 | d=0.75 ↔ cosine_sim≈0.72 | d=0.50 ↔ cosine_sim≈0.875
    """
    labels = labels.copy()
    noise_mask = labels == -1
    n_noise = int(noise_mask.sum())
    if n_noise == 0 or not centroids:
        return labels

    cids   = list(centroids.keys())
    cmat   = np.array([centroids[c] for c in cids], dtype=np.float32)
    n_embs = embeddings[noise_mask]

    try:
        import faiss
        index = faiss.IndexFlatL2(cmat.shape[1])
        index.add(cmat)
        dists_sq, idxs = index.search(n_embs, 1)
        dists   = np.sqrt(dists_sq[:, 0])
        nearest = idxs[:, 0]
    except ImportError:
        diff    = n_embs[:, np.newaxis, :] - cmat[np.newaxis, :, :]
        dists   = np.linalg.norm(diff, axis=-1)
        nearest = dists.argmin(axis=1)
        dists   = dists[np.arange(len(nearest)), nearest]

    noise_indices = np.where(noise_mask)[0]
    assigned = 0
    for i, (dist, best_ci) in enumerate(zip(dists, nearest)):
        if dist < max_dist:
            labels[noise_indices[i]] = cids[int(best_ci)]
            assigned += 1

    log.info('Noise re-assignment: %d/%d assigned (max_dist=%.2f)', assigned, n_noise, max_dist)
    return labels


def _merge_similar_clusters(
    embeddings:      np.ndarray,
    labels:          np.ndarray,
    centroids:       Dict[int, np.ndarray],
    merge_threshold: float,
) -> Tuple[np.ndarray, Dict[int, np.ndarray]]:
    """
    Union-find merge of clusters whose centroids have cosine similarity ≥ merge_threshold.

    Uses weighted centroid update on each merge so the merged centroid reflects
    the face count proportionally (larger cluster gets more weight).
    """
    unique = np.unique(labels[labels >= 0])
    if len(unique) < 2:
        return labels, centroids

    canonical: Dict[int, int] = {int(c): int(c) for c in unique}

    def find(x: int) -> int:
        while canonical[x] != x:
            canonical[x] = canonical[canonical[x]]
            x = canonical[x]
        return x

    # Build a count map so weighted merge is correct
    count_map: Dict[int, int] = {int(c): int((labels == c).sum()) for c in unique}

    merges = 0
    cluster_list = sorted([int(c) for c in unique])
    for i in range(len(cluster_list)):
        a = find(cluster_list[i])
        for j in range(i + 1, len(cluster_list)):
            b = find(cluster_list[j])
            if a == b:
                continue
            sim = float(np.dot(centroids[a], centroids[b]))
            if sim >= merge_threshold:
                n_a = count_map.get(a, 1)
                n_b = count_map.get(b, 1)
                # Weighted centroid: larger cluster contributes more
                merged = centroids[a] * n_a + centroids[b] * n_b
                centroids[a] = _l2_normalise(merged)
                count_map[a] = n_a + n_b
                canonical[b] = a
                merges += 1
                a = find(a)

    if merges > 0:
        labels = labels.copy()
        for i in range(len(labels)):
            if labels[i] >= 0:
                labels[i] = find(int(labels[i]))
        final_unique = np.unique(labels[labels >= 0])
        centroids = _compute_centroids(embeddings, labels, final_unique)
        log.info('Merged %d cluster pairs (threshold=%.3f)', merges, merge_threshold)

    return labels, centroids


def _refine_small_clusters(
    embeddings:      np.ndarray,
    det_scores:      np.ndarray,
    labels:          np.ndarray,
    centroids:       Dict[int, np.ndarray],
    small_thresh:    int   = REFINE_SMALL_THRESH,
    absorb_sim:      float = REFINE_ABSORB_SIM,
) -> Tuple[np.ndarray, Dict[int, np.ndarray]]:
    """
    Absorb small clusters (face_count ≤ small_thresh) into the nearest large cluster
    if their centroid cosine similarity ≥ absorb_sim.

    Why: HDBSCAN may leave a few faces of a well-known person in a tiny cluster
    (e.g. 2–3 slightly occluded frames) rather than attaching them to the main
    cluster with 30+ faces of the same person.  This refinement pass merges those
    satellite clusters back in, reducing fragmentation without aggressive merging.

    Small clusters whose nearest match is still below absorb_sim are kept as-is
    rather than force-assigned (preserving genuinely rare / unique people).
    """
    unique = np.unique(labels[labels >= 0])
    if len(unique) < 2:
        return labels, centroids

    counts   = {int(c): int((labels == c).sum()) for c in unique}
    small_ids = [c for c in unique if counts.get(int(c), 0) <= small_thresh]
    large_ids = [c for c in unique if counts.get(int(c), 0)  > small_thresh]

    if not small_ids or not large_ids:
        return labels, centroids

    large_ids_i = sorted(large_ids)
    large_mat   = np.array([centroids[c] for c in large_ids_i], dtype=np.float32)

    absorbed = 0
    canonical: Dict[int, int] = {int(c): int(c) for c in unique}

    for sc in small_ids:
        sc_centroid = centroids[int(sc)]
        sims        = large_mat @ sc_centroid               # cosine sims (L2-normed)
        best_idx    = int(sims.argmax())
        best_sim    = float(sims[best_idx])
        best_large  = large_ids_i[best_idx]

        if best_sim >= absorb_sim:
            canonical[int(sc)] = int(best_large)
            absorbed += 1
            # Update large centroid (online weighted mean)
            n_l = counts.get(int(best_large), 1)
            n_s = counts.get(int(sc), 1)
            merged = centroids[int(best_large)] * n_l + centroids[int(sc)] * n_s
            centroids[int(best_large)] = _l2_normalise(merged)
            counts[int(best_large)]    = n_l + n_s
            # Update large_mat to reflect new centroid
            large_mat[best_idx] = centroids[int(best_large)]

    if absorbed > 0:
        labels = labels.copy()
        for i in range(len(labels)):
            if labels[i] >= 0:
                src = int(labels[i])
                tgt = canonical[src]
                if tgt != src:
                    labels[i] = tgt
        final_unique = np.unique(labels[labels >= 0])
        centroids = _compute_centroids(embeddings, labels, final_unique)
        log.info('Refinement: absorbed %d small clusters into large clusters '
                 '(small_thresh=%d absorb_sim=%.2f)', absorbed, small_thresh, absorb_sim)

    return labels, centroids


def _temporal_continuity_merge(
    embeddings:     np.ndarray,
    det_scores:     np.ndarray,
    labels:         np.ndarray,
    centroids:      Dict[int, np.ndarray],
    face_records:   List[FaceRecord],
    time_window_ms: int   = TEMPORAL_WINDOW_MS,
    sim_threshold:  float = TEMPORAL_MERGE_SIM,
) -> Tuple[np.ndarray, Dict[int, np.ndarray]]:
    """
    For video files: if faces in two different clusters appear in the same video
    within a time window of each other, the same person almost certainly appears
    in both.  Merge those clusters if their centroid cosine similarity ≥ sim_threshold.

    Uses a lower sim_threshold than the standard merge (0.60 vs 0.72) because the
    temporal co-occurrence is strong evidence of identity.

    Only acts on video / gif media_types (images don't have meaningful frame_ms).
    """
    # Index face_id → FaceRecord for fast lookup
    fr_map = {r.face_id: r for r in face_records}

    # Gather (media_id, frame_ms, cluster_id) for video faces only
    video_entries: List[Tuple[int, int, int]] = []
    for i, rec in enumerate(face_records):
        if rec.media_type not in ('video', 'gif'):
            continue
        cid = int(labels[i])
        if cid < 0:
            continue
        video_entries.append((rec.media_id, rec.frame_ms, cid))

    if not video_entries:
        return labels, centroids

    # Group by media_id → list of (frame_ms, cluster_id)
    from collections import defaultdict
    media_clusters: Dict[int, List[Tuple[int, int]]] = defaultdict(list)
    for media_id, frame_ms, cid in video_entries:
        media_clusters[media_id].append((frame_ms, cid))

    # Find cluster pairs that appear in the same video within time_window_ms
    candidate_pairs: Dict[Tuple[int, int], int] = defaultdict(int)  # (c1,c2) → co-occurrence count
    for media_id, entries in media_clusters.items():
        entries.sort(key=lambda x: x[0])  # sort by timestamp
        for i in range(len(entries)):
            for j in range(i + 1, len(entries)):
                t_i, cid_i = entries[i]
                t_j, cid_j = entries[j]
                if t_j - t_i > time_window_ms:
                    break  # sorted, so no further j will be in range
                if cid_i != cid_j:
                    key = (min(cid_i, cid_j), max(cid_i, cid_j))
                    candidate_pairs[key] += 1

    if not candidate_pairs:
        return labels, centroids

    # Check centroid similarity for candidate pairs; merge if above threshold
    unique = np.unique(labels[labels >= 0])
    canonical: Dict[int, int] = {int(c): int(c) for c in unique}
    counts    = {int(c): int((labels == c).sum()) for c in unique}

    def find(x: int) -> int:
        while canonical[x] != x:
            canonical[x] = canonical[canonical[x]]
            x = canonical[x]
        return x

    merges = 0
    for (ca, cb), co_count in sorted(candidate_pairs.items(), key=lambda x: -x[1]):
        ra, rb = find(ca), find(cb)
        if ra == rb:
            continue
        if ra not in centroids or rb not in centroids:
            continue
        sim = float(np.dot(centroids[ra], centroids[rb]))
        if sim >= sim_threshold:
            n_a = counts.get(ra, 1)
            n_b = counts.get(rb, 1)
            merged = centroids[ra] * n_a + centroids[rb] * n_b
            centroids[ra] = _l2_normalise(merged)
            counts[ra]    = n_a + n_b
            canonical[rb] = ra
            merges += 1

    if merges > 0:
        labels = labels.copy()
        for i in range(len(labels)):
            if labels[i] >= 0:
                labels[i] = find(int(labels[i]))
        final_unique = np.unique(labels[labels >= 0])
        centroids = _compute_centroids(embeddings, labels, final_unique)
        log.info('Temporal continuity: merged %d video cluster pairs (sim≥%.2f window=%dms)',
                 merges, sim_threshold, time_window_ms)

    return labels, centroids


def _final_hard_dedup(
    embeddings:    np.ndarray,
    labels:        np.ndarray,
    centroids:     Dict[int, np.ndarray],
    sim_threshold: float = 0.98,
) -> Tuple[np.ndarray, Dict[int, np.ndarray]]:
    """
    Last-resort safety net: merge any two clusters whose centroids have cosine
    similarity ≥ sim_threshold.  This catches degenerate splits that survive all
    earlier merge passes (e.g. two tiny clusters of the same person in unrelated
    images that were just below the HDBSCAN density threshold).

    Uses the same union-find merge as _merge_similar_clusters but at a very high
    threshold, so it only fires for near-identical centroids.
    """
    unique = np.unique(labels[labels >= 0])
    if len(unique) < 2:
        return labels, centroids

    canonical: Dict[int, int] = {int(c): int(c) for c in unique}
    count_map: Dict[int, int] = {int(c): int((labels == c).sum()) for c in unique}

    def find(x: int) -> int:
        while canonical[x] != x:
            canonical[x] = canonical[canonical[x]]
            x = canonical[x]
        return x

    merges = 0
    clist  = sorted([int(c) for c in unique])
    for i in range(len(clist)):
        a = find(clist[i])
        for j in range(i + 1, len(clist)):
            b = find(clist[j])
            if a == b:
                continue
            if a not in centroids or b not in centroids:
                continue
            sim = float(np.dot(centroids[a], centroids[b]))
            if sim >= sim_threshold:
                n_a = count_map.get(a, 1)
                n_b = count_map.get(b, 1)
                merged = centroids[a] * n_a + centroids[b] * n_b
                centroids[a] = _l2_normalise(merged)
                count_map[a] = n_a + n_b
                canonical[b] = a
                merges += 1
                a = find(a)

    if merges > 0:
        labels = labels.copy()
        for i in range(len(labels)):
            if labels[i] >= 0:
                labels[i] = find(int(labels[i]))
        final_unique = np.unique(labels[labels >= 0])
        centroids = _compute_centroids(embeddings, labels, final_unique)
        log.info('Hard dedup: force-merged %d near-identical cluster pairs (sim≥%.2f)',
                 merges, sim_threshold)

    return labels, centroids


def _compact_and_build_result(
    embeddings:   np.ndarray,
    det_scores:   np.ndarray,
    labels:       np.ndarray,
    centroids:    Dict[int, np.ndarray],
    face_ids:     np.ndarray,
    n_total:      int,
) -> ClusterResult:
    """
    Final step: re-index cluster IDs to 0…K-1, recompute confidence-weighted
    centroids, and build the ClusterResult.
    """
    # Compact IDs (HDBSCAN + merge may leave gaps)
    unique_ids = sorted(int(l) for l in labels if l >= 0)
    unique_ids = sorted(set(unique_ids))
    remap      = {old: new for new, old in enumerate(unique_ids)}
    final_labels = np.array(
        [remap.get(int(l), -1) for l in labels], dtype=np.int32
    )

    # Recompute confidence-weighted centroids after final label assignment
    remapped_unique = list(range(len(unique_ids)))
    weighted_centroids = _compute_weighted_centroids(
        embeddings, det_scores, final_labels,
        remapped_unique, weight_power=CENTROID_WEIGHT_PWR,
    )

    result = ClusterResult()
    result.n_total    = n_total
    result.n_clusters = len(unique_ids)
    result.n_noise    = int((final_labels == -1).sum())

    result.centroids = {new_id: weighted_centroids[new_id].tolist()
                        for new_id in remapped_unique
                        if new_id in weighted_centroids}

    best_score: Dict[int, float] = {}
    for i in range(n_total):
        cid   = int(final_labels[i])
        fid   = int(face_ids[i])
        score = float(det_scores[i])
        result.assignments[fid] = cid
        if cid >= 0:
            result.face_counts[cid] = result.face_counts.get(cid, 0) + 1
            if score > best_score.get(cid, -1.0):
                best_score[cid]         = score
                result.cover_faces[cid] = fid

    # Defensive: fill any missing centroids
    for new_id in range(result.n_clusters):
        if new_id not in result.centroids:
            mask = final_labels == new_id
            if mask.any():
                c = _l2_normalise(embeddings[mask].mean(axis=0).astype(np.float32))
                result.centroids[new_id] = c.tolist()

    return result


# ─────────────────────────────────────────────────────────────────────────────
#  PUBLIC ENTRY POINT
# ─────────────────────────────────────────────────────────────────────────────

def run_full_cluster(
    db_path:          str,
    min_cluster_size: int   = MIN_CLUSTER_SIZE,
    min_samples:      int   = MIN_SAMPLES,
    merge_threshold:  float = CENTROID_MERGE_SIM,
) -> ClusterResult:
    """
    Full HDBSCAN recluster of all faces in the database.

    Called by /cluster HTTP endpoint.  Node.js face-worker writes the results.
    """
    import hdbscan as hdbscan_lib

    records = _read_faces_from_db(db_path)
    N = len(records)

    if N == 0:
        log.info('No faces in DB — nothing to cluster')
        return ClusterResult()

    face_ids   = np.array([r.face_id   for r in records], dtype=np.int64)
    det_scores = np.array([r.det_score for r in records], dtype=np.float32)
    embeddings = np.stack([r.embedding for r in records]).astype(np.float32)

    if N == 1:
        result = ClusterResult()
        cid = 0
        fid = int(face_ids[0])
        result.assignments[fid]  = cid
        result.centroids[cid]    = embeddings[0].tolist()
        result.cover_faces[cid]  = fid
        result.face_counts[cid]  = 1
        result.n_clusters        = 1
        result.n_total           = 1
        return result

    log.info('HDBSCAN: N=%d min_cluster_size=%d min_samples=%d', N, min_cluster_size, min_samples)

    X64 = embeddings.astype(np.float64)

    clusterer = hdbscan_lib.HDBSCAN(
        min_cluster_size=min_cluster_size,
        min_samples=min_samples,
        metric='euclidean',
        cluster_selection_method='eom',
        cluster_selection_epsilon=0.0,
        core_dist_n_jobs=-1,
        prediction_data=True,
        gen_min_span_tree=False,
    )
    raw_labels = clusterer.fit_predict(X64).astype(np.int32)

    n_noise_init = int((raw_labels == -1).sum())
    n_clusters_raw = int(raw_labels.max()) + 1 if raw_labels.max() >= 0 else 0
    log.info('HDBSCAN done: %d clusters | %d/%d noise', n_clusters_raw, n_noise_init, N)

    # ── Step 1: Re-assign noise points ───────────────────────────────────────
    if n_noise_init > 0 and n_clusters_raw > 0:
        init_centroids = _compute_centroids(
            embeddings, raw_labels, np.unique(raw_labels[raw_labels >= 0])
        )
        raw_labels = _reassign_noise(embeddings, raw_labels, init_centroids,
                                      max_dist=NOISE_REASSIGN_DIST)

    # ── Step 2: First merge pass (standard threshold) ─────────────────────────
    unique_after_noise = np.unique(raw_labels[raw_labels >= 0])
    current_centroids  = _compute_centroids(embeddings, raw_labels, unique_after_noise)
    raw_labels, current_centroids = _merge_similar_clusters(
        embeddings, raw_labels, current_centroids, merge_threshold=merge_threshold
    )

    # ── Step 3: Iterative refinement — absorb small satellite clusters ────────
    raw_labels, current_centroids = _refine_small_clusters(
        embeddings, det_scores, raw_labels, current_centroids,
        small_thresh=REFINE_SMALL_THRESH, absorb_sim=REFINE_ABSORB_SIM,
    )

    # ── Step 4: Temporal continuity — same-video face pairs ──────────────────
    raw_labels, current_centroids = _temporal_continuity_merge(
        embeddings, det_scores, raw_labels, current_centroids, records,
        time_window_ms=TEMPORAL_WINDOW_MS, sim_threshold=TEMPORAL_MERGE_SIM,
    )

    # ── Step 5: Second merge pass (slightly lower threshold) ──────────────────
    # After refinement reshuffled cluster memberships, centroids may have shifted
    # enough for previously-just-below-threshold clusters to now cross the bar.
    raw_labels, current_centroids = _merge_similar_clusters(
        embeddings, raw_labels, current_centroids, merge_threshold=MERGE2_SIM
    )

    # ── Step 6: Deterministic stabilisation — sort clusters by size DESC ──────
    # Relabel clusters so that cluster 0 is always the largest.
    # This makes the output deterministic regardless of HDBSCAN's internal ordering
    # and prevents the same person from getting a different cluster ID on every run.
    unique_final  = np.unique(raw_labels[raw_labels >= 0])
    counts_final  = {int(c): int((raw_labels == c).sum()) for c in unique_final}
    sorted_cids   = sorted(counts_final.keys(), key=lambda c: -counts_final[c])
    stable_remap  = {old: new for new, old in enumerate(sorted_cids)}
    raw_labels    = np.array(
        [stable_remap.get(int(l), -1) if l >= 0 else -1 for l in raw_labels],
        dtype=np.int32
    )
    current_centroids = {stable_remap[old]: v for old, v in current_centroids.items()
                         if old in stable_remap}

    # ── Step 7: Final hard dedup — identical centroid vectors ─────────────────
    # If two clusters ended up with cosine sim ≥ 0.98 after all merges (can happen
    # when a person appears in isolated images that HDBSCAN seeded separately),
    # force-merge them. This is a last-resort safety net.
    raw_labels, current_centroids = _final_hard_dedup(
        embeddings, raw_labels, current_centroids, sim_threshold=0.98
    )

    # ── Final: compact IDs and build result ──────────────────────────────────
    result = _compact_and_build_result(
        embeddings, det_scores, raw_labels, current_centroids, face_ids, N
    )

    log.info(
        'Cluster result: %d clusters | %d noise | %d total | pipeline: '
        'hdbscan → noise-reassign → merge(%.2f) → refine → temporal → merge2(%.2f)',
        result.n_clusters, result.n_noise, result.n_total,
        merge_threshold, MERGE2_SIM,
    )
    return result

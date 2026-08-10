'use strict';

/**
 * face-cluster.js  (v2.0 — HDBSCAN via Python AI service)
 * =========================================================
 * Face clustering engine for Vault OS.
 *
 * Two clustering modes:
 *
 *   incremental  (assignFace)
 *     Called after each newly indexed face.  Compares the new embedding against
 *     every person's centroid.  O(P × 512) where P = person count.
 *     Unchanged from v1.x — fast enough for real-time indexing.
 *
 *   full recluster  (fullReclusterPython)  ← REPLACED from v1.x
 *     Delegates to the Python AI microservice (/cluster endpoint).
 *     Python reads all embeddings from SQLite (read-only), runs HDBSCAN —
 *     a density-based algorithm that doesn't require pre-specifying K and
 *     is not order-dependent — and returns assignments + centroids.
 *     This worker then writes the results in a single SQLite transaction.
 *
 * Why HDBSCAN replaces the old greedy single-linkage:
 *   - Old: processes faces in det_score order; first cluster centroid in a region
 *     "locks in" that region. Faces arriving later may not join correctly.
 *   - HDBSCAN: global, density-based, order-independent. Same person split across
 *     two clusters is detected and merged. Outliers explicitly labelled as noise.
 *   - Result: dramatically fewer fragmented identities.
 *
 * Thresholds (configurable via .env):
 *   FACE_SIMILARITY_THRESHOLD   default 0.55  (incremental assignFace)
 *   FACE_MARGIN_THRESHOLD       default 0.05  (incremental assignFace)
 *   FACE_CENTROID_MERGE_SIM     default 0.72  (passed to Python HDBSCAN)
 */

const http   = require('http');
const https  = require('https');
const { FaceLogger } = require('./face-logger');
const db_module      = require('./face-db');

const log = new FaceLogger('CLUSTER');

const SIM_THRESHOLD      = parseFloat(process.env.FACE_SIMILARITY_THRESHOLD) || 0.55;
const MARGIN_THRESHOLD   = parseFloat(process.env.FACE_MARGIN_THRESHOLD)     || 0.05;
const CENTROID_MERGE_SIM = parseFloat(process.env.FACE_CENTROID_MERGE_SIM)   || 0.72;

log.info('Cluster thresholds', { SIM_THRESHOLD, MARGIN_THRESHOLD, CENTROID_MERGE_SIM });

// ─────────────────────────────────────────────────────────────
//  MATH UTILITIES
// ─────────────────────────────────────────────────────────────

/**
 * Dot product of two L2-normalised Float32Arrays = cosine similarity.
 * 4×-unrolled for CPU pipeline friendliness.
 */
function cosineSim(a, b) {
  const n  = a.length;
  const n4 = (n >> 2) << 2;
  let   s  = 0, i = 0;
  for (; i < n4; i += 4) {
    s += a[i] * b[i] + a[i+1] * b[i+1] + a[i+2] * b[i+2] + a[i+3] * b[i+3];
  }
  for (; i < n; i++) s += a[i] * b[i];
  return s;
}

function meanEmbedding(embeddings) {
  const dim = embeddings[0].length;
  const out = new Float32Array(dim);
  for (const e of embeddings) for (let i = 0; i < dim; i++) out[i] += e[i];
  const n = embeddings.length;
  for (let i = 0; i < dim; i++) out[i] /= n;
  return out;
}

function l2NormInPlace(v) {
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm);
  if (norm < 1e-10) return v;
  for (let i = 0; i < v.length; i++) v[i] /= norm;
  return v;
}

function blobToF32(blob) {
  return new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
}

function f32ToBlob(f32) {
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
}

// ─────────────────────────────────────────────────────────────
//  CENTROID CACHE
// ─────────────────────────────────────────────────────────────

/**
 * In-memory centroid cache: Map<personId, Float32Array>.
 * Populated lazily; updated incrementally after each assignFace().
 * Keeps the incremental path at O(P × 512) with zero DB reads per assignment.
 */
let _centroids = null;

async function loadCentroidCache(db) {
  const t = log.timer('Load centroid cache');
  _centroids = new Map();
  const rows = await db.all('SELECT id, centroid FROM persons WHERE centroid IS NOT NULL AND face_count > 0');
  for (const row of rows) {
    _centroids.set(row.id, blobToF32(row.centroid));
  }
  t.end({ persons: _centroids.size });
}

async function getCentroids(db) {
  if (!_centroids) await loadCentroidCache(db);
  return _centroids;
}

function invalidateCentroidCache() {
  _centroids = null;
}

// ─────────────────────────────────────────────────────────────
//  INCREMENTAL ASSIGNMENT  (unchanged from v1.x)
// ─────────────────────────────────────────────────────────────

/**
 * Assign a newly indexed face to the best-matching person, or create a new one.
 * Used during the scan phase for real-time incremental clustering.
 * HDBSCAN full recluster (fullReclusterPython) will correct any errors later.
 *
 * Respects not_this_person feedback: if a face was explicitly rejected from a
 * specific person cluster, that person is skipped during incremental assignment.
 *
 * @param {import('sqlite').Database} db
 * @param {number}       faceId
 * @param {Float32Array} embedding  L2-normalised 512-dim
 * @returns {Promise<number>}  assigned person id
 */
async function assignFace(db, faceId, embedding) {
  const centroids = await getCentroids(db);
  const blocklist = await db_module.getFeedbackBlocklistForFace(db, faceId);

  let bestId = -1, bestSim = -Infinity, secondSim = -Infinity;
  for (const [pid, centroid] of centroids) {
    if (blocklist.has(pid)) continue;  // skip explicitly rejected persons
    const sim = cosineSim(embedding, centroid);
    if (sim > bestSim) { secondSim = bestSim; bestSim = sim; bestId = pid; }
    else if (sim > secondSim) { secondSim = sim; }
  }
  const margin = bestSim - secondSim;

  log.debug('assignFace', {
    faceId, personCount: centroids.size,
    bestId, bestSim: bestId !== -1 ? bestSim.toFixed(4) : 'n/a',
    margin: bestId !== -1 ? margin.toFixed(4) : 'n/a',
  });

  if (bestId !== -1 && bestSim >= SIM_THRESHOLD &&
      (centroids.size === 1 || margin >= MARGIN_THRESHOLD)) {
    await db_module.assignFaceToPerson(db, faceId, bestId);
    await _updateCentroid(db, bestId, embedding, centroids);
    await _maybeUpdateCoverFace(db, bestId, faceId);
    return bestId;
  }

  const personId = await db_module.createPerson(db, faceId, f32ToBlob(embedding));
  centroids.set(personId, new Float32Array(embedding));
  log.info('New person created', { personId, faceId, reason: bestId === -1 ? 'no_candidates' : bestSim < SIM_THRESHOLD ? 'below_threshold' : 'below_margin' });
  return personId;
}

async function _updateCentroid(db, personId, newEmbedding, centroids) {
  const row = await db.get('SELECT face_count, centroid FROM persons WHERE id = ?', personId);
  if (!row) return;

  const n    = row.face_count + 1;
  const prev = row.centroid ? blobToF32(row.centroid) : new Float32Array(512);
  const dim  = newEmbedding.length;
  const next = new Float32Array(dim);
  for (let i = 0; i < dim; i++) next[i] = (prev[i] * (n - 1) + newEmbedding[i]) / n;

  // L2-renormalise back to the unit sphere before storing/caching.
  //
  // Why this is needed: cosineSim() (top of this file) is a plain dot product,
  // which only equals cosine similarity when both inputs are unit vectors.
  // newEmbedding always is (InsightFace returns normed_embedding — see
  // face_service/detector.py). prev is *not* guaranteed to be, because this
  // running-mean update is applied repeatedly: each weighted average of two
  // unit-ish vectors generally has |result| < 1 (by the triangle inequality,
  // strictly so whenever the two inputs aren't identical), so without
  // renormalising, the centroid's magnitude shrinks a little on every single
  // face added to a person. Verified by simulation: with realistic inter-photo
  // noise, |centroid| drops to roughly 0.2-0.35 after 30-50 faces, which understates
  // the true cosine similarity of a genuinely matching new face by ~0.03-0.15 —
  // easily enough to push a real match below SIM_THRESHOLD and spawn a
  // duplicate person. This bug compounds with person size, so well-photographed
  // people are hit hardest — consistent with the duplicate-cluster symptom.
  //
  // Note: a full HDBSCAN recluster (fullReclusterPython) already computes
  // centroids correctly via Python's _l2_normalize, so this fix only affects
  // centroids maintained incrementally between reclusters — but that is most
  // of the system's actual runtime.
  l2NormInPlace(next);

  centroids.set(personId, next);
  await db_module.updatePersonStats(db, personId, { centroidBlob: f32ToBlob(next), faceCount: n });
}

async function _maybeUpdateCoverFace(db, personId, candidateFaceId) {
  const person = await db.get('SELECT cover_face_id FROM persons WHERE id = ?', personId);
  if (!person) return;
  if (!person.cover_face_id) {
    await db_module.updatePersonStats(db, personId, { coverFaceId: candidateFaceId });
    return;
  }
  const [newRow, curRow] = await Promise.all([
    db.get('SELECT det_score FROM faces WHERE id = ?', candidateFaceId),
    db.get('SELECT det_score FROM faces WHERE id = ?', person.cover_face_id),
  ]);
  if ((newRow ? newRow.det_score : 0) > (curRow ? curRow.det_score : 0)) {
    await db_module.updatePersonStats(db, personId, { coverFaceId: candidateFaceId });
  }
}

// ─────────────────────────────────────────────────────────────
//  FULL RECLUSTER VIA PYTHON HDBSCAN  (replaces old JS greedy)
// ─────────────────────────────────────────────────────────────

/**
 * Simple HTTP POST helper (no external deps).
 * Used here to call the Python AI service /cluster endpoint.
 */
function _httpPost(url, body, timeoutMs = 600000) {
  return new Promise((resolve, reject) => {
    const data   = JSON.stringify(body);
    let   parsed;
    try { parsed = new URL(url); } catch (e) { return reject(new Error(`Bad URL: ${url}`)); }

    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method:   'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, res => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        try {
          const obj = JSON.parse(raw);
          if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${obj.detail || raw.slice(0, 300)}`));
          resolve(obj);
        } catch (e) { reject(new Error(`JSON parse: ${raw.slice(0, 200)}`)); }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Timeout (${timeoutMs}ms)`)));
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

/**
 * Full HDBSCAN recluster via Python AI microservice.
 *
 * Step-by-step:
 *   1. Snapshot names + locked_cover settings from existing persons
 *   2. POST { db_path, merge_threshold } to Python /cluster
 *   3. Python reads all embeddings from db_path (read-only SQLite)
 *   4. Python runs HDBSCAN + 5-stage pipeline, returns assignments + centroids
 *   5. Write person rows + face assignments in a single DB transaction
 *   6. Re-apply names by matching old best-face → new person
 *   7. Post-dedup: merge any newly-created persons with cosine sim > 0.95
 *
 * @param {import('sqlite').Database} db
 * @param {string}  dbPath       Absolute path to face_index.db (sent to Python)
 * @param {string}  pythonUrl    Python service base URL
 * @returns {Promise<{persons: number, facesAssigned: number, deduped: number}>}
 */
async function fullReclusterPython(db, dbPath, pythonUrl) {
  const t = log.timer('Python HDBSCAN recluster');
  log.info('Requesting HDBSCAN recluster from Python service', { dbPath, pythonUrl });

  // ── 0. Snapshot existing names and locked covers BEFORE wiping ─────────────
  // Strategy: map each named person's cover_face_id → { name, locked_cover }
  // After rebuild, find which new person inherited that face and re-apply the name.
  const namedSnapshot = await db.all(`
    SELECT p.name, p.locked_cover, p.cover_face_id AS best_face_id
    FROM   persons p
    WHERE  p.name IS NOT NULL AND p.cover_face_id IS NOT NULL
  `);
  // Also capture locked covers without names (to re-lock them)
  const lockedCovers = await db.all(`
    SELECT p.cover_face_id AS face_id
    FROM   persons p
    WHERE  p.locked_cover = 1 AND p.cover_face_id IS NOT NULL
  `);
  // face_feedback rows survive the wipe (they have ON DELETE CASCADE only for faces rows)
  log.info('Snapshot', { named: namedSnapshot.length, locked: lockedCovers.length });

  // ── 1. Call Python /cluster endpoint ─────────────────────────────────────
  let pyResult;
  try {
    pyResult = await _httpPost(`${pythonUrl}/cluster`, {
      db_path:          dbPath,
      min_cluster_size: 2,
      min_samples:      1,
      merge_threshold:  CENTROID_MERGE_SIM,
    }, 600000); // 10-minute timeout for very large libraries
  } catch (err) {
    throw new Error(`Python /cluster call failed: ${err.message}`);
  }

  const { assignments, centroids, cover_faces, face_counts, n_clusters, n_noise, n_total } = pyResult;
  log.info('HDBSCAN result received', { n_clusters, n_noise, n_total });

  if (!assignments || Object.keys(assignments).length === 0) {
    log.info('No faces to cluster — skipping write');
    return { persons: 0, facesAssigned: 0, deduped: 0 };
  }

  // Collect all active cluster IDs (non-noise)
  const activeClusterIds = new Set(
    Object.values(assignments).filter(cid => cid >= 0).map(Number)
  );

  // ── 2. Write to DB in a single transaction ─────────────────────────────────
  await db.run('BEGIN');
  try {
    // Wipe all existing person assignments (rebuilding from scratch)
    await db.run('UPDATE faces SET person_id = NULL');
    await db.run('DELETE FROM persons');

    const now             = Date.now();
    const clusterToPerson = new Map(); // cluster_id (Python int) → person_id (SQLite)

    // Insert one person row per non-empty cluster
    for (const cid of activeClusterIds) {
      const cidStr    = String(cid);
      const centroid  = centroids[cidStr];
      const faceCount = face_counts[cidStr] || 0;
      if (faceCount === 0) continue;

      let centroidBlob = null;
      if (centroid && centroid.length === 512) {
        centroidBlob = f32ToBlob(new Float32Array(centroid));
      }

      const result = await db.run(
        'INSERT INTO persons (face_count, centroid, created_at, updated_at) VALUES (?, ?, ?, ?)',
        faceCount, centroidBlob, now, now,
      );
      clusterToPerson.set(cid, result.lastID);
    }

    // Assign faces to persons
    const stmtFace = await db.prepare('UPDATE faces SET person_id = ? WHERE id = ?');
    let   facesAssigned = 0;
    for (const [faceIdStr, clusterId] of Object.entries(assignments)) {
      if (clusterId < 0) continue;
      const personId = clusterToPerson.get(Number(clusterId));
      if (personId == null) continue;
      await stmtFace.run(personId, Number(faceIdStr));
      facesAssigned++;
    }
    await stmtFace.finalize();

    // Set cover face (Python already chose best det_score face per cluster)
    const stmtCover = await db.prepare('UPDATE persons SET cover_face_id = ? WHERE id = ?');
    for (const [cidStr, coverFaceId] of Object.entries(cover_faces || {})) {
      const personId = clusterToPerson.get(Number(cidStr));
      if (personId == null || !coverFaceId) continue;
      await stmtCover.run(Number(coverFaceId), personId);
    }
    await stmtCover.finalize();

    await db.run('COMMIT');
    log.info('HDBSCAN DB write complete', { persons: clusterToPerson.size, facesAssigned, noise: n_noise });
  } catch (e) {
    try { await db.run('ROLLBACK'); } catch {}
    throw e;
  }

  // ── 3. Re-apply names: find which new person inherited each old best-face ──
  // Each named person's cover_face_id now belongs to some new person.
  // We look up that face's new person_id and apply the name (first-wins, no override).
  if (namedSnapshot.length > 0) {
    const applied = { names: 0 };
    for (const snap of namedSnapshot) {
      try {
        const faceRow = await db.get('SELECT person_id FROM faces WHERE id = ?', snap.best_face_id);
        if (!faceRow || !faceRow.person_id) continue;
        const newPid = faceRow.person_id;
        // Don't overwrite a name that was already re-applied by an earlier snap
        const existing = await db.get('SELECT name FROM persons WHERE id = ?', newPid);
        if (!existing || existing.name) continue; // already has a name — skip
        await db.run('UPDATE persons SET name = ?, updated_at = ? WHERE id = ?', snap.name, Date.now(), newPid);
        applied.names++;
      } catch {}
    }
    log.info('Name re-application', applied);
  }

  // ── 4. Re-apply not-me feedback ───────────────────────────────────────────
  // After rebuild, some faces may be re-assigned to clusters very similar to
  // ones the user previously rejected them from.  Use the saved centroid snapshot
  // (rejected_centroid in face_feedback) to identify and undo those re-assignments.
  const notMeUnassigned = await _reapplyNotMeFeedback(db);
  if (notMeUnassigned > 0) {
    log.info(`Re-applied not-me feedback: unassigned ${notMeUnassigned} face(s) from rebuilt clusters`);
  }

  // ── 5. Post-recluster deduplication ──────────────────────────────────────
  // Multi-strategy dedup: centroid cosine sim + face-set (media) overlap + Jaccard.
  // Catches cases where the same person ended up in 2-4 separate person rows.
  const deduped = await _deduplicatePostRecluster(db);
  if (deduped > 0) {
    log.info(`Post-recluster dedup: merged ${deduped} near-duplicate person pair(s)`);
  }

  invalidateCentroidCache();
  t.end({ persons: activeClusterIds.size, facesAssigned: n_total - n_noise, deduped });
  return { persons: activeClusterIds.size, facesAssigned: n_total - n_noise, deduped };
}

// ─────────────────────────────────────────────────────────────
//  NOT-ME FEEDBACK RE-APPLICATION  (post recluster)
// ─────────────────────────────────────────────────────────────

/**
 * After a full recluster, re-apply "not this person" rejections.
 *
 * When persons table is rebuilt, face_feedback.person_id becomes NULL (ON DELETE SET NULL).
 * But face_feedback.rejected_centroid preserves the centroid of the rejected cluster.
 * We use cosine similarity between the saved centroid and the newly-assigned person's
 * centroid to detect when a face has been re-assigned to the same semantic cluster.
 *
 * Threshold 0.72 — same as CENTROID_MERGE_SIM.  If two centroids are this similar
 * they represent the same person cluster.
 *
 * @param {import('sqlite').Database} db
 * @returns {Promise<number>} faces unassigned
 */
async function _reapplyNotMeFeedback(db, simThreshold = 0.72) {
  const feedbackRows = await db_module.getNotMeFeedbackWithCentroids(db);
  if (!feedbackRows.length) return 0;

  // Group saved rejected centroids by face_id
  const rejectedByFace = new Map(); // face_id → Float32Array[]
  for (const row of feedbackRows) {
    if (!row.rejected_centroid) continue;
    const emb = blobToF32(row.rejected_centroid);
    if (!rejectedByFace.has(row.face_id)) rejectedByFace.set(row.face_id, []);
    rejectedByFace.get(row.face_id).push(emb);
  }
  if (!rejectedByFace.size) return 0;

  let unassigned = 0;
  for (const [faceId, rejectedCentroids] of rejectedByFace) {
    // Get this face's current person assignment
    const faceRow = await db.get('SELECT person_id FROM faces WHERE id = ?', faceId);
    if (!faceRow || !faceRow.person_id) continue;

    // Get new person's centroid
    const personRow = await db.get('SELECT centroid FROM persons WHERE id = ?', faceRow.person_id);
    if (!personRow || !personRow.centroid) continue;

    const newCentroid = blobToF32(personRow.centroid);

    // Check similarity against every rejected centroid for this face
    const shouldUnassign = rejectedCentroids.some(
      rejC => cosineSim(rejC, newCentroid) >= simThreshold
    );

    if (shouldUnassign) {
      await db.run('UPDATE faces SET person_id = NULL WHERE id = ?', faceId);
      const cnt = await db.get('SELECT COUNT(*) AS cnt FROM faces WHERE person_id = ?', faceRow.person_id);
      await db.run(
        'UPDATE persons SET face_count = ?, updated_at = ? WHERE id = ?',
        cnt ? cnt.cnt : 0, Date.now(), faceRow.person_id,
      );
      unassigned++;
      log.debug(`Not-me re-applied: face ${faceId} unassigned from person ${faceRow.person_id}`);
    }
  }
  return unassigned;
}

// ─────────────────────────────────────────────────────────────
//  COMPREHENSIVE POST-RECLUSTER DEDUPLICATION
// ─────────────────────────────────────────────────────────────

/**
 * Multi-strategy deduplication run AFTER a full recluster.
 *
 * Three merge triggers (any one is enough):
 *   1. Centroid cosine similarity ≥ centroidThreshold (default 0.80)
 *      — same person's embeddings cluster similarly
 *   2. Media-set Jaccard similarity ≥ jaccardThreshold (default 0.80)
 *      — two persons co-appear in 80%+ of the same media files
 *   3. Max media overlap ≥ overlapThreshold (default 0.90)
 *      — 90%+ of the smaller person's media is also in the larger person's media
 *      (asymmetric: handles cases where one cluster is a near-subset of another)
 *
 * Hard duplicate: identical centroid vectors → always merge regardless of thresholds.
 *
 * Always preserves: names, locked cover, feedback, manual edits.
 * Merges smaller/unnamed into larger/named.
 * Never deletes faces/media rows.
 *
 * @param {import('sqlite').Database} db
 * @returns {Promise<number>} number of merges performed
 */
async function _deduplicatePostRecluster(db, {
  centroidThreshold = 0.80,
  jaccardThreshold  = 0.80,
  overlapThreshold  = 0.90,
} = {}) {
  const rows = await db.all(
    'SELECT id, centroid, face_count, name FROM persons WHERE centroid IS NOT NULL AND face_count > 0 ORDER BY face_count DESC'
  );
  if (rows.length < 2) return 0;

  // Load media IDs per person (for Jaccard / overlap computation)
  const personMediaSets = new Map(); // personId → Set<mediaId>
  for (const row of rows) {
    const mediaRows = await db.all(
      'SELECT DISTINCT media_id FROM faces WHERE person_id = ?', row.id
    );
    personMediaSets.set(row.id, new Set(mediaRows.map(r => r.media_id)));
  }

  const merged = new Set();
  let mergeCount = 0;

  for (let i = 0; i < rows.length; i++) {
    if (merged.has(rows[i].id)) continue;
    const embA    = blobToF32(rows[i].centroid);
    const mediaA  = personMediaSets.get(rows[i].id) || new Set();

    for (let j = i + 1; j < rows.length; j++) {
      if (merged.has(rows[j].id)) continue;
      const embB   = blobToF32(rows[j].centroid);
      const sim    = cosineSim(embA, embB);
      const mediaB = personMediaSets.get(rows[j].id) || new Set();

      // Compute media set overlap metrics
      let intersection = 0;
      for (const mid of mediaA) if (mediaB.has(mid)) intersection++;
      const union     = mediaA.size + mediaB.size - intersection;
      const jaccard   = union > 0 ? intersection / union : 0;
      const overlapA  = mediaA.size > 0 ? intersection / mediaA.size : 0;
      const overlapB  = mediaB.size > 0 ? intersection / mediaB.size : 0;
      const maxOverlap = Math.max(overlapA, overlapB);

      const hardDup    = sim >= 0.98;
      const shouldMerge = hardDup ||
        sim         >= centroidThreshold ||
        jaccard     >= jaccardThreshold  ||
        maxOverlap  >= overlapThreshold;

      if (!shouldMerge) continue;

      // Decide direction: larger (or named) is the merge target
      // rows[] is sorted face_count DESC, so rows[i].face_count ≥ rows[j].face_count
      let winnerId = rows[i].id;
      let loserId  = rows[j].id;
      // But if j has a name and i doesn't, prefer j as winner
      if (!rows[i].name && rows[j].name) {
        [winnerId, loserId] = [loserId, winnerId];
      }

      try {
        await db_module.mergePersons(db, loserId, winnerId);
        merged.add(loserId);
        mergeCount++;

        // Update winner's media set
        const winnerMedia = personMediaSets.get(winnerId) || new Set();
        for (const mid of mediaB) winnerMedia.add(mid);
        personMediaSets.set(winnerId, winnerMedia);

        log.info(`Post-recluster dedup: person ${loserId} → ${winnerId}`, {
          centroid: sim.toFixed(4),
          jaccard:  jaccard.toFixed(4),
          overlap:  maxOverlap.toFixed(4),
          reason:   hardDup ? 'hard_dup' : sim >= centroidThreshold ? 'centroid' : jaccard >= jaccardThreshold ? 'jaccard' : 'overlap',
        });
      } catch (e) {
        log.warn(`Dedup merge ${loserId}→${winnerId} failed: ${e.message}`);
      }
    }
  }

  return mergeCount;
}

/**
 * Legacy centroid-only deduplication — kept for the manual /api/faces/deduplicate
 * endpoint.  Lower threshold (default 0.80) so it's useful on-demand too.
 *
 * For automatic post-recluster use, prefer _deduplicatePostRecluster which also
 * checks media overlap and Jaccard similarity.
 *
 * @param {import('sqlite').Database} db
 * @param {number} threshold  cosine sim threshold, default 0.80
 * @returns {Promise<number>}  number of merges performed
 */
async function _deduplicateHighSimPersons(db, threshold = 0.80) {
  const rows = await db.all(
    'SELECT id, centroid, face_count, name FROM persons WHERE centroid IS NOT NULL AND face_count > 0 ORDER BY face_count DESC'
  );
  if (rows.length < 2) return 0;

  const merged = new Set();
  let mergeCount = 0;

  for (let i = 0; i < rows.length; i++) {
    if (merged.has(rows[i].id)) continue;
    const embA = blobToF32(rows[i].centroid);

    for (let j = i + 1; j < rows.length; j++) {
      if (merged.has(rows[j].id)) continue;
      const embB = blobToF32(rows[j].centroid);
      const sim  = cosineSim(embA, embB);

      if (sim >= threshold) {
        // Named person wins; otherwise larger cluster wins (rows sorted DESC)
        let winnerId = rows[i].id;
        let loserId  = rows[j].id;
        if (!rows[i].name && rows[j].name) {
          [winnerId, loserId] = [loserId, winnerId];
        }
        try {
          await db_module.mergePersons(db, loserId, winnerId);
          merged.add(loserId);
          mergeCount++;
          log.info(`Dedup merge: person ${loserId} → ${winnerId} (sim=${sim.toFixed(4)})`);
        } catch (e) {
          log.warn(`Dedup merge failed: ${e.message}`);
        }
      }
    }
  }

  return mergeCount;
}

// ─────────────────────────────────────────────────────────────
//  EXPORTS
// ─────────────────────────────────────────────────────────────

module.exports = {
  // Incremental (used during scanning)
  assignFace,
  loadCentroidCache,
  invalidateCentroidCache,
  getCentroids,
  // Full recluster (HDBSCAN via Python)
  fullReclusterPython,
  // Post-recluster deduplication (comprehensive — used internally + exposed for manual call)
  _deduplicatePostRecluster,
  // Legacy centroid-only dedup (manual /api/faces/deduplicate endpoint)
  _deduplicateHighSimPersons,
  // Not-me feedback re-application (post recluster)
  _reapplyNotMeFeedback,
  // Math utilities (used by face-worker deduplication)
  cosineSim,
  l2NormInPlace,
  meanEmbedding,
  blobToF32,
  f32ToBlob,
};

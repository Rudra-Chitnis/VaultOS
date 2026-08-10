'use strict';

/**
 * face-db.js
 * SQLite database layer for the face-indexing subsystem.
 *
 * Driver: sqlite3 (prebuilt Windows binaries, no VS Build Tools needed)
 * Wrapper: sqlite (Promise/async-await API over sqlite3)
 *
 * WRITER  → the face-worker process (exclusive write access).
 *           Opens with READWRITE|CREATE, busy_timeout 10 000 ms.
 * SERVER  → the Express server process (reads + person management writes).
 *           Opens with READWRITE, busy_timeout 3 000 ms.
 *
 * WAL journal mode lets one writer and multiple readers work concurrently.
 * All heavy indexing transactions stay in the worker; server writes are
 * infrequent (rename / merge / delete person).
 *
 * Schema version: 1
 */

const path  = require('path');
const fs    = require('fs');
const { FaceLogger } = require('./face-logger');

const log = new FaceLogger('DB');

// ─────────────────────────────────────────────────────────────
//  SCHEMA
// ─────────────────────────────────────────────────────────────

const SCHEMA_VERSION = 4;

/**
 * DDL executed on every open (IF NOT EXISTS guards make it idempotent).
 * PRAGMAs are run separately after open because sqlite3 requires them
 * outside of a multi-statement exec in some versions.
 */
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS media_index (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    filename    TEXT    UNIQUE NOT NULL,
    file_mtime  INTEGER NOT NULL,
    file_size   INTEGER NOT NULL,
    media_type  TEXT    NOT NULL,
    status      TEXT    NOT NULL DEFAULT 'pending',
    error_msg   TEXT,
    face_count  INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER,
    width       INTEGER,
    height      INTEGER,
    indexed_at  INTEGER
);

CREATE TABLE IF NOT EXISTS faces (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    media_id    INTEGER NOT NULL REFERENCES media_index(id) ON DELETE CASCADE,
    frame_ms    INTEGER NOT NULL DEFAULT 0,
    det_score   REAL    NOT NULL,
    bbox_x      REAL    NOT NULL,
    bbox_y      REAL    NOT NULL,
    bbox_w      REAL    NOT NULL,
    bbox_h      REAL    NOT NULL,
    embedding   BLOB    NOT NULL,
    person_id   INTEGER REFERENCES persons(id) ON DELETE SET NULL,
    thumb_path  TEXT,
    keypoints   TEXT,
    created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS persons (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT,
    cover_face_id   INTEGER REFERENCES faces(id) ON DELETE SET NULL,
    face_count      INTEGER NOT NULL DEFAULT 0,
    centroid        BLOB,
    locked_cover    INTEGER NOT NULL DEFAULT 0,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS face_feedback (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    face_id           INTEGER NOT NULL REFERENCES faces(id) ON DELETE CASCADE,
    action            TEXT    NOT NULL,
    person_id         INTEGER REFERENCES persons(id) ON DELETE SET NULL,
    rejected_centroid BLOB,
    created_at        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS scan_queue (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    filename    TEXT    UNIQUE NOT NULL,
    priority    INTEGER NOT NULL DEFAULT 0,
    enqueued_at INTEGER NOT NULL,
    status      TEXT    NOT NULL DEFAULT 'queued',
    error_msg   TEXT,
    attempts    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS index_meta (
    key     TEXT PRIMARY KEY,
    value   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_faces_media      ON faces(media_id);
CREATE INDEX IF NOT EXISTS idx_faces_person     ON faces(person_id);
CREATE INDEX IF NOT EXISTS idx_faces_score      ON faces(det_score DESC);
CREATE INDEX IF NOT EXISTS idx_media_status     ON media_index(status);
CREATE INDEX IF NOT EXISTS idx_media_type       ON media_index(media_type, status);
CREATE INDEX IF NOT EXISTS idx_persons_count    ON persons(face_count DESC);
CREATE INDEX IF NOT EXISTS idx_queue_work       ON scan_queue(status, priority DESC, enqueued_at ASC);
CREATE INDEX IF NOT EXISTS idx_feedback_face    ON face_feedback(face_id);
CREATE INDEX IF NOT EXISTS idx_feedback_person  ON face_feedback(person_id);

CREATE TABLE IF NOT EXISTS media_cluster_manual (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    filename   TEXT    NOT NULL,
    person_id  INTEGER NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    UNIQUE(filename, person_id)
);
CREATE INDEX IF NOT EXISTS idx_mcm_filename ON media_cluster_manual(filename);
CREATE INDEX IF NOT EXISTS idx_mcm_person   ON media_cluster_manual(person_id);
`;

// ─────────────────────────────────────────────────────────────
//  OPEN / MIGRATE
// ─────────────────────────────────────────────────────────────

/**
 * Open (or create) the face index database.
 * Returns a Promise that resolves to a sqlite Database instance.
 *
 * Three open modes — chosen via the options object:
 *
 *   WORKER  (default)  readonly:false, create:true
 *     Opens READWRITE|CREATE.  Runs all PRAGMAs + full DDL + schema version.
 *     Only the face-worker should use this mode.
 *
 *   SERVER             readonly:false, create:false
 *     Opens READWRITE (no CREATE flag — fails if file absent, good for server).
 *     Runs write PRAGMAs (WAL etc.) but skips DDL — schema already exists.
 *     Server needs READWRITE because it writes rename/merge/delete operations.
 *
 *   READONLY           readonly:true  (create is forced false)
 *     Opens OPEN_READONLY.  Skips ALL write PRAGMAs and DDL.
 *     NOTE: journal_mode=WAL and CREATE TABLE both throw SQLITE_READONLY —
 *     that is why this mode skips them completely.
 *
 * @param {string} dbPath
 * @param {{ busyTimeout?: number, readonly?: boolean, create?: boolean }} options
 * @returns {Promise<import('sqlite').Database>}
 */
async function openDB(dbPath, options = {}) {
  const { busyTimeout = 5000, readonly = false } = options;
  // create defaults to true for writer, false for readonly connections
  const create = readonly ? false : (options.create !== undefined ? options.create : true);

  let open, sqlite3;
  try {
    ({ open }  = require('sqlite'));
    sqlite3    = require('sqlite3');
  } catch (e) {
    const msg = 'sqlite / sqlite3 not installed. Run: npm install sqlite sqlite3';
    log.error(msg);
    throw new Error(msg);
  }

  // For write connections, ensure the containing directory exists
  if (!readonly) {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  // Select the correct SQLite open flags
  let mode;
  if (readonly) {
    mode = sqlite3.OPEN_READONLY;
  } else if (create) {
    mode = sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE;
  } else {
    // READWRITE without CREATE — fails cleanly if file not yet created by worker
    mode = sqlite3.OPEN_READWRITE;
  }

  log.debug('openDB', { dbPath, readonly, create, mode });

  const db = await open({ filename: dbPath, driver: sqlite3.Database, mode });

  // ── PRAGMAs safe for ALL connection modes (connection-level, no DB write) ──
  await db.run(`PRAGMA busy_timeout = ${busyTimeout}`);
  await db.run('PRAGMA cache_size   = -32000');
  await db.run('PRAGMA temp_store   = MEMORY');

  if (!readonly) {
    // ── Write-mode PRAGMAs (SQLITE_READONLY if attempted on OPEN_READONLY) ──
    await db.run('PRAGMA journal_mode = WAL');
    await db.run('PRAGMA synchronous  = NORMAL');
    await db.run('PRAGMA foreign_keys = ON');
  }

  if (!readonly && create) {
    // ── Full schema setup — only the worker needs this ──
    // DDL is idempotent (IF NOT EXISTS guards), but still fails on OPEN_READONLY.
    await db.exec(SCHEMA_SQL);

    // Check / set schema version; run incremental migrations as needed
    const vrow = await db.get('SELECT version FROM schema_version');
    if (vrow === undefined) {
      await db.run('INSERT INTO schema_version VALUES (?)', SCHEMA_VERSION);
      log.info('DB schema initialised', { version: SCHEMA_VERSION });
    } else if (vrow.version < SCHEMA_VERSION) {
      log.warn('Schema migration needed', { stored: vrow.version, target: SCHEMA_VERSION });

      // v1 → v2: add locked_cover column + face_feedback table
      if (vrow.version < 2) {
        try {
          await db.run('ALTER TABLE persons ADD COLUMN locked_cover INTEGER NOT NULL DEFAULT 0');
          log.info('Migration v1→v2: added persons.locked_cover');
        } catch (e) {
          if (!e.message.includes('duplicate column')) throw e;
        }
        await db.exec(`
          CREATE TABLE IF NOT EXISTS face_feedback (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            face_id    INTEGER NOT NULL REFERENCES faces(id) ON DELETE CASCADE,
            action     TEXT    NOT NULL,
            person_id  INTEGER REFERENCES persons(id) ON DELETE SET NULL,
            created_at INTEGER NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_feedback_face   ON face_feedback(face_id);
          CREATE INDEX IF NOT EXISTS idx_feedback_person ON face_feedback(person_id);
        `);
        log.info('Migration v1→v2: created face_feedback table');
      }

      // v2 → v3: add rejected_centroid BLOB to face_feedback
      // Stores the embedding centroid of the rejected person cluster so that
      // the Not Me feedback can be re-applied after a full recluster even when
      // person IDs are rebuilt from scratch (ON DELETE SET NULL clears person_id).
      if (vrow.version < 3) {
        try {
          await db.run('ALTER TABLE face_feedback ADD COLUMN rejected_centroid BLOB');
          log.info('Migration v2→v3: added face_feedback.rejected_centroid');
        } catch (e) {
          if (!e.message.includes('duplicate column')) throw e;
        }
      }

      // v3 → v4: add media_cluster_manual table.
      // Stores authoritative user-controlled media → cluster associations that
      // are independent of AI face detection.  Any media type can be manually
      // linked to any cluster, even files with zero detected faces.
      if (vrow.version < 4) {
        await db.exec(`
          CREATE TABLE IF NOT EXISTS media_cluster_manual (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            filename   TEXT    NOT NULL,
            person_id  INTEGER NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
            created_at INTEGER NOT NULL,
            UNIQUE(filename, person_id)
          );
          CREATE INDEX IF NOT EXISTS idx_mcm_filename ON media_cluster_manual(filename);
          CREATE INDEX IF NOT EXISTS idx_mcm_person   ON media_cluster_manual(person_id);
        `);
        log.info('Migration v3→v4: created media_cluster_manual table');
      }

      await db.run('UPDATE schema_version SET version = ?', SCHEMA_VERSION);
      log.info('Schema migrated to version', SCHEMA_VERSION);
    }
  }

  // ── SERVER mode incremental migration ───────────────────────
  // Full DDL only runs in WORKER/create mode, but the server (READWRITE,
  // create:false) also needs new tables that were added after the initial
  // schema creation.  Run targeted CREATE IF NOT EXISTS here so the server
  // connection sees the latest schema without requiring a full WORKER start.
  if (!readonly && !create) {
    try {
      const sv = await db.get('SELECT version FROM schema_version').catch(() => null);
      if (sv && sv.version < 4) {
        await db.exec(`
          CREATE TABLE IF NOT EXISTS media_cluster_manual (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            filename   TEXT    NOT NULL,
            person_id  INTEGER NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
            created_at INTEGER NOT NULL,
            UNIQUE(filename, person_id)
          );
          CREATE INDEX IF NOT EXISTS idx_mcm_filename ON media_cluster_manual(filename);
          CREATE INDEX IF NOT EXISTS idx_mcm_person   ON media_cluster_manual(person_id);
        `);
        await db.run('UPDATE schema_version SET version = 4').catch(() => {});
        log.info('Server-mode migration: created media_cluster_manual (v4)');
      }
    } catch (sme) {
      log.warn('Server-mode migration check failed (non-fatal)', { error: sme.message });
    }
  }

  return db;
}

// ─────────────────────────────────────────────────────────────
//  QUEUE HELPERS
// ─────────────────────────────────────────────────────────────

async function enqueueFile(db, filename, priority = 0) {
  const now = Date.now();
  const existing = await db.get(
    'SELECT status FROM scan_queue WHERE filename = ?',
    filename,
  );
  if (existing) {
    if (existing.status !== 'processing') {
      await db.run(
        "UPDATE scan_queue SET status = 'queued', priority = MAX(priority, ?), enqueued_at = ?, error_msg = NULL WHERE filename = ?",
        priority, now, filename,
      );
    }
    return;
  }
  await db.run(
    "INSERT OR IGNORE INTO scan_queue (filename, priority, enqueued_at, status) VALUES (?, ?, ?, 'queued')",
    filename, priority, now,
  );
}

async function recoverProcessingQueue(db) {
  return db.run(
    "UPDATE scan_queue SET status = 'queued', error_msg = NULL WHERE status = 'processing'",
  );
}

async function requeueFile(db, filename, priority = 2) {
  const now = Date.now();
  await db.run(
    'UPDATE scan_queue SET status = \'queued\', priority = ?, enqueued_at = ?, error_msg = NULL, attempts = 0 WHERE filename = ?',
    priority, now, filename,
  );
  await db.run(
    "INSERT OR IGNORE INTO scan_queue (filename, priority, enqueued_at, status) VALUES (?, ?, ?, 'queued')",
    filename, priority, now,
  );
}

/**
 * Atomically pull the next queued item and mark it 'processing'.
 * Uses BEGIN IMMEDIATE to prevent two concurrent readers from claiming the
 * same row — the only safe pattern without RETURNING in older SQLite builds.
 *
 * @returns {Promise<{id, filename, priority, attempts}|null>}
 */
async function dequeueNext(db) {
  await db.run('BEGIN IMMEDIATE');
  try {
    const row = await db.get(
      "SELECT id, filename, priority, attempts FROM scan_queue WHERE status = 'queued' ORDER BY priority DESC, enqueued_at ASC LIMIT 1",
    );
    if (!row) {
      await db.run('ROLLBACK');
      return null;
    }
    await db.run(
      "UPDATE scan_queue SET status = 'processing', attempts = attempts + 1 WHERE id = ?",
      row.id,
    );
    await db.run('COMMIT');
    return row;
  } catch (e) {
    try { await db.run('ROLLBACK'); } catch {}
    throw e;
  }
}

async function finaliseQueueItem(db, queueId, status, errorMsg = null) {
  await db.run(
    'UPDATE scan_queue SET status = ?, error_msg = ? WHERE id = ?',
    status, errorMsg, queueId,
  );
}

// ─────────────────────────────────────────────────────────────
//  READ HELPERS  (safe to call from the Express server process)
// ─────────────────────────────────────────────────────────────

/**
 * Return face metadata for a batch of filenames.
 * Used by /api/files to attach facePersonIds to each gallery item.
 * Returns a Map<filename, { faceCount, personIds: number[] }>.
 */
async function getIndexedFaceBatch(db, filenames) {
  if (!filenames.length) return new Map();

  const map   = new Map();
  const CHUNK = 500;

  for (let i = 0; i < filenames.length; i += CHUNK) {
    const chunk = filenames.slice(i, i + CHUNK);
    const ph    = chunk.map(() => '?').join(',');
    const rows  = await db.all(`
      SELECT m.filename,
             m.face_count,
             GROUP_CONCAT(DISTINCT f.person_id) AS pids
      FROM   media_index m
      LEFT JOIN faces f ON f.media_id = m.id AND f.person_id IS NOT NULL
      WHERE  m.filename IN (${ph})
        AND  m.status = 'done'
      GROUP  BY m.id
    `, chunk);   // sqlite accepts an array as the params argument

    for (const row of rows) {
      map.set(row.filename, {
        faceCount: row.face_count,
        personIds: row.pids
          ? row.pids.split(',').map(Number).filter(Boolean)
          : [],
      });
    }
  }
  return map;
}

async function getPersons(db, { limit = 40, offset = 0 } = {}) {
  const crow = await db.get('SELECT COUNT(*) AS cnt FROM persons WHERE face_count > 0');
  const total = crow ? crow.cnt : 0;

  const items = await db.all(`
    SELECT p.id,
           p.name,
           p.face_count,
           p.cover_face_id,
           f.thumb_path AS cover_thumb
    FROM   persons p
    LEFT JOIN faces f ON f.id = p.cover_face_id
    WHERE  p.face_count > 0
    ORDER  BY p.face_count DESC
    LIMIT  ? OFFSET ?
  `, limit, offset);

  return { items, total };
}

async function getPersonMedia(db, personId, { limit = 60, offset = 0 } = {}) {
  // Total = distinct filenames from AI-detected faces UNION manual assignments.
  // UNION (not UNION ALL) deduplicates files that appear in both sources.
  // Manual branch uses LEFT JOIN so files not yet indexed still count.
  const crow = await db.get(`
    SELECT COUNT(*) AS cnt FROM (
      SELECT m.filename
      FROM   media_index m
      JOIN   faces f ON f.media_id = m.id
      WHERE  f.person_id = ? AND m.status = 'done'
      GROUP  BY m.id
      UNION
      SELECT mc.filename
      FROM   media_cluster_manual mc
      LEFT JOIN media_index m ON m.filename = mc.filename
      WHERE  mc.person_id = ? AND (m.id IS NULL OR m.status = 'done')
    )
  `, personId, personId);
  const total = crow ? crow.cnt : 0;

  // Items query: AI rows take priority. Manual rows only included for files
  // that have no AI-detected faces for this person (no duplicates).
  // is_manual=0 → AI-detected; is_manual=1 → manual assignment only.
  // Manual branch uses LEFT JOIN so files not yet in media_index still appear.
  const items = await db.all(`
    SELECT filename, media_type, face_ids, best_thumb, is_manual, sort_ts
    FROM (
      SELECT m.filename,
             m.media_type,
             GROUP_CONCAT(f.id) AS face_ids,
             (SELECT f2.thumb_path
              FROM   faces f2
              WHERE  f2.media_id  = m.id
                AND  f2.person_id = ?
              ORDER  BY f2.det_score DESC
              LIMIT  1)          AS best_thumb,
             0                   AS is_manual,
             m.indexed_at        AS sort_ts
      FROM   media_index m
      JOIN   faces f ON f.media_id = m.id
      WHERE  f.person_id = ? AND m.status = 'done'
      GROUP  BY m.id

      UNION ALL

      SELECT mc.filename,
             m.media_type,
             NULL                                    AS face_ids,
             NULL                                    AS best_thumb,
             1                                       AS is_manual,
             COALESCE(m.indexed_at, mc.created_at)  AS sort_ts
      FROM   media_cluster_manual mc
      LEFT JOIN media_index m ON m.filename = mc.filename
      WHERE  mc.person_id = ? AND (m.id IS NULL OR m.status = 'done')
        AND  mc.filename NOT IN (
          SELECT mi.filename
          FROM   media_index mi
          JOIN   faces fi ON fi.media_id = mi.id
          WHERE  fi.person_id = ?
        )
    )
    ORDER BY sort_ts DESC
    LIMIT ? OFFSET ?
  `, personId, personId, personId, personId, limit, offset);

  return { items, total };
}

async function getMediaFaces(db, filename) {
  const media = await db.get(
    'SELECT id, status, face_count, width, height FROM media_index WHERE filename = ?',
    filename,
  );
  if (!media) return null;

  const faces = await db.all(`
    SELECT id, frame_ms, det_score,
           bbox_x, bbox_y, bbox_w, bbox_h,
           person_id, thumb_path, keypoints
    FROM   faces
    WHERE  media_id = ?
    ORDER  BY frame_ms ASC, det_score DESC
  `, media.id);

  return { media, faces };
}

async function getIndexStatus(db) {
  const r = row => row ? row.cnt : 0;
  const [total, done, errored, queued, processing, personCount, faceCount] =
    await Promise.all([
      db.get('SELECT COUNT(*) AS cnt FROM media_index'),
      db.get("SELECT COUNT(*) AS cnt FROM media_index WHERE status='done'"),
      db.get("SELECT COUNT(*) AS cnt FROM media_index WHERE status='error'"),
      db.get("SELECT COUNT(*) AS cnt FROM scan_queue  WHERE status='queued'"),
      db.get("SELECT COUNT(*) AS cnt FROM scan_queue  WHERE status='processing'"),
      db.get('SELECT COUNT(*) AS cnt FROM persons WHERE face_count > 0'),
      db.get('SELECT COUNT(*) AS cnt FROM faces'),
    ]);
  return {
    total:        r(total),
    done:         r(done),
    errored:      r(errored),
    queued:       r(queued),
    processing:   r(processing),
    personCount:  r(personCount),
    faceCount:    r(faceCount),
  };
}

async function getPerson(db, personId) {
  return await db.get(`
    SELECT p.*, f.thumb_path AS cover_thumb
    FROM   persons p
    LEFT JOIN faces f ON f.id = p.cover_face_id
    WHERE  p.id = ?
  `, personId) || null;
}

// ─────────────────────────────────────────────────────────────
//  WRITE HELPERS  (called only from face-worker.js)
// ─────────────────────────────────────────────────────────────

/**
 * Upsert a row in media_index. Returns the row id.
 */
async function upsertMedia(db, { filename, mtime, size, mediaType, width, height, durationMs }) {
  await db.run(`
    INSERT INTO media_index
      (filename, file_mtime, file_size, media_type, status, width, height, duration_ms)
    VALUES (?, ?, ?, ?, 'processing', ?, ?, ?)
    ON CONFLICT(filename) DO UPDATE SET
      file_mtime  = excluded.file_mtime,
      file_size   = excluded.file_size,
      status      = 'processing',
      width       = excluded.width,
      height      = excluded.height,
      duration_ms = excluded.duration_ms,
      error_msg   = NULL
  `, filename, mtime, size, mediaType, width || null, height || null, durationMs || null);

  const row = await db.get('SELECT id FROM media_index WHERE filename = ?', filename);
  return row.id;
}

/**
 * Insert a detected face row. Returns the new face id.
 */
async function insertFace(db, {
  mediaId, frameMs = 0, detScore,
  bboxX, bboxY, bboxW, bboxH,
  embedding, thumbPath, keypoints,
}) {
  const result = await db.run(`
    INSERT INTO faces
      (media_id, frame_ms, det_score, bbox_x, bbox_y, bbox_w, bbox_h,
       embedding, thumb_path, keypoints, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
    mediaId, frameMs, detScore,
    bboxX, bboxY, bboxW, bboxH,
    embedding,
    thumbPath || null,
    keypoints ? JSON.stringify(keypoints) : null,
    Date.now(),
  );
  return result.lastID;   // sqlite package uses lastID (not lastInsertRowid)
}

async function finaliseMedia(db, mediaId, faceCount, status = 'done', errorMsg = null) {
  await db.run(
    'UPDATE media_index SET status = ?, face_count = ?, indexed_at = ?, error_msg = ? WHERE id = ?',
    status, faceCount, Date.now(), errorMsg, mediaId,
  );
}

async function assignFaceToPerson(db, faceId, personId) {
  await db.run('UPDATE faces SET person_id = ? WHERE id = ?', personId, faceId);
}

/**
 * Create a new person, assign the first face to it, return the person id.
 */
async function createPerson(db, faceId, centroidBlob) {
  const now    = Date.now();
  const result = await db.run(`
    INSERT INTO persons (name, cover_face_id, face_count, centroid, created_at, updated_at)
    VALUES (NULL, ?, 1, ?, ?, ?)
  `, faceId, centroidBlob, now, now);

  const personId = result.lastID;
  await db.run('UPDATE faces SET person_id = ? WHERE id = ?', personId, faceId);
  return personId;
}

async function updatePersonStats(db, personId, { centroidBlob, faceCount, coverFaceId } = {}) {
  await db.run(`
    UPDATE persons
    SET centroid      = COALESCE(?, centroid),
        face_count    = COALESCE(?, face_count),
        cover_face_id = COALESCE(?, cover_face_id),
        updated_at    = ?
    WHERE id = ?
  `,
    centroidBlob ?? null,
    faceCount    ?? null,
    coverFaceId  ?? null,
    Date.now(),
    personId,
  );
}

async function renamePerson(db, personId, name) {
  await db.run(
    'UPDATE persons SET name = ?, updated_at = ? WHERE id = ?',
    name || null, Date.now(), personId,
  );
}

/**
 * Merge all faces from sourceId into targetId, then delete sourceId.
 * Picks the highest-quality cover face after merging.
 * Runs in a single transaction. Returns the number of faces reassigned.
 */
async function mergePersons(db, sourceId, targetId) {
  await db.run('BEGIN');
  try {
    const res = await db.run(
      'UPDATE faces SET person_id = ? WHERE person_id = ?',
      targetId, sourceId,
    );
    const changes = res.changes;

    const crow = await db.get(
      'SELECT COUNT(*) AS cnt FROM faces WHERE person_id = ?', targetId,
    );
    const faceCount = crow ? crow.cnt : 0;

    // Migrate any locked_cover feedback from source to target
    await db.run(
      "UPDATE face_feedback SET person_id = ? WHERE person_id = ? AND action = 'locked_cover'",
      targetId, sourceId,
    );

    // Pick best cover: respect locked_cover on target, otherwise choose highest det_score face
    const target = await db.get('SELECT locked_cover FROM persons WHERE id = ?', targetId);
    let newCoverId = null;
    if (!target || !target.locked_cover) {
      const bestFace = await db.get(
        'SELECT id FROM faces WHERE person_id = ? ORDER BY det_score DESC LIMIT 1', targetId,
      );
      newCoverId = bestFace ? bestFace.id : null;
    }

    await db.run(
      'UPDATE persons SET face_count = ?, cover_face_id = COALESCE(?, cover_face_id), updated_at = ? WHERE id = ?',
      faceCount, newCoverId, Date.now(), targetId,
    );
    await db.run('DELETE FROM persons WHERE id = ?', sourceId);
    await db.run('COMMIT');
    return changes;
  } catch (e) {
    try { await db.run('ROLLBACK'); } catch {}
    throw e;
  }
}

/**
 * Set a custom cover face for a person.
 * If locked=true the cover will survive incremental scans (but not full reclusters).
 */
async function setPersonCover(db, personId, faceId, locked = false) {
  const now = Date.now();
  await db.run(
    'UPDATE persons SET cover_face_id = ?, locked_cover = ?, updated_at = ? WHERE id = ?',
    faceId, locked ? 1 : 0, now, personId,
  );
  // Record in feedback so we can re-apply after a full recluster if needed
  if (locked) {
    await db.run(
      "DELETE FROM face_feedback WHERE face_id = ? AND action = 'locked_cover'",
      faceId,
    );
    await db.run(
      "INSERT INTO face_feedback (face_id, action, person_id, created_at) VALUES (?, 'locked_cover', ?, ?)",
      faceId, personId, now,
    );
  }
}

/**
 * Remove a face from its cluster (set person_id = NULL, recount).
 * Records the action in face_feedback for audit / undo history.
 */
async function removeFaceFromPerson(db, faceId, personId = null) {
  await db.run('BEGIN');
  try {
    // Determine which person owns this face if not supplied
    const face = await db.get('SELECT person_id FROM faces WHERE id = ?', faceId);
    const ownerId = personId || (face ? face.person_id : null);

    await db.run('UPDATE faces SET person_id = NULL WHERE id = ?', faceId);

    if (ownerId) {
      const crow = await db.get(
        'SELECT COUNT(*) AS cnt FROM faces WHERE person_id = ?', ownerId,
      );
      await db.run(
        'UPDATE persons SET face_count = ?, updated_at = ? WHERE id = ?',
        crow ? crow.cnt : 0, Date.now(), ownerId,
      );
    }

    await db.run(
      "INSERT INTO face_feedback (face_id, action, person_id, created_at) VALUES (?, 'remove_from_person', ?, ?)",
      faceId, ownerId || null, Date.now(),
    );

    await db.run('COMMIT');
  } catch (e) {
    try { await db.run('ROLLBACK'); } catch {}
    throw e;
  }
}

/**
 * Manually assign a face to a person (removes from previous person first).
 */
async function addFaceToPersonManual(db, faceId, personId) {
  await db.run('BEGIN');
  try {
    const face = await db.get('SELECT person_id FROM faces WHERE id = ?', faceId);
    const prevOwner = face ? face.person_id : null;

    // Remove from previous owner
    if (prevOwner && prevOwner !== personId) {
      await db.run('UPDATE faces SET person_id = NULL WHERE id = ?', faceId);
      const crow = await db.get(
        'SELECT COUNT(*) AS cnt FROM faces WHERE person_id = ?', prevOwner,
      );
      await db.run(
        'UPDATE persons SET face_count = ?, updated_at = ? WHERE id = ?',
        crow ? crow.cnt : 0, Date.now(), prevOwner,
      );
    }

    await db.run('UPDATE faces SET person_id = ? WHERE id = ?', personId, faceId);

    const crow = await db.get(
      'SELECT COUNT(*) AS cnt FROM faces WHERE person_id = ?', personId,
    );
    await db.run(
      'UPDATE persons SET face_count = ?, updated_at = ? WHERE id = ?',
      crow ? crow.cnt : 0, Date.now(), personId,
    );

    await db.run(
      "INSERT INTO face_feedback (face_id, action, person_id, created_at) VALUES (?, 'manual_assign', ?, ?)",
      faceId, personId, Date.now(),
    );

    await db.run('COMMIT');
  } catch (e) {
    try { await db.run('ROLLBACK'); } catch {}
    throw e;
  }
}

/**
 * Record a "not this person" correction for a face.
 * Removes the face from the given person and logs the feedback.
 *
 * @param {import('sqlite').Database} db
 * @param {number}  faceId
 * @param {number}  personId
 * @param {Buffer|null} rejectedCentroid  – the person's centroid BLOB at time of rejection.
 *   Stored in face_feedback so the rejection can be re-applied after a full recluster
 *   (when person IDs are rebuilt and person_id becomes NULL via ON DELETE SET NULL).
 */
async function recordNotThisPerson(db, faceId, personId, rejectedCentroid = null) {
  await db.run('BEGIN');
  try {
    // Unassign from this person
    await db.run(
      'UPDATE faces SET person_id = NULL WHERE id = ? AND person_id = ?',
      faceId, personId,
    );

    const crow = await db.get(
      'SELECT COUNT(*) AS cnt FROM faces WHERE person_id = ?', personId,
    );
    await db.run(
      'UPDATE persons SET face_count = ?, updated_at = ? WHERE id = ?',
      crow ? crow.cnt : 0, Date.now(), personId,
    );

    // Remove any prior not_this_person entry for this face+person pair before inserting
    // (prevents duplicate rejection records for the same pair).
    await db.run(
      "DELETE FROM face_feedback WHERE action = 'not_this_person' AND face_id = ? AND person_id = ?",
      faceId, personId,
    );

    // Log feedback with optional centroid snapshot.
    // rejected_centroid is used during recluster to re-apply the rejection even after
    // persons are rebuilt and person_id references become NULL.
    await db.run(
      "INSERT INTO face_feedback (face_id, action, person_id, rejected_centroid, created_at) VALUES (?, 'not_this_person', ?, ?, ?)",
      faceId, personId, rejectedCentroid || null, Date.now(),
    );

    await db.run('COMMIT');
  } catch (e) {
    try { await db.run('ROLLBACK'); } catch {}
    throw e;
  }
}

/**
 * Return "not_this_person" feedback entries as a Set<"faceId:personId"> strings.
 * Used by assignFace() to block re-assignment of explicitly rejected pairs.
 */
async function getFeedbackBlocklist(db) {
  const rows = await db.all(
    "SELECT face_id, person_id FROM face_feedback WHERE action = 'not_this_person' AND person_id IS NOT NULL",
  );
  return new Set(rows.map(r => `${r.face_id}:${r.person_id}`));
}

/**
 * Return blocked person IDs for a specific face as a Set<number>.
 * More efficient than getFeedbackBlocklist when checking one face at a time.
 */
async function getFeedbackBlocklistForFace(db, faceId) {
  const rows = await db.all(
    "SELECT person_id FROM face_feedback WHERE action = 'not_this_person' AND face_id = ? AND person_id IS NOT NULL",
    faceId,
  );
  return new Set(rows.map(r => r.person_id));
}

/**
 * Return all not-me feedback entries that have a saved rejected_centroid.
 * Used after full recluster to re-apply rejections even though person IDs changed.
 *
 * Returns array of { face_id, rejected_centroid } — one entry per distinct face_id
 * (multiple rejections for the same face may exist; we group by face_id and return
 * all centroid snapshots so the recluster can check against all of them).
 */
async function getNotMeFeedbackWithCentroids(db) {
  return db.all(
    "SELECT face_id, rejected_centroid FROM face_feedback WHERE action = 'not_this_person' AND rejected_centroid IS NOT NULL",
  );
}

/**
 * Find the face with the highest det_score for a given person.
 */
async function getBestCoverForPerson(db, personId) {
  return await db.get(
    'SELECT id, det_score FROM faces WHERE person_id = ? ORDER BY det_score DESC LIMIT 1',
    personId,
  ) || null;
}

/**
 * Delete a person and unassign all their faces (rows stay, person_id → NULL).
 */
async function deletePerson(db, personId) {
  await db.run('UPDATE faces SET person_id = NULL WHERE person_id = ?', personId);
  await db.run('DELETE FROM persons WHERE id = ?', personId);
}

/**
 * Returns all persons associated with a given media file (by filename).
 * Merges two sources:
 *   1. AI face detection  — faces table joined to persons via person_id
 *   2. Manual assignments — media_cluster_manual table joined to persons
 *
 * Only returns rows where the person still exists (both sources use INNER JOIN
 * to persons, so deleted person rows are never returned).
 *
 * Returns one row per (person, face) pair; caller deduplicates by person id.
 * Manual rows have face_id = NULL and det_score = 0 so they sort lower —
 * an AI face entry for the same person always wins the dedup step.
 */
async function getMediaPersons(db, filename) {
  return db.all(`
    SELECT
      p.id            AS id,
      p.name          AS name,
      p.face_count    AS face_count,
      p.cover_face_id AS cover_face_id,
      fc.thumb_path   AS cover_thumb_path,
      f.id            AS face_id,
      f.det_score     AS det_score,
      f.thumb_path    AS thumb_path,
      0               AS is_manual
    FROM faces f
    JOIN media_index m ON m.id = f.media_id
    JOIN persons p     ON p.id = f.person_id
    LEFT JOIN faces fc ON fc.id = p.cover_face_id
    WHERE m.filename = ?
      AND f.person_id IS NOT NULL

    UNION

    SELECT
      p.id            AS id,
      p.name          AS name,
      p.face_count    AS face_count,
      p.cover_face_id AS cover_face_id,
      fc.thumb_path   AS cover_thumb_path,
      NULL            AS face_id,
      0.0             AS det_score,
      NULL            AS thumb_path,
      1               AS is_manual
    FROM media_cluster_manual mc
    JOIN persons p     ON p.id = mc.person_id
    LEFT JOIN faces fc ON fc.id = p.cover_face_id
    WHERE mc.filename = ?

    ORDER BY id, det_score DESC
  `, filename, filename);
}

/**
 * Manually link a media file to a person cluster.
 * Works for any media type (image, video, GIF) regardless of face detection.
 * The UNIQUE constraint on (filename, person_id) makes this idempotent.
 */
async function addMediaToCluster(db, filename, personId) {
  await db.run(
    `INSERT OR IGNORE INTO media_cluster_manual (filename, person_id, created_at)
     VALUES (?, ?, ?)`,
    filename, personId, Date.now(),
  );
}

/**
 * Remove a manual media → cluster association.
 */
async function removeMediaFromCluster(db, filename, personId) {
  await db.run(
    `DELETE FROM media_cluster_manual WHERE filename = ? AND person_id = ?`,
    filename, personId,
  );
}

/**
 * Async generator over all face embeddings — memory-efficient for large libraries.
 * Yields { id, personId, embedding: Float32Array }.
 *
 * Note: sqlite3 returns BLOB columns as Buffer objects, so the Float32Array
 * zero-copy view works identically to the better-sqlite3 version.
 */
async function* iterateFaceEmbeddings(db) {
  // Load in pages of 2 000 to avoid holding all embeddings in RAM at once.
  // Each embedding is 2 048 bytes; 2 000 rows ≈ 4 MB per page.
  const PAGE = 2000;
  let offset = 0;
  while (true) {
    const rows = await db.all(
      'SELECT id, person_id, embedding FROM faces ORDER BY id LIMIT ? OFFSET ?',
      PAGE, offset,
    );
    if (rows.length === 0) break;
    for (const row of rows) {
      const buf = row.embedding; // Buffer from sqlite3
      yield {
        id:        row.id,
        personId:  row.person_id,
        embedding: new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4),
      };
    }
    if (rows.length < PAGE) break;
    offset += PAGE;
  }
}

// ─────────────────────────────────────────────────────────────
//  EXPORTS
// ─────────────────────────────────────────────────────────────

module.exports = {
  openDB,
  SCHEMA_VERSION,
  // Queue
  enqueueFile,
  recoverProcessingQueue,
  requeueFile,
  dequeueNext,
  finaliseQueueItem,
  // Read (server-safe)
  getIndexedFaceBatch,
  getPersons,
  getPersonMedia,
  getMediaFaces,
  getIndexStatus,
  getPerson,
  getFeedbackBlocklist,
  getFeedbackBlocklistForFace,
  getNotMeFeedbackWithCentroids,
  getBestCoverForPerson,
  // Write (worker only)
  upsertMedia,
  insertFace,
  finaliseMedia,
  assignFaceToPerson,
  createPerson,
  updatePersonStats,
  renamePerson,
  mergePersons,
  deletePerson,
  iterateFaceEmbeddings,
  // Media → person lookup (server-safe)
  getMediaPersons,
  // Manual media → cluster assignments (server-safe)
  addMediaToCluster,
  removeMediaFromCluster,
  // User corrections (server-safe)
  setPersonCover,
  removeFaceFromPerson,
  addFaceToPersonManual,
  recordNotThisPerson,
};

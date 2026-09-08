'use strict';

/**
 * face-worker.js  (v2.0 — Python AI service backend)
 * ====================================================
 * Background face-indexing worker — forked from server.js via child_process.fork().
 *
 * ARCHITECTURE CHANGE from v1.x:
 *   Old: ONNX inference ran in this Node.js process (face-infer.js)
 *   New: All detection + embedding delegated to the Python AI microservice
 *        (face_service/main.py) via HTTP on 127.0.0.1:7860
 *
 * This worker is responsible for:
 *   • Waiting for the Python AI service to be ready
 *   • Draining the SQLite scan_queue (concurrency = FACE_WORKER_CONCURRENCY)
 *   • For each file: calling /detect on the Python service
 *   • For video files: extracting frames with FFmpeg, calling /detect per frame
 *   • Deduplicating across video frames (cosine similarity, same as v1.x)
 *   • Saving face rows + aligned thumbnails to disk
 *   • Incremental clustering via assignFace() (cosine centroid, same as v1.x)
 *   • Full recluster via Python /cluster endpoint (HDBSCAN, replaces greedy JS)
 *   • IPC messaging to server.js (unchanged)
 *
 * IPC messages received:
 *   { type: 'init',    ffmpegPath, mediaDir, dbPath, faceThumbs, pythonServiceUrl }
 *   { type: 'enqueue', filename, priority }
 *   { type: 'pause'   }
 *   { type: 'resume'  }
 *   { type: 'cluster' }
 *   { type: 'rescan',  filename }
 *   { type: 'reclassify_face', faceId }
 *   { type: 'get_status' }
 *   { type: 'shutdown' }
 *
 * IPC messages sent:
 *   { type: 'ready',    state }
 *   { type: 'status',   state, queued, processing, done, total, personCount, faceCount }
 *   { type: 'progress', filename, faces, personIds }
 *   { type: 'error',    filename, message }
 *   { type: 'cluster_done', persons, facesAssigned }
 *   { type: 'reclassify_done', faceId, personId }
 */

const path    = require('path');
const fs      = require('fs');
const http    = require('http');
const https   = require('https');
const { spawn } = require('child_process');

const { FaceLogger }       = require('./face-logger');
const dbModule             = require('./face-db');
const { assignFace, fullReclusterPython, invalidateCentroidCache, blobToF32, f32ToBlob, cosineSim, withWriteLock } =
  require('./face-cluster');

const log = new FaceLogger('WORKER');

// ─────────────────────────────────────────────────────────────
//  STATE
// ─────────────────────────────────────────────────────────────

const STATES = {
  INITIALIZING:   'initializing',
  SERVICE_WAIT:   'service_wait',     // waiting for Python service
  IDLE:           'idle',
  RUNNING:        'running',
  PAUSED:         'paused',
  SHUTTING_DOWN:  'shutting_down',
};

let state         = STATES.INITIALIZING;
let db            = null;
let ffmpegPath    = null;
let mediaDir      = null;
let faceThumbsDir = null;
let dbPath        = null;   // stored for /cluster requests
let activeJobs    = 0;
let draining      = false;
const CONCURRENCY = parseInt(process.env.FACE_WORKER_CONCURRENCY) || 2;

/** URL of the Python AI microservice. Overridden by init message. */
let PYTHON_URL = process.env.FACE_SERVICE_URL || 'http://127.0.0.1:7860';

// ─────────────────────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));

function send(msg) {
  if (process.send) process.send(msg);
}

function setState(s) {
  state = s;
  log.info('State', { state: s });
}

function faceThumbPath(faceId) {
  return path.join(faceThumbsDir, `${faceId}.jpg`);
}

function faceThumbRelPath(faceId) {
  return `${faceId}.jpg`;
}

// ─────────────────────────────────────────────────────────────
//  HTTP CLIENT  (built-in http/https — no npm deps needed)
// ─────────────────────────────────────────────────────────────

/**
 * POST JSON to a URL.  Returns parsed response body.
 * @param {string}  url
 * @param {object}  body
 * @param {number}  [timeoutMs=120000]
 * @returns {Promise<object>}
 */
function httpPost(url, body, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const data   = JSON.stringify(body);
    let   parsed;
    try { parsed = new URL(url); } catch (e) { return reject(new Error(`Bad URL: ${url}`)); }

    const lib  = parsed.protocol === 'https:' ? https : http;
    const opts = {
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    };

    const req = lib.request(opts, res => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(raw);
          if (res.statusCode >= 400) {
            return reject(new Error(`HTTP ${res.statusCode}: ${parsed.detail || parsed.error || raw.slice(0, 200)}`));
          }
          resolve(parsed);
        } catch (e) {
          reject(new Error(`JSON parse error (status ${res.statusCode}): ${raw.slice(0, 200)}`));
        }
      });
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Request to ${url} timed out after ${timeoutMs}ms`));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

/**
 * GET a URL, return parsed body.
 */
function httpGet(url, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    let   parsed;
    try { parsed = new URL(url); } catch (e) { return reject(new Error(`Bad URL: ${url}`)); }
    const lib = parsed.protocol === 'https:' ? https : http;

    const req = lib.get(url, res => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch (e) { reject(new Error(`JSON parse error: ${raw.slice(0, 200)}`)); }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('GET timeout')));
    req.on('error', reject);
  });
}

// ─────────────────────────────────────────────────────────────
//  PYTHON SERVICE COMMUNICATION
// ─────────────────────────────────────────────────────────────

/**
 * Detect faces in an image file on disk.
 * Sends the absolute path to the Python service so it reads the file directly —
 * much more efficient than base64-encoding large images over HTTP.
 *
 * @param {string} filePath  Absolute path to image file
 * @returns {Promise<Array>} Array of face objects
 */
async function detectFacesInFile(filePath) {
  const resp = await httpPost(
    `${PYTHON_URL}/detect`,
    { path: filePath },
    60000, // 60s per image
  );
  return parsePythonFaces(resp.faces || []);
}

/**
 * Detect faces in an in-memory JPEG buffer (used for video frame extraction).
 * The buffer is base64-encoded and sent to the Python service.
 *
 * @param {Buffer} buffer  JPEG image buffer
 * @returns {Promise<Array>} Array of face objects
 */
async function detectFacesInBuffer(buffer) {
  const b64  = buffer.toString('base64');
  const resp = await httpPost(
    `${PYTHON_URL}/detect`,
    { image_b64: b64 },
    60000,
  );
  return parsePythonFaces(resp.faces || []);
}

/**
 * Convert Python service face objects into the format expected by this worker.
 *
 * Field mapping:
 *   Python                  → Worker
 *   bbox                    → bbox          [x1,y1,x2,y2]
 *   bbox_norm               → bboxNorm      [x,y,w,h] 0-1
 *   score                   → score         float
 *   embedding               → embedding     Float32Array(512) L2-normalised
 *   aligned_thumb_b64       → alignedThumbB64  base64 JPEG string
 *   kps                     → kps           [[x,y]×5]
 *   orig_w, orig_h          → origW, origH  int
 */
function parsePythonFaces(pyFaces) {
  if (!Array.isArray(pyFaces)) return [];
  return pyFaces.map(f => ({
    bbox:            f.bbox,
    bboxNorm:        f.bbox_norm,
    kps:             f.kps,
    score:           f.score,
    embedding:       new Float32Array(f.embedding),   // Float32Array for cosineSim()
    alignedThumbB64: f.aligned_thumb_b64 || null,     // base64 JPEG — used by makeFaceThumb
    origW:           f.orig_w,
    origH:           f.orig_h,
  }));
}

/**
 * Wait until the Python AI service /health endpoint reports ready:true.
 * Retries every 3 seconds up to maxRetries times, then throws.
 * This prevents the worker from trying to process files before the service is up.
 */
async function waitForPythonService(maxRetries = 40) {
  setState(STATES.SERVICE_WAIT);
  log.info('Waiting for Python AI service', { url: PYTHON_URL });

  for (let i = 0; i < maxRetries; i++) {
    try {
      const resp = await httpGet(`${PYTHON_URL}/health`, 5000);
      if (resp && resp.ready === true) {
        log.info('Python AI service ready', { url: PYTHON_URL, model: resp.model });
        return;
      }
      log.info('Python service: models still loading', { attempt: i + 1, ready: resp && resp.ready });
    } catch (err) {
      if (i === 0) {
        log.info('Python service not yet responding — waiting …', { url: PYTHON_URL });
      }
      // Connection refused or timeout — service not started yet
    }
    await sleep(3000);
  }

  throw new Error(
    `Python AI service at ${PYTHON_URL} did not become ready after ${maxRetries * 3}s. ` +
    'Please start face_service/start.bat first.'
  );
}

// ─────────────────────────────────────────────────────────────
//  THUMBNAIL GENERATION
// ─────────────────────────────────────────────────────────────

/**
 * Generate a face thumbnail buffer for storage on disk.
 *
 * Primary path (v2.0):
 *   The Python service returns an aligned_thumb_b64 field — a base64-encoded
 *   128×128 JPEG of the properly aligned face chip.  InsightFace's norm_crop
 *   handles the 5-point similarity transform correctly, so we can use this
 *   directly.  No body parts, no background clutter.
 *
 * Fallback path:
 *   If the Python service didn't return a thumbnail (shouldn't happen), fall
 *   back to a bbox crop with padding, the same as pre-v2.0.
 *
 * @param {object} face           Face object from parsePythonFaces()
 * @param {string} origFilePath   Original image path (used for bbox fallback)
 * @param {number} [thumbSize=128]
 * @returns {Promise<Buffer>}  JPEG buffer
 */
async function makeFaceThumb(face, origFilePath, thumbSize = 128) {
  // ── Preferred: aligned chip from Python ─────────────────────────────────
  if (face.alignedThumbB64) {
    const buf = Buffer.from(face.alignedThumbB64, 'base64');
    // Python already produces 128×128 JPEG; only re-encode if different size needed
    if (thumbSize === 128) return buf;
    const sharp = require('sharp');
    return sharp(buf)
      .resize(thumbSize, thumbSize, { fit: 'fill', kernel: 'lanczos3' })
      .jpeg({ quality: 90 })
      .toBuffer();
  }

  // ── Fallback: bbox-crop (should not normally be reached) ─────────────────
  log.debug('makeFaceThumb: no aligned thumb from Python — falling back to bbox crop');
  const [x1, y1, x2, y2] = face.bbox || [0, 0, 1, 1];
  const fw = x2 - x1;
  const fh = y2 - y1;
  const margin = Math.max(fw, fh) * 0.25;

  const left   = Math.max(0, Math.round(x1 - margin));
  const top    = Math.max(0, Math.round(y1 - margin));
  const right  = Math.round(x2 + margin);
  const bottom = Math.round(y2 + margin);
  const width  = right - left;
  const height = bottom - top;

  if (width <= 0 || height <= 0 || !origFilePath) {
    // Last resort: blank grey square
    const sharp = require('sharp');
    return sharp({ create: { width: thumbSize, height: thumbSize, channels: 3, background: { r: 180, g: 180, b: 180 } } })
      .jpeg({ quality: 80 })
      .toBuffer();
  }

  const sharp = require('sharp');
  return sharp(origFilePath)
    .rotate()
    .extract({ left, top, width, height })
    .resize(thumbSize, thumbSize, { fit: 'cover', position: 'centre' })
    .jpeg({ quality: 88 })
    .toBuffer();
}

// ─────────────────────────────────────────────────────────────
//  VIDEO FRAME SAMPLING
// ─────────────────────────────────────────────────────────────

/**
 * Compute sample timestamps for a video — same adaptive strategy as v1.x.
 * Designed to capture representative frames without over-sampling.
 */
function videoSampleTimes(durationSec) {
  const times = new Set();
  times.add(0.5);
  if (durationSec > 3) times.add(durationSec - 1.5);

  let interval, maxFrames;
  if      (durationSec < 5)    { interval = 1;  maxFrames = 5;  }
  else if (durationSec < 30)   { interval = 3;  maxFrames = 10; }
  else if (durationSec < 120)  { interval = 10; maxFrames = 12; }
  else if (durationSec < 600)  { interval = 30; maxFrames = 20; }
  else                          { interval = 60; maxFrames = 30; }

  for (let t = interval; t < durationSec - 1; t += interval) {
    times.add(Math.round(t * 10) / 10);
    if (times.size >= maxFrames) break;
  }
  return Array.from(times).sort((a, b) => a - b);
}

// ─────────────────────────────────────────────────────────────
//  FFMPEG HELPERS  (unchanged from v1.x)
// ─────────────────────────────────────────────────────────────

function probeVideo(filePath) {
  return new Promise(resolve => {
    if (!ffmpegPath) return resolve(null);

    const ffprobe    = ffmpegPath.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1');
    const useFfprobe = fs.existsSync(ffprobe);
    const args       = useFfprobe
      ? ['-v', 'quiet', '-print_format', 'json', '-show_streams', '-select_streams', 'v:0', filePath]
      : ['-i', filePath];
    const bin = useFfprobe ? ffprobe : ffmpegPath;

    let stderr = '', stdout = '';
    const proc = spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    proc.stdout.on('data', d => { stdout += d; });
    proc.stderr.on('data', d => { stderr += d; });

    const timer = setTimeout(() => { try { proc.kill(); } catch {} resolve(null); }, 10000);
    proc.on('close', () => {
      clearTimeout(timer);
      try {
        if (useFfprobe) {
          const info = JSON.parse(stdout);
          const s    = info.streams && info.streams[0];
          if (!s) return resolve(null);
          resolve({ durationSec: parseFloat(s.duration) || 0, width: s.width || 0, height: s.height || 0 });
        } else {
          const dur = stderr.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
          const dim = stderr.match(/(\d{2,5})x(\d{2,5})/);
          if (!dur) return resolve(null);
          const secs = parseInt(dur[1]) * 3600 + parseInt(dur[2]) * 60 + parseFloat(dur[3]);
          resolve({ durationSec: secs, width: dim ? parseInt(dim[1]) : 0, height: dim ? parseInt(dim[2]) : 0 });
        }
      } catch { resolve(null); }
    });
    proc.on('error', () => { clearTimeout(timer); resolve(null); });
  });
}

function extractVideoFrame(filePath, timeSec) {
  return new Promise(resolve => {
    if (!ffmpegPath) return resolve(null);

    const args = [
      '-y', '-ss', String(timeSec), '-i', filePath,
      '-frames:v', '1', '-vf', 'scale=iw:ih',
      '-f', 'image2', '-vcodec', 'mjpeg', '-q:v', '2', 'pipe:1',
    ];

    let buf = Buffer.alloc(0);
    const proc = spawn(ffmpegPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    proc.stdout.on('data', chunk => { buf = Buffer.concat([buf, chunk]); });

    const timer = setTimeout(() => { try { proc.kill(); } catch {} resolve(null); }, 30000);
    proc.on('close', () => { clearTimeout(timer); resolve(buf.length > 500 ? buf : null); });
    proc.on('error', () => { clearTimeout(timer); resolve(null); });
  });
}

// ─────────────────────────────────────────────────────────────
//  FACE DEDUPLICATION ACROSS VIDEO FRAMES  (unchanged from v1.x)
// ─────────────────────────────────────────────────────────────

/**
 * From all faces detected across multiple video frames, retain only one
 * representative entry per unique identity — the highest-scoring detection.
 *
 * Uses the same cosine similarity comparison as v1.x, but benefits from
 * much better InsightFace embeddings, so this dedup is more accurate.
 *
 * @param {Array<{face, frameMs}>} allFaces
 * @param {number} simThresh  cosine threshold for "same person" (default 0.68)
 */
function deduplicateVideoFaces(allFaces, simThresh = 0.68) {
  const reps = [];
  for (const item of allFaces) {
    let bestMatchIdx = -1, bestSim = simThresh;
    for (let ri = 0; ri < reps.length; ri++) {
      const sim = cosineSim(item.face.embedding, reps[ri].face.embedding);
      if (sim > bestSim) { bestSim = sim; bestMatchIdx = ri; }
    }
    if (bestMatchIdx >= 0) {
      const rep = reps[bestMatchIdx];
      if (item.face.score > rep.face.score) { rep.face = item.face; rep.frameMs = item.frameMs; }
    } else {
      reps.push({ face: item.face, frameMs: item.frameMs });
    }
  }
  return reps;
}

// ─────────────────────────────────────────────────────────────
//  CORE FACE SAVE + CLUSTERING
// ─────────────────────────────────────────────────────────────

/**
 * Persist a face detection to the database:
 *   1. Generate aligned thumbnail → write to disk
 *   2. Insert face row
 *   3. Update face row with thumb path
 *   4. Run incremental cluster assignment (cosine centroid matching)
 *
 * @returns {{ faceId, personId }}
 */
async function saveFace(mediaId, face, frameMs, origFilePath) {
  let faceId = null;
  try {
    // ── 1. Generate thumbnail ─────────────────────────────────────────────
    const thumbBuf = await makeFaceThumb(face, origFilePath);
    const tmpId    = `tmp_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const tmpPath  = path.join(faceThumbsDir, tmpId + '.jpg');
    fs.writeFileSync(tmpPath, thumbBuf);

    // ── 2. Insert face row (gets auto-assigned ID) ─────────────────────────
    faceId = await dbModule.insertFace(db, {
      mediaId,
      frameMs,
      detScore:  face.score,
      bboxX:     face.bboxNorm[0],
      bboxY:     face.bboxNorm[1],
      bboxW:     face.bboxNorm[2],
      bboxH:     face.bboxNorm[3],
      embedding: f32ToBlob(face.embedding),
      keypoints: face.kps,
      thumbPath: null,
    });

    // ── 3. Rename tmp thumb to final path (face ID now known) ─────────────
    const finalThumbPath = faceThumbPath(faceId);
    fs.renameSync(tmpPath, finalThumbPath);
    await db.run('UPDATE faces SET thumb_path = ? WHERE id = ?', faceThumbRelPath(faceId), faceId);

    // ── 4. Incremental cluster assignment ─────────────────────────────────
    // The face row is already durable at this point.  If the in-memory
    // centroid cache is stale because another process changed the persons
    // table, refresh it and retry once before giving up.  Previously the
    // assignment error was swallowed here, causing the media row to be marked
    // "done" while the face silently remained unassigned.
    let personId;
    try {
      personId = await assignFace(db, faceId, face.embedding);
    } catch (firstErr) {
      invalidateCentroidCache();
      log.warn('Incremental assignment failed — refreshing centroid cache and retrying', {
        mediaId, frameMs, faceId, error: firstErr.message,
      });
      try {
        personId = await assignFace(db, faceId, face.embedding);
      } catch (secondErr) {
        // Last-resort product guarantee: a successfully detected/stored face
        // must never disappear merely because incremental centroid matching
        // failed. Create a singleton person so the face remains visible in
        // People; a later full recluster can merge it into the correct cluster.
        invalidateCentroidCache();
        log.error('Incremental assignment retry failed — creating singleton person', {
          mediaId, frameMs, faceId, error: secondErr.message,
        });
        personId = await dbModule.createPerson(db, faceId, f32ToBlob(face.embedding));
      }
    }

    return { faceId, personId };
  } catch (err) {
    log.error('saveFace error', { mediaId, frameMs, faceId, error: err.message });
    // Preserve the durable face row if insertion already succeeded. The caller
    // counts actual rows rather than trusting the detector count.
    return { faceId, personId: null };
  }
}

/**
 * Repair faces that were successfully indexed but are still unassigned.
 * This is deliberately separate from detection: assignment can be retried
 * without re-running InsightFace/FFmpeg. `not_this_person` feedback is treated
 * as an explicit user choice and is therefore excluded.
 */
async function repairUnassignedFaces(mediaId = null) {
  const params = [];
  let sql = `SELECT f.id, f.embedding
             FROM faces f
             WHERE f.person_id IS NULL AND f.embedding IS NOT NULL
               AND NOT EXISTS (
                 SELECT 1 FROM face_feedback ff
                 WHERE ff.face_id = f.id AND ff.action = 'not_this_person'
               )`;
  if (mediaId != null) {
    sql += ' AND f.media_id = ?';
    params.push(mediaId);
  }
  sql += ' ORDER BY f.id ASC';

  const rows = await db.all(sql, ...params);
  let repaired = 0;
  for (const row of rows) {
    try {
      const personId = await assignFace(db, row.id, blobToF32(row.embedding));
      if (personId != null) repaired++;
    } catch (firstErr) {
      invalidateCentroidCache();
      try {
        const personId = await assignFace(db, row.id, blobToF32(row.embedding));
        if (personId != null) repaired++;
      } catch (secondErr) {
        log.error('Unable to repair unassigned face', { faceId: row.id, error: secondErr.message });
      }
    }
  }
  if (repaired) log.info('Repaired unassigned faces', { mediaId, repaired, candidates: rows.length });
  return repaired;
}

async function clearExistingFaces(mediaId) {
  const existing = await db.get('SELECT COUNT(*) AS cnt FROM faces WHERE media_id = ?', mediaId);
  if (!existing || existing.cnt === 0) return;

  const affected = await db.all(
    'SELECT DISTINCT person_id FROM faces WHERE media_id = ? AND person_id IS NOT NULL',
    mediaId,
  );
  await db.run('DELETE FROM faces WHERE media_id = ?', mediaId);

  for (const row of affected) {
    const personId = row.person_id;
    const faces = await db.all(
      'SELECT id, embedding, det_score FROM faces WHERE person_id = ? ORDER BY det_score DESC',
      personId,
    );
    if (faces.length === 0) {
      await db.run(
        'UPDATE persons SET face_count = 0, centroid = NULL, cover_face_id = NULL, updated_at = ? WHERE id = ?',
        Date.now(), personId,
      );
      continue;
    }

    const dim = blobToF32(faces[0].embedding).length;
    const centroid = new Float32Array(dim);
    for (const face of faces) {
      const emb = blobToF32(face.embedding);
      for (let i = 0; i < dim; i++) centroid[i] += emb[i];
    }
    for (let i = 0; i < dim; i++) centroid[i] /= faces.length;

    await db.run(
      'UPDATE persons SET face_count = ?, centroid = ?, cover_face_id = ?, updated_at = ? WHERE id = ?',
      faces.length, f32ToBlob(centroid), faces[0].id, Date.now(), personId,
    );
  }

  invalidateCentroidCache();
}

// ─────────────────────────────────────────────────────────────
//  MEDIA PROCESSING
// ─────────────────────────────────────────────────────────────

async function processImage(filename) {
  const filePath = path.join(mediaDir, filename);
  const stat     = fs.statSync(filePath);
  const sharp    = require('sharp');
  const meta     = await sharp(filePath).rotate().metadata();

  const mediaId  = await dbModule.upsertMedia(db, {
    filename, mtime: stat.mtimeMs, size: stat.size,
    mediaType: 'image', width: meta.width, height: meta.height, durationMs: null,
  });
  await clearExistingFaces(mediaId);

  const t     = log.timer('detectFaces');
  const faces = await detectFacesInFile(filePath);
  t.end({ file: filename, faces: faces.length });

  const personIds = [];
  let savedFaces = 0;
  for (const face of faces) {
    const { faceId, personId } = await saveFace(mediaId, face, 0, filePath);
    if (faceId != null) savedFaces++;
    if (personId != null) personIds.push(personId);
  }
  await repairUnassignedFaces(mediaId);

  await dbModule.finaliseMedia(db, mediaId, savedFaces, 'done');
  return { faces: savedFaces, personIds };
}

async function processVideo(filename) {
  const filePath = path.join(mediaDir, filename);
  const stat     = fs.statSync(filePath);
  const probe    = await probeVideo(filePath);
  const dur      = probe ? probe.durationSec : 0;

  const mediaId = await dbModule.upsertMedia(db, {
    filename, mtime: stat.mtimeMs, size: stat.size,
    mediaType: 'video',
    width:  probe ? probe.width  : null,
    height: probe ? probe.height : null,
    durationMs: Math.round(dur * 1000),
  });
  await clearExistingFaces(mediaId);

  if (!ffmpegPath) {
    log.warn('FFmpeg unavailable — skipping video', { filename });
    await dbModule.finaliseMedia(db, mediaId, 0, 'error', 'ffmpeg_not_found');
    return { faces: 0, personIds: [] };
  }

  const sampleTimes = videoSampleTimes(dur);
  log.info('Video frame plan', { filename, dur: dur.toFixed(1), frames: sampleTimes.length });

  const allFaces = [];
  for (const timeSec of sampleTimes) {
    const frameMs  = Math.round(timeSec * 1000);
    const frameBuf = await extractVideoFrame(filePath, timeSec);
    if (!frameBuf) continue;
    try {
      const faces = await detectFacesInBuffer(frameBuf);
      for (const face of faces) allFaces.push({ face, frameMs });
    } catch (err) {
      log.warn('Frame detection error', { filename, timeSec, error: err.message });
    }
  }

  const unique = deduplicateVideoFaces(allFaces);
  log.info('Video faces', { filename, raw: allFaces.length, unique: unique.length });

  const personIds = [];
  let savedFaces = 0;
  for (const { face, frameMs } of unique) {
    const { faceId, personId } = await saveFace(mediaId, face, frameMs, filePath);
    if (faceId != null) savedFaces++;
    if (personId != null) personIds.push(personId);
  }
  await repairUnassignedFaces(mediaId);

  await dbModule.finaliseMedia(db, mediaId, savedFaces, 'done');
  return { faces: savedFaces, personIds };
}

async function processGif(filename) {
  const filePath = path.join(mediaDir, filename);
  const stat     = fs.statSync(filePath);
  const sharp    = require('sharp');

  const meta        = await sharp(filePath, { animated: false }).metadata();
  const totalFrames = meta.pages || 1;
  const width       = meta.width  || 0;
  const height      = meta.pageHeight || meta.height || 0;

  const mediaId = await dbModule.upsertMedia(db, {
    filename, mtime: stat.mtimeMs, size: stat.size,
    mediaType: 'gif', width, height, durationMs: null,
  });
  await clearExistingFaces(mediaId);

  const MAX_GIF_FRAMES = 10;
  const step           = Math.max(1, Math.floor(totalFrames / MAX_GIF_FRAMES));
  const frameIndices   = [];
  for (let i = 0; i < totalFrames; i += step) {
    frameIndices.push(i);
    if (frameIndices.length >= MAX_GIF_FRAMES) break;
  }

  log.info('GIF frame plan', { filename, totalFrames, sampling: frameIndices.length });
  const allFaces = [];

  for (const pageIdx of frameIndices) {
    let frameBuf;
    try {
      frameBuf = await sharp(filePath, { page: pageIdx }).jpeg({ quality: 90 }).toBuffer();
    } catch (err) {
      log.debug('GIF frame extract fail', { filename, page: pageIdx, error: err.message });
      continue;
    }
    try {
      const faces = await detectFacesInBuffer(frameBuf);
      for (const face of faces) allFaces.push({ face, frameMs: pageIdx });
    } catch (err) {
      log.warn('GIF frame detection error', { filename, page: pageIdx, error: err.message });
    }
  }

  const unique = deduplicateVideoFaces(allFaces);
  log.info('GIF faces', { filename, raw: allFaces.length, unique: unique.length });

  const personIds = [];
  let savedFaces = 0;
  for (const { face, frameMs } of unique) {
    const { faceId, personId } = await saveFace(mediaId, face, frameMs, filePath);
    if (faceId != null) savedFaces++;
    if (personId != null) personIds.push(personId);
  }
  await repairUnassignedFaces(mediaId);

  await dbModule.finaliseMedia(db, mediaId, savedFaces, 'done');
  return { faces: savedFaces, personIds };
}

// ─────────────────────────────────────────────────────────────
//  CHANGE DETECTION  (unchanged from v1.x)
// ─────────────────────────────────────────────────────────────

async function fileHasChanged(filename) {
  const row = await db.get(
    'SELECT file_mtime, file_size FROM media_index WHERE filename = ?', filename
  );
  if (!row) return true;
  try {
    const stat = fs.statSync(path.join(mediaDir, filename));
    return stat.mtimeMs !== row.file_mtime || stat.size !== row.file_size;
  } catch { return true; }
}

// ─────────────────────────────────────────────────────────────
//  QUEUE DRAIN LOOP  (unchanged from v1.x)
// ─────────────────────────────────────────────────────────────

async function processQueueItem(item) {
  const { filename } = item;
  const filePath     = path.join(mediaDir, filename);

  if (!fs.existsSync(filePath)) {
    log.warn('File gone — skipping', { filename });
    await dbModule.finaliseQueueItem(db, item.id, 'error', 'file_not_found');
    return;
  }

  const ext  = path.extname(filename).toLowerCase();
  const type = (['.mp4', '.webm', '.mov', '.avi', '.mkv', '.m4v', '.flv', '.wmv', '.3gp', '.ogg'].includes(ext))
    ? 'video'
    : (ext === '.gif' ? 'gif' : 'image');

  const t = log.timer(`Process ${type}`);
  let result = { faces: 0, personIds: [] };

  try {
    if      (type === 'video') result = await processVideo(filename);
    else if (type === 'gif')   result = await processGif(filename);
    else                       result = await processImage(filename);

    await dbModule.finaliseQueueItem(db, item.id, 'done');
    t.end({ file: filename, faces: result.faces });

    send({
      type:      'progress',
      filename,
      faces:     result.faces,
      personIds: [...new Set(result.personIds)],
    });

    log.event('INDEXED', filename, { faces: result.faces, type });
  } catch (err) {
    log.error('Processing failed', { filename, error: err.message });
    const mediaRow = await db.get('SELECT id FROM media_index WHERE filename = ?', filename);
    await dbModule.finaliseMedia(db, mediaRow ? mediaRow.id : 0, 0, 'error', err.message);
    await dbModule.finaliseQueueItem(db, item.id, 'error', err.message);
    send({ type: 'error', filename, message: err.message });
    t.end({ file: filename, error: err.message });
  }
}

async function drain() {
  if (draining) return;
  if (state === STATES.PAUSED || state === STATES.SHUTTING_DOWN) return;
  if (state !== STATES.RUNNING) return;

  draining = true;
  try {
    while (state === STATES.RUNNING && activeJobs < CONCURRENCY) {
      const item = await withWriteLock(() => dbModule.dequeueNext(db));
      if (!item) break;

      activeJobs++;
      processQueueItem(item).finally(() => {
        activeJobs--;
        drain().catch(e => log.error('drain error', { error: e.message }));
      });
    }
  } finally {
    draining = false;
  }
}

/**
 * Wait until the persistent scan queue has no queued/processing rows.
 * drain() deliberately returns after dispatching work, so callers that need
 * a reliable "scan finished" boundary must wait for the DB state as well.
 */
async function waitForQueueIdle(timeoutMs = 15 * 60 * 1000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const row = await db.get(`
      SELECT
        SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued,
        SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) AS processing
      FROM scan_queue
    `);
    const queued = Number(row?.queued || 0);
    const processing = Number(row?.processing || 0);
    if (queued === 0 && processing === 0 && activeJobs === 0) return true;

    if (state !== STATES.RUNNING) return false;
    drain().catch(e => log.error('waitForQueueIdle drain error', { error: e.message }));
    await sleep(250);
  }
  return false;
}

let scanInProgress = false;

/**
 * Explicit user scan:
 *   1. Reconcile the actual media directory (including files added outside
 *      the upload endpoint).
 *   2. Run the normal worker queue.
 *   3. Once all indexing work is finished, perform one HDBSCAN recluster.
 *
 * The recluster is intentionally at the end of the explicit Scan operation.
 * That gives newly-created face rows a deterministic clustering pass even if
 * incremental assignment was unable to attach one of them.
 */
async function handleScan() {
  if (scanInProgress) {
    log.info('Scan request ignored — a scan is already in progress');
    return;
  }
  if (!db || state === STATES.INITIALIZING || state === STATES.SERVICE_WAIT ||
      state === STATES.SHUTTING_DOWN) {
    log.warn('Scan request ignored — worker is not ready', { state });
    return;
  }

  scanInProgress = true;
  try {
    const existingFilenames = await reconcileMediaDirectory();
    if (!existingFilenames) {
      log.error('Explicit scan aborted — media directory could not be reconciled');
      return;
    }

    // A paused worker is explicitly resumed by the Scan command.  RUNNING is
    // already the normal state; setting it again is harmless and guarantees
    // that a paused worker can consume the newly reconciled queue.
    if (state === STATES.PAUSED) {
      setState(STATES.RUNNING);
      await db.run("INSERT OR REPLACE INTO index_meta (key, value) VALUES ('worker_state', 'running')");
    }

    drain().catch(e => log.error('Scan drain error', { error: e.message }));
    const idle = await waitForQueueIdle();
    if (!idle) {
      log.warn('Scan did not reach a clean queue-idle boundary', { state, activeJobs });
      return;
    }

    if (state === STATES.RUNNING) {
      await handleCluster();
    }
  } catch (err) {
    log.error('Explicit scan failed', { error: err.message, stack: err.stack });
  } finally {
    scanInProgress = false;
  }
}

setInterval(() => {
  if (state === STATES.RUNNING && activeJobs < CONCURRENCY) {
    drain().catch(e => log.error('poll drain error', { error: e.message }));
  }
}, 2000).unref();

// ─────────────────────────────────────────────────────────────
//  STARTUP RECONCILIATION  (unchanged from v1.x)
// ─────────────────────────────────────────────────────────────

async function reconcileMediaDirectory() {
  const t = log.timer('Reconcile media dir');
  let newCount = 0, changedCount = 0, deletedCount = 0;
  const ALL_RE = /\.(jpg|jpeg|png|gif|webp|bmp|tiff|tif|avif|heic|jfif|mp4|webm|ogg|mov|avi|mkv|m4v|flv|wmv|3gp|svg)$/i;

  const recovered = await dbModule.recoverProcessingQueue(db);
  if (recovered && recovered.changes) {
    log.info('Recovered stale processing queue rows', { count: recovered.changes });
  }

  let files;
  try {
    files = fs.readdirSync(mediaDir).filter(f => !f.startsWith('.') && !f.startsWith('_') && ALL_RE.test(f));
  } catch (err) {
    log.error('Cannot read media dir', { error: err.message });
    return;
  }

  const indexedRows = await db.all("SELECT filename FROM media_index WHERE status='done'");
  const indexedSet  = new Set(indexedRows.map(r => r.filename));

  for (const filename of files) {
    const changed = !indexedSet.has(filename) || await fileHasChanged(filename);
    if (changed) {
      await dbModule.enqueueFile(db, filename, 0);
      if (indexedSet.has(filename)) changedCount++; else newCount++;
    }
  }

  const fileSet    = new Set(files);
  const allIndexed = await db.all('SELECT filename FROM media_index');
  for (const row of allIndexed) {
    if (!fileSet.has(row.filename)) {
      await db.run('DELETE FROM media_index WHERE filename = ?', row.filename);
      deletedCount++;
    }
  }

  t.end({ new: newCount, changed: changedCount, deleted: deletedCount });
  log.info('Reconcile complete', { new: newCount, changed: changedCount });
  return fileSet;
}

// ─────────────────────────────────────────────────────────────
//  IPC MESSAGE HANDLERS
// ─────────────────────────────────────────────────────────────

async function handleInit(msg) {
  ffmpegPath    = msg.ffmpegPath || null;
  mediaDir      = msg.mediaDir;
  faceThumbsDir = msg.faceThumbs;
  dbPath        = msg.dbPath;

  if (msg.pythonServiceUrl) {
    PYTHON_URL = msg.pythonServiceUrl;
    log.info('Python service URL', { url: PYTHON_URL });
  }

  if (!fs.existsSync(faceThumbsDir)) {
    fs.mkdirSync(faceThumbsDir, { recursive: true });
  }

  db = await dbModule.openDB(msg.dbPath, { busyTimeout: 10000 });
  log.info('Worker initialised', { ffmpeg: ffmpegPath || 'NOT FOUND', mediaDir, db: msg.dbPath });

  // Wait for Python AI service (retries for up to 2 minutes)
  try {
    await waitForPythonService(40);
  } catch (err) {
    log.error('Python AI service unavailable', { error: err.message });
    send({ type: 'ready', state: 'models_missing' });
    // Retry every 30s in case service starts later
    const retry = setInterval(async () => {
      try {
        const resp = await httpGet(`${PYTHON_URL}/health`, 5000);
        if (resp && resp.ready) {
          clearInterval(retry);
          await startup();
        }
      } catch {}
    }, 30000);
    return;
  }

  await startup();
}

async function startup() {
  const existingFilenames = await reconcileMediaDirectory();
  // One-time repair of known-invalid persons/faces states (stale face_count,
  // stale cover_face_id, empty persons) — idempotent, safe to run every
  // startup. Runs before setState(RUNNING)/drain(), so nothing else is
  // writing on this connection yet — no write-lock needed for this call.
  // See face-db.js reconcilePersonsAndFaces() for exactly what it checks.
  try {
    const result = await dbModule.reconcilePersonsAndFaces(db, existingFilenames);
    log.info('Startup reconciliation complete', result);
  } catch (e) {
    log.error('Startup reconciliation failed (non-fatal)', { error: e.message });
  }
  setState(STATES.RUNNING);
  send({ type: 'ready', state: STATES.RUNNING });
  drain().catch(e => log.error('Initial drain error', { error: e.message }));
}

async function handleEnqueue(msg) {
  await dbModule.enqueueFile(db, msg.filename, msg.priority || 1);
  if (state === STATES.RUNNING) {
    drain().catch(e => log.error('Enqueue drain error', { error: e.message }));
  }
}

async function handlePause() {
  if (state !== STATES.RUNNING) return;
  setState(STATES.PAUSED);
  await db.run("INSERT OR REPLACE INTO index_meta (key, value) VALUES ('worker_state', 'paused')");
  log.info('Paused by user request');
}

async function handleResume() {
  if (state === STATES.PAUSED) {
    setState(STATES.RUNNING);
    await db.run("INSERT OR REPLACE INTO index_meta (key, value) VALUES ('worker_state', 'running')");
    log.info('Resumed');
  }

  // The server's existing /api/faces/scan/start control message is `resume`.
  // A scan must reconcile the filesystem even when the worker is already
  // running; the old early-return made the button a no-op in that normal case.
  if (state === STATES.RUNNING) {
    handleScan().catch(e => log.error('Resume/scan error', { error: e.message }));
  }
}

async function handleRescan(msg) {
  await dbModule.requeueFile(db, msg.filename, 2);
  if (state === STATES.RUNNING) {
    drain().catch(e => log.error('Rescan drain error', { error: e.message }));
  }
}

/**
 * Full recluster via Python AI service HDBSCAN.
 *
 * Flow:
 *   1. POST { db_path } to Python /cluster
 *   2. Python reads embeddings from DB (read-only), runs HDBSCAN, returns assignments
 *   3. This worker writes the person rows + face assignments into SQLite (write lock)
 */
/**
 * Full HDBSCAN recluster via Python AI service HDBSCAN.
 *
 * Wrapped in the SAME withWriteLock used by assignFace() (see the doc
 * comment on withWriteLock in face-cluster.js) — this is the only call site
 * of fullReclusterPython(), and it does not itself run inside any other
 * locked section, so this acquires the lock exactly once, never nested.
 * A recluster requested mid-scan now waits for any in-flight assignFace()
 * transaction to finish first, and any assignFace() calls that arrive while
 * the recluster is running wait their turn behind it — the two transaction
 * types can never overlap on this connection.
 */
async function handleCluster() {
  log.info('Full HDBSCAN recluster requested');
  try {
    const result = await withWriteLock(() => fullReclusterPython(db, dbPath, PYTHON_URL));
    // HDBSCAN intentionally labels isolated faces as noise. VaultOS, however,
    // promises that every detected face is represented in People unless the
    // user explicitly rejected it. Convert remaining noise/orphans into
    // singleton people; future scans/reclusters can merge those people.
    const repaired = await repairUnassignedFaces();
    send({ type: 'cluster_done', persons: result.persons, facesAssigned: result.facesAssigned + repaired, repaired });
  } catch (err) {
    log.error('Full recluster failed', { error: err.message });
  }
}

async function handleGetStatus() {
  if (!db) { send({ type: 'status', state }); return; }
  const counts = await dbModule.getIndexStatus(db);
  send({ type: 'status', state, ...counts });
}

/**
 * Reconsider a single orphaned face (person_id IS NULL) after user feedback
 * (e.g. "not this person") detached it from a cluster. Reuses the existing
 * incremental assignFace() path — same centroid-matching logic used for
 * newly-detected faces, which already respects the not_this_person blocklist
 * (see getFeedbackBlocklistForFace in face-cluster.js's assignFace()) — so
 * the face can be re-matched to some OTHER person, or spun into a new
 * singleton person, but can never immediately return to the person it was
 * just rejected from. assignFace() itself acquires the write-lock, so this
 * safely queues behind any in-flight scan assignment or full recluster.
 *
 * Deliberately does NOT trigger a full recluster — this is the smallest safe
 * mechanism that keeps the change scoped to the one affected face.
 *
 * Guarded on `db` existing and state not being pre-startup — reconciliation
 * runs before setState(RUNNING), and while that's a narrow window unlikely
 * to overlap a live user action, this guard makes it impossible regardless.
 */
async function handleReclassifyFace(msg) {
  if (!db || !msg || !msg.faceId) return;
  if (state === STATES.INITIALIZING || state === STATES.SERVICE_WAIT) {
    log.debug('Reclassify: worker not ready yet, skipping', { faceId: msg.faceId });
    return;
  }
  try {
    const row = await db.get(
      'SELECT embedding, person_id FROM faces WHERE id = ?', msg.faceId,
    );
    if (!row) { log.warn('Reclassify: face not found', { faceId: msg.faceId }); return; }
    if (row.person_id) { log.debug('Reclassify: face already assigned, skipping', { faceId: msg.faceId }); return; }

    const embedding = blobToF32(row.embedding);
    const personId  = await assignFace(db, msg.faceId, embedding);
    log.info('Reclassified orphaned face', { faceId: msg.faceId, personId });
    send({ type: 'reclassify_done', faceId: msg.faceId, personId });
  } catch (e) {
    log.error('handleReclassifyFace error', { faceId: msg.faceId, error: e.message });
  }
}

/**
 * Drop the in-memory centroid cache (face-cluster.js `_centroids`) without
 * running a full HDBSCAN recluster.
 *
 * Why this exists:
 *   server.js performs some person-table writes directly (manual merge via
 *   mergePersons(), comprehensive dedup via _deduplicatePostRecluster()) from
 *   its own process. Those writes land in SQLite correctly, but this worker
 *   runs in a *separate forked process* (see server.js startFaceWorker()) and
 *   keeps its own copy of person centroids in memory for fast incremental
 *   matching (assignFace()). That in-memory copy has no way to find out about
 *   writes made by the other process except via an explicit IPC message.
 *
 *   Without this, a person row deleted by server.js (e.g. merged away during
 *   dedup) can still be selected as the "best match" by assignFace() on the
 *   next incremental face. Writing that stale person_id then fails the
 *   `faces.person_id REFERENCES persons(id)` foreign-key constraint, and the
 *   face is silently left unassigned (see saveFace() catch block).
 *
 * Next call to getCentroids() will lazily reload fresh rows from SQLite —
 * cheap (one SELECT) compared to a full recluster.
 */
async function handleInvalidateCache() {
  invalidateCentroidCache();
  log.info('Centroid cache invalidated (external DB write notified)');
  send({ type: 'cache_invalidated' });
}

async function handleShutdown() {
  setState(STATES.SHUTTING_DOWN);
  log.info('Graceful shutdown — waiting for active jobs', { activeJobs });

  const deadline = Date.now() + 30000;
  while (activeJobs > 0 && Date.now() < deadline) await sleep(200);
  if (activeJobs > 0) log.warn('Forcing exit with active jobs', { activeJobs });
  if (db) try { await db.close(); } catch {}
  process.exit(0);
}

// ─────────────────────────────────────────────────────────────
//  MAIN IPC LISTENER
// ─────────────────────────────────────────────────────────────

process.on('message', (msg) => {
  if (!msg || !msg.type) return;
  log.debug('IPC received', { type: msg.type });

  switch (msg.type) {
    case 'init':       handleInit(msg).catch(e => log.error('handleInit error',   { error: e.message })); break;
    case 'enqueue':    handleEnqueue(msg).catch(e => log.error('handleEnqueue',   { error: e.message })); break;
    case 'scan':       handleScan().catch(e => log.error('handleScan',             { error: e.message })); break;
    case 'pause':      handlePause().catch(e => log.error('handlePause',          { error: e.message })); break;
    case 'resume':     handleResume().catch(e => log.error('handleResume',        { error: e.message })); break;
    case 'rescan':     handleRescan(msg).catch(e => log.error('handleRescan',     { error: e.message })); break;
    case 'cluster':    handleCluster().catch(e => log.error('handleCluster',      { error: e.message })); break;
    case 'reclassify_face': handleReclassifyFace(msg).catch(e => log.error('handleReclassifyFace', { error: e.message })); break;
    case 'invalidate_cache': handleInvalidateCache().catch(e => log.error('handleInvalidateCache', { error: e.message })); break;
    case 'get_status': handleGetStatus().catch(e => log.error('handleGetStatus',  { error: e.message })); break;
    case 'shutdown':   handleShutdown().catch(e => { log.error('shutdown error', { error: e.message }); process.exit(1); }); break;
    default:           log.warn('Unknown IPC message', { type: msg.type });
  }
});

// ─────────────────────────────────────────────────────────────
//  SIGNAL HANDLERS
// ─────────────────────────────────────────────────────────────

const sigHandler = sig => { log.info('Signal', { sig }); handleShutdown().catch(() => process.exit(1)); };
process.on('SIGTERM', () => sigHandler('SIGTERM'));
process.on('SIGINT',  () => sigHandler('SIGINT'));

process.on('uncaughtException', (err) => {
  log.error('Uncaught exception', { error: err.message, stack: err.stack });
});
process.on('unhandledRejection', (reason) => {
  log.error('Unhandled rejection', { reason: String(reason) });
});

log.info('Face worker process started', { pid: process.pid });

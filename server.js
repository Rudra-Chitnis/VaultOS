/**
 * VAULT_OS — server.js
 * Setup: npm install
 * FFmpeg: winget install Gyan.FFmpeg  (restart terminal after)
 * Config: copy .env.example → .env and set PASS_HASH
 */

// Graceful dotenv load — server still boots with built-in defaults if dotenv
// is not yet installed (e.g. before running npm install for the first time).
try {
  require('dotenv').config();
} catch (e) {
  if (e.code !== 'MODULE_NOT_FOUND') throw e;
  console.warn('⚠️  dotenv not found — run npm install to load .env settings.');
}

const express        = require('express');
const fs             = require('fs');
const path           = require('path');
const crypto         = require('crypto');
const os             = require('os');
const { spawn, execFileSync, fork } = require('child_process');
const compression    = require('compression');

const app = express();
app.use(compression());

// ── Config (from .env, with safe defaults) ────────────────────
const PASS_HASH        = (process.env.PASS_HASH || '').trim();
const PORT             = parseInt(process.env.PORT) || 8000;
const SESSION_TTL      = (parseInt(process.env.SESSION_TTL_HOURS) || 8) * 3600 * 1000;
const RATE_MAX         = parseInt(process.env.LOGIN_RATE_LIMIT_MAX) || 10;
const RATE_WINDOW      = (parseInt(process.env.LOGIN_RATE_LIMIT_WINDOW_MINUTES) || 15) * 60 * 1000;
// Python AI microservice URL — start face_service/start.bat before server.js
const FACE_SERVICE_URL = process.env.FACE_SERVICE_URL || 'http://127.0.0.1:7860';

if (!PASS_HASH || PASS_HASH === 'replace_with_sha256_password_hash' || PASS_HASH === 'your_sha256_hash_here') {
  console.error('PASS_HASH is not configured. Copy .env.example to .env and set PASS_HASH before starting VaultOS.');
  process.exit(1);
}

// ── Paths ─────────────────────────────────────────────────────
const MEDIA_DIR       = path.join(__dirname, 'media');
const THUMBS_DIR      = path.join(MEDIA_DIR, '.thumbs');
const FACE_THUMBS_DIR = path.join(MEDIA_DIR, '.face-thumbs');
const FACE_DB_PATH    = path.join(MEDIA_DIR, 'face_index.db');
const THUMB_PX        = 300;

[MEDIA_DIR, THUMBS_DIR, FACE_THUMBS_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// ── Auth ──────────────────────────────────────────────────────
const COOKIE_NAME = 'vs';
const sessions    = new Map();

const mkToken = () => {
  const t = crypto.randomBytes(32).toString('hex');
  sessions.set(t, Date.now() + SESSION_TTL);
  return t;
};
const validTok = t => {
  if (!t) return false;
  const e = sessions.get(t);
  if (!e) return false;
  if (Date.now() > e) { sessions.delete(t); return false; }
  return true;
};
const parseCookies = h => {
  const out = {};
  (h || '').split(';').forEach(c => {
    const i = c.indexOf('=');
    if (i < 0) return;
    out[decodeURIComponent(c.slice(0, i).trim())] = decodeURIComponent(c.slice(i + 1).trim());
  });
  return out;
};
function auth(req, res, next) {
  if (validTok(parseCookies(req.headers.cookie)[COOKIE_NAME])) return next();
  if (/^\/(api|media|thumbs)\//.test(req.path)) return res.status(401).json({ error: 'Unauthorized' });
  res.redirect('/login.html');
}

app.use(express.json(), express.urlencoded({ extended: false }));

// ── Rate limiting (login endpoint) ───────────────────────────
// Simple in-memory per-IP counter. Parallel requests all share the
// same counter, so the 800ms delay alone cannot be bypassed by flooding.
const loginAttempts = new Map(); // ip → { count, resetAt }

// Prune expired entries every 30 minutes to prevent memory growth
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of loginAttempts) {
    if (now > entry.resetAt) loginAttempts.delete(ip);
  }
}, 30 * 60 * 1000).unref();

function checkRateLimit(ip) {
  const now   = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: now + RATE_WINDOW });
    return true;
  }
  if (entry.count >= RATE_MAX) return false; // locked out
  entry.count++;
  return true;
}

function getClientIp(req) {
  return (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
}

// ── File types ────────────────────────────────────────────────
const IMG_EXT = new Set(['.jpg','.jpeg','.png','.webp','.avif','.bmp','.tiff','.tif','.jfif','.heic','.svg']);
const VID_EXT = new Set(['.mp4','.webm','.mov','.avi','.mkv','.m4v','.flv','.wmv','.3gp','.ogg']);
const GIF_EXT = new Set(['.gif']);
const ALL_RE  = /\.(jpg|jpeg|png|gif|webp|bmp|tiff|tif|avif|heic|svg|jfif|mp4|webm|ogg|mov|avi|mkv|m4v|flv|wmv|3gp)$/i;

function ftype(name) {
  const e = path.extname(name).toLowerCase();
  return IMG_EXT.has(e) ? 'image' : VID_EXT.has(e) ? 'video' : GIF_EXT.has(e) ? 'gif' : 'unknown';
}

// MD5 of original filename → thumb filename / path
function tname(name) { return crypto.createHash('md5').update(name).digest('hex') + '.jpg'; }
function tpath(name)  { return path.join(THUMBS_DIR, tname(name)); }

// Deterministic pseudo-random rank for a (seed, filename) pair — used by
// sort=random. Same seed + same filename always produces the same rank, so
// one seed defines one stable full-list ordering across every page of a
// paginated request. A different seed produces a different ordering.
// Uses the already-imported crypto module — no new dependency.
function seededRank(seed, name) {
  const h = crypto.createHash('md5').update(`${seed}\u0000${name}`).digest();
  return h.readUInt32BE(0);
}

// ── Sharp ─────────────────────────────────────────────────────
let sharp = null;
try { sharp = require('sharp'); } catch {}

// ── FFmpeg — resolved once at startup ─────────────────────────
let FFMPEG_PATH   = null;
let FFMPEG_TESTED = false;

function findFfmpeg() {
  if (FFMPEG_TESTED) return FFMPEG_PATH;
  FFMPEG_TESTED = true;

  // 1. Scan WinGet packages dir dynamically — picks up any installed version (7.x, 6.x, etc.)
  try {
    const wingetDir = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages');
    if (fs.existsSync(wingetDir)) {
      for (const entry of fs.readdirSync(wingetDir)) {
        if (!entry.startsWith('Gyan.FFmpeg')) continue;
        const pkgPath = path.join(wingetDir, entry);
        const builds  = fs.readdirSync(pkgPath).filter(d => d.startsWith('ffmpeg-')).sort().reverse();
        for (const build of builds) {
          const exe = path.join(pkgPath, build, 'bin', 'ffmpeg.exe');
          try { if (fs.existsSync(exe)) { FFMPEG_PATH = exe; return exe; } } catch {}
        }
      }
    }
  } catch {}

  // 2. Common static install locations (Chocolatey, Scoop, manual)
  const statics = [
    'C:\\ffmpeg\\bin\\ffmpeg.exe',
    'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe',
    'C:\\ProgramData\\chocolatey\\bin\\ffmpeg.exe',
    path.join(process.env.USERPROFILE || '', 'scoop', 'apps', 'ffmpeg', 'current', 'bin', 'ffmpeg.exe'),
  ];
  for (const c of statics) {
    try { if (fs.existsSync(c)) { FFMPEG_PATH = c; return c; } } catch {}
  }

  // 3. System PATH via 'where' (Windows)
  try {
    const r = execFileSync('where', ['ffmpeg'], { timeout: 3000, windowsHide: true }).toString().trim();
    const first = r.split(/\r?\n/)[0].trim();
    if (first && fs.existsSync(first)) { FFMPEG_PATH = first; return first; }
  } catch {}

  // 4. Last resort — try invoking 'ffmpeg' directly (works if it's on PATH but 'where' failed)
  try {
    execFileSync('ffmpeg', ['-version'], { timeout: 3000, windowsHide: true, stdio: 'ignore' });
    FFMPEG_PATH = 'ffmpeg';
    return 'ffmpeg';
  } catch {}

  return null;
}

// ── Thumbnail generators ──────────────────────────────────────
async function imgThumb(src, dest) {
  if (!sharp) return false;
  try {
    await sharp(src)
      .rotate()
      .resize(THUMB_PX, THUMB_PX, { fit: 'cover', position: 'centre' })
      .jpeg({ quality: 72 })
      .toFile(dest);
    return true;
  } catch { return false; }
}

async function gifThumb(src, dest) {
  if (!sharp) return false;
  // Try reading only the first frame (animated GIFs); if that fails, try without the hint
  for (const opts of [{ pages: 1 }, {}]) {
    try {
      await sharp(src, opts)
        .resize(THUMB_PX, THUMB_PX, { fit: 'cover', position: 'centre' })
        .jpeg({ quality: 72 })
        .toFile(dest);
      return true;
    } catch (e) {
      console.warn(`[gifThumb] sharp(${path.basename(src)}, pages:${opts.pages ?? 'all'}) — ${e.message}`);
    }
  }
  return false;
}

function vidThumb(src, dest) {
  return new Promise(resolve => {
    const ff = findFfmpeg();
    if (!ff) {
      console.warn(`[vidThumb] FFmpeg not found — cannot generate thumbnail for ${path.basename(src)}`);
      return resolve(false);
    }

    try { if (fs.existsSync(dest)) fs.unlinkSync(dest); } catch {}

    // Output seek (-ss after -i): decodes from start but handles WebM/MKV/MOV more reliably
    // than input seek, which can miss the first decodable keyframe on certain container formats.
    const args = [
      '-y',
      '-i', src,
      '-ss', '0.5',          // skip 0.5s — avoids black/blank first frames on fades/intros
      '-frames:v', '1',
      '-vf', `scale=${THUMB_PX}:${THUMB_PX}:force_original_aspect_ratio=increase,crop=${THUMB_PX}:${THUMB_PX}`,
      '-f', 'image2',
      '-q:v', '5',
      dest
    ];

    console.log(`[vidThumb] spawn: "${ff}" ${args.join(' ')}`);
    console.log(`[vidThumb] output: ${dest}`);

    let stderr = '';
    const proc = spawn(ff, args, { windowsHide: true, shell: false, stdio: ['ignore', 'ignore', 'pipe'] });

    proc.stderr.on('data', d => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      try { proc.kill(); } catch {}
      console.warn(`[vidThumb] timeout (30s): ${path.basename(src)}`);
      resolve(false);
    }, 30000);

    proc.on('close', code => {
      clearTimeout(timer);
      const exists = fs.existsSync(dest);
      const size   = exists ? fs.statSync(dest).size : 0;
      const ok     = code === 0 && exists && size > 500; // <500 bytes = corrupt/empty JPEG
      if (ok) {
        console.log(`[vidThumb] OK   ${path.basename(src)} → ${size}b`);
      } else {
        try { if (exists) fs.unlinkSync(dest); } catch {}
        // Print all stderr lines that mention errors, then last 5 lines as context
        const errLines = stderr.trim().split('\n').filter(l => /error|invalid|unable|fail/i.test(l));
        const lastLines = stderr.trim().split('\n').slice(-5);
        console.error(`[vidThumb] FAIL ${path.basename(src)} — exit=${code} exists=${exists} size=${size}b`);
        if (errLines.length)  console.error(`[vidThumb]  !! ${errLines.join('\n[vidThumb]  !! ')}`);
        if (!errLines.length) console.error(`[vidThumb]  >> ${lastLines.join('\n[vidThumb]  >> ')}`);
      }
      resolve(ok);
    });

    proc.on('error', err => {
      clearTimeout(timer);
      console.error(`[FFmpeg spawn] ${err.message}`);
      resolve(false);
    });
  });
}

// ── Thumb queue — all generation goes through here ────────────
// Max 3 concurrent jobs. Both background prewarm and on-demand
// requests share this queue so the server never gets overwhelmed.
// thumbQSet mirrors thumbQ for O(1) membership checks (replaces O(n) includes).
const inFlight  = new Set();
const thumbQSet = new Set();  // dedup in O(1)
const thumbQ    = [];
let   thumbJobs = 0;
const MAX_JOBS  = 3;

// When multiple HTTP requests arrive for the same not-yet-generated thumb,
// they all wait on the same job instead of spawning duplicates.
const waiting = new Map(); // hash → [resolve, ...]

function enqueue(name, priority = false) {
  if (fs.existsSync(tpath(name))) return;
  if (inFlight.has(name))   return;
  if (thumbQSet.has(name))  return; // O(1) — was O(n) includes()
  thumbQSet.add(name);
  if (priority) thumbQ.unshift(name);
  else          thumbQ.push(name);
  drainQ();
}

async function drainQ() {
  while (thumbJobs < MAX_JOBS && thumbQ.length > 0) {
    const name = thumbQ.shift();
    if (!name) continue;
    thumbQSet.delete(name); // keep Set in sync with array

    if (inFlight.has(name)) continue;

    const dest = tpath(name);
    if (fs.existsSync(dest)) {
      // Already done (race) — resolve any waiters immediately
      const h = crypto.createHash('md5').update(name).digest('hex');
      (waiting.get(h) || []).forEach(cb => cb(true));
      waiting.delete(h);
      continue;
    }

    inFlight.add(name);
    thumbJobs++;

    const src  = path.join(MEDIA_DIR, name);
    const type = ftype(name);
    let ok = false;
    try {
      if      (type === 'image') ok = await imgThumb(src, dest);
      else if (type === 'gif') {
        ok = await gifThumb(src, dest);
        if (!ok) {
          // Sharp failed (corrupt/unusual GIF) — FFmpeg can decode most GIFs as video
          console.log(`[gif] sharp failed for ${name} — trying FFmpeg fallback`);
          ok = await vidThumb(src, dest);
        }
      }
      else if (type === 'video') ok = await vidThumb(src, dest);
    } catch (e) {
      console.error('[thumb error]', name, e.message);
    }
    if (!ok && type !== 'image') {
      console.warn(`[thumb] ❌ no thumbnail generated for ${name}`);
    }

    inFlight.delete(name);
    thumbJobs--;

    const h = crypto.createHash('md5').update(name).digest('hex');
    (waiting.get(h) || []).forEach(cb => cb(ok));
    waiting.delete(h);

    drainQ();
  }
}

// Wait for a specific thumb — used by the /thumbs/ route.
// Multiple concurrent requests for the same thumb share one job.
function waitForThumb(name) {
  return new Promise(resolve => {
    if (fs.existsSync(tpath(name))) return resolve(true);
    const h = crypto.createHash('md5').update(name).digest('hex');
    if (!waiting.has(h)) waiting.set(h, []);
    waiting.get(h).push(resolve);
    enqueue(name, true); // priority = goes to front of queue
  });
}

// ── File list cache ───────────────────────────────────────────
let fileCache        = null;
let fileCacheTime    = 0;
let fileCachePending = null; // coalesces concurrent readdir calls
let fileCacheGen     = 0;    // incremented on invalidation; guards stale writes
const FILE_CACHE_TTL = 30000;

function invalidateCache() {
  fileCache        = null;
  fileCachePending = null;
  fileCacheGen++;          // any in-flight readdir will not commit its result
  invalidateHashMap();
}

// Each cached entry is { name, mtimeMs } — mtimeMs is the real filesystem
// modification time (fs.promises.stat), read fresh whenever the 30s cache is
// rebuilt. This lets /api/files sort by actual mtime without a DB column and
// without re-statting the directory on every request. Default/fallback order
// is still natural filename order (applied below, before stat is attached).
async function getFiles() {
  if (fileCache && Date.now() - fileCacheTime < FILE_CACHE_TTL) return fileCache;

  // Coalesce: if a readdir is already in progress, return the same promise
  if (fileCachePending) return fileCachePending;

  const myGen = fileCacheGen;
  const p = fs.promises.readdir(MEDIA_DIR).then(async raw => {
    const names = raw
      .filter(f => !f.startsWith('.') && !f.startsWith('_') && ALL_RE.test(f))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));

    const result = await Promise.all(names.map(async name => {
      let mtimeMs = 0;
      try {
        const st = await fs.promises.stat(path.join(MEDIA_DIR, name));
        mtimeMs = st.mtimeMs;
      } catch {
        // File may have been removed/renamed mid-scan — keep it in the listing
        // with mtimeMs 0 so it sorts predictably instead of throwing.
      }
      return { name, mtimeMs };
    }));

    // Only commit if cache wasn't invalidated while we were reading
    if (fileCacheGen === myGen) {
      fileCache     = result;
      fileCacheTime = Date.now();
    }
    if (fileCachePending === p) fileCachePending = null;
    return result;
  }).catch(e => {
    if (fileCachePending === p) fileCachePending = null;
    throw e;
  });

  fileCachePending = p;
  return p;
}

// ── Hash map: md5hash → original filename ─────────────────────
// Used by /thumbs/<hash>.jpg for reverse lookup.
// Built from the async file cache — no blocking readdirSync.
let hashMap     = null;
let hashMapTime = 0;
const HASHMAP_TTL = 60000;

async function getHashMap() {
  const now = Date.now();
  if (hashMap && now - hashMapTime < HASHMAP_TTL) return hashMap;
  try {
    const files = await getFiles(); // reuses cache; never blocks the event loop
    const map   = {};
    files.forEach(f => { map[crypto.createHash('md5').update(f.name).digest('hex')] = f.name; });
    hashMap     = map;
    hashMapTime = now;
    return map;
  } catch { return hashMap || {}; }
}

function invalidateHashMap() { hashMap = null; }

// ── Background pre-warm ───────────────────────────────────────
// Feeds missing thumbnails into the queue in batches to avoid
// overwhelming the OS with thousands of queued file ops at once.
async function prewarm() {
  const files = await getFiles();
  const todo  = files.filter(f => !fs.existsSync(tpath(f.name))).map(f => f.name);
  if (!todo.length) { console.log('✅ All thumbnails cached'); return; }
  console.log(`🔄 Pre-warming ${todo.length} missing thumbnails…`);

  let i = 0;
  const BATCH    = 50;   // was 10 — 5× faster queue fill
  const INTERVAL = 5000; // ms between batches

  const tick = () => {
    todo.slice(i, i + BATCH).forEach(f => enqueue(f, false));
    i += BATCH;
    if (i < todo.length) setTimeout(tick, INTERVAL);
    else console.log('✅ Pre-warm queue filled — generating in background');
  };
  tick();
}

// ── Reusable sendFile helper for local HTML/JS assets ─────────
// Uses absolute paths (path.join(__dirname, ...)) — do NOT pass { root }
// alongside an absolute path in Express 5; the send module requires a relative
// path when root is specified and will error-out on absolute Windows paths.
function sendAsset(res, filename, fallback) {
  res.sendFile(path.join(__dirname, filename), err => {
    if (!err || res.headersSent) return;
    fallback ? res.redirect(fallback) : res.status(404).end();
  });
}

// ── Auth routes ───────────────────────────────────────────────

// GET /  — unauthenticated: serve login page directly (200, no redirect needed)
//          authenticated:   redirect to main app at /app
app.get('/', (req, res) => {
  if (validTok(parseCookies(req.headers.cookie)[COOKIE_NAME])) return res.redirect('/app');
  sendAsset(res, 'login.html');
});

// GET /login.html — convenience alias; behaves identically to GET /
// Authenticated users are bounced to /app so they never see the login form again.
app.get('/login.html', (req, res) => {
  if (validTok(parseCookies(req.headers.cookie)[COOKIE_NAME])) return res.redirect('/app');
  sendAsset(res, 'login.html');
});

// GET /app — the main gallery. Auth-gated; unauthenticated users → /login.html.
app.get('/app', auth, (req, res) => {
  sendAsset(res, 'index.html');
});

// Check auth status — polled by login.html on load to auto-redirect if already
// authenticated. Was missing; caused an unhandled rejection on every page load.
app.get('/api/check', (req, res) => {
  res.json({ authenticated: validTok(parseCookies(req.headers.cookie)[COOKIE_NAME]) });
});

app.post('/api/login', (req, res) => {
  // Rate limit checked BEFORE hashing to avoid hash timing oracle
  const ip = getClientIp(req);
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Too many attempts. Try again later.' });
  }
  const h = crypto.createHash('sha256').update(req.body.password || '').digest('hex');
  if (h !== PASS_HASH)
    return setTimeout(() => res.status(401).json({ error: 'Wrong password' }), 800);
  const tok = mkToken();
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${tok}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL / 1000}`);
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  sessions.delete(parseCookies(req.headers.cookie)[COOKIE_NAME]);
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0`);
  res.json({ ok: true });
});

// ── Paginated file list ───────────────────────────────────────
app.get('/api/files', auth, async (req, res) => {
  const pg     = Math.max(0, parseInt(req.query.page) || 0);
  const lim    = Math.min(80, Math.max(10, parseInt(req.query.limit) || 60));
  const search = (req.query.search || '').toLowerCase().trim();
  const type   = req.query.type || 'all';
  const sort   = req.query.sort; // 'newest' | 'oldest' | 'random' | anything else = default order
  const seed   = (req.query.seed || '0').toString().slice(0, 64); // opaque; only used when sort === 'random'

  let files = await getFiles(); // [{ name, mtimeMs }], natural filename order by default
  if (type !== 'all') files = files.filter(f => ftype(f.name) === type);
  if (search)         files = files.filter(f => f.name.toLowerCase().includes(search));

  // Sort BEFORE pagination. Any missing/unknown sort value leaves the
  // existing natural-filename ordering from getFiles() untouched.
  if (sort === 'newest' || sort === 'oldest') {
    files = files.slice().sort((a, b) => {
      const diff = sort === 'newest' ? b.mtimeMs - a.mtimeMs : a.mtimeMs - b.mtimeMs;
      if (diff !== 0) return diff;
      // Identical mtimeMs — fall back to the same natural filename ordering
      // used everywhere else, for a deterministic result.
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    });
  } else if (sort === 'random') {
    // Deterministic shuffle: the same seed always produces the same full-list
    // ordering, so paginating through it (page 0, 1, 2, ...) yields a single
    // consistent randomized sequence with no duplicates/gaps. A new seed
    // (sent by the client on a fresh Random session) gives a new ordering.
    files = files.slice().sort((a, b) => {
      const ra = seededRank(seed, a.name);
      const rb = seededRank(seed, b.name);
      if (ra !== rb) return ra - rb;
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    });
  }

  const total      = files.length;
  const slice      = files.slice(pg * lim, (pg + 1) * lim);
  const sliceNames = slice.map(f => f.name);

  // Augment with face person IDs from face DB (non-blocking — faceDB may be null)
  let faceMap = new Map();
  const db = getFaceDB ? getFaceDB() : null;
  if (db) {
    try {
      const { getIndexedFaceBatch } = require('./face-db');
      faceMap = await getIndexedFaceBatch(db, sliceNames);
    } catch (_) { /* face DB not ready — skip silently */ }
  }

  res.json({
    items: sliceNames.map(name => ({
      name,
      type:          ftype(name),
      thumb:         `/thumbs/${tname(name)}`,
      url:           `/media/${encodeURIComponent(name)}`,
      hasThumb:      fs.existsSync(tpath(name)),
      facePersonIds: faceMap.get(name) || [],
    })),
    total, page: pg, hasMore: (pg + 1) * lim < total,
  });

  // Enqueue background generation for this page's files (non-priority)
  sliceNames.forEach(f => enqueue(f, false));
  if (db) enqueueDiscoveredFaceFiles(db, sliceNames).catch(() => {});
});

// ── All filenames — lightweight endpoint for favorites mode ───
// Returns every filename with type + pre-computed URLs but no pagination.
// The frontend filters by localStorage favorites and builds its own list.
// Average payload: ~40 bytes/file → ~600 KB for 15,000 files (acceptable).
app.get('/api/filenames', auth, async (req, res) => {
  const search = (req.query.search || '').toLowerCase().trim();
  let files = await getFiles();
  if (search) files = files.filter(f => f.name.toLowerCase().includes(search));
  res.json({
    items: files.map(({ name }) => ({
      name,
      type:  ftype(name),
      thumb: `/thumbs/${tname(name)}`,
      url:   `/media/${encodeURIComponent(name)}`,
    })),
  });
});

// ── Thumb serving ─────────────────────────────────────────────
// sendFile helper for thumbnails.
// IMPORTANT: filePath must be absolute. Do NOT pass { root } — Express 5's send
// module requires a relative path when root is specified. Using an absolute path
// with { root: '/' } causes the send module to reject the path and return an error.
function sendThumb(res, filePath) {
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  // dotfiles:'allow' is required — thumbs live in media/.thumbs/ (dot-prefixed directory).
  // The send module's default is dotfiles:'ignore', which returns 404 for any path
  // component starting with a dot, even when the file physically exists on disk.
  res.sendFile(filePath, { dotfiles: 'allow' }, err => {
    if (err && !res.headersSent) {
      console.error(`[sendThumb] sendFile error for ${filePath}: ${err.message}`);
      res.status(404).end();
    }
  });
}

// ── Thumb diagnostic logger ────────────────────────────────────
// Prefixes every line with timestamp + [THUMB] so they're easy to grep.
function tlog(...args) {
  // Quiet by default; keep the hook available for temporary local diagnostics.
}

app.get('/thumbs/:name', auth, async (req, res) => {
  const name = decodeURIComponent(req.params.name);

  // ── Hash filename: /thumbs/<md5hash>.jpg (what the frontend sends) ──
  if (/^[a-f0-9]{32}\.jpg$/i.test(name)) {
    const thumbFile = path.join(THUMBS_DIR, name);

    // Fast path: already on disk
    if (fs.existsSync(thumbFile)) {
      tlog(`HIT  ${name} → 200 (cached)`);
      return sendThumb(res, thumbFile);
    }

    // Reverse-lookup hash → original filename (now async; no readdirSync)
    const hashKey  = name.slice(0, 32);
    const origName = (await getHashMap())[hashKey];
    if (!origName) {
      tlog(`MISS ${name} → 404 (hash not in hashmap — file not in media dir)`);
      return res.status(404).end();
    }

    const srcFile = path.join(MEDIA_DIR, origName);
    const srcExists = fs.existsSync(srcFile);
    const type = ftype(origName);

    tlog(`REQ  "${origName}" | type=${type} | sharp=${!!sharp} | ffmpeg=${findFfmpeg() || 'NOT FOUND'}`);
    tlog(`     src=${srcFile} | exists=${srcExists}`);
    tlog(`     dest=${thumbFile}`);

    if (!srcExists) {
      tlog(`     → 404 (source file missing from media dir)`);
      return res.status(404).end();
    }

    // Images: Sharp is fast enough to generate synchronously per-request
    if (type === 'image' && sharp) {
      try {
        tlog(`     [image] calling imgThumb via sharp`);
        await imgThumb(srcFile, thumbFile);
        if (fs.existsSync(thumbFile)) {
          tlog(`     [image] sharp OK → 200 (wrote to disk)`);
          return sendThumb(res, thumbFile);
        }
        tlog(`     [image] sharp ran but no output file — streaming buffer`);
        const buf = await sharp(srcFile).rotate()
          .resize(THUMB_PX, THUMB_PX, { fit: 'cover' })
          .jpeg({ quality: 70 }).toBuffer();
        tlog(`     [image] buffer stream → 200 (${buf.length}b)`);
        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader('Cache-Control', 'public, max-age=3600');
        return res.send(buf);
      } catch (e) {
        tlog(`     [image] sharp FAILED: ${e.message} → 404`);
        console.error('[imgThumb fail]', origName, e.message);
        return res.status(404).end();
      }
    }

    // GIFs: try Sharp first.
    // On failure do NOT return — fall through to FFmpeg waitForThumb below.
    if (type === 'gif' && sharp) {
      tlog(`     [gif] trying sharp (pages:1 first, then default)`);
      try {
        await gifThumb(srcFile, thumbFile);
        if (fs.existsSync(thumbFile)) {
          tlog(`     [gif] sharp OK → 200 (wrote to disk)`);
          return sendThumb(res, thumbFile);
        }
        tlog(`     [gif] sharp ran but no output file — streaming buffer`);
        const buf = await sharp(srcFile, { pages: 1 })
          .resize(THUMB_PX, THUMB_PX, { fit: 'cover' })
          .jpeg({ quality: 72 }).toBuffer();
        tlog(`     [gif] buffer stream → 200 (${buf.length}b)`);
        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader('Cache-Control', 'public, max-age=3600');
        return res.send(buf);
      } catch (e) {
        // Sharp cannot decode this GIF — fall through to FFmpeg below
        tlog(`     [gif] sharp FAILED: ${e.message} — falling through to FFmpeg`);
        console.warn(`[gif] sharp failed for ${origName} — ${e.message} — trying FFmpeg`);
      }
    } else if (type === 'gif' && !sharp) {
      tlog(`     [gif] sharp not available — going straight to FFmpeg`);
    }

    // Videos + GIF FFmpeg fallback — 100 requests for same file = 1 FFmpeg process
    const ff = findFfmpeg();
    tlog(`     [ffmpeg] waitForThumb("${origName}") | ffmpeg=${ff || 'NOT FOUND'}`);
    const ok = await waitForThumb(origName);
    const outExists = fs.existsSync(thumbFile);
    const outSize   = outExists ? fs.statSync(thumbFile).size : 0;
    tlog(`     [ffmpeg] done | ok=${ok} | file exists=${outExists} | size=${outSize}b`);
    if (ok && outExists) {
      tlog(`     → 200`);
      return sendThumb(res, thumbFile);
    }
    tlog(`     → 404 (ffmpeg ok=${ok}, file=${outExists}, size=${outSize})`);
    return res.status(404).end();
  }

  // ── Legacy: original filename in URL ──
  const dest = tpath(name);
  if (fs.existsSync(dest)) return sendThumb(res, dest);
  const ok = await waitForThumb(name);
  if (ok && fs.existsSync(dest)) return sendThumb(res, dest);
  res.status(404).end();
});

// ── Upload ────────────────────────────────────────────────────
app.post('/api/upload', auth, (req, res) => {
  let bb;
  try { bb = require('busboy')({ headers: req.headers, limits: { fileSize: 500 * 1024 * 1024 } }); }
  catch { return res.status(500).json({ error: 'npm install busboy' }); }

  const saved = []; let pending = 0, finished = false;
  const tryDone = () => {
    if (finished && !pending) { invalidateCache(); res.json({ ok: true, files: saved }); }
  };

  bb.on('file', (_, file, info) => {
    let name = '';
    try { name = decodeURIComponent(typeof info === 'object' ? info.filename : info); } catch {}
    name = name.replace(/[/\\?%*:|"<>]/g, '_').trim();
    if (!name || !ALL_RE.test(name)) { file.resume(); return; }

    const ext   = path.extname(name);
    const base  = path.basename(name, ext);
    const final = fs.existsSync(path.join(MEDIA_DIR, name)) ? `${base}_${Date.now()}${ext}` : name;
    const dest  = path.join(MEDIA_DIR, final);

    pending++;
    const ws = fs.createWriteStream(dest);
    file.pipe(ws);
    ws.on('close', () => {
      saved.push(final);
      enqueue(final, true);                                      // thumbnail queue (priority)
      workerSend({ type: 'enqueue', filename: final, priority: 1 }); // face worker queue
      pending--;
      tryDone();
    });
    ws.on('error', () => { pending--; tryDone(); });
  });
  bb.on('finish', () => { finished = true; tryDone(); });
  bb.on('error',  e => res.status(500).json({ error: e.message }));
  req.pipe(bb);
});

// ── Delete ────────────────────────────────────────────────────
app.delete('/api/files/:name', auth, (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const fp   = path.join(MEDIA_DIR, name);
  if (!fp.startsWith(MEDIA_DIR + path.sep)) return res.status(400).json({ error: 'Bad path' });
  fs.unlink(fp, err => {
    if (err) return res.status(404).json({ error: 'Not found' });
    const tp = tpath(name);
    if (fs.existsSync(tp)) fs.unlinkSync(tp);
    invalidateCache();
    res.json({ ok: true });
  });
});

// ── Static: media files ───────────────────────────────────────
// dotfiles: 'deny' prevents /media/.thumbs/* from being served directly.
app.use('/media', auth,
  (_, res, next) => { res.setHeader('Cache-Control', 'private, max-age=86400'); next(); },
  express.static(MEDIA_DIR, { dotfiles: 'deny' })
);

// ── Static: frontend assets (explicit whitelist, auth-gated) ─────────────────
// Only serves the single JS file that index.html loads at runtime.
// Sensitive files (server.js, .env, package.json, node_modules) are never
// matched here and fall through to Express's default 404 handler.
const FRONTEND_WHITELIST = new Set(['upload.js']);
app.get('/:file', auth, (req, res, next) => {
  if (!FRONTEND_WHITELIST.has(req.params.file)) return next();
  sendAsset(res, req.params.file); // absolute path, no { root } option
});

// ═══════════════════════════════════════════════════════════════
//  FACE INDEXING SUBSYSTEM
// ═══════════════════════════════════════════════════════════════

// ── Face DB ────────────────────────────────────────────────────
// Opens READWRITE + full schema setup (create:true).
// Retries every 5 s automatically — handles the case where sqlite3
// isn't ready, the file is temporarily locked, or a first-run race.
// NOTE: readonly:true was previously used here but caused SQLITE_READONLY
// when openDB tried to set journal_mode=WAL on a read-only connection,
// which silently killed faceDB with no retry. Fixed.
let faceDB            = null;
let _faceDBRetryTimer = null;

async function initFaceDB() {
  if (faceDB) return; // already connected — do nothing
  try {
    const { openDB } = require('./face-db');
    const db = await openDB(FACE_DB_PATH, {
      busyTimeout: 5000,
      readonly:    false, // server also writes (rename / merge / delete person)
      create:      true,  // create schema if DB doesn't exist yet on first run
    });
    faceDB = db;
    console.log('✅ Face DB:   ready →', FACE_DB_PATH);
    if (_faceDBRetryTimer) { clearInterval(_faceDBRetryTimer); _faceDBRetryTimer = null; }
  } catch (e) {
    // Always log the real error — the old code masked SQLITE_* errors behind
    // a misleading "run npm install" message, hiding actual failure reasons.
    console.warn('⚠️  Face DB:   init failed —', e.message);
    if (e.message && e.message.includes('MODULE_NOT_FOUND')) {
      console.warn('   ↳ sqlite/sqlite3 not installed — run: npm install sqlite sqlite3');
    }
    // faceDB stays null; retry timer will call us again
  }
}

// Attempt immediately, then retry every 5 s until connected
initFaceDB().then(() => {
  if (!faceDB) {
    _faceDBRetryTimer = setInterval(() => {
      initFaceDB().catch(e => console.error('[face-db retry]', e.message));
    }, 5000);
  }
});

// ── Face worker (forked child process) ────────────────────────
let faceWorker       = null;
let faceWorkerState  = 'stopped';
let appShuttingDown  = false;

// In-memory status cache — updated on every IPC 'status' / 'progress' message
let faceStatusCache  = {
  state: 'stopped', queued: 0, processing: 0,
  done: 0, total: 0, personCount: 0, faceCount: 0,
};

function startFaceWorker() {
  if (appShuttingDown) return;

  const workerPath = path.join(__dirname, 'face-worker.js');
  if (!fs.existsSync(workerPath)) {
    console.log('ℹ️  Face worker: face-worker.js not found — face indexing disabled');
    return;
  }

  faceWorker = fork(workerPath, [], {
    silent: false,       // let worker stdout/stderr flow to parent console
    detached: false,
  });

  faceWorker.on('message', (msg) => {
    if (!msg || !msg.type) return;

    switch (msg.type) {
      case 'ready':
        faceWorkerState = msg.state;
        console.log(`✅ Face worker ready (${msg.state})`);
        break;

      case 'status':
        faceWorkerState = msg.state;
        faceStatusCache = { ...msg };
        break;

      case 'progress':
        // Invalidate per-file face cache entry so next /api/files call reflects new data
        if (facePerFileCache) facePerFileCache.delete(msg.filename);
        faceListCacheTs = 0; // force refresh of persons list
        // Keep status cache counts fresh on every progress tick
        if (msg.faces != null) {
          faceStatusCache.faceCount = (faceStatusCache.faceCount || 0) + msg.faces;
        }
        break;

      case 'cluster_done':
        faceListCacheTs = 0;
        break;

      case 'error':
        console.error(`[face-worker] Error on ${msg.filename}: ${msg.message}`);
        break;
    }
  });

  // Poll worker for full status every 8 s so statusCache stays accurate
  const _workerStatusPoll = setInterval(() => {
    if (faceWorker && faceWorker.connected) {
      faceWorker.send({ type: 'get_status' });
    }
  }, 8000);
  faceWorker.once('exit', () => clearInterval(_workerStatusPoll));

  faceWorker.on('exit', (code, signal) => {
    faceWorkerState = 'stopped';
    faceWorker      = null;
    console.warn(`⚠️  Face worker exited (code=${code} signal=${signal})`);

    // Auto-restart after 5 s unless the server itself is shutting down
    if (!appShuttingDown) {
      setTimeout(startFaceWorker, 5000);
    }
  });

  faceWorker.on('error', (err) => {
    console.error('[face-worker] Fork error:', err.message);
  });

  // Send init payload to face-worker.js
  // Note: detModelPath / recModelPath removed (v2.0) — detection now runs in
  //       the Python AI microservice (face_service/main.py).
  faceWorker.send({
    type:             'init',
    ffmpegPath:       findFfmpeg() || null,
    mediaDir:         MEDIA_DIR,
    dbPath:           FACE_DB_PATH,
    faceThumbs:       FACE_THUMBS_DIR,
    pythonServiceUrl: FACE_SERVICE_URL,  // v2.0: Python AI service URL
  });
}

/** Forward a control message to the worker, ignoring it if worker is down. */
function workerSend(msg) {
  if (faceWorker && faceWorker.connected) faceWorker.send(msg);
}

async function enqueueDiscoveredFaceFiles(db, filenames) {
  if (!db || !filenames || filenames.length === 0) return;
  const ph = filenames.map(() => '?').join(',');
  const rows = await db.all(
    `SELECT filename, file_mtime, file_size, status FROM media_index WHERE filename IN (${ph})`,
    filenames,
  );
  const byName = new Map(rows.map(row => [row.filename, row]));

  for (const filename of filenames) {
    const row = byName.get(filename);
    let needsScan = !row || row.status === 'error';

    if (row && row.status === 'done') {
      try {
        const stat = fs.statSync(path.join(MEDIA_DIR, filename));
        needsScan = stat.mtimeMs !== row.file_mtime || stat.size !== row.file_size;
      } catch {
        needsScan = false;
      }
    }

    if (needsScan) {
      workerSend({ type: 'enqueue', filename, priority: 0 });
    }
  }
}

// Graceful server shutdown: tell worker to wind down first
process.on('SIGTERM', () => { appShuttingDown = true; workerSend({ type: 'shutdown' }); });
process.on('SIGINT',  () => { appShuttingDown = true; workerSend({ type: 'shutdown' }); });

// ── Simple server-side cache for face API reads ────────────────
let faceListCacheTs  = 0;
let faceListCache    = null;
const FACE_CACHE_TTL = 15000; // 15 s
let facePerFileCache = new Map(); // filename → {faceData, ts}
const FACE_PER_FILE_TTL = 60000;

function getFaceDB() { return faceDB; }

// ─────────────────────────────────────────────────────────────
//  FACE API ROUTES
// ─────────────────────────────────────────────────────────────

// GET /api/faces/status
app.get('/api/faces/status', auth, async (req, res) => {
  const db = getFaceDB();
  if (!db) {
    // DB not ready — kick off another init attempt and return initializing state
    initFaceDB().catch(() => {});
    return res.json({
      state:       faceWorkerState === 'stopped' ? 'unavailable' : faceWorkerState,
      reason:      'db_initializing',
      workerState: faceWorkerState,
    });
  }
  try {
    const { getIndexStatus } = require('./face-db');
    const counts = await getIndexStatus(db);
    res.json({ ...counts, state: faceWorkerState });
  } catch (e) {
    console.error('[face/status]', e.message);
    res.json({ state: faceWorkerState, error: e.message });
  }
});

// GET /api/faces/persons?page=0&limit=40&search=name
app.get('/api/faces/persons', auth, async (req, res) => {
  const db = getFaceDB();
  if (!db) return res.status(503).json({ error: 'face_db_unavailable' });

  const page   = Math.max(0, parseInt(req.query.page)  || 0);
  const limit  = Math.min(80, Math.max(8, parseInt(req.query.limit) || 40));
  const search = (req.query.search || '').toLowerCase().trim();

  try {
    let total, items;
    if (search) {
      // Name-filtered query — searches person names (NULL names use "Person {id}")
      const pattern = `%${search}%`;
      const crow = await db.get(`
        SELECT COUNT(*) AS cnt FROM persons
        WHERE face_count > 0
          AND (name IS NOT NULL AND LOWER(name) LIKE ?)
      `, pattern);
      total = crow ? crow.cnt : 0;
      items = await db.all(`
        SELECT p.id, p.name, p.face_count, p.cover_face_id, f.thumb_path AS cover_thumb
        FROM   persons p
        LEFT JOIN faces f ON f.id = p.cover_face_id
        WHERE  p.face_count > 0
          AND  (p.name IS NOT NULL AND LOWER(p.name) LIKE ?)
        ORDER  BY p.face_count DESC
        LIMIT  ? OFFSET ?
      `, pattern, limit, page * limit);
    } else {
      const { getPersons } = require('./face-db');
      ({ items, total } = await getPersons(db, { limit, offset: page * limit }));
    }

    res.json({
      items: items.map(p => ({
        id:         p.id,
        name:       p.name || null,
        faceCount:  p.face_count,
        coverThumb: p.cover_thumb ? `/thumbs/face/${p.cover_thumb}` : null,
      })),
      total,
      page,
      hasMore: (page + 1) * limit < total,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/faces/persons/:id/media?page=0&limit=60
app.get('/api/faces/persons/:id/media', auth, async (req, res) => {
  const db = getFaceDB();
  if (!db) return res.status(503).json({ error: 'face_db_unavailable' });

  const personId = parseInt(req.params.id);
  if (!personId) return res.status(400).json({ error: 'invalid_id' });

  const page  = Math.max(0, parseInt(req.query.page)  || 0);
  const limit = Math.min(80, Math.max(8, parseInt(req.query.limit) || 60));
  const offset = page * limit;

  console.log(`[face/person-media] personId=${personId} page=${page} limit=${limit} offset=${offset}`);

  try {
    const { getPersonMedia, getPerson } = require('./face-db');
    const person = await getPerson(db, personId);
    if (!person) {
      console.warn(`[face/person-media] person ${personId} not found in DB`);
      return res.status(404).json({ error: 'person_not_found' });
    }

    console.log(`[face/person-media] person found: id=${person.id} name=${person.name || '(unnamed)'} faceCount=${person.face_count} coverFaceId=${person.cover_face_id}`);

    const { items, total } = await getPersonMedia(db, personId, { limit, offset });

    console.log(`[face/person-media] query returned ${items.length} items, total=${total}`);
    if (items.length > 0) {
      console.log(`[face/person-media] sample item[0]:`, JSON.stringify(items[0]));
    }

    const mappedItems = items.map(m => ({
      name:    m.filename,
      type:    m.media_type || ftype(m.filename),
      thumb:   `/thumbs/${tname(m.filename)}`,
      url:     `/media/${encodeURIComponent(m.filename)}`,
      // Face IDs (comma-separated from GROUP_CONCAT) → split to array for UI actions
      faceIds: m.face_ids
        ? m.face_ids.toString().split(',').map(Number).filter(Boolean)
        : [],
      bestFaceThumb: m.best_thumb ? `/thumbs/face/${m.best_thumb}` : null,
    }));

    res.json({
      person: {
        id:         person.id,
        name:       person.name || null,
        faceCount:  person.face_count,
        coverThumb: person.cover_thumb ? `/thumbs/face/${person.cover_thumb}` : null,
      },
      items:   mappedItems,
      total,
      page,
      hasMore: (page + 1) * limit < total,
    });
  } catch (e) {
    console.error(`[face/person-media] ERROR personId=${personId}:`, e.message, e.stack);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/faces/media/:filename — faces detected in a specific file
app.get('/api/faces/media/:filename', auth, async (req, res) => {
  const db = getFaceDB();
  if (!db) return res.status(503).json({ error: 'face_db_unavailable' });

  const filename = decodeURIComponent(req.params.filename);
  const cached   = facePerFileCache.get(filename);
  if (cached && Date.now() - cached.ts < FACE_PER_FILE_TTL) {
    return res.json(cached.data);
  }

  try {
    const { getMediaFaces } = require('./face-db');
    const result = await getMediaFaces(db, filename);
    if (!result) return res.json({ faces: [], status: 'not_indexed' });

    const data = {
      status:    result.media.status,
      faceCount: result.media.face_count,
      width:     result.media.width,
      height:    result.media.height,
      faces: result.faces.map(f => ({
        id:        f.id,
        frameMs:   f.frame_ms,
        frame_ms:  f.frame_ms,
        score:     f.det_score,
        bbox:      [f.bbox_x, f.bbox_y, f.bbox_w, f.bbox_h],
        bbox_x:    f.bbox_x,
        bbox_y:    f.bbox_y,
        bbox_w:    f.bbox_w,
        bbox_h:    f.bbox_h,
        personId:  f.person_id || null,
        person_id: f.person_id || null,
        thumbUrl:  f.thumb_path ? `/thumbs/face/${f.thumb_path}` : null,
        thumb_url: f.thumb_path ? `/thumbs/face/${f.thumb_path}` : null,
        kps:       f.keypoints ? JSON.parse(f.keypoints) : null,
      })),
    };
    facePerFileCache.set(filename, { data, ts: Date.now() });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/faces/media/:filename/persons — persons detected in a specific file
app.get('/api/faces/media/:filename/persons', auth, async (req, res) => {
  const db = getFaceDB();
  if (!db) return res.status(503).json({ error: 'face_db_unavailable' });
  const filename = decodeURIComponent(req.params.filename);
  try {
    const { getMediaPersons } = require('./face-db');
    const rows = await getMediaPersons(db, filename);
    // Deduplicate by person id — keep highest det_score row per person
    const byPerson = new Map();
    for (const r of rows) {
      if (!byPerson.has(r.id) || r.det_score > byPerson.get(r.id).det_score) {
        byPerson.set(r.id, r);
      }
    }
    const persons = [...byPerson.values()].map(r => ({
      id:        r.id,
      name:      r.name || null,
      faceCount: r.face_count,
      thumbUrl:  r.thumb_path
        ? `/thumbs/face/${r.thumb_path}`
        : (r.cover_thumb_path ? `/thumbs/face/${r.cover_thumb_path}` : null),
      faceId:    r.face_id,
      detScore:  r.det_score,
    }));
    res.json({ filename, persons });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/faces/deduplicate — manually trigger comprehensive person deduplication
// Uses multi-strategy: centroid cosine sim (≥0.80) + media Jaccard (≥0.80) + overlap (≥0.90)
app.post('/api/faces/deduplicate', auth, async (req, res) => {
  const db = getFaceDB();
  if (!db) return res.status(503).json({ error: 'face_db_unavailable' });
  try {
    const { _deduplicatePostRecluster } = require('./face-cluster');
    const merged = await _deduplicatePostRecluster(db);
    faceListCacheTs = 0;
    facePerFileCache.clear();
    // Tell face-worker.js (a separate forked process) to drop its in-memory
    // centroid cache. Without this, the worker's assignFace() can still pick
    // a person row this call just merged away and deleted, which fails the
    // faces.person_id foreign-key constraint and silently leaves that face
    // unassigned (see face-worker.js handleInvalidateCache() for full detail).
    workerSend({ type: 'invalidate_cache' });
    res.json({ ok: true, merged });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/faces/scan/start — start / resume background scan
app.post('/api/faces/scan/start', auth, (req, res) => {
  workerSend({ type: 'resume' });
  res.json({ ok: true });
});

// POST /api/faces/scan/pause
app.post('/api/faces/scan/pause', auth, (req, res) => {
  workerSend({ type: 'pause' });
  res.json({ ok: true });
});

// POST /api/faces/scan/cluster — trigger full recluster
app.post('/api/faces/scan/cluster', auth, (req, res) => {
  workerSend({ type: 'cluster' });
  res.json({ ok: true, message: 'Full recluster queued' });
});

// POST /api/faces/scan/rescan { filename }
app.post('/api/faces/scan/rescan', auth, (req, res) => {
  const { filename } = req.body;
  if (!filename) return res.status(400).json({ error: 'filename required' });
  workerSend({ type: 'rescan', filename });
  facePerFileCache.delete(filename);
  res.json({ ok: true });
});

// POST /api/faces/persons/:id/name { name }
app.post('/api/faces/persons/:id/name', auth, async (req, res) => {
  const db = getFaceDB();
  if (!db) return res.status(503).json({ error: 'face_db_unavailable' });

  const personId = parseInt(req.params.id);
  if (!personId) return res.status(400).json({ error: 'invalid_id' });
  const name = (req.body.name || '').trim() || null;

  try {
    const { renamePerson } = require('./face-db');
    await renamePerson(db, personId, name);
    faceListCacheTs = 0;
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/faces/persons/merge { sourceId, targetId }
app.post('/api/faces/persons/merge', auth, async (req, res) => {
  const db = getFaceDB();
  if (!db) return res.status(503).json({ error: 'face_db_unavailable' });

  const { sourceId, targetId } = req.body;
  if (!sourceId || !targetId || sourceId === targetId) {
    return res.status(400).json({ error: 'invalid sourceId / targetId' });
  }

  try {
    const { mergePersons } = require('./face-db');
    const moved = await mergePersons(db, parseInt(sourceId), parseInt(targetId));
    faceListCacheTs = 0;
    facePerFileCache.clear();
    // Previously this sent {type:'cluster'}, which queued a full HDBSCAN
    // recluster (can take up to ~10 min, see face-cluster.js _httpPost
    // timeout) just to refresh the worker's in-memory centroid cache after a
    // 2-row merge. A targeted cache invalidation accomplishes the same
    // correctness goal (worker stops matching against the now-deleted
    // sourceId) without re-running the full clustering pipeline or
    // reshuffling unrelated clusters as a side effect.
    workerSend({ type: 'invalidate_cache' });
    res.json({ ok: true, facesMoved: moved });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/faces/persons/:id
app.delete('/api/faces/persons/:id', auth, async (req, res) => {
  const db = getFaceDB();
  if (!db) return res.status(503).json({ error: 'face_db_unavailable' });

  const personId = parseInt(req.params.id);
  if (!personId) return res.status(400).json({ error: 'invalid_id' });

  try {
    const { deletePerson } = require('./face-db');
    await deletePerson(db, personId);
    faceListCacheTs = 0;
    facePerFileCache.clear();
    // Same stale-cache exposure as /api/faces/deduplicate and /persons/merge:
    // this deletes a persons row from the server process; the worker process's
    // in-memory centroid cache would otherwise keep matching new faces against
    // the now-deleted personId until something else invalidates it.
    workerSend({ type: 'invalidate_cache' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/faces/persons/:id/cover { faceId, lock? }
// Set a custom cover thumbnail for a person.
// lock=true marks it as user-chosen so incremental scans won't overwrite it.
app.put('/api/faces/persons/:id/cover', auth, async (req, res) => {
  const db = getFaceDB();
  if (!db) return res.status(503).json({ error: 'face_db_unavailable' });

  const personId = parseInt(req.params.id);
  if (!personId) return res.status(400).json({ error: 'invalid_id' });

  const faceId = parseInt(req.body.faceId);
  if (!faceId) return res.status(400).json({ error: 'faceId required' });

  const lock = req.body.lock === true || req.body.lock === 'true';

  try {
    const { setPersonCover } = require('./face-db');
    // Verify the face actually belongs to this person
    const face = await db.get('SELECT person_id FROM faces WHERE id = ?', faceId);
    if (!face) return res.status(404).json({ error: 'face_not_found' });
    if (face.person_id !== personId) return res.status(400).json({ error: 'face_not_in_person' });

    await setPersonCover(db, personId, faceId, lock);
    faceListCacheTs = 0;
    res.json({ ok: true, locked: lock });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/faces/persons/:id/cover/by-media  { filename }
// Set person cover from a media filename — full parity for manually-assigned media.
// Tries: (1) face from this person in this file, (2) any face in this file.
// If the file has never been face-scanned, returns 404 with a clear message.
app.put('/api/faces/persons/:id/cover/by-media', auth, async (req, res) => {
  const db = getFaceDB();
  if (!db) return res.status(503).json({ error: 'face_db_unavailable' });

  const personId = parseInt(req.params.id);
  const filename  = req.body.filename;
  if (!personId || !filename) return res.status(400).json({ error: 'personId and filename required' });

  try {
    // Prefer: highest-confidence face from this person in this media
    let face = await db.get(`
      SELECT f.id FROM faces f
      JOIN   media_index m ON m.id = f.media_id
      WHERE  m.filename = ? AND f.person_id = ?
      ORDER  BY f.det_score DESC LIMIT 1
    `, [filename, personId]);

    // Fallback: any face detected in this media (highest confidence)
    if (!face) face = await db.get(`
      SELECT f.id FROM faces f
      JOIN   media_index m ON m.id = f.media_id
      WHERE  m.filename = ?
      ORDER  BY f.det_score DESC LIMIT 1
    `, [filename]);

    if (!face) {
      return res.status(404).json({
        error: 'no_face_in_media',
        message: 'No face detected in this media. Run a face scan first to enable cover selection.'
      });
    }

    const { setPersonCover } = require('./face-db');
    await setPersonCover(db, personId, face.id, true);
    faceListCacheTs = 0;
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/faces/persons/:personId/faces/:faceId
// Remove a face from a cluster (unassigns it; doesn't delete the face row).
app.delete('/api/faces/persons/:personId/faces/:faceId', auth, async (req, res) => {
  const db = getFaceDB();
  if (!db) return res.status(503).json({ error: 'face_db_unavailable' });

  const personId = parseInt(req.params.personId);
  const faceId   = parseInt(req.params.faceId);
  if (!personId || !faceId) return res.status(400).json({ error: 'invalid_ids' });

  try {
    const { removeFaceFromPerson } = require('./face-db');
    await removeFaceFromPerson(db, faceId, personId);
    faceListCacheTs = 0;
    facePerFileCache.clear();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/faces/persons/:personId/faces { faceId }
// Manually assign a face to a different cluster.
app.post('/api/faces/persons/:personId/faces', auth, async (req, res) => {
  const db = getFaceDB();
  if (!db) return res.status(503).json({ error: 'face_db_unavailable' });

  const personId = parseInt(req.params.personId);
  const faceId   = parseInt(req.body.faceId);
  if (!personId || !faceId) return res.status(400).json({ error: 'invalid_ids' });

  try {
    const { addFaceToPersonManual, getPerson } = require('./face-db');
    const person = await getPerson(db, personId);
    if (!person) return res.status(404).json({ error: 'person_not_found' });

    await addFaceToPersonManual(db, faceId, personId);
    faceListCacheTs = 0;
    facePerFileCache.clear();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/faces/persons/:personId/media { filename }
// Manually assign any media file to a cluster — works for all types including
// files with no detected faces.  Assignment is stored in media_cluster_manual
// and merged with AI face associations in /api/faces/media/:filename/persons.
app.post('/api/faces/persons/:personId/media', auth, async (req, res) => {
  const db = getFaceDB();
  if (!db) return res.status(503).json({ error: 'face_db_unavailable' });

  const personId = parseInt(req.params.personId);
  const { filename } = req.body;
  if (!personId || !filename) return res.status(400).json({ error: 'personId and filename required' });

  try {
    const { addMediaToCluster, getPerson } = require('./face-db');
    const person = await getPerson(db, personId);
    if (!person) return res.status(404).json({ error: 'person_not_found' });

    await addMediaToCluster(db, filename, personId);
    facePerFileCache.delete(filename);
    res.json({ ok: true, personId, filename });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/faces/persons/:personId/media/:filename
// Remove a manual media → cluster association.
app.delete('/api/faces/persons/:personId/media/:filename', auth, async (req, res) => {
  const db = getFaceDB();
  if (!db) return res.status(503).json({ error: 'face_db_unavailable' });

  const personId = parseInt(req.params.personId);
  const filename  = decodeURIComponent(req.params.filename);
  if (!personId || !filename) return res.status(400).json({ error: 'personId and filename required' });

  try {
    const { removeMediaFromCluster } = require('./face-db');
    await removeMediaFromCluster(db, filename, personId);
    facePerFileCache.delete(filename);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/faces/feedback/not-this-person { personId, faceId }
// Record that a face does NOT belong to a cluster; removes it from the cluster.
// Also captures the person's centroid at time of rejection so the feedback can be
// re-applied after a full recluster (when person IDs are rebuilt from scratch).
app.post('/api/faces/feedback/not-this-person', auth, async (req, res) => {
  const db = getFaceDB();
  if (!db) return res.status(503).json({ error: 'face_db_unavailable' });

  const { personId, faceId } = req.body;
  if (!personId || !faceId) return res.status(400).json({ error: 'personId and faceId required' });

  try {
    const { recordNotThisPerson } = require('./face-db');

    // Capture person's current centroid so the rejection survives a future recluster
    let rejectedCentroid = null;
    try {
      const personRow = await db.get('SELECT centroid FROM persons WHERE id = ?', parseInt(personId));
      if (personRow && personRow.centroid) rejectedCentroid = personRow.centroid;
    } catch { /* centroid capture is best-effort */ }

    await recordNotThisPerson(db, parseInt(faceId), parseInt(personId), rejectedCentroid);
    faceListCacheTs = 0;
    facePerFileCache.clear();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /thumbs/face/:filename — serve face thumbnail from .face-thumbs/
app.get('/thumbs/face/:filename', auth, (req, res) => {
  const filename = decodeURIComponent(req.params.filename);
  // Sanitise: only allow <digits>.jpg
  if (!/^\d+\.jpg$/i.test(filename)) return res.status(400).end();
  const filePath = path.join(FACE_THUMBS_DIR, filename);
  if (!fs.existsSync(filePath)) return res.status(404).end();
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.sendFile(filePath, { dotfiles: 'allow' }, err => {
    if (err && !res.headersSent) res.status(404).end();
  });
});

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  const lanUrls = Object.values(os.networkInterfaces())
    .flat()
    .filter(addr => addr && addr.family === 'IPv4' && !addr.internal)
    .map(addr => `http://${addr.address}:${PORT}`);

  console.log('\n🔐 VAULT OS running');
  console.log('Local:   http://localhost:' + PORT);
  if (lanUrls.length) console.log('Network: ' + lanUrls.join(', '));
  console.log('📁 Media:     ' + MEDIA_DIR);
  console.log('🖼  Thumbs:    ' + THUMBS_DIR);
  console.log('✅ Sharp:     ' + (sharp ? 'ready' : '❌  npm install sharp'));

  const ff = findFfmpeg();
  if (ff) {
    console.log('✅ FFmpeg:    ready → ' + ff);
  } else {
    console.log('❌ FFmpeg:    NOT FOUND');
    console.log('   Run:       winget install Gyan.FFmpeg');
    console.log('   Then:      close terminal, open new one, restart server');
  }

  // ── Python AI service reminder ───────────────────────────────
  console.log('');
  console.log('🤖 Face AI:  Python microservice required for face indexing');
  console.log('   URL:      ' + FACE_SERVICE_URL);
  console.log('   Start:    cd face_service && start.bat  (Windows)');
  console.log('             cd face_service && ./start.sh  (Linux/Mac)');
  console.log('   Note:     face-worker will wait up to 2 min for the service');
  console.log('');

  // Pre-warm thumbnails 5s after startup (gives server time to settle)
  setTimeout(prewarm, 5000);

  // Start face recognition worker — waits for Python service automatically
  startFaceWorker();
});
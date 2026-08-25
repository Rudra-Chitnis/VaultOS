'use strict';
// ─────────────────────────────────────────────────────────────
//  CONSTANTS
// ─────────────────────────────────────────────────────────────
const PAGE     = 80;   // files per API page
const COLS_D   = 4;    // default columns on desktop
const GAP      = 4;    // px gap between cards
const OVERSCAN = 2;    // extra rows above/below viewport to keep rendered
const MAX_LOAD = 6;    // max simultaneous thumb loads

// ─────────────────────────────────────────────────────────────
//  STATE
// ─────────────────────────────────────────────────────────────
let items=[], total=0, pg=0, loading=false, more=true;
let ctype='all', csearch='';
// Generation counter — incremented on every tab/reset so in-flight fetches from
// a previous tab can detect they're stale and discard their results.
let _fetchGen = 0;
function readFavs() {
  try {
    const raw = JSON.parse(localStorage.getItem('vfavs') || '{}');
    if (Array.isArray(raw)) {
      return raw.reduce((acc, name) => {
        if (typeof name === 'string') acc[name] = 1;
        return acc;
      }, {});
    }
    if (raw && typeof raw === 'object') return raw;
  } catch {}
  return {};
}
function writeFavs() {
  localStorage.setItem('vfavs', JSON.stringify(favs));
}
let favs = readFavs();
const RECENT_KEY = 'vrecent';
const VIEWS_KEY  = 'vviews';
const RECENT_MAX = 200;
function readRecent() {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    return Array.isArray(raw) ? raw.filter(n => typeof n === 'string') : [];
  } catch { return []; }
}
function readViews() {
  try {
    const raw = JSON.parse(localStorage.getItem(VIEWS_KEY) || '{}');
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch { return {}; }
}
function recordMediaView(item) {
  if (!item || !item.name) return;
  const recent = [item.name, ...readRecent().filter(n => n !== item.name)].slice(0, RECENT_MAX);
  localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
  const views = readViews();
  views[item.name] = (parseInt(views[item.name]) || 0) + 1;
  localStorage.setItem(VIEWS_KEY, JSON.stringify(views));
}

// Layout
let cols=COLS_D, cw=0, rh=0;

// ── Phase B: multi-layout state ──────────────────────────
// currentLayout: 'grid' | 'dense' | 'cinematic' | 'masonry' | 'duo'
let currentLayout = localStorage.getItem('vault_layout') || 'grid';
// _positions: per-item {x,y,w,h} used in masonry mode
let _positions = [];

// Virtual scroll — recycled card pool
// pool: array of {el, idx} — cards currently rendered
// freeList: array of DOM nodes not currently in use
let pool=[], freeList=[];

// Image load queue
let loadQ=[], loadActive=0;

// Lightbox
let lbIdx=0, ssOn=false, ssTimer=null, txStart=0;
// Cluster-context lightbox: when viewing media from a person detail, _lbCtx holds
// { items: array, idx: number } so navigation stays within that person's media.
let _lbCtx = null;

// ─────────────────────────────────────────────────────────────
//  FILE KINDS
//  The vault holds more than photos.  The server classifies only
//  image/video/gif and returns 'unknown' for everything else, so we
//  refine that client-side by extension to give documents, archives,
//  code and audio their own identity — icon, label and accent hue.
// ─────────────────────────────────────────────────────────────
const KIND_BY_EXT = {
  pdf:  'pdf',
  doc:  'doc',  docx: 'doc',  odt: 'doc',  rtf: 'doc',  pages: 'doc',
  xls:  'sheet', xlsx: 'sheet', ods: 'sheet', csv: 'sheet', tsv: 'sheet', numbers: 'sheet',
  ppt:  'slide', pptx: 'slide', odp: 'slide', key: 'slide',
  zip:  'archive', rar: 'archive', '7z': 'archive', tar: 'archive', gz: 'archive',
  bz2:  'archive', xz: 'archive', iso: 'archive',
  txt:  'text',  md: 'text',  log: 'text',  nfo: 'text',
  js:   'code',  mjs: 'code', ts: 'code',  tsx: 'code', jsx: 'code', json: 'code',
  html: 'code',  css: 'code', py: 'code',  rb: 'code',  go: 'code',  rs: 'code',
  java: 'code',  c: 'code',   cpp: 'code', h: 'code',   sh: 'code',  yml: 'code',
  yaml: 'code',  xml: 'code', sql: 'code', toml: 'code',
  mp3:  'audio', wav: 'audio', flac: 'audio', aac: 'audio', m4a: 'audio', opus: 'audio',
};

// Icon path data per kind — drawn at 24×24, stroked with currentColor.
const KIND_ICON = {
  pdf:     '<path d="M14 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7l-5-5z"/><path d="M14 2v5h5"/><path d="M9 15h1.5a1.25 1.25 0 0 0 0-2.5H9V18"/><path d="M14 18v-5.5h1a1.5 1.5 0 0 1 0 3h-1"/>',
  doc:     '<path d="M14 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7l-5-5z"/><path d="M14 2v5h5"/><path d="M9 13h6"/><path d="M9 17h4"/>',
  sheet:   '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/><path d="M3 15h18"/><path d="M9 3v18"/><path d="M15 3v18"/>',
  slide:   '<rect x="2.5" y="4" width="19" height="12.5" rx="2"/><path d="M12 16.5V21"/><path d="M8.5 21h7"/>',
  archive: '<path d="M3 7.5h18v11.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7.5z"/><path d="M2 4.5h20v3H2z"/><path d="M10 12h4"/>',
  text:    '<path d="M14 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7l-5-5z"/><path d="M14 2v5h5"/><path d="M9 12h6"/><path d="M9 16h6"/><path d="M9 8h2"/>',
  code:    '<path d="M9 18l-5-6 5-6"/><path d="M15 6l5 6-5 6"/>',
  audio:   '<path d="M9 18V6l11-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/>',
  file:    '<path d="M14 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7l-5-5z"/><path d="M14 2v5h5"/>',
};

const KIND_LABEL = {
  pdf: 'PDF', doc: 'Document', sheet: 'Spreadsheet', slide: 'Presentation',
  archive: 'Archive', text: 'Text', code: 'Code', audio: 'Audio', file: 'File',
};

// Every kind maps to a CSS custom property defined in app.css
const KIND_VAR = {
  pdf: '--k-pdf', doc: '--k-doc', sheet: '--k-sheet', slide: '--k-slide',
  archive: '--k-archive', text: '--k-text', code: '--k-code',
  audio: '--k-audio', file: '--k-text',
};

function extOf(name) {
  const i = (name || '').lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

// True for anything that isn't a visual medium — these render as typed tiles.
function isDocItem(item) {
  return !item || (item.type !== 'image' && item.type !== 'video' && item.type !== 'gif');
}

function kindOf(item) {
  if (!isDocItem(item)) return item.type;
  return KIND_BY_EXT[extOf(item.name)] || 'file';
}

// ─────────────────────────────────────────────────────────────
//  MULTI-SELECT STATE
// ─────────────────────────────────────────────────────────────
let selMode = false;
let selected = new Set();   // filenames
let _lastSelIdx = null;     // anchor for shift-click ranges

// ─────────────────────────────────────────────────────────────
//  DOM REFS
// ─────────────────────────────────────────────────────────────
const gwEl  = document.getElementById('gw');
const ghEl  = document.getElementById('gh');
const gcEl  = document.getElementById('gc');
const sp2El = document.getElementById('sp2');
const empEl = document.getElementById('emp');
const snEl  = document.getElementById('sn');
const stTot = document.getElementById('st-tot');
const stLd  = document.getElementById('st-ld');
const stSh  = document.getElementById('st-sh');
const pfEl  = document.getElementById('pf');
const stxEl = document.getElementById('stx');
const srchEl= document.getElementById('search');
const sbEl  = document.getElementById('sb');
const ovEl  = document.getElementById('ov');
const lbEl  = document.getElementById('lb');
const lbiEl = document.getElementById('lbi');
const lbvEl = document.getElementById('lbv');
const lbnEl = document.getElementById('lbn');
const lbcEl = document.getElementById('lbc');
const lbpfEl= document.getElementById('lbpf');
const spdEl = document.getElementById('spd');
const spdvEl= document.getElementById('spv');

// Video player DOM refs
const vpcEl      = document.getElementById('vpc');
const vpcSeekEl  = document.getElementById('vpc-seek-range');
const vpcProgEl  = document.getElementById('vpc-prog-bar');
const vpcBufEl   = document.getElementById('vpc-buf-bar');
const vpcPPEl    = document.getElementById('vpc-pp');
const vpcMuEl    = document.getElementById('vpc-mu');
const vpcVolEl   = document.getElementById('vpc-vol-sl');
const vpcFsEl    = document.getElementById('vpc-fs');
const vpcTimeEl  = document.getElementById('vpc-time');

// ─────────────────────────────────────────────────────────────
//  HAMBURGER
// ─────────────────────────────────────────────────────────────
document.getElementById('hb').onclick = () => { sbEl.classList.toggle('on'); ovEl.classList.toggle('on'); };
ovEl.onclick = () => { sbEl.classList.remove('on'); ovEl.classList.remove('on'); };

// ─────────────────────────────────────────────────────────────
//  LAYOUT  (Phase B: multi-mode)
// ─────────────────────────────────────────────────────────────
function _hashAspect(str) {
  // Deterministic pseudo-random aspect ratio from filename for masonry variety
  let h = 0;
  for (let i = 0; i < str.length; i++) h = ((h << 5) - h) + str.charCodeAt(i);
  const aspects = [1.0, 1.35, 0.75, 1.2, 0.85, 1.5, 0.9, 1.1, 0.65, 1.4];
  return aspects[Math.abs(h) % aspects.length];
}

function _computeMasonryPositions() {
  const colHeights = new Array(cols).fill(0);
  _positions = items.map(item => {
    const aspect = _hashAspect(item.name || '');
    const h = Math.round(cw * aspect);
    const colIdx = colHeights.indexOf(Math.min(...colHeights));
    const pos = { x: colIdx * (cw + GAP), y: colHeights[colIdx], w: cw, h };
    colHeights[colIdx] += h + GAP;
    return pos;
  });
}

function layout() {
  const w = gwEl.clientWidth;
  const isMobile = window.innerWidth < 640;
  const isTablet = window.innerWidth < 1024;

  switch (currentLayout) {
    case 'dense':
      cols = isMobile ? 4 : Math.max(4, Math.floor((w + GAP) / (90 + GAP)));
      cw   = Math.floor((w - (cols - 1) * GAP) / cols);
      rh   = cw; // square
      break;
    case 'cinematic':
      cols = isMobile ? 1 : isTablet ? 2 : Math.max(2, Math.floor((w + GAP) / (320 + GAP)));
      cw   = Math.floor((w - (cols - 1) * GAP) / cols);
      rh   = Math.round(cw * 9 / 16);
      break;
    case 'duo':
      cols = isMobile ? 1 : 2;
      cw   = cols === 1 ? w : Math.floor((w - GAP) / 2);
      rh   = Math.round(cw * 0.62);
      break;
    case 'masonry':
      cols = isMobile ? 2 : isTablet ? 3 : 4;
      cw   = Math.floor((w - (cols - 1) * GAP) / cols);
      rh   = cw; // base height (actual heights vary per item in _positions)
      _computeMasonryPositions();
      break;
    default: // grid
      {
        const minC = isMobile ? 110 : isTablet ? 130 : 180;
        cols = Math.max(2, Math.floor((w + GAP) / (minC + GAP)));
        cw   = Math.floor((w - (cols - 1) * GAP) / cols);
        rh   = cw;
      }
  }
}

// ─────────────────────────────────────────────────────────────
//  IMAGE LOAD QUEUE  —  prevents simultaneous request flood
// ─────────────────────────────────────────────────────────────
function qLoad(img, src, onDone) {
  loadQ.push({ img, src, onDone });
  pump();
}

function pump() {
  while (loadActive < MAX_LOAD && loadQ.length) {
    const { img, src, onDone } = loadQ.shift();
    // Skip if element removed from DOM
    if (!document.contains(img)) continue;
    loadActive++;
    img.onload  = () => { loadActive--; onDone(true);  pump(); };
    img.onerror = () => { loadActive--; onDone(false); pump(); };
    img.src = src;
  }
}

function cancelLoadsForEl(el) {
  // Remove any pending loads for images inside this element
  const imgs = el.querySelectorAll('img');
  imgs.forEach(img => {
    loadQ = loadQ.filter(q => q.img !== img);
  });
}

// ─────────────────────────────────────────────────────────────
//  CARD DOM FACTORY  —  creates a bare recyclable card element
// ─────────────────────────────────────────────────────────────
function makeCardEl() {
  const el = document.createElement('div');
  el.className = 'c sk';
  el.innerHTML =
    `<img class="c-bg" alt=""/>` +
    `<img class="ti" alt=""/>` +
    `<video class="pv" muted loop playsinline preload="none"></video>` +
    `<div class="dt" style="display:none"><div class="dt-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"></svg></div><div class="dt-body"><div class="dt-name"></div><div class="dt-meta"></div></div></div>` +
    `<button class="cs" tabindex="-1" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg></button>` +
    `<div class="cb"></div>` +
    `<div class="cfa" style="display:none"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="7" r="4"/><path d="M3 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2"/></svg><span></span></div>` +
    `<button class="cf">★</button>` +
    `<div class="cp" style="display:none"><svg viewBox="0 0 48 48" fill="none"><circle cx="24" cy="24" r="24" fill="rgba(0,0,0,.55)"/><polygon points="19,15 37,24 19,33" fill="rgba(255,255,255,.9)"/></svg></div>` +
    `<div class="cn" style="display:none"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/></svg><span></span></div>` +
    `<div class="c-ov"><span class="c-ov-name"></span></div>`;
  return el;
}

// ─────────────────────────────────────────────────────────────
//  CLEAR CARD VISUALS — called whenever a card moves to freeList
//  Hides the element and wipes its thumbnail so stale content
//  from a previous tab never bleeds through into a new render.
// ─────────────────────────────────────────────────────────────
function clearCardVisuals(el) {
  el.style.visibility = 'hidden';
  const img = el.querySelector('img.ti');
  if (img) { img.src = ''; img.className = 'ti'; }
  const bgImg = el.querySelector('img.c-bg');
  if (bgImg) bgImg.src = '';
  const dt = el.querySelector('.dt');
  if (dt) dt.style.display = 'none';
  el.classList.remove('is-doc', 'is-sel');
  el._item = null;
}

// ─────────────────────────────────────────────────────────────
//  BIND ITEM DATA TO RECYCLED CARD
// ─────────────────────────────────────────────────────────────
function bindCard(el, item, idx, ctxItems = null) {
  const ext = item.name.split('.').pop().toUpperCase();
  const isFav = !!favs[item.name];

  // Reset state — including any active preview
  cancelLoadsForEl(el);
  stopCardPreview(el);
  el.style.visibility = '';   // restore after clearCardVisuals
  el.className = 'c sk';
  el._item = item;
  el._idx  = idx;
  el._ctxItems = ctxItems;

  const img    = el.querySelector('img.ti');
  const badge  = el.querySelector('.cb');
  const faBadge= el.querySelector('.cfa');
  const fvBtn  = el.querySelector('.cf');
  const play   = el.querySelector('.cp');
  const noth   = el.querySelector('.cn');
  const ovName = el.querySelector('.c-ov-name');

  img.src = '';
  img.className = 'ti';
  const bgImg = el.querySelector('img.c-bg');
  if (bgImg) bgImg.src = '';
  badge.textContent = ext;
  fvBtn.className = 'cf' + (isFav ? ' on' : '');
  play.style.display = item.type === 'video' ? 'flex' : 'none';
  noth.style.display = 'none';
  noth.querySelector('span').textContent = ext;
  if (ovName) ovName.textContent = item.name;

  // Face count badge
  const faceCount = (item.facePersonIds || []).length;
  if (faceCount > 0) {
    faBadge.querySelector('span').textContent = faceCount;
    faBadge.style.display = 'flex';
  } else {
    faBadge.style.display = 'none';
  }

  // Load thumbnail with smart retry for video/gif
  let retries = 0;
  const MAX_RETRIES = 4;
  const RETRY_DELAYS = [5000, 10000, 20000, 35000];

  function tryLoadThumb() {
    if (el._item !== item) return;
    const src = retries === 0 ? item.thumb : item.thumb + '?t=' + Date.now();
    qLoad(img, src, ok => {
      if (el._item !== item) return;
      if (ok) {
        el.classList.remove('sk');
        img.classList.add('v');
        if (bgImg) bgImg.src = src;
        return;
      }
      if (item.type === 'image') {
        el.classList.remove('sk');
        qLoad(img, item.url, ok2 => {
          if (el._item !== item) return;
          if (ok2) { img.classList.add('v'); if (bgImg) bgImg.src = item.url; }
          else noth.style.display = 'flex';
        });
        return;
      }
      if (retries < MAX_RETRIES) {
        const delay = RETRY_DELAYS[retries];
        retries++;
        setTimeout(tryLoadThumb, delay);
        return;
      }
      el.classList.remove('sk');
      noth.style.display = 'flex';
    });
  }

  // Always try immediately - thumbs are pre-generated on server
  // hasThumb flag from API tells us if file exists, but try regardless
  tryLoadThumb();

  // Fav click
  fvBtn.onclick = e => {
    e.stopPropagation();
    const wasFav = !!favs[item.name];
    if (wasFav) { delete favs[item.name]; fvBtn.classList.remove('on'); }
    else { favs[item.name]=1; fvBtn.classList.add('on'); }
    writeFavs();
    if (ctype === 'fav' && wasFav) fetchPage(true);
  };

  // Card click → lightbox
  el.onclick = e => {
    if (e.target === fvBtn) return;
    if (el._ctxItems) openContextLB(el._ctxItems, idx);
    else openLB(idx);
  };
}

// ─────────────────────────────────────────────────────────────
//  VIRTUAL SCROLL — RECYCLING ENGINE
//  Instead of destroying/creating DOM nodes, we reuse them.
//  pool[] tracks which data index each card is showing.
//  freeList[] holds unused card elements ready to reuse.
// ─────────────────────────────────────────────────────────────
function rowH() { return rh + GAP; }

function totalRows() { return Math.ceil(items.length / cols); }

function visRange() {
  const st  = gwEl.scrollTop;
  const vh  = gwEl.clientHeight;
  const rh2 = rowH();
  const fr  = Math.max(0, Math.floor(st / rh2) - OVERSCAN);
  const lr  = Math.min(totalRows() - 1, Math.floor((st + vh) / rh2) + OVERSCAN);
  return { fr, lr };
}

function indexRange(fr, lr) {
  const first = fr * cols;
  const last  = Math.min(items.length - 1, (lr + 1) * cols - 1);
  return { first, last };
}

// Masonry-aware visible range: scan _positions[] for items overlapping viewport
function visRangeMasonry() {
  const st   = gwEl.scrollTop;
  const vh   = gwEl.clientHeight;
  const pad  = (rh + GAP) * OVERSCAN;
  const top  = st - pad;
  const bot  = st + vh + pad;
  let first  = items.length, last = -1;
  for (let i = 0; i < _positions.length; i++) {
    const p = _positions[i];
    if (!p) continue;
    if (p.y + p.h >= top && p.y <= bot) {
      if (i < first) first = i;
      if (i > last)  last  = i;
    }
  }
  return {
    first: Math.max(0, first),
    last:  Math.min(items.length - 1, last)
  };
}

function renderGrid() {
  if (!cols || !cw) return;

  // Determine visible item range based on layout mode
  let first, last;
  if (currentLayout === 'masonry') {
    if (_positions.length === 0 && items.length > 0) _computeMasonryPositions();
    const r = visRangeMasonry();
    first = r.first; last = r.last;
  } else {
    const { fr, lr } = visRange();
    const range = indexRange(fr, lr);
    first = range.first; last = range.last;
  }

  // Guard: nothing to render
  if (last < 0 || first > last) {
    pool.forEach(p => {
      if (typeof stopCardPreview !== 'undefined') stopCardPreview(p.el);
      if (typeof previewObserver !== 'undefined') previewObserver.unobserve(p.el);
      clearCardVisuals(p.el);
      freeList.push(p.el);
    });
    pool = [];
    return;
  }

  // Find pool entries no longer in range → recycle them
  const keep = new Set();
  const toFree = [];
  pool.forEach(p => {
    if (p.idx >= first && p.idx <= last) keep.add(p.idx);
    else toFree.push(p);
  });
  toFree.forEach(p => {
    if (typeof stopCardPreview !== 'undefined') stopCardPreview(p.el);
    if (typeof previewObserver !== 'undefined') previewObserver.unobserve(p.el);
    clearCardVisuals(p.el);
    freeList.push(p.el);
  });
  pool = pool.filter(p => keep.has(p.idx));

  const rendered = new Set(pool.map(p => p.idx));

  // Render new items
  for (let i = first; i <= last; i++) {
    if (rendered.has(i) || i >= items.length) continue;
    const item = items[i];

    // Get or create card element
    let el = freeList.pop();
    if (!el) {
      el = makeCardEl();
      gcEl.appendChild(el);
    } else if (!gcEl.contains(el)) {
      gcEl.appendChild(el);
    }

    bindCard(el, item, i);
    pool.push({ el, idx: i });

    // Position using transform (no layout thrash)
    let x, y, w, h;
    if (currentLayout === 'masonry' && _positions[i]) {
      ({ x, y, w, h } = _positions[i]);
    } else {
      const row = Math.floor(i / cols);
      const col = i % cols;
      x = col * (cw + GAP);
      y = row * rowH();
      w = cw; h = rh;
    }
    el.style.transform = `translate(${x}px,${y}px)`;
    el.style.width  = w + 'px';
    el.style.height = h + 'px';

    // Register card with preview observer (video/gif only)
    if ((item.type === 'video' || item.type === 'gif') && typeof previewObserver !== 'undefined') {
      previewObserver.observe(el);
    }
  }
}

function updateSpacer() {
  let h;
  if (currentLayout === 'masonry' && _positions.length > 0) {
    h = _positions.reduce((m, p) => Math.max(m, p.y + p.h), 0);
  } else {
    h = totalRows() * rowH();
  }
  ghEl.style.minHeight = (h + 80) + 'px';
}

// ─────────────────────────────────────────────────────────────
//  FETCH
// ─────────────────────────────────────────────────────────────
async function fetchPage(reset=false) {
  // Non-reset calls: block if already loading or nothing more to fetch.
  // Reset calls: always proceed — they invalidate in-flight fetches via _fetchGen.
  if (!reset && (loading || !more)) return;

  // Claim this generation slot.  Any in-flight fetch from a previous generation
  // will compare its saved gen against _fetchGen after its await and bail out.
  const myGen = reset ? ++_fetchGen : _fetchGen;

  loading = true;
  sp2El.classList.add('on');

  if (reset) {
    pg = 0; more = true;

    // ── Hard-isolate card pool ──────────────────────────────
    // Stop all active previews BEFORE clearing pool so _previewCount decrements
    // correctly, then unobserve cards so the IntersectionObserver doesn't fire
    // callbacks on recycled elements assigned to a different tab's items.
    pool.forEach(p => {
      stopCardPreview(p.el);                  // stops video/GIF, decrements counter
      previewObserver.unobserve(p.el);        // remove from observer
      cancelLoadsForEl(p.el);
      clearCardVisuals(p.el);                 // wipe thumbnail + hide so old tab content never bleeds
      freeList.push(p.el);
    });
    pool = [];
    items = [];                               // clear AFTER pool so stopCardPreview can read _item
    _previewCount = 0;                        // hard-reset counter — prevents drift across tabs
    loadQ = []; loadActive = 0;
    _positions = [];                          // reset masonry positions on new fetch
    gwEl.scrollTop = 0;
    layout(); updateSpacer();
  }

  try {
    // ── Favorites mode ──────────────────────────────────────
    // Fetch all filenames in one call, filter client-side by localStorage favs.
    if (ctype === 'fav') {
      const r = await fetch(`/api/filenames?search=${encodeURIComponent(csearch)}`);
      if (_fetchGen !== myGen) return;        // stale — newer tab switch happened
      if (r.status === 401) { location.href = '/login.html'; return; }
      const d = await r.json();
      if (_fetchGen !== myGen) return;

      // Reload favs from localStorage in case they changed since last render
      favs = readFavs();
      items = (d.items || []).filter(it => favs[it.name]);
      total = items.length;
      more  = false; // no pagination in favorites mode
      updateStats(); layout(); updateSpacer(); renderGrid();
      return;
    }

    if (ctype === 'recent' || ctype === 'viewed') {
      const r = await fetch(`/api/filenames?search=${encodeURIComponent(csearch)}`);
      if (_fetchGen !== myGen) return;
      if (r.status === 401) { location.href = '/login.html'; return; }
      const d = await r.json();
      if (_fetchGen !== myGen) return;

      const all = d.items || [];
      if (ctype === 'recent') {
        const order = new Map(readRecent().map((name, i) => [name, i]));
        items = all.filter(it => order.has(it.name)).sort((a, b) => order.get(a.name) - order.get(b.name));
      } else {
        const views = readViews();
        items = all
          .filter(it => (parseInt(views[it.name]) || 0) > 0)
          .sort((a, b) => (parseInt(views[b.name]) || 0) - (parseInt(views[a.name]) || 0));
      }
      total = items.length;
      more = false;
      updateStats(); layout(); updateSpacer(); renderGrid();
      return;
    }

    // ── Normal paginated mode ────────────────────────────────
    const r = await fetch(`/api/files?page=${pg}&limit=${PAGE}&type=${ctype}&search=${encodeURIComponent(csearch)}`);
    if (_fetchGen !== myGen) return;
    if (r.status === 401) { location.href = '/login.html'; return; }
    const d = await r.json();
    if (_fetchGen !== myGen) return;

    total = d.total; more = d.hasMore === true;
    if (!d.items || d.items.length === 0) more = false; // termination guard
    items = items.concat(d.items || []); pg++;
    updateStats(); layout(); updateSpacer(); renderGrid();
  } catch (e) {
    if (_fetchGen !== myGen) return; // ignore errors from stale fetches
    console.error(e);
  } finally {
    // Only the current generation releases the loading flag
    if (_fetchGen === myGen) {
      loading = false;
      sp2El.classList.remove('on');
    }
  }
}

function updateStats() {
  stTot.textContent = total.toLocaleString();
  stLd.textContent  = items.length.toLocaleString();
  stSh.textContent  = items.length.toLocaleString();
  pfEl.style.width  = (total ? items.length/total*100 : 0)+'%';
  stxEl.innerHTML   = `Ready — <b>${items.length.toLocaleString()}</b> files`;

  if (!more && !items.length) {
    empEl.style.display = 'flex';
    // Contextual empty-state message
    if (ctype === 'fav') {
      empEl.innerHTML =
        `<svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polygon points="12,2 15.09,8.26 22,9.27 17,14.14 18.18,21.02 12,17.77 5.82,21.02 7,14.14 2,9.27 8.91,8.26 12,2"/></svg>` +
        `No favorites yet<br><small style="opacity:.55">Click ★ on any media to save it here</small>`;
    } else if (ctype === 'recent') {
      empEl.innerHTML =
        `<svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>` +
        `No recent media yet<br><small style="opacity:.55">Open media to build history</small>`;
    } else if (ctype === 'viewed') {
      empEl.innerHTML =
        `<svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z"/><circle cx="12" cy="12" r="3"/></svg>` +
        `No viewed media yet<br><small style="opacity:.55">Open media to count views</small>`;
    } else if (csearch) {
      empEl.innerHTML =
        `<svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>` +
        `No results for "<b style="color:var(--t)">${csearch}</b>"`;
    } else {
      empEl.innerHTML =
        `<svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 20M14 8h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>No files found`;
    }
  } else {
    empEl.style.display = 'none';
  }
}

// ─────────────────────────────────────────────────────────────
//  SCROLL  —  rAF throttled, never blocks main thread
// ─────────────────────────────────────────────────────────────
let rafPending = false;
gwEl.addEventListener('scroll', () => {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    renderGrid();
    // Infinite load trigger
    const nearBottom = gwEl.scrollTop + gwEl.clientHeight > gwEl.scrollHeight - 1500;
    if (nearBottom && !loading && more) fetchPage();
  });
}, { passive: true });

// ─────────────────────────────────────────────────────────────
//  RESIZE
// ─────────────────────────────────────────────────────────────
let resT;
window.addEventListener('resize', () => {
  clearTimeout(resT);
  resT = setTimeout(() => {
    // Return all to freeList, recalculate, re-render
    pool.forEach(p => { cancelLoadsForEl(p.el); clearCardVisuals(p.el); freeList.push(p.el); });
    pool=[];
    loadQ=[]; loadActive=0;
    _positions = []; // force masonry recompute
    layout(); updateSpacer(); renderGrid();
  }, 200);
});

// ─────────────────────────────────────────────────────────────
//  SET LAYOUT  (Phase B)
// ─────────────────────────────────────────────────────────────
function setLayout(mode) {
  currentLayout = mode;
  localStorage.setItem('vault_layout', mode);
  gwEl.dataset.layout = mode;

  // Update UI active state
  document.querySelectorAll('.lm-btn').forEach(b => b.classList.toggle('on', b.dataset.layout === mode));

  // Full pool reset — all cards get recycled and re-measured
  pool.forEach(p => {
    cancelLoadsForEl(p.el);
    if (typeof stopCardPreview !== 'undefined') stopCardPreview(p.el);
    if (typeof previewObserver !== 'undefined') previewObserver.unobserve(p.el);
    clearCardVisuals(p.el);
    freeList.push(p.el);
  });
  pool = []; loadQ = []; loadActive = 0;
  _positions = [];
  layout(); updateSpacer(); renderGrid();
}

// ─────────────────────────────────────────────────────────────
//  SEARCH  — global unified search with person suggestions (Task 5)
// ─────────────────────────────────────────────────────────────
const suggEl = document.getElementById('search-sugg');
let srchT, suggT;
let _suggVisible = false;

function hideSugg() {
  suggEl.classList.remove('on');
  _suggVisible = false;
}

function showSugg() {
  suggEl.classList.add('on');
  _suggVisible = true;
}

async function fetchSuggestions(q) {
  if (!q || q.length < 2) { hideSugg(); return; }
  try {
    // Parallel fetch: cluster names + media filenames
    const [pr, fr] = await Promise.all([
      fetch(`/api/faces/persons?search=${encodeURIComponent(q)}&limit=5&offset=0`),
      fetch(`/api/files?page=0&limit=4&type=all&search=${encodeURIComponent(q)}`),
    ]);
    const [pd, fd] = await Promise.all([
      pr.ok ? pr.json() : { items: [] },
      fr.ok ? fr.json() : { items: [] },
    ]);
    const persons = pd.items || [];
    const files   = (fd.items || []).slice(0, 4);

    if (!persons.length && !files.length) { hideSugg(); return; }

    suggEl.innerHTML = '';

    // ── Clusters section ────────────────────────────────────
    if (persons.length) {
      const sect = document.createElement('div');
      sect.className = 'sugg-sect'; sect.textContent = 'Clusters';
      suggEl.appendChild(sect);

      persons.forEach(p => {
        const name  = p.name || `Person ${p.id}`;
        const count = p.faceCount || p.face_count || 0;
        const thumb = p.coverThumb || null;
        const item  = document.createElement('div');
        item.className = 'sugg-item';
        item.innerHTML =
          `<div class="sugg-av">${
            thumb
              ? `<img src="${thumb}" alt="" loading="lazy"/>`
              : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="8" r="4"/><path d="M4 20a8 8 0 0 1 16 0"/></svg>`
          }</div>` +
          `<span class="sugg-name">${name}</span>` +
          `<span class="sugg-meta">${count} face${count===1?'':'s'}</span>`;
        item.addEventListener('mousedown', e => {
          e.preventDefault();
          hideSugg(); srchEl.value = ''; csearch = '';
          navigateToPerson(p);
        });
        suggEl.appendChild(item);
      });
    }

    // ── Media section ────────────────────────────────────────
    if (files.length) {
      const sect = document.createElement('div');
      sect.className = 'sugg-sect';
      if (persons.length) sect.style.marginTop = '4px';
      sect.textContent = 'Media';
      suggEl.appendChild(sect);

      files.forEach(f => {
        const ext  = f.name.split('.').pop().toUpperCase();
        const item = document.createElement('div');
        item.className = 'sugg-item';
        item.innerHTML =
          `<div class="sugg-av" style="border-radius:4px">${
            f.thumb
              ? `<img src="${f.thumb}" alt="" loading="lazy" style="width:100%;height:100%;object-fit:cover"/>`
              : `<div style="display:flex;align-items:center;justify-content:center;width:100%;height:100%;font-size:7px;font-family:'IBM Plex Mono',monospace;color:var(--t3)">${ext}</div>`
          }</div>` +
          `<span class="sugg-name" style="font-size:11px">${f.name}</span>` +
          `<span class="sugg-meta">${f.type||ext}</span>`;
        item.addEventListener('mousedown', e => {
          e.preventDefault();
          hideSugg(); srchEl.value = ''; csearch = '';
          openFileFromSearch(f);
        });
        suggEl.appendChild(item);
      });
    }

    showSugg();
  } catch (e) {
    console.debug('[sugg]', e.message);
  }
}

// Open a specific media file from search suggestions without disrupting gallery state.
// If gallery has no items loaded, triggers a silent reload in the background.
function openFileFromSearch(fileItem) {
  if (viewMode !== 'gallery') {
    // Silently show gallery (no loadPeople, no history push — just show the view)
    viewMode = 'gallery';
    ppEl.classList.remove('on');
    gwWrapEl.style.display = '';
    frEl.style.display     = '';
    stEl.style.display     = '';
    srchEl.placeholder     = 'Search files, people…';
    document.querySelectorAll('.snb').forEach(b => b.classList.remove('on'));
    const nav = document.querySelector(`.snb[data-t="${ctype}"]`);
    if (nav) nav.classList.add('on');
    if (!items.length) fetchPage(true); // reload gallery in background if empty
  }
  // Open in single-item context lightbox — doesn't affect main gallery items[]
  openContextLB([fileItem], 0);
}

// Search clear button
const srchClearEl = document.getElementById('search-clear');
const srchWrapEl  = document.getElementById('sw');
srchClearEl.addEventListener('mousedown', e => {
  e.preventDefault();
  srchEl.value = '';
  srchEl.classList.remove('has-value');
  srchWrapEl.classList.remove('active');
  hideSugg();
  if (viewMode === 'gallery' && csearch) { csearch = ''; fetchPage(true); }
  else if (viewMode === 'people' && pdPersonId === null) loadPeople(true);
  srchEl.focus();
});

srchEl.addEventListener('input', () => {
  clearTimeout(srchT);
  clearTimeout(suggT);
  const q = srchEl.value.trim();
  // Toggle clear button visibility
  if (q) { srchEl.classList.add('has-value'); srchWrapEl.classList.add('active'); }
  else   { srchEl.classList.remove('has-value'); srchWrapEl.classList.remove('active'); }
  srchT = setTimeout(() => {
    if (viewMode === 'gallery') {
      // Gallery: filter media files
      csearch = q; fetchPage(true);
    } else if (viewMode === 'people' && pdPersonId === null) {
      // People list: filter cluster grid
      if (q.length >= 1) loadPeopleFiltered(q);
      else loadPeople(true);         // empty query → reload full list
    }
  }, 350);
  // Always show suggestions dropdown (clusters + media)
  suggT = setTimeout(() => fetchSuggestions(q), 250);
});

srchEl.addEventListener('focus', () => {
  if (srchEl.value.trim().length >= 2 && _suggVisible) showSugg();
});

srchEl.addEventListener('blur', () => {
  // Small delay so mousedown on suggestions fires first
  setTimeout(hideSugg, 200);
});

// ESC: close suggestions; if search is active also clear it and reload
srchEl.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    hideSugg();
    if (srchEl.value) {
      srchEl.value = '';
      if (viewMode === 'gallery' && csearch) { csearch = ''; fetchPage(true); }
      else if (viewMode === 'people' && pdPersonId === null) loadPeople(true);
    }
    srchEl.blur();
  }
});

// Close suggestions when clicking outside
document.addEventListener('click', e => {
  if (!e.target.closest('#sw')) hideSugg();
});

// ─────────────────────────────────────────────────────────────
//  TYPE FILTER
// ─────────────────────────────────────────────────────────────
function setType(t) {
  saveScroll();          // preserve current view's scroll before switching
  // If we're in people view, switch DOM to gallery first WITHOUT triggering a
  // fetch — setType handles the fetch below.  This also sets viewMode='gallery'
  // synchronously so the secondary override listeners that fire on the same
  // click event will see viewMode==='gallery' and skip their own showGalleryView()
  // call, preventing a double fetchPage(true).
  if (viewMode !== 'gallery') showGalleryView(true);
  // Clear all search state — prevents stale filter bleed across tabs
  csearch = '';
  srchEl.value = '';
  srchEl.classList.remove('has-value');
  document.getElementById('sw').classList.remove('active');
  hideSugg();
  ctype = t;
  document.querySelectorAll('.ft,.snb').forEach(b => b.classList.toggle('on', b.dataset.t === t));
  sbEl.classList.remove('on'); ovEl.classList.remove('on');
  fetchPage(true).then(() => restoreScroll(`gallery_${t}`));
}
document.querySelectorAll('.ft,.snb[data-t]').forEach(b => b.addEventListener('click', () => setType(b.dataset.t)));

// ─────────────────────────────────────────────────────────────
//  PREMIUM VIDEO PLAYER
// ─────────────────────────────────────────────────────────────

const VPC_SVG = {
  play:   '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>',
  pause:  '<svg viewBox="0 0 24 24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>',
  vol:    '<svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>',
  muted:  '<svg viewBox="0 0 24 24"><path d="M16.5 12A4.5 4.5 0 0 0 14 7.97v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51A8.796 8.796 0 0 0 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06A8.99 8.99 0 0 0 17.73 18l2 2L21 18.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/></svg>',
  fs:     '<svg viewBox="0 0 24 24"><path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg>',
  exitFs: '<svg viewBox="0 0 24 24"><path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z"/></svg>',
};

let _vpcRaf      = null;   // rAF handle for UI updates
let _vpcHideT    = null;   // auto-hide timer
let _vpcSeeking  = false;  // true while user drags the seek thumb
let _vpcActive   = false;  // true when a video is loaded

function _vpcFmt(s) {
  if (!isFinite(s) || isNaN(s)) return '0:00';
  const m = Math.floor(s / 60);
  return m + ':' + String(Math.floor(s % 60)).padStart(2, '0');
}

function _vpcUpdateUI() {
  if (!_vpcActive) return;
  const dur = lbvEl.duration || 0;
  const cur = lbvEl.currentTime || 0;
  const pct = dur > 0 ? (cur / dur) * 100 : 0;

  if (!_vpcSeeking) {
    vpcSeekEl.value  = dur > 0 ? (cur / dur) * 10000 : 0;
    vpcProgEl.style.width = pct + '%';
  }

  // buffered
  if (lbvEl.buffered && lbvEl.buffered.length > 0) {
    const bufEnd = lbvEl.buffered.end(lbvEl.buffered.length - 1);
    vpcBufEl.style.width = (dur > 0 ? (bufEnd / dur) * 100 : 0) + '%';
  }

  vpcTimeEl.textContent = _vpcFmt(cur) + ' / ' + _vpcFmt(dur);
  vpcPPEl.innerHTML     = lbvEl.paused ? VPC_SVG.play : VPC_SVG.pause;
  const isMuted         = lbvEl.muted || lbvEl.volume === 0;
  document.getElementById('vpc-vol-icon').outerHTML =
    (isMuted ? VPC_SVG.muted : VPC_SVG.vol).replace('<svg ', '<svg id="vpc-vol-icon" ');

  _vpcRaf = requestAnimationFrame(_vpcUpdateUI);
}

function vpcShow(autoHide) {
  vpcEl.classList.add('vp-show');
  clearTimeout(_vpcHideT);
  if (autoHide && !lbvEl.paused) {
    _vpcHideT = setTimeout(() => vpcEl.classList.remove('vp-show'), 3200);
  }
}

function vpcHide() {
  clearTimeout(_vpcHideT);
  vpcEl.classList.remove('vp-show');
}

function vpcTogglePlay() {
  if (lbvEl.paused) { lbvEl.play().catch(() => {}); }
  else              { lbvEl.pause(); }
  vpcShow(true);
}

function vpcToggleMute() {
  lbvEl.muted = !lbvEl.muted;
  vpcShow(true);
}

function vpcToggleFs() {
  const container = document.getElementById('lbmw');
  if (!document.fullscreenElement) {
    (container.requestFullscreen || container.webkitRequestFullscreen ||
     container.mozRequestFullScreen || container.msRequestFullscreen)
     .call(container).catch(() => {});
  } else {
    (document.exitFullscreen || document.webkitExitFullscreen ||
     document.mozCancelFullScreen || document.msExitFullscreen)
     .call(document).catch(() => {});
  }
  vpcShow(true);
}

function _vpcFsIcon() {
  vpcFsEl.innerHTML = document.fullscreenElement ? VPC_SVG.exitFs : VPC_SVG.fs;
}

function vpcInit() {
  // Reset seek to 0 — src just changed
  vpcSeekEl.value = 0;
  vpcProgEl.style.width = '0%';
  vpcBufEl.style.width  = '0%';
  vpcTimeEl.textContent = '0:00 / 0:00';
  vpcPPEl.innerHTML     = VPC_SVG.pause;
  vpcFsEl.innerHTML     = VPC_SVG.fs;
  _vpcActive = true;
  vpcShow(true);
  if (_vpcRaf) cancelAnimationFrame(_vpcRaf);
  _vpcRaf = requestAnimationFrame(_vpcUpdateUI);
}

function vpcDispose() {
  _vpcActive = false;
  if (_vpcRaf) { cancelAnimationFrame(_vpcRaf); _vpcRaf = null; }
  clearTimeout(_vpcHideT);
  vpcEl.classList.remove('vp-show');
}

// Seek scrubber — drag support
vpcSeekEl.addEventListener('mousedown', () => { _vpcSeeking = true; });
vpcSeekEl.addEventListener('touchstart', () => { _vpcSeeking = true; }, { passive: true });

vpcSeekEl.addEventListener('input', () => {
  const dur = lbvEl.duration || 0;
  if (!dur) return;
  const t = (vpcSeekEl.value / 10000) * dur;
  vpcProgEl.style.width = ((t / dur) * 100) + '%';
  vpcTimeEl.textContent = _vpcFmt(t) + ' / ' + _vpcFmt(dur);
});

vpcSeekEl.addEventListener('change', () => {
  const dur = lbvEl.duration || 0;
  if (dur) lbvEl.currentTime = (vpcSeekEl.value / 10000) * dur;
  _vpcSeeking = false;
  vpcShow(true);
});

// Volume slider
vpcVolEl.addEventListener('input', () => {
  lbvEl.volume = parseFloat(vpcVolEl.value);
  lbvEl.muted  = (lbvEl.volume === 0);
  vpcShow(true);
});

// Button clicks
vpcPPEl.addEventListener('click', e => { e.stopPropagation(); vpcTogglePlay(); });
vpcMuEl.addEventListener('click', e => { e.stopPropagation(); vpcToggleMute(); });
vpcFsEl.addEventListener('click', e => { e.stopPropagation(); vpcToggleFs(); });

// Clicking directly on the video toggles play/pause and shows controls
lbvEl.addEventListener('click', e => { e.stopPropagation(); if (_vpcActive) vpcTogglePlay(); });

// Mouse movement over the player area shows controls
document.getElementById('lbmw').addEventListener('mousemove', () => {
  if (_vpcActive) vpcShow(true);
});

// Sync video events → update controls
lbvEl.addEventListener('play',  () => { vpcShow(true); });
lbvEl.addEventListener('pause', () => { vpcShow(false); }); // stay visible when paused
lbvEl.addEventListener('ended', () => { vpcShow(false); });
lbvEl.addEventListener('loadedmetadata', () => { if (_vpcActive) vpcShow(true); });

// Fullscreen change — update icon
document.addEventListener('fullscreenchange', _vpcFsIcon);
document.addEventListener('webkitfullscreenchange', _vpcFsIcon);

// ─────────────────────────────────────────────────────────────
//  LIGHTBOX
// ─────────────────────────────────────────────────────────────
function openLB(idx) {
  lbIdx=idx; lbEl.classList.add('on'); document.body.style.overflow='hidden';
  showLB();
  maybeShowSwipeHint();
}

// Open lightbox in cluster context (person detail view) — does NOT switch view mode.
// ctxItems: array of media item objects; idx: starting index within that array.
function openContextLB(ctxItems, idx) {
  _lbCtx = { items: ctxItems, idx: Math.max(0, Math.min(idx, ctxItems.length-1)) };
  lbEl.classList.add('on');
  document.body.style.overflow = 'hidden';
  showLB();
  maybeShowSwipeHint();
}

function closeLB() {
  stopSS();
  lbEl.classList.remove('on');
  lbEl.classList.remove('assign-open'); // ensure dim/block state is always cleared
  vpcDispose();
  lbvEl.pause(); lbvEl.src = ''; lbvEl.style.display = 'none'; lbiEl.style.display = 'none';
  clearFaceOverlay();
  document.body.style.overflow = '';
  _lbCtx = null; // exit cluster context
  document.getElementById('lb-persons').innerHTML = ''; // clear person chips
  if (viewMode === 'gallery' && (ctype === 'recent' || ctype === 'viewed')) fetchPage(true);
}
function showLB() {
  // Support both gallery mode and cluster-context mode
  const _items = _lbCtx ? _lbCtx.items : items;
  const _idx   = _lbCtx ? _lbCtx.idx   : lbIdx;
  const it = _items[_idx]; if(!it) return;
  recordMediaView(it);
  lbnEl.textContent=it.name;
  lbcEl.textContent=`${_idx+1}/${_items.length}`;
  lbvEl.pause(); lbvEl.style.display='none'; lbiEl.style.display='none';
  vpcDispose();
  clearFaceOverlay();
  // Show/hide gallery nav arrows based on media type
  const navStyle = it.type === 'video' ? 'none' : '';
  document.getElementById('lbpv').style.display = navStyle;
  document.getElementById('lbnx').style.display = navStyle;

  if (it.type==='video') {
    lbvEl.src=it.url;
    lbvEl.style.display='block';
    // Trigger fade-in animation
    lbvEl.classList.remove('lb-nav-anim');
    void lbvEl.offsetWidth;
    lbvEl.classList.add('lb-nav-anim');
    lbvEl.play().catch(()=>{});
    vpcInit();
  } else {
    lbiEl.src=it.url; lbiEl.style.display='block';
    // Trigger fade-in animation
    lbiEl.classList.remove('lb-nav-anim');
    void lbiEl.offsetWidth;
    lbiEl.classList.add('lb-nav-anim');
  }
  // Load face bounding boxes asynchronously (non-blocking)
  loadLightboxFaces(it);
  // Load person chips for this media item (Task 6)
  loadLbPersonChips(it);
  // Preload next item's thumbnail
  const nxt = _items[_idx+1];
  if (nxt && nxt.type!=='video') new Image().src=nxt.thumb||nxt.url;
  // In gallery mode only: trigger next page fetch near end
  if (!_lbCtx && _idx>=items.length-5 && more) fetchPage();
  if (ssOn) restartSS();
}
function lbGo(d) {
  if (_lbCtx) {
    const ni = _lbCtx.idx + d;
    if (ni < 0 || ni >= _lbCtx.items.length) return;
    _lbCtx.idx = ni;
  } else {
    const ni = lbIdx + d;
    if (ni < 0 || ni >= items.length) return;
    lbIdx = ni;
  }
  showLB();
}

function getSSD() { return parseInt(spdEl.value)*1000; }
function startSS() {
  ssOn=true;
  document.getElementById('lb-ss').classList.add('on');
  document.getElementById('lb-ss').textContent='⏸ Pause';
  restartSS();
}
function stopSS() {
  ssOn=false; clearTimeout(ssTimer); ssTimer=null;
  lbpfEl.style.transition='none'; lbpfEl.style.width='0%';
  const b=document.getElementById('lb-ss');
  if(b){b.classList.remove('on');b.textContent='▶ Slideshow';}
}
function restartSS() {
  clearTimeout(ssTimer);
  const d=getSSD();
  lbpfEl.style.transition='none'; lbpfEl.style.width='0%';
  lbpfEl.offsetWidth;
  lbpfEl.style.transition=`width ${d}ms linear`; lbpfEl.style.width='100%';
  ssTimer=setTimeout(()=>{
    const _items = _lbCtx ? _lbCtx.items : items;
    const _idx   = _lbCtx ? _lbCtx.idx   : lbIdx;
    if (_idx < _items.length - 1) { lbGo(1); }
    else { if (_lbCtx) _lbCtx.idx=0; else lbIdx=0; showLB(); }
  },d);
}

document.getElementById('lb-ss').onclick = () => ssOn?stopSS():startSS();
spdEl.oninput = () => { spdvEl.textContent=spdEl.value+'s'; if(ssOn) restartSS(); };
document.getElementById('lbcl').onclick  = closeLB;
document.getElementById('lbpv').onclick  = () => { stopSS(); lbGo(-1); };
document.getElementById('lbnx').onclick  = () => { stopSS(); lbGo(1); };
document.getElementById('lb-pv').onclick = () => { stopSS(); lbGo(-1); };
document.getElementById('lb-nx').onclick = () => { stopSS(); lbGo(1); };
document.getElementById('lb-dl').onclick = () => {
  const it = _lbCtx ? _lbCtx.items[_lbCtx.idx] : items[lbIdx]; if (!it) return;
  const a = document.createElement('a');
  a.href = it.url; a.download = it.name;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
};
lbEl.addEventListener('click', e => { if(e.target===lbEl||e.target.id==='lbmw') closeLB(); });
document.addEventListener('keydown', e => {
  if (!lbEl.classList.contains('on')) return;
  const isVideo = _vpcActive;

  if (e.key === 'Escape') {
    // Priority chain: assign modal → lightbox (never close viewer when modal is open)
    if (!assignBg.classList.contains('hide')) { closeAssignModal(); return; }
    closeLB(); return;
  }

  if (isVideo) {
    // Video-specific shortcuts — prevent gallery navigation conflicts
    if (e.key === ' ') {
      e.preventDefault();
      vpcTogglePlay();
      return;
    }
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      lbvEl.currentTime = Math.min((lbvEl.duration || 0), lbvEl.currentTime + 10);
      vpcShow(true);
      return;
    }
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      lbvEl.currentTime = Math.max(0, lbvEl.currentTime - 10);
      vpcShow(true);
      return;
    }
    if (e.key === 'm' || e.key === 'M') { vpcToggleMute(); return; }
    if (e.key === 'f' || e.key === 'F') { vpcToggleFs();   return; }
  } else {
    // Image / slideshow shortcuts
    if (e.key === 'ArrowRight') { stopSS(); lbGo(1);  }
    if (e.key === 'ArrowLeft')  { stopSS(); lbGo(-1); }
    if (e.key === ' ') { e.preventDefault(); ssOn ? stopSS() : startSS(); }
  }
});
let txStartY = 0;
lbEl.addEventListener('touchstart', e=>{
  txStart=e.touches[0].clientX;
  txStartY=e.touches[0].clientY;
},{passive:true});
lbEl.addEventListener('touchend', e=>{
  const dx=e.changedTouches[0].clientX-txStart;
  const dy=e.changedTouches[0].clientY-txStartY;
  // Only treat as horizontal swipe if X movement dominates (not a vertical scroll)
  if(Math.abs(dx)<40 || Math.abs(dy)>Math.abs(dx)) return;
  stopSS(); lbGo(dx<0?1:-1);
},{passive:true});

// Show swipe hint on first lightbox open on mobile
let _swipeHintShown = false;
function maybeShowSwipeHint() {
  if (_swipeHintShown || window.innerWidth > 640) return;
  _swipeHintShown = true;
  const hint = document.getElementById('lb-swipe-hint');
  hint.style.display = 'block';
  setTimeout(() => { hint.style.display = 'none'; }, 2800);
}

// ─────────────────────────────────────────────────────────────
//  UPLOAD / LOGOUT
// ─────────────────────────────────────────────────────────────
document.getElementById('upl').onclick   = () => { if(typeof openUploader==='function') openUploader(); };
document.getElementById('logout').onclick= async () => { await fetch('/api/logout',{method:'POST'}); location.href='/login.html'; };
function loadFiles() { return fetchPage(true); }

// ─────────────────────────────────────────────────────────────
//  VIEW MODE — 'gallery' | 'people'
// ─────────────────────────────────────────────────────────────
let viewMode = 'gallery';
const mainEl    = document.getElementById('main');
const ppEl      = document.getElementById('pp');
const gwWrapEl  = document.getElementById('gw');
const tbEl      = document.getElementById('tb');
const frEl      = document.getElementById('fr');
const stEl      = document.getElementById('st');

// skipFetch=true: do the DOM switch only, let the caller drive the fetch.
// Used by setType() so it can set ctype first before the fetch fires.
function showGalleryView(skipFetch = false) {
  saveScroll();          // preserve people scroll before leaving
  viewMode = 'gallery';
  ppEl.classList.remove('on');
  gwWrapEl.style.display = '';
  tbEl.style.display    = '';   // toolbar always visible
  frEl.style.display    = '';
  stEl.style.display    = '';
  srchEl.placeholder    = 'Search files, people…';
  document.querySelectorAll('.snb').forEach(b => b.classList.remove('on'));
  const activeNav = document.querySelector(`.snb[data-t="${ctype}"]`);
  if (activeNav) activeNav.classList.add('on');
  // Sync search input with csearch state — the input may have had people-search text
  // typed while in people view.  Restore the actual gallery search value.
  srchEl.value = csearch;
  if (csearch) {
    srchEl.classList.add('has-value');
    document.getElementById('sw').classList.add('active');
  } else {
    srchEl.classList.remove('has-value');
    document.getElementById('sw').classList.remove('active');
  }
  hideSugg();
  // skipFetch: caller will drive the fetch (e.g. setType needs to set ctype first).
  // !loading guard: secondary override listeners on the same click event may call
  // showGalleryView() after setType() already called fetchPage(true) — block duplicate.
  if (!skipFetch) {
    if (items.length === 0 && !loading) {
      fetchPage(true);
    } else {
      restoreScroll(`gallery_${ctype}`);
    }
  }
}

function showPeopleView() {
  saveScroll();          // preserve gallery scroll before leaving
  if (!history.state || history.state.view !== 'people') {
    history.pushState({ view: 'people' }, '', '#people');
  }
  viewMode = 'people';
  gwWrapEl.style.display = 'none';
  // Keep toolbar visible so search works in people view too
  tbEl.style.display    = '';
  frEl.style.display    = 'none';
  stEl.style.display    = 'none';
  srchEl.placeholder    = 'Search people…';
  ppEl.classList.add('on');
  document.querySelectorAll('.snb').forEach(b => b.classList.remove('on'));
  document.getElementById('nav-people').classList.add('on');
  sbEl.classList.remove('on'); ovEl.classList.remove('on');
  document.getElementById('ppback').classList.remove('on');
  document.getElementById('pptitle').textContent = 'People';
  // Reset detail state
  pdPersonId = null; _curPerson = null;
  if (typeof pdActEl !== 'undefined') pdActEl.classList.remove('on');
  // Immediately show fresh status then load grid (or filtered grid if search active)
  const _initQ = srchEl.value.trim();
  pollFaceStatus().then(() => _initQ ? loadPeopleFiltered(_initQ) : loadPeople());
}

// Navigate directly to a person's detail view without loading the full people grid.
// Used when coming from search suggestions or cluster chips — avoids the flash of
// ALL clusters rendering before openPersonDetail() wipes them out.
function navigateToPerson(p) {
  if (viewMode !== 'people') {
    // Set up People view visuals without running loadPeople()
    saveScroll();
    if (!history.state || history.state.view !== 'people') {
      history.pushState({ view: 'people' }, '', '#people');
    }
    viewMode = 'people';
    gwWrapEl.style.display = 'none';
    // Toolbar stays visible — search must work in people view
    tbEl.style.display     = '';
    frEl.style.display     = 'none';
    stEl.style.display     = 'none';
    srchEl.placeholder     = 'Search people…';
    ppEl.classList.add('on');
    document.querySelectorAll('.snb').forEach(b => b.classList.remove('on'));
    document.getElementById('nav-people').classList.add('on');
    sbEl.classList.remove('on'); ovEl.classList.remove('on');
    document.getElementById('ppback').classList.remove('on');
    document.getElementById('pptitle').textContent = 'People';
    pdPersonId = null; _curPerson = null;
    if (typeof pdActEl !== 'undefined') pdActEl.classList.remove('on');
    ppgridEl.innerHTML = '';
    ppemptyEl.style.display = 'none';
  }
  openPersonDetail(p);
}

// ─────────────────────────────────────────────────────────────
//  TOAST NOTIFICATION
// ─────────────────────────────────────────────────────────────
let _toastTimer = null;
const toastEl = document.getElementById('toast-el');

function showToast(msg, type = 'ok', duration = 2800) {
  clearTimeout(_toastTimer);
  toastEl.textContent = msg;
  toastEl.className   = type;          // 'ok' | 'err' | ''
  toastEl.classList.add('on');
  _toastTimer = setTimeout(() => toastEl.classList.remove('on'), duration);
}

// ─────────────────────────────────────────────────────────────
//  PEOPLE PAGE
// ─────────────────────────────────────────────────────────────
let ppLoading    = false;
let ppMore       = true;
let ppPage       = 0;
let ppPersonId   = null;  // null = list view; number = person detail

// Currently open person (detail view)
let _curPerson   = null;  // { id, name, faceCount, coverThumb }

const ppgridEl  = document.getElementById('pggrid');
const ppspEl    = document.getElementById('ppsp');
const ppemptyEl = document.getElementById('ppempty');
const ppbodyEl  = document.getElementById('ppbody');
const pdActEl   = document.getElementById('pd-actions');

// ── People list ──────────────────────────────────────────────

async function loadPeople(reset = true) {
  if (ppLoading) return;
  ppLoading = true;
  ppspEl.classList.add('on');
  ppemptyEl.style.display = 'none';

  if (reset) {
    ppPage = 0;
    ppMore = true;
    ppgridEl.innerHTML = '';
  }

  try {
    const offset = ppPage * 60;
    const r = await fetch(`/api/faces/persons?limit=60&offset=${offset}`);
    if (r.status === 401) { location.href = '/login.html'; return; }
    const d = await r.json();

    ppMore = (ppPage + 1) * 60 < d.total;
    ppPage++;

    if (d.items.length === 0 && ppPage === 1) {
      ppemptyEl.style.display = 'flex';
    } else {
      d.items.forEach(p => renderPersonCard(p));
    }
  } catch (e) {
    console.error('loadPeople:', e);
  } finally {
    ppLoading = false;
    ppspEl.classList.remove('on');
  }
}

// Filter people grid by search query — used when search input fires in people list view
async function loadPeopleFiltered(q) {
  if (ppLoading) return;
  ppLoading = true;
  ppspEl.classList.add('on');
  ppemptyEl.style.display = 'none';
  ppPage = 0; ppMore = true;
  ppgridEl.innerHTML = '';
  try {
    const r = await fetch(`/api/faces/persons?limit=60&offset=0&search=${encodeURIComponent(q)}`);
    if (r.status === 401) { location.href = '/login.html'; return; }
    const d = await r.json();
    ppMore = 60 < d.total; ppPage = 1;
    if (!d.items.length) {
      ppemptyEl.style.display = 'flex';
      ppemptyEl.innerHTML =
        `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width:32px;height:32px;opacity:.25"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>` +
        `No clusters matching "<b style="color:var(--t2)">${q}</b>"`;
    } else {
      d.items.forEach(p => renderPersonCard(p));
    }
  } catch (e) { console.error('loadPeopleFiltered:', e); }
  finally { ppLoading = false; ppspEl.classList.remove('on'); }
}

// Tracks the currently open context menu so we can close it on outside-click
let _openCtxMenu = null;
document.addEventListener('click', () => {
  if (_openCtxMenu) { _openCtxMenu.classList.remove('on'); _openCtxMenu = null; }
}, true);

function renderPersonCard(person) {
  const card = document.createElement('div');
  card.className = 'pgc';
  const displayName = person.name || `Person ${person.id}`;
  const thumb = person.coverThumb || null;

  card.innerHTML =
    `<div class="pgav">${
      thumb
        ? `<img src="${thumb}" alt="" onerror="this.style.display='none';this.nextSibling.style.display='block'"/><svg style="display:none" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="8" r="4"/><path d="M4 20a8 8 0 0 1 16 0"/></svg>`
        : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="8" r="4"/><path d="M4 20a8 8 0 0 1 16 0"/></svg>`
    }</div>` +
    `<div class="pgn" title="${displayName}">${displayName}</div>` +
    `<div class="pgct">${person.faceCount || person.face_count || 0} face${(person.faceCount || person.face_count || 0) === 1 ? '' : 's'}</div>` +
    // ⋮ context button
    `<button class="pg-menu-btn" title="Options" tabindex="-1">⋮</button>` +
    // Dropdown context menu
    `<div class="pg-ctx">` +
      `<button class="pg-ctx-item" data-action="rename">✎ Rename</button>` +
      `<button class="pg-ctx-item" data-action="merge">⊕ Merge into…</button>` +
      `<button class="pg-ctx-item danger" data-action="delete">✕ Delete</button>` +
    `</div>`;

  const ctx  = card.querySelector('.pg-ctx');
  const mbtn = card.querySelector('.pg-menu-btn');

  // ⋮ button — toggle context menu
  mbtn.addEventListener('click', e => {
    e.stopPropagation();
    const wasOpen = ctx.classList.contains('on');
    if (_openCtxMenu) { _openCtxMenu.classList.remove('on'); }
    if (!wasOpen) { ctx.classList.add('on'); _openCtxMenu = ctx; }
    else { _openCtxMenu = null; }
  });

  // Context menu items
  ctx.addEventListener('click', e => {
    e.stopPropagation();
    const action = e.target.dataset.action;
    ctx.classList.remove('on'); _openCtxMenu = null;
    if (action === 'rename') openRenameModal(person.id, displayName);
    if (action === 'merge')  openMergeModal(person.id, displayName);
    if (action === 'delete') confirmDeletePerson(person.id, displayName, card);
  });

  // Card body click → open detail
  card.addEventListener('click', e => {
    if (e.target.closest('.pg-menu-btn') || e.target.closest('.pg-ctx')) return;
    openPersonDetail(person);
  });

  ppgridEl.appendChild(card);
}

// Infinite scroll for people grid
// FIX: was checking ppPersonId (always null) — now correctly checks pdPersonId
ppbodyEl.addEventListener('scroll', () => {
  const near = ppbodyEl.scrollTop + ppbodyEl.clientHeight > ppbodyEl.scrollHeight - 300;
  if (near && !ppLoading && ppMore && pdPersonId === null) loadPeople(false);
}, { passive: true });

// ─────────────────────────────────────────────────────────────
//  PERSON DETAIL VIEW — shows media gallery for one person
// ─────────────────────────────────────────────────────────────
let pdLoading  = false;
let pdMore     = true;
let pdPage     = 0;
let pdPersonId = null;
let pdItems    = [];  // flat list of media items for current person — used by cluster-aware lightbox

function clearPersonMediaGrid() {
  ppgridEl.querySelectorAll('.c').forEach(el => {
    cancelLoadsForEl(el);
    stopCardPreview(el);
    if (typeof previewObserver !== 'undefined') previewObserver.unobserve(el);
  });
  ppgridEl.innerHTML = '';
}

async function openPersonDetail(personOrId, legacyName) {
  saveScroll();          // preserve people_list scroll before entering detail
  // Accept either a full person object or just an id (backwards compat)
  const person = (typeof personOrId === 'object' && personOrId !== null)
    ? personOrId
    : { id: personOrId, name: legacyName || null, faceCount: 0, coverThumb: null };

  pdPersonId = person.id;
  _curPerson = { ...person };
  pdItems    = [];  // reset cluster-context items for new person

  pdLoading = false;
  pdMore    = true;
  pdPage    = 0;
  ppgridEl.innerHTML   = '';
  ppemptyEl.style.display = 'none';

  const displayName = person.name || `Person ${person.id}`;
  document.getElementById('ppback').classList.add('on');
  document.getElementById('pptitle').textContent = displayName;
  pdActEl.classList.add('on');
  ppbodyEl.scrollTop = 0;

  // Push history state so browser Back button works (Task 4)
  if (!history.state || history.state.personId !== person.id) {
    history.pushState({ view: 'person', personId: person.id }, '', `#person-${person.id}`);
  }

  await loadPersonMedia(true);
}

async function loadPersonMedia(reset = false) {
  if (pdLoading || !pdMore) return;
  pdLoading = true;
  ppspEl.classList.add('on');

  if (reset) {
    pdPage = 0; pdMore = true;
    pdItems = [];  // reset cluster-context items on reset
    clearPersonMediaGrid();
    ppemptyEl.style.display = 'none';
  }

  try {
    const r = await fetch(`/api/faces/persons/${pdPersonId}/media?limit=60&page=${pdPage}`);
    if (r.status === 401) { location.href = '/login.html'; return; }
    if (!r.ok) {
      ppemptyEl.style.display = 'flex';
      ppemptyEl.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width:32px;height:32px;opacity:.25"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>Error loading person media (${r.status}).`;
      return;
    }
    const d = await r.json();

    // Keep _curPerson in sync with latest server data
    if (d.person) _curPerson = { ..._curPerson, ...d.person };

    pdMore = d.hasMore === true;
    pdPage++;

    if (!d.items || (d.items.length === 0 && pdPage === 1)) {
      ppemptyEl.style.display = 'flex';
      ppemptyEl.innerHTML =
        `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width:32px;height:32px;opacity:.25"><path d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 20M14 8h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>` +
        `No media found for this person.<br><small style="opacity:.5">Try a full re-cluster from the scan menu.</small>`;
    } else {
      d.items.forEach(item => {
        pdItems.push(item);          // accumulate for cluster-context lightbox
        renderPersonMediaCard(item);
      });
    }
  } catch (e) {
    console.error('[personMedia] fetch failed:', e);
    ppemptyEl.style.display = 'flex';
    ppemptyEl.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width:32px;height:32px;opacity:.25"><circle cx="12" cy="12" r="10"/></svg>Failed to load media.`;
  } finally {
    pdLoading = false;
    ppspEl.classList.remove('on');
  }
}

function renderPersonMediaCard(item) {
  const name     = item.name;
  const faceIds  = item.faceIds || [];
  const firstFid = faceIds[0] || null;

  if (!name) { console.warn('[renderPersonMediaCard] missing name', item); return; }

  const idx = pdItems.findIndex(it => it.name === name);
  const card = makeCardEl();
  ppgridEl.appendChild(card);   // must be in DOM before bindCard so qLoad's document.contains() check passes
  bindCard(card, item, idx >= 0 ? idx : 0, pdItems);

  const actionOverlay = document.createElement('div');
  actionOverlay.className = 'pm-overlay';
  actionOverlay.innerHTML =
      `<div class="pm-btns">` +
        `<button class="pm-btn safe" data-act="cover">☆ Cover</button>` +
        `<button class="pm-btn" data-act="remove">− Remove</button>` +
        `<button class="pm-btn" data-act="not-me">✕ Not me</button>` +
      `</div>`;
  card.appendChild(actionOverlay);
  if ((item.type === 'video' || item.type === 'gif') && typeof previewObserver !== 'undefined') {
    previewObserver.observe(card);
  }

  // Action buttons
  actionOverlay.addEventListener('click', async e => {
    e.stopPropagation();
    const act = e.target.dataset.act;
    if (!act) return;

    if (act === 'cover') {
      try {
        let r;
        if (firstFid) {
          // AI-scanned media — use the face directly
          r = await fetch(`/api/faces/persons/${pdPersonId}/cover`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ faceId: firstFid, lock: true }),
          });
        } else {
          // Manually assigned media with no face data — look up best face by filename
          r = await fetch(`/api/faces/persons/${pdPersonId}/cover/by-media`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename: name }),
          });
        }
        if (r.ok) showToast('Cover photo updated', 'ok');
        else {
          const err = await r.json().catch(() => ({}));
          showToast(err.message || 'Failed to set cover', 'err');
        }
      } catch { showToast('Network error', 'err'); }
    }

    if (act === 'remove') {
      try {
        let r;
        if (firstFid) {
          // AI-scanned face — remove the face association
          r = await fetch(`/api/faces/persons/${pdPersonId}/faces/${firstFid}`, { method: 'DELETE' });
        } else {
          // Manually assigned media — remove the media→cluster link
          r = await fetch(`/api/faces/persons/${pdPersonId}/media/${encodeURIComponent(name)}`, { method: 'DELETE' });
        }
        if (r.ok) {
          stopCardPreview(card);
          if (typeof previewObserver !== 'undefined') previewObserver.unobserve(card);
          card.remove();
          pdItems = pdItems.filter(it => it.name !== name);
          showToast('Removed from cluster', 'ok');
        }
        else showToast('Failed to remove', 'err');
      } catch { showToast('Network error', 'err'); }
    }

    if (act === 'not-me') {
      try {
        let r;
        if (firstFid) {
          // AI-scanned face — record feedback against the face
          r = await fetch('/api/faces/feedback/not-this-person', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ personId: pdPersonId, faceId: firstFid }),
          });
        } else {
          // Manually assigned media — just remove the association (no face embedding to flag)
          r = await fetch(`/api/faces/persons/${pdPersonId}/media/${encodeURIComponent(name)}`, { method: 'DELETE' });
        }
        if (r.ok) {
          stopCardPreview(card);
          if (typeof previewObserver !== 'undefined') previewObserver.unobserve(card);
          card.remove();
          pdItems = pdItems.filter(it => it.name !== name);
          showToast('Feedback saved — face removed', 'ok');
        }
        else showToast('Failed to save feedback', 'err');
      } catch { showToast('Network error', 'err'); }
    }
  });
}

// Infinite scroll for person media
ppbodyEl.addEventListener('scroll', () => {
  if (pdPersonId === null) return;
  const near = ppbodyEl.scrollTop + ppbodyEl.clientHeight > ppbodyEl.scrollHeight - 300;
  if (near && !pdLoading && pdMore) loadPersonMedia(false);
}, { passive: true });

// ── Back button ──────────────────────────────────────────────
function goBackToPeopleList() {
  pdPersonId = null;
  _curPerson = null;
  pdItems    = [];
  document.getElementById('ppback').classList.remove('on');
  document.getElementById('pptitle').textContent = 'People';
  pdActEl.classList.remove('on');
  // Reset search to people mode
  srchEl.placeholder = 'Search people…';
  // If search was active while in person detail, clear it and reload full list
  const q = srchEl.value.trim();
  if (q) loadPeopleFiltered(q);
  else   loadPeople(true);
}

document.getElementById('ppback').addEventListener('click', () => {
  // Pop the history state we pushed when entering person detail
  if (history.state && history.state.view === 'person') history.back();
  else goBackToPeopleList();
});

// Handle browser Back/Forward button and mobile swipe-back gesture (Task 4)
window.addEventListener('popstate', e => {
  // Priority 1: close assign modal (must be before lightbox — ESC follows same priority)
  if (!assignBg.classList.contains('hide')) { closeAssignModal(); return; }
  // Priority 2: close other modals
  if (!document.getElementById('modal-rename-bg').classList.contains('hide')) { closeRenameModal(); return; }
  if (!document.getElementById('modal-merge-bg').classList.contains('hide')) { closeMergeModal(); return; }
  // Priority 3: close lightbox if open
  if (lbEl.classList.contains('on')) { closeLB(); return; }

  const state = e.state || {};
  if (state.view === 'person') {
    // Forward nav to person state — ensure we're showing the right person
    if (pdPersonId !== state.personId) {
      if (viewMode !== 'people') navigateToPerson({ id: state.personId, name: null });
      else openPersonDetail({ id: state.personId, name: null });
    }
  } else if (state.view === 'people') {
    // Back to people list from person detail
    if (viewMode === 'people' && pdPersonId !== null) goBackToPeopleList();
    else if (viewMode !== 'people') showPeopleView();
  } else {
    // No state or gallery state — return to gallery
    if (viewMode === 'people') showGalleryView();
    // Ensure search is cleared when popping to no-state (e.g. page load state)
    if (csearch) { csearch = ''; srchEl.value = ''; fetchPage(true); }
  }
});

// ── Detail action bar buttons ────────────────────────────────
document.getElementById('pd-rename').addEventListener('click', () => {
  if (!_curPerson) return;
  openRenameModal(_curPerson.id, _curPerson.name || `Person ${_curPerson.id}`);
});
document.getElementById('pd-merge').addEventListener('click', () => {
  if (!_curPerson) return;
  openMergeModal(_curPerson.id, _curPerson.name || `Person ${_curPerson.id}`);
});
document.getElementById('pd-delete').addEventListener('click', () => {
  if (!_curPerson) return;
  const displayName = _curPerson.name || `Person ${_curPerson.id}`;
  confirmDeletePerson(_curPerson.id, displayName, null, true);
});

// ─────────────────────────────────────────────────────────────
//  RENAME MODAL
// ─────────────────────────────────────────────────────────────
const renameBg    = document.getElementById('modal-rename-bg');
const renameInput = document.getElementById('modal-rename-input');
let   _renameTarget = null; // { id }

function openRenameModal(personId, currentName) {
  _renameTarget = { id: personId };
  renameInput.value = (currentName && !currentName.startsWith('Person ')) ? currentName : '';
  renameBg.classList.remove('hide');
  setTimeout(() => renameInput.focus(), 60);
}

function closeRenameModal() { renameBg.classList.add('hide'); _renameTarget = null; }

document.getElementById('modal-rename-cancel').addEventListener('click', closeRenameModal);
renameBg.addEventListener('click', e => { if (e.target === renameBg) closeRenameModal(); });

renameInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('modal-rename-ok').click();
  if (e.key === 'Escape') closeRenameModal();
});

document.getElementById('modal-rename-ok').addEventListener('click', async () => {
  if (!_renameTarget) return;
  const name = renameInput.value.trim();
  try {
    const r = await fetch(`/api/faces/persons/${_renameTarget.id}/name`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ name }),
    });
    if (r.ok) {
      showToast(name ? `Renamed to "${name}"` : 'Name cleared', 'ok');
      closeRenameModal();
      // Update header + _curPerson if we renamed the currently open person
      if (_curPerson && _curPerson.id === _renameTarget.id) {
        _curPerson.name = name || null;
        const displayName = name || `Person ${_curPerson.id}`;
        document.getElementById('pptitle').textContent = displayName;
      }
      if (pdPersonId === null) loadPeople(true); // refresh grid if in list view
    } else {
      showToast('Rename failed', 'err');
    }
  } catch { showToast('Network error', 'err'); }
});

// ─────────────────────────────────────────────────────────────
//  MERGE MODAL
// ─────────────────────────────────────────────────────────────
const mergeBg      = document.getElementById('modal-merge-bg');
const mergeSearchEl = document.getElementById('merge-search');
const mergeListEl   = document.getElementById('merge-list');
const mergeOkBtn    = document.getElementById('modal-merge-ok');
let   _mergeSource = null;  // { id, name }
let   _mergeTarget = null;  // selected person id
let   _mergeAll    = [];    // all loaded people for filter

function openMergeModal(personId, personName) {
  _mergeSource = { id: personId, name: personName };
  _mergeTarget = null;
  mergeOkBtn.disabled = true;
  mergeSearchEl.value = '';
  mergeListEl.innerHTML = '<div style="padding:14px;text-align:center;font-size:11px;color:var(--t3);font-family:IBM Plex Mono,monospace">Loading…</div>';
  mergeBg.classList.remove('hide');
  loadMergeList('');
}

function closeMergeModal() {
  mergeBg.classList.add('hide');
  _mergeSource = _mergeTarget = null;
}

async function loadMergeList(filter) {
  try {
    const r = await fetch('/api/faces/persons?limit=80&offset=0');
    const d = await r.json();
    _mergeAll = (d.items || []).filter(p => p.id !== (_mergeSource && _mergeSource.id));
    renderMergeList(filter);
  } catch {
    mergeListEl.innerHTML = '<div style="padding:12px;font-size:11px;color:var(--t3);font-family:IBM Plex Mono,monospace">Failed to load people</div>';
  }
}

function renderMergeList(filter) {
  const q = filter.toLowerCase().trim();
  const list = q
    ? _mergeAll.filter(p => (p.name || `Person ${p.id}`).toLowerCase().includes(q))
    : _mergeAll;

  mergeListEl.innerHTML = '';
  if (list.length === 0) {
    mergeListEl.innerHTML = '<div style="padding:12px;font-size:11px;color:var(--t3);font-family:IBM Plex Mono,monospace">No people found</div>';
    return;
  }
  list.forEach(p => {
    const name  = p.name || `Person ${p.id}`;
    const thumb = p.coverThumb || null;
    const el    = document.createElement('div');
    el.className = 'merge-item' + (_mergeTarget === p.id ? ' sel' : '');
    el.dataset.pid = p.id;
    el.innerHTML =
      `<div class="merge-av">${
        thumb
          ? `<img src="${thumb}" alt=""/>`
          : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="8" r="4"/><path d="M4 20a8 8 0 0 1 16 0"/></svg>`
      }</div>` +
      `<div><div class="merge-name">${name}</div><div class="merge-count">${p.faceCount || 0} faces</div></div>`;
    el.addEventListener('click', () => {
      _mergeTarget = p.id;
      mergeOkBtn.disabled = false;
      mergeListEl.querySelectorAll('.merge-item').forEach(i => i.classList.toggle('sel', i.dataset.pid == p.id));
    });
    mergeListEl.appendChild(el);
  });
}

mergeSearchEl.addEventListener('input', () => renderMergeList(mergeSearchEl.value));

document.getElementById('modal-merge-cancel').addEventListener('click', closeMergeModal);
mergeBg.addEventListener('click', e => { if (e.target === mergeBg) closeMergeModal(); });

mergeOkBtn.addEventListener('click', async () => {
  if (!_mergeSource || !_mergeTarget) return;
  mergeOkBtn.disabled = true;
  mergeOkBtn.textContent = 'Merging…';
  try {
    const r = await fetch('/api/faces/persons/merge', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ sourceId: _mergeSource.id, targetId: _mergeTarget }),
    });
    const d = await r.json();
    if (r.ok) {
      showToast(`Merged — ${d.facesMoved || 0} faces moved`, 'ok');
      closeMergeModal();
      // Navigate back to people list
      pdPersonId = null; _curPerson = null;
      document.getElementById('ppback').classList.remove('on');
      document.getElementById('pptitle').textContent = 'People';
      pdActEl.classList.remove('on');
      loadPeople(true);
    } else {
      showToast(d.error || 'Merge failed', 'err');
    }
  } catch { showToast('Network error', 'err'); }
  finally {
    mergeOkBtn.disabled = false;
    mergeOkBtn.textContent = 'Merge';
  }
});

// ─────────────────────────────────────────────────────────────
//  DELETE PERSON
// ─────────────────────────────────────────────────────────────
async function confirmDeletePerson(personId, displayName, cardEl, fromDetail = false) {
  if (!confirm(`Delete "${displayName}"?\n\nThis removes the person cluster. Media files are not affected.`)) return;
  try {
    const r = await fetch(`/api/faces/persons/${personId}`, { method: 'DELETE' });
    if (r.ok) {
      showToast(`"${displayName}" deleted`, 'ok');
      if (cardEl) cardEl.remove();
      if (fromDetail) {
        // Navigate back
        pdPersonId = null; _curPerson = null;
        document.getElementById('ppback').classList.remove('on');
        document.getElementById('pptitle').textContent = 'People';
        pdActEl.classList.remove('on');
        loadPeople(true);
      }
    } else {
      showToast('Delete failed', 'err');
    }
  } catch { showToast('Network error', 'err'); }
}

// Scan button replaced by the initScanDropdown() IIFE below

// People nav button
document.getElementById('nav-people').addEventListener('click', () => {
  if (viewMode === 'people') return;
  showPeopleView();
});

// Override existing type filter listeners to return to gallery view
document.querySelectorAll('.ft').forEach(b => {
  b.addEventListener('click', () => {
    if (viewMode !== 'gallery') showGalleryView();
  });
});
document.querySelectorAll('.snb[data-t]').forEach(b => {
  b.addEventListener('click', () => {
    if (viewMode !== 'gallery') showGalleryView();
  });
});

// ─────────────────────────────────────────────────────────────
//  FACE SCAN STATUS — polls /api/faces/status every 10 s
// ─────────────────────────────────────────────────────────────
const faceStEl    = document.getElementById('face-st');
const faceStDot   = document.getElementById('face-st-dot');
const faceStTxt   = document.getElementById('face-st-txt');

// Progress panel DOM refs
const ppProgEl    = document.getElementById('pp-progress');
const ppProgFill  = document.getElementById('pp-prog-bar-fill');
const ppProgDot   = document.getElementById('pp-prog-dot');
const ppProgLabel = document.getElementById('pp-prog-label');
const ppProgEta   = document.getElementById('pp-prog-eta');
const ppProgStats = document.getElementById('pp-prog-stats');

// ETA tracking state
let _scanStartTime = 0;
let _scanStartDone = 0;
let _lastState     = null;
let _autoRefreshTimer = null;

const STATE_LABELS = {
  RUNNING:       'Indexing…',
  IDLE:          'Index ready',
  PAUSED:        'Paused',
  INITIALIZING:  'Initializing…',
  MODELS_MISSING:'Models missing',
  SHUTTING_DOWN: 'Shutting down',
  unavailable:   'Connecting…',
  db_initializing: 'Connecting…',
};
const STATE_DOT = {
  RUNNING: 'run', IDLE: 'ok', PAUSED: 'warn',
  INITIALIZING: 'run', MODELS_MISSING: 'warn',
  SHUTTING_DOWN: 'warn', unavailable: 'err',
};

function fmtEta(seconds) {
  if (!isFinite(seconds) || seconds <= 0) return '';
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  if (m === 0) return `~${s}s left`;
  if (s === 0) return `~${m}m left`;
  return `~${m}m ${s}s left`;
}

function fmtNum(n) {
  if (n == null) return '—';
  return Number(n).toLocaleString();
}

function updateProgressPanel(d) {
  if (!ppProgEl) return;

  const state = d.state || 'unavailable';
  const isRunning = state === 'RUNNING';
  const isIdle    = state === 'IDLE';
  const isOk      = isRunning || isIdle || state === 'PAUSED';

  // Show/hide panel: hide only when completely unavailable and no data at all
  const hasData = d.personCount != null || d.faceCount != null || d.queued != null;
  if (!isOk && !hasData) {
    ppProgEl.classList.add('hide');
    return;
  }
  ppProgEl.classList.remove('hide');

  // Dot colour
  ppProgDot.className = '';
  ppProgDot.classList.add(STATE_DOT[state] || 'warn');

  // Progress bar
  const total     = (d.done || 0) + (d.queued || 0);
  const done      = d.done || 0;
  const pct       = total > 0 ? Math.round((done / total) * 100) : (isIdle ? 100 : 0);
  ppProgFill.style.width = pct + '%';

  // ETA calculation — reset counters on state transitions
  if (isRunning && _lastState !== 'RUNNING') {
    _scanStartTime = Date.now();
    _scanStartDone = done;
  }
  _lastState = state;

  let etaStr = '';
  if (isRunning && done > _scanStartDone) {
    const elapsed = (Date.now() - _scanStartTime) / 1000;  // seconds
    const processed = done - _scanStartDone;
    const rate = processed / elapsed;  // files/sec
    const remaining = d.queued || 0;
    const etaSec = rate > 0 ? remaining / rate : 0;
    etaStr = fmtEta(etaSec);
  }
  ppProgEta.textContent = etaStr;

  // Label
  let label;
  if (state === 'RUNNING') {
    label = `Indexing — ${fmtNum(done)} / ${fmtNum(total)} files`;
  } else if (state === 'IDLE') {
    label = d.personCount != null
      ? `${fmtNum(d.personCount)} people · ${fmtNum(d.faceCount || 0)} faces`
      : 'Index ready';
  } else {
    label = STATE_LABELS[state] || state;
  }
  ppProgLabel.textContent = label;

  // Stats row
  const stats = [];
  if (d.personCount != null) stats.push({ val: fmtNum(d.personCount), lbl: 'People' });
  if (d.faceCount   != null) stats.push({ val: fmtNum(d.faceCount),   lbl: 'Faces' });
  if (d.done        != null) stats.push({ val: fmtNum(d.done),        lbl: 'Scanned' });
  if (d.queued      != null) stats.push({ val: fmtNum(d.queued),      lbl: 'Queued' });
  if (d.errors      != null && d.errors > 0) stats.push({ val: fmtNum(d.errors), lbl: 'Errors' });

  ppProgStats.innerHTML = stats.map(s =>
    `<div class="pp-stat"><span class="pp-stat-val">${s.val}</span><span class="pp-stat-lbl">${s.lbl}</span></div>`
  ).join('');

  // Auto-refresh people list while scanning (every 15s when on people page)
  if (isRunning && viewMode === 'people' && pdPersonId === null) {
    if (!_autoRefreshTimer) {
      _autoRefreshTimer = setInterval(() => {
        if (viewMode === 'people' && pdPersonId === null) {
          loadPeople(false);
        }
      }, 15000);
    }
  } else {
    if (_autoRefreshTimer) { clearInterval(_autoRefreshTimer); _autoRefreshTimer = null; }
  }
}

async function pollFaceStatus() {
  try {
    const r = await fetch('/api/faces/status');
    if (!r.ok) return;
    const d = await r.json();

    // ── Sidebar status widget ──────────────────────────────────
    faceStEl.classList.add('on');
    faceStDot.className = '';
    faceStDot.classList.add(STATE_DOT[d.state] || 'idle');

    let label = STATE_LABELS[d.state] || d.state;
    if (d.state === 'RUNNING' && d.queued != null) {
      label = `Indexing… (${d.queued} queued)`;
    }
    if (d.personCount != null && d.state === 'IDLE') {
      label = `${d.personCount} people · ${d.faceCount || 0} faces`;
    }
    faceStTxt.textContent = label;

    // ── People page progress panel ─────────────────────────────
    if (viewMode === 'people') {
      updateProgressPanel(d);
    }
  } catch { /* server may not have face module — stay hidden */ }
}

// Refresh button — reloads people list (or person media if in detail)
document.getElementById('pp-refresh').addEventListener('click', () => {
  if (pdPersonId !== null) {
    openPersonDetail(pdPersonId, document.getElementById('pptitle').textContent);
  } else {
    loadPeople(true);
    pollFaceStatus();
  }
});

pollFaceStatus();
setInterval(pollFaceStatus, 10000);

// ─────────────────────────────────────────────────────────────
//  LIGHTBOX FACE OVERLAY
// ─────────────────────────────────────────────────────────────
const lbfovEl  = document.getElementById('lbfov');
const lbfsvgEl = document.getElementById('lbfsvg');

function clearFaceOverlay() {
  lbfovEl.classList.remove('on');
  lbfsvgEl.innerHTML = '';
}

async function loadLightboxFaces(item) {
  clearFaceOverlay();
  if (!item || item.type === 'gif') return; // skip GIFs (multi-frame)
  try {
    const r = await fetch(`/api/faces/media/${encodeURIComponent(item.name)}`);
    if (!r.ok) return;
    const d = await r.json();
    if (!d.faces || d.faces.length === 0) return;

    // Wait for image dimensions to be known
    const mediaEl = item.type === 'video' ? lbvEl : lbiEl;
    const getNatW  = () => item.type === 'video' ? mediaEl.videoWidth  : mediaEl.naturalWidth;
    const getNatH  = () => item.type === 'video' ? mediaEl.videoHeight : mediaEl.naturalHeight;
    const getDispW = () => mediaEl.clientWidth;
    const getDispH = () => mediaEl.clientHeight;

    function drawBoxes() {
      const natW = getNatW(), natH = getNatH();
      const dW   = getDispW(), dH  = getDispH();
      if (!natW || !natH || !dW || !dH) return;

      // Compute letterbox offsets (object-fit: contain)
      const scale = Math.min(dW / natW, dH / natH);
      const rW    = natW * scale;
      const rH    = natH * scale;
      const offX  = (dW - rW) / 2;
      const offY  = (dH - rH) / 2;

      lbfsvgEl.innerHTML = '';
      lbfsvgEl.setAttribute('viewBox', `0 0 ${dW} ${dH}`);

      // De-duplicate by person_id (video may have multiple frames)
      const seen = new Set();
      d.faces.forEach(face => {
        const key = face.person_id != null ? `p${face.person_id}` : `f${face.id}`;
        if (seen.has(key)) return;
        seen.add(key);

        // bbox_x/y/w/h are pixel coords in the original image
        const x = offX + face.bbox_x * scale;
        const y = offY + face.bbox_y * scale;
        const w = face.bbox_w * scale;
        const h = face.bbox_h * scale;

        const rect = document.createElementNS('http://www.w3.org/2000/svg','rect');
        rect.setAttribute('x', x.toFixed(1));
        rect.setAttribute('y', y.toFixed(1));
        rect.setAttribute('width', w.toFixed(1));
        rect.setAttribute('height', h.toFixed(1));
        rect.setAttribute('class', 'fbox');
        lbfsvgEl.appendChild(rect);

        if (face.person_id != null) {
          const lh = 16, lw = 70, lx = x, ly = Math.max(0, y - lh);
          const bg = document.createElementNS('http://www.w3.org/2000/svg','rect');
          bg.setAttribute('x', lx); bg.setAttribute('y', ly);
          bg.setAttribute('width', lw); bg.setAttribute('height', lh);
          bg.setAttribute('rx', '2'); bg.setAttribute('fill', 'rgba(0,0,0,.65)');
          lbfsvgEl.appendChild(bg);

          const txt = document.createElementNS('http://www.w3.org/2000/svg','text');
          txt.setAttribute('x', (lx + 4).toFixed(1));
          txt.setAttribute('y', (ly + 11).toFixed(1));
          txt.setAttribute('class', 'fbox-txt');
          txt.textContent = `ID ${face.person_id}`;
          lbfsvgEl.appendChild(txt);
        }
      });

      lbfovEl.classList.add('on');
    }

    // Try immediately; if not ready, wait for load event
    if (getNatW()) {
      drawBoxes();
    } else {
      mediaEl.addEventListener('loadedmetadata', drawBoxes, { once: true });
      mediaEl.addEventListener('load', drawBoxes, { once: true });
    }
  } catch (e) {
    console.debug('face overlay:', e.message);
  }
}


// ─────────────────────────────────────────────────────────────
//  LIGHTBOX PERSON CHIPS  (Task 6)
// ─────────────────────────────────────────────────────────────
const lbPersonsEl = document.getElementById('lb-persons');

async function loadLbPersonChips(item) {
  lbPersonsEl.innerHTML = '';
  if (!item || !item.name) return;
  try {
    const r = await fetch(`/api/faces/media/${encodeURIComponent(item.name)}/persons`);
    if (!r.ok) return;
    const d = await r.json();
    if (!d.persons || d.persons.length === 0) return;

    // Belt-and-suspenders: skip any entry that lacks a valid numeric id.
    // Server already validates via JOIN to persons table, but guard client-side
    // against stale caches or race conditions during cluster rebuilds.
    const validPersons = d.persons.filter(p => p.id && typeof p.id === 'number');
    if (!validPersons.length) return;

    validPersons.forEach(p => {
      const name = p.name || `Person ${p.id}`;
      const chip = document.createElement('div');
      chip.className = 'lb-pchip';
      chip.title = `Open cluster: ${name}`;
      chip.innerHTML =
        `<div class="lb-pchip-av">${
          p.thumbUrl
            ? `<img src="${p.thumbUrl}" alt="" loading="lazy"/>`
            : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width:12px;height:12px;margin:auto;display:block"><circle cx="12" cy="8" r="4"/><path d="M4 20a8 8 0 0 1 16 0"/></svg>`
        }</div>` +
        `<span class="lb-pchip-name">${name}</span>`;

      chip.addEventListener('click', e => {
        e.stopPropagation();
        closeLB();
        navigateToPerson(p);
      });

      lbPersonsEl.appendChild(chip);
    });
  } catch (e) {
    console.debug('[lbPersonChips]', e.message);
  }
}

// ─────────────────────────────────────────────────────────────
//  ASSIGN TO CLUSTER MODAL
// ─────────────────────────────────────────────────────────────
const assignBg       = document.getElementById('modal-assign-bg');
const assignSearchEl = document.getElementById('assign-search');
const assignListEl   = document.getElementById('assign-list');
const assignOkBtn    = document.getElementById('modal-assign-ok');
let _assignFilename  = null;  // filename being assigned
let _assignTarget    = null;  // selected person id
let _assignAll       = [];    // loaded people for filter

function openAssignModal(filename) {
  _assignFilename = filename;
  _assignTarget   = null;
  assignOkBtn.disabled = true;
  assignOkBtn.textContent = 'Assign';
  assignSearchEl.value = '';
  assignListEl.innerHTML = '<div style="padding:14px;text-align:center;font-size:11px;color:var(--t3);font-family:IBM Plex Mono,monospace">Loading…</div>';
  document.getElementById('modal-assign-sub').textContent =
    `Manually link "${filename}" to a cluster. Works for all media types — no face detection required.`;
  // Dim and block the lightbox underneath while modal is open
  lbEl.classList.add('assign-open');
  assignBg.classList.remove('hide');
  loadAssignList('');
  setTimeout(() => assignSearchEl.focus(), 60);
}

function closeAssignModal() {
  assignBg.classList.add('hide');
  lbEl.classList.remove('assign-open');
  _assignFilename = _assignTarget = null;
}

async function loadAssignList(filter) {
  try {
    const r = await fetch(`/api/faces/persons?limit=80&offset=0${filter ? `&search=${encodeURIComponent(filter)}` : ''}`);
    const d = await r.json();
    _assignAll = d.items || [];
    renderAssignList(_assignAll);
  } catch {
    assignListEl.innerHTML = '<div style="padding:12px;color:var(--t3);font-size:11px;font-family:IBM Plex Mono,monospace">Failed to load people</div>';
  }
}

function renderAssignList(list) {
  assignListEl.innerHTML = '';
  if (!list.length) {
    assignListEl.innerHTML = '<div style="padding:12px;color:var(--t3);font-size:11px;font-family:IBM Plex Mono,monospace;text-align:center">No people found</div>';
    return;
  }
  list.forEach(p => {
    const name = p.name || `Person ${p.id}`;
    const item = document.createElement('div');
    item.className = 'merge-item' + (_assignTarget === p.id ? ' sel' : '');
    item.innerHTML =
      `<div class="merge-av">${
        p.coverThumb
          ? `<img src="${p.coverThumb}" alt=""/>`
          : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="8" r="4"/><path d="M4 20a8 8 0 0 1 16 0"/></svg>`
      }</div>` +
      `<div style="flex:1;min-width:0"><div class="merge-name">${name}</div><div class="merge-count">${p.faceCount||p.face_count||0} faces</div></div>`;
    item.addEventListener('click', () => {
      _assignTarget = p.id;
      assignOkBtn.disabled = false;
      assignListEl.querySelectorAll('.merge-item').forEach(el => el.classList.remove('sel'));
      item.classList.add('sel');
    });
    assignListEl.appendChild(item);
  });
}

let _assignSearchT;
assignSearchEl.addEventListener('input', () => {
  clearTimeout(_assignSearchT);
  _assignSearchT = setTimeout(() => {
    const q = assignSearchEl.value.trim();
    if (!q) { renderAssignList(_assignAll); return; }
    const lq = q.toLowerCase();
    renderAssignList(_assignAll.filter(p => (p.name||`Person ${p.id}`).toLowerCase().includes(lq)));
    if (_assignAll.filter(p => (p.name||`Person ${p.id}`).toLowerCase().includes(lq)).length < 3) {
      loadAssignList(q); // re-fetch if local filter too narrow
    }
  }, 250);
});

assignSearchEl.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeAssignModal();
});

document.getElementById('modal-assign-cancel').addEventListener('click', closeAssignModal);
assignBg.addEventListener('click', e => { if (e.target === assignBg) closeAssignModal(); });

document.getElementById('modal-assign-ok').addEventListener('click', async () => {
  if (!_assignFilename || !_assignTarget) return;
  assignOkBtn.disabled = true;
  assignOkBtn.textContent = '…';

  try {
    // Direct manual assignment — no face detection required.
    // Works for images, videos, GIFs, and files with zero detected faces.
    const r = await fetch(`/api/faces/persons/${_assignTarget}/media`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: _assignFilename }),
    });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      throw new Error(d.error || `server error ${r.status}`);
    }

    showToast('Added to cluster', 'ok');
    closeAssignModal();
    // Refresh person chips in lightbox so new chip appears immediately
    if (lbEl.classList.contains('on')) {
      const cur = _lbCtx ? _lbCtx.items[_lbCtx.idx] : items[lbIdx];
      if (cur) loadLbPersonChips(cur);
    }
  } catch (e) {
    showToast('Assignment failed: ' + e.message, 'err');
    assignOkBtn.disabled = false;
    assignOkBtn.textContent = 'Assign';
  }
});

// Wire up the ⊕ Cluster button in the lightbox
document.getElementById('lb-cluster').addEventListener('click', () => {
  const it = _lbCtx ? _lbCtx.items[_lbCtx.idx] : items[lbIdx];
  if (!it) return;
  openAssignModal(it.name);
});

// ─────────────────────────────────────────────────────────────
//  SCROLL POSITION PRESERVATION
// ─────────────────────────────────────────────────────────────
const scrollState = {};

function saveScroll() {
  const key = viewMode === 'people'
    ? (pdPersonId !== null ? `people_detail_${pdPersonId}` : 'people_list')
    : `gallery_${ctype}`;
  const el = viewMode === 'people' ? ppbodyEl : gwEl;
  scrollState[key] = el.scrollTop;
}

function restoreScroll(key) {
  const pos = scrollState[key] || 0;
  if (!pos) return;
  const el = key.startsWith('people') ? ppbodyEl : gwEl;
  requestAnimationFrame(() => {
    el.scrollTop = pos;
    if (!key.startsWith('people')) renderGrid();
  });
}

// Save people detail scroll when going Back; restore people_list scroll
// Capture phase fires before the existing ppback click handler
document.getElementById('ppback').addEventListener('click', () => {
  saveScroll();
  const listPos = scrollState['people_list'] || 0;
  const _check = setInterval(() => {
    if (!ppLoading) {
      clearInterval(_check);
      requestAnimationFrame(() => { ppbodyEl.scrollTop = listPos; });
    }
  }, 80);
}, true);

// ─────────────────────────────────────────────────────────────
//  VIDEO / GIF AUTOPLAY PREVIEWS — IntersectionObserver
// ─────────────────────────────────────────────────────────────
const MAX_PREVIEWS = 6;
let _previewCount = 0;

// scheduleResumeStalled — rAF-debounced scan that re-starts previews for
// in-viewport previewable cards that were skipped because MAX_PREVIEWS was
// full when the IntersectionObserver fired. Called whenever a preview slot
// is freed so stalled cards don't stay static until the next scroll event.
let _resumeRafId = null;
function scheduleResumeStalled() {
  if (_resumeRafId !== null) return; // already scheduled
  _resumeRafId = requestAnimationFrame(() => {
    _resumeRafId = null;
    if (_previewCount >= MAX_PREVIEWS) return;
    // Scan visible pool entries; gwEl bounds used as viewport reference
    const gwRect = gwEl.getBoundingClientRect();
    for (const p of pool) {
      if (_previewCount >= MAX_PREVIEWS) break;
      const el = p.el;
      if (el._previewActive) continue;
      const item = el._item;
      if (!item || (item.type !== 'video' && item.type !== 'gif')) continue;
      const r = el.getBoundingClientRect();
      // Check ≥30% vertical overlap with gwEl viewport (mirrors observer threshold)
      const overlapTop    = Math.max(r.top, gwRect.top);
      const overlapBottom = Math.min(r.bottom, gwRect.bottom);
      const overlap = overlapBottom - overlapTop;
      if (overlap / r.height >= 0.3) {
        startCardPreview(el);
      }
    }
  });
}

function startCardPreview(el) {
  const item = el._item;
  if (!item || (item.type !== 'video' && item.type !== 'gif')) return;
  if (el._previewActive) return;
  if (_previewCount >= MAX_PREVIEWS) return;

  const vid = el.querySelector('video.pv');
  if (!vid) return;

  // For GIFs: play the actual GIF file as a video (if browser supports it)
  // Fallback: swap the thumbnail img src to the animated GIF
  if (item.type === 'gif') {
    // Animated GIF via img swap — simpler and more compatible
    const img = el.querySelector('img.ti');
    if (img && item.url) {
      img._staticSrc = img._staticSrc || item.thumb;
      el._previewActive = true;
      _previewCount++;
      const gifProbe = new Image();
      img._gifProbe = gifProbe;
      gifProbe.onload = () => {
        if (el._item !== item || !el._previewActive || img._gifProbe !== gifProbe) return;
        img.src = item.url; // shows animated GIF only after it is ready
      };
      gifProbe.onerror = () => {
        if (img._gifProbe === gifProbe) img._gifProbe = null;
      };
      gifProbe.src = item.url;
    }
    return;
  }

  // Video: use the video element
  vid.src = item.url;
  vid.onloadeddata = () => {
    if (el._item !== item || !el._previewActive) return;
    vid.classList.add('on');
  };
  el._previewActive = true;
  _previewCount++;
  vid.play().catch(() => {
    // Autoplay blocked — check if stopCardPreview already handled cleanup
    if (!el._previewActive) return; // already stopped, count already decremented
    vid.classList.remove('on');
    vid.src = '';
    el._previewActive = false;
    _previewCount = Math.max(0, _previewCount - 1);
  });
}

function stopCardPreviewGif(el) {
  // Capture and clear active flag immediately to prevent double-decrement races
  const wasActive = el._previewActive;
  el._previewActive = false;
  const img = el.querySelector('img.ti');
  if (img && img._gifProbe) {
    img._gifProbe.onload = null;
    img._gifProbe.onerror = null;
    img._gifProbe = null;
  }
  if (img && img._staticSrc) {
    img.src = img._staticSrc;
    img._staticSrc = null;
  }
  const vid = el.querySelector('video.pv');
  if (vid && !vid.paused) vid.pause();
  if (vid) { vid.classList.remove('on'); vid.src = ''; vid.load(); }
  // Decrement count based on the flag, not on video pause state (GIFs use img swap)
  if (wasActive) {
    _previewCount = Math.max(0, _previewCount - 1);
    scheduleResumeStalled(); // free slot → wake up any stalled in-viewport cards
  }
}

// Override stopCardPreview to handle both cases
function stopCardPreview(el) {
  const item = el._item;
  if (item && item.type === 'gif') { stopCardPreviewGif(el); return; }
  // Capture and clear active flag first to win any async play().catch races
  const wasActive = el._previewActive;
  el._previewActive = false;
  const vid = el.querySelector('video.pv');
  if (!vid) return;
  if (!vid.paused) vid.pause();
  vid.onloadeddata = null;
  vid.classList.remove('on');
  vid.src = ''; vid.load();
  if (wasActive) {
    _previewCount = Math.max(0, _previewCount - 1);
    scheduleResumeStalled(); // free slot → wake up any stalled in-viewport cards
  }
}

const previewObserver = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    const el = entry.target;
    const item = el._item;
    if (!item) continue;
    const isPreviewable = item.type === 'video' || item.type === 'gif';
    if (entry.isIntersecting && isPreviewable) {
      startCardPreview(el);
    } else if (el._previewActive) {
      stopCardPreview(el);
    }
  }
}, { root: gwEl, threshold: 0.3 });

// ─────────────────────────────────────────────────────────────
//  DARK / LIGHT THEME TOGGLE
// ─────────────────────────────────────────────────────────────
(function initTheme() {
  const saved = localStorage.getItem('vault_theme') || 'dark';
  document.documentElement.dataset.theme = saved;
  const btn = document.getElementById('theme-btn');
  btn.textContent = saved === 'light' ? '☽' : '☀';
  btn.addEventListener('click', () => {
    const cur = document.documentElement.dataset.theme || 'dark';
    const next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('vault_theme', next);
    btn.textContent = next === 'light' ? '☽' : '☀';
  });
})();

// ─────────────────────────────────────────────────────────────
//  RAIL COLLAPSE  (Phase B)
// ─────────────────────────────────────────────────────────────
(function initRail() {
  // Rail collapse is a desktop-only feature; on mobile the sidebar is an overlay
  const toggle = document.getElementById('rail-toggle');
  if (!toggle) return;

  // Restore persisted state on load (desktop only)
  if (window.innerWidth > 640) {
    const savedCollapsed = localStorage.getItem('vault_rail_collapsed') === '1';
    if (savedCollapsed) {
      sbEl.classList.add('collapsed');
      document.body.classList.add('rail-collapsed');
    }
  }

  toggle.addEventListener('click', () => {
    // On mobile this button still opens the overlay sidebar — don't collapse
    if (window.innerWidth <= 640) {
      sbEl.classList.toggle('on');
      ovEl.classList.toggle('on');
      return;
    }
    const collapsed = sbEl.classList.toggle('collapsed');
    document.body.classList.toggle('rail-collapsed', collapsed);
    localStorage.setItem('vault_rail_collapsed', collapsed ? '1' : '0');
    // Re-render gallery after sidebar width changes
    clearTimeout(resT);
    resT = setTimeout(() => {
      pool.forEach(p => { cancelLoadsForEl(p.el); clearCardVisuals(p.el); freeList.push(p.el); });
      pool = []; loadQ = []; loadActive = 0;
      _positions = [];
      layout(); updateSpacer(); renderGrid();
    }, 260);
  });
})();

// ─────��───────────────────────────────────────────────────────
//  LAYOUT MODE SWITCHER  (Phase B)
// ─────────────────────────────────────────────────────────────
(function initLayoutSwitcher() {
  // Restore saved layout state on boot
  const saved = localStorage.getItem('vault_layout') || 'grid';
  gwEl.dataset.layout = saved;
  document.querySelectorAll('.lm-btn').forEach(b => {
    b.classList.toggle('on', b.dataset.layout === saved);
    b.addEventListener('click', () => setLayout(b.dataset.layout));
  });
})();

// ─────────────────────────────────────────────────────────────
//  MOBILE BOTTOM NAV  (Phase B)
// ─────────────────────────────────────────────────────────────
(function initBnav() {
  const bnavEl = document.getElementById('bnav');
  if (!bnavEl) return;

  // Type buttons (All, Images, Videos)
  bnavEl.querySelectorAll('.bnav-btn[data-t]').forEach(btn => {
    btn.addEventListener('click', () => {
      bnavEl.querySelectorAll('.bnav-btn').forEach(b => b.classList.remove('on'));
      btn.classList.add('on');
      setType(btn.dataset.t);
    });
  });

  // People button
  const bnavPeople = document.getElementById('bnav-people');
  if (bnavPeople) {
    bnavPeople.addEventListener('click', () => {
      bnavEl.querySelectorAll('.bnav-btn').forEach(b => b.classList.remove('on'));
      bnavPeople.classList.add('on');
      if (viewMode !== 'people') showPeopleView();
    });
  }

  // Keep bnav in sync when gallery tab changes via sidebar
  function syncBnav() {
    bnavEl.querySelectorAll('.bnav-btn').forEach(b => b.classList.remove('on'));
    if (viewMode === 'people') {
      if (bnavPeople) bnavPeople.classList.add('on');
    } else {
      const match = bnavEl.querySelector(`.bnav-btn[data-t="${ctype}"]`);
      if (match) match.classList.add('on');
    }
  }

  // Patch showGalleryView and showPeopleView to sync bnav
  const _origShowGallery = showGalleryView;
  window.showGalleryView = function(skipFetch) { _origShowGallery(skipFetch); syncBnav(); };
  const _origShowPeople  = showPeopleView;
  window.showPeopleView  = function()           { _origShowPeople();          syncBnav(); };
})();

// ─────────────────────────────────────────────────────────────
//  SCAN DROPDOWN
// ─────────────────────────────────────────────────────────────
(function initScanDropdown() {
  const toggleBtn  = document.getElementById('scan-toggle');
  const menuEl     = document.getElementById('scan-menu');
  const scanNewBtn = document.getElementById('scan-new');
  const reclusterBtn = document.getElementById('scan-recluster');
  const dedupBtn   = document.getElementById('scan-dedup');

  function openMenu() { menuEl.classList.add('on'); toggleBtn.classList.add('on'); }
  function closeMenu() { menuEl.classList.remove('on'); toggleBtn.classList.remove('on'); }

  toggleBtn.addEventListener('click', e => {
    e.stopPropagation();
    menuEl.classList.contains('on') ? closeMenu() : openMenu();
  });
  document.addEventListener('click', () => closeMenu());
  menuEl.addEventListener('click', e => e.stopPropagation());

  async function runScanAction(btn, label, url, body) {
    closeMenu();
    const orig = btn.textContent;
    btn.disabled = true; btn.textContent = '… Working';
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok) showToast(d.message || label + ' started', 'ok');
      else      showToast(d.error   || label + ' failed',  'err');
    } catch { showToast('Network error', 'err'); }
    finally { setTimeout(() => { btn.disabled = false; btn.textContent = orig; }, 3500); }
  }

  scanNewBtn.addEventListener('click', () =>
    runScanAction(scanNewBtn, 'Scan', '/api/faces/scan/start', null));

  reclusterBtn.addEventListener('click', () =>
    runScanAction(reclusterBtn, 'Recluster', '/api/faces/scan/cluster', null));

  dedupBtn.addEventListener('click', () =>
    runScanAction(dedupBtn, 'Dedup', '/api/faces/deduplicate', null));
})();

// ─────────────────────────────────────────────────────────────
//  BOOT
// ─────────────────────────────────────────────────────────────
layout();
fetchPage(true);

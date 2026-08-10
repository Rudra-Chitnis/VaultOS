const CONCURRENCY = 5;

(function injectModal() {
  const style = document.createElement('style');
  style.textContent = `
    #upl-backdrop {
      position:fixed;inset:0;z-index:300;
      background:rgba(0,0,0,0.55);backdrop-filter:blur(6px);
      display:flex;align-items:center;justify-content:center;
      opacity:0;pointer-events:none;transition:opacity 0.2s;
    }
    #upl-backdrop.open{opacity:1;pointer-events:all;}
    #upl-modal{
      background:#111;width:min(600px,95vw);max-height:90vh;
      border-radius:16px;display:flex;flex-direction:column;
      transform:translateY(12px);transition:transform 0.2s;overflow:hidden;
      border:1px solid #222;
    }
    #upl-backdrop.open #upl-modal{transform:translateY(0);}
    #upl-header{
      display:flex;justify-content:space-between;align-items:center;
      padding:20px 24px 16px;border-bottom:1px solid #222;flex-shrink:0;
    }
    #upl-title{font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:15px;color:#f0f0f0;}
    #upl-close{background:none;border:none;cursor:pointer;color:#888;font-size:20px;line-height:1;padding:4px;}
    #upl-close:hover{color:#FF2B2B;}
    #upl-drop{
      margin:20px 24px 0;border:2px dashed #2a2a2a;border-radius:12px;
      padding:32px 20px;text-align:center;cursor:pointer;
      transition:border-color 0.2s,background 0.2s;flex-shrink:0;display:block;
    }
    #upl-drop.drag-over{border-color:#FF2B2B;background:rgba(255,43,43,0.04);}
    #upl-drop-icon{font-size:32px;margin-bottom:10px;opacity:0.35;}
    #upl-drop-label{font-size:13px;color:#777;font-family:'IBM Plex Mono',monospace;}
    #upl-file-input{display:none;}
    #upl-type-note{
      text-align:center;font-size:10px;font-family:'IBM Plex Mono',monospace;
      color:#444;margin:8px 24px 0;letter-spacing:0.05em;
    }
    #upl-overall{margin:16px 24px 0;display:none;flex-shrink:0;}
    #upl-overall-row{
      display:flex;justify-content:space-between;
      font-size:11px;font-family:'IBM Plex Mono',monospace;color:#666;margin-bottom:6px;
    }
    #upl-overall-bar-track{height:4px;background:#222;border-radius:2px;overflow:hidden;}
    #upl-overall-bar{height:100%;background:#FF2B2B;border-radius:2px;transition:width 0.2s;width:0%;}
    #upl-queue{
      flex:1;overflow-y:auto;padding:12px 24px;
      display:flex;flex-direction:column;gap:8px;min-height:0;
    }
    #upl-queue::-webkit-scrollbar{width:4px;}
    #upl-queue::-webkit-scrollbar-thumb{background:#333;border-radius:2px;}
    .upl-item{
      display:flex;align-items:center;gap:12px;
      padding:10px 12px;border-radius:10px;background:#1a1a1a;transition:background 0.2s;
    }
    .upl-thumb{width:44px;height:44px;border-radius:6px;object-fit:cover;flex-shrink:0;background:#2a2a2a;}
    .upl-thumb.video-thumb{display:flex;align-items:center;justify-content:center;font-size:18px;color:#555;}
    .upl-info{flex:1;min-width:0;}
    .upl-name{
      font-size:12px;font-weight:600;font-family:'IBM Plex Mono',monospace;
      white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#ddd;
    }
    .upl-size{font-size:10px;color:#555;font-family:'IBM Plex Mono',monospace;margin-bottom:5px;}
    .upl-bar-track{height:3px;background:#2a2a2a;border-radius:2px;overflow:hidden;}
    .upl-bar{height:100%;border-radius:2px;background:#FF2B2B;width:0%;transition:width 0.1s linear;}
    .upl-bar.done{background:#22c55e;width:100%!important;}
    .upl-bar.error{background:#ef4444;width:100%!important;}
    .upl-status{font-size:10px;font-family:'IBM Plex Mono',monospace;flex-shrink:0;min-width:48px;text-align:right;}
    .upl-status.pending{color:#555;}
    .upl-status.uploading{color:#FF2B2B;}
    .upl-status.done{color:#22c55e;}
    .upl-status.error{color:#ef4444;}
    .upl-remove{background:none;border:none;cursor:pointer;color:#444;font-size:14px;padding:0 2px;flex-shrink:0;font-family:monospace;line-height:1;}
    .upl-remove:hover{color:#FF2B2B;}
    .upl-item.active .upl-remove{display:none;}
    #upl-footer{
      padding:16px 24px;border-top:1px solid #222;
      display:flex;align-items:center;gap:12px;flex-shrink:0;
    }
    #upl-queue-count{font-size:11px;font-family:'IBM Plex Mono',monospace;color:#666;}
    #upl-clear{
      font-size:11px;font-family:'IBM Plex Mono',monospace;
      color:#444;background:none;border:none;cursor:pointer;text-decoration:underline;padding:0;
    }
    #upl-clear:hover{color:#FF2B2B;}
    #upl-start{
      background:#FF2B2B;color:white;border:none;border-radius:8px;
      padding:10px 24px;font-family:'Space Grotesk',sans-serif;
      font-size:12px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;
      cursor:pointer;transition:opacity 0.15s,transform 0.1s;margin-left:auto;
    }
    #upl-start:hover{opacity:0.88;}
    #upl-start:active{transform:scale(0.97);}
    #upl-start:disabled{opacity:0.4;cursor:not-allowed;transform:none;}
  `;
  document.head.appendChild(style);

  const backdrop = document.createElement('div');
  backdrop.id = 'upl-backdrop';
  backdrop.innerHTML = `
    <div id="upl-modal" role="dialog" aria-modal="true">
      <div id="upl-header">
        <div id="upl-title">Upload Files</div>
        <button id="upl-close" title="Close">✕</button>
      </div>
      <label id="upl-drop" for="upl-file-input">
        <div id="upl-drop-icon">📁</div>
        <div id="upl-drop-label">Tap to select or drag &amp; drop files here</div>
        <input type="file" id="upl-file-input" multiple accept="image/*,video/*"/>
      </label>
      <div id="upl-type-note">JPG · PNG · WEBP · HEIC · GIF · MP4 · MOV · MKV · and more</div>
      <div id="upl-overall">
        <div id="upl-overall-row">
          <span id="upl-overall-label">Uploading...</span>
          <span id="upl-overall-pct">0%</span>
        </div>
        <div id="upl-overall-bar-track"><div id="upl-overall-bar"></div></div>
      </div>
      <div id="upl-queue"></div>
      <div id="upl-footer">
        <span id="upl-queue-count">No files selected</span>
        <button id="upl-clear" style="display:none">Clear all</button>
        <button id="upl-start" disabled>Upload</button>
      </div>
    </div>
  `;
  document.body.appendChild(backdrop);

  // Wire buttons
  document.getElementById('upl-close').addEventListener('click', () => closeUploader());
  document.getElementById('upl-clear').addEventListener('click', () => clearQueue());
  document.getElementById('upl-start').addEventListener('click', () => startUpload());
  backdrop.addEventListener('click', e => { if (e.target === backdrop) closeUploader(); });

  // File input
  document.getElementById('upl-file-input').addEventListener('change', function() {
    if (!this.files || this.files.length === 0) return;
    addFiles(Array.from(this.files));
    this.value = '';
  });

  // Drag and drop on drop zone
  const drop = document.getElementById('upl-drop');
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('drag-over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('drag-over'));
  drop.addEventListener('drop', e => {
    e.preventDefault();
    drop.classList.remove('drag-over');
    if (e.dataTransfer.files.length) addFiles(Array.from(e.dataTransfer.files));
  });

  // Drag onto whole page when modal open
  document.addEventListener('dragover', e => { if (uploaderOpen) e.preventDefault(); });
  document.addEventListener('drop', e => {
    if (!uploaderOpen) return;
    e.preventDefault();
    if (e.dataTransfer.files.length) addFiles(Array.from(e.dataTransfer.files));
  });

  document.addEventListener('keydown', e => { if (uploaderOpen && e.key === 'Escape') closeUploader(); });
})();

// ── State ────────────────────────────────────────────────────
let uploaderOpen = false;
let queue = [];
let uploading = false;

function openUploader() {
  uploaderOpen = true;
  document.getElementById('upl-backdrop').classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeUploader() {
  if (uploading) return;
  uploaderOpen = false;
  document.getElementById('upl-backdrop').classList.remove('open');
  document.body.style.overflow = '';
}

function formatBytes(b) {
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
  return (b / (1024 * 1024)).toFixed(1) + ' MB';
}

function isVideo(file) {
  return file.type.startsWith('video/');
}

function addFiles(files) {
  const allowed = /\.(jpg|jpeg|png|gif|webp|bmp|tiff|tif|avif|heic|svg|jfif|mp4|webm|ogg|mov|avi|mkv|m4v|flv|wmv|3gp)$/i;
  files.filter(f => allowed.test(f.name)).forEach(file => {
    if (queue.find(q => q.file.name === file.name && q.file.size === file.size)) return;
    const id = Math.random().toString(36).slice(2);
    const item = { file, id, status: 'pending', progress: 0, barEl: null, statusEl: null };
    queue.push(item);
    renderQueueItem(item);
  });
  updateFooter();
}

function renderQueueItem(item) {
  const queueEl = document.getElementById('upl-queue');
  const div = document.createElement('div');
  div.className = 'upl-item';
  div.id = 'upl-item-' + item.id;

  if (isVideo(item.file)) {
    div.innerHTML = `<div class="upl-thumb video-thumb">▶</div>`;
  } else {
    div.innerHTML = `<img class="upl-thumb" id="upl-thumb-${item.id}" src="" alt=""/>`;
  }

  div.innerHTML += `
    <div class="upl-info">
      <div class="upl-name" title="${item.file.name}">${item.file.name}</div>
      <div class="upl-size">${formatBytes(item.file.size)}</div>
      <div class="upl-bar-track"><div class="upl-bar" id="upl-bar-${item.id}"></div></div>
    </div>
    <div class="upl-status pending" id="upl-status-${item.id}">queued</div>
    <button class="upl-remove" title="Remove">✕</button>
  `;

  // ✅ item.id captured correctly in closure
  div.querySelector('.upl-remove').addEventListener('click', () => removeFromQueue(item.id));

  item.barEl    = div.querySelector('.upl-bar');
  item.statusEl = div.querySelector('.upl-status');

  queueEl.appendChild(div);

  // Image preview
  if (!isVideo(item.file)) {
    const reader = new FileReader();
    reader.onload = e => {
      const img = div.querySelector('.upl-thumb');
      if (img) img.src = e.target.result;
    };
    reader.readAsDataURL(item.file);
  }
}

function removeFromQueue(id) {
  queue = queue.filter(q => q.id !== id);
  const el = document.getElementById('upl-item-' + id);
  if (el) el.remove();
  updateFooter();
}

function clearQueue() {
  queue = queue.filter(q => q.status === 'uploading');
  document.getElementById('upl-queue').innerHTML = '';
  queue.forEach(item => renderQueueItem(item));
  updateFooter();
}

function updateFooter() {
  const total   = queue.length;
  const done    = queue.filter(q => q.status === 'done').length;
  const errored = queue.filter(q => q.status === 'error').length;
  const pending = queue.filter(q => q.status === 'pending').length;

  const countEl = document.getElementById('upl-queue-count');
  if (total === 0) countEl.textContent = 'No files selected';
  else if (uploading) countEl.textContent = `${done} / ${total} done${errored ? ` · ${errored} failed` : ''}`;
  else countEl.textContent = `${total} file${total !== 1 ? 's' : ''} selected · ${formatBytes(queue.reduce((s, q) => s + q.file.size, 0))}`;

  document.getElementById('upl-clear').style.display = total > 0 && !uploading ? 'block' : 'none';
  document.getElementById('upl-start').disabled = pending === 0 || uploading;
  document.getElementById('upl-start').textContent = uploading
    ? 'Uploading...'
    : `Upload ${pending > 0 ? pending + ' file' + (pending !== 1 ? 's' : '') : ''}`;
}

// ── Upload engine ─────────────────────────────────────────────
async function startUpload() {
  const pending = queue.filter(q => q.status === 'pending');
  if (pending.length === 0) return;

  uploading = true;
  document.getElementById('upl-overall').style.display = 'block';
  document.getElementById('upl-start').disabled = true;
  document.getElementById('upl-close').style.opacity = '0.4';
  document.getElementById('upl-close').style.pointerEvents = 'none';
  updateFooter();

  const total = pending.length;
  let completed = 0;

  function tick() {
    completed++;
    const pct = Math.round((completed / total) * 100);
    document.getElementById('upl-overall-bar').style.width = pct + '%';
    document.getElementById('upl-overall-pct').textContent = pct + '%';
    document.getElementById('upl-overall-label').textContent = `${completed} / ${total} uploaded`;
    updateFooter();
  }

  let idx = 0;
  async function runWorker() {
    while (idx < pending.length) {
      const item = pending[idx++];
      await uploadOne(item);
      tick();
    }
  }

  const workers = [];
  for (let i = 0; i < Math.min(CONCURRENCY, pending.length); i++) workers.push(runWorker());
  await Promise.all(workers);

  uploading = false;
  document.getElementById('upl-close').style.opacity = '';
  document.getElementById('upl-close').style.pointerEvents = '';
  document.getElementById('upl-start').textContent = 'Done ✓';
  document.getElementById('upl-overall-label').textContent = `All ${total} file${total !== 1 ? 's' : ''} processed`;

  if (typeof loadFiles === 'function') await loadFiles();
  updateFooter();
}

function uploadOne(item) {
  return new Promise(resolve => {
    item.status = 'uploading';
    const itemEl = document.getElementById('upl-item-' + item.id);
    if (itemEl) itemEl.classList.add('active');
    if (item.statusEl) { item.statusEl.className = 'upl-status uploading'; item.statusEl.textContent = '0%'; }

    const form = new FormData();
    form.append('files', item.file, item.file.name);

    const xhr = new XMLHttpRequest();

    xhr.upload.addEventListener('progress', e => {
      if (!e.lengthComputable) return;
      const pct = Math.round((e.loaded / e.total) * 100);
      if (item.barEl) item.barEl.style.width = pct + '%';
      if (item.statusEl) item.statusEl.textContent = pct + '%';
    });

    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        item.status = 'done';
        if (item.barEl) item.barEl.classList.add('done');
        if (item.statusEl) { item.statusEl.className = 'upl-status done'; item.statusEl.textContent = '✓'; }
      } else {
        let msg = 'failed';
        try { msg = JSON.parse(xhr.responseText).error || 'failed'; } catch {}
        item.status = 'error';
        if (item.barEl) item.barEl.classList.add('error');
        if (item.statusEl) { item.statusEl.className = 'upl-status error'; item.statusEl.textContent = '✕'; }
        console.error('Upload failed:', item.file.name, msg);
      }
      resolve();
    });

    xhr.addEventListener('error', () => {
      item.status = 'error';
      if (item.barEl) item.barEl.classList.add('error');
      if (item.statusEl) { item.statusEl.className = 'upl-status error'; item.statusEl.textContent = '✕'; }
      resolve();
    });

    xhr.open('POST', '/api/upload');
    xhr.send(form);
  });
}
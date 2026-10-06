'use strict';

const CONCURRENCY = 5;
const allowed = /\.(jpg|jpeg|png|gif|webp|bmp|tiff|tif|avif|heic|svg|jfif|mp4|webm|ogg|mov|avi|mkv|m4v|flv|wmv|3gp)$/i;

let queue = [];
let uploading = false;
let uploaderOpen = false;
let uploadOrigin = null;
let dragDepth = 0;
let nextUploadId = 1;

(function mountUploader() {
    const style = document.createElement('style');
    style.textContent = `
        #upl-backdrop{position:fixed;inset:0;z-index:300;display:grid;place-items:center;padding:24px;background:rgba(7,8,12,.62);backdrop-filter:blur(9px);opacity:0;pointer-events:none;visibility:hidden;transition:opacity var(--motion-normal,180ms) var(--ease-standard,ease),visibility var(--motion-normal,180ms)}
        #upl-backdrop.open{opacity:1;pointer-events:auto;visibility:visible}
        #upl-modal,#upl-center{color:var(--t);background:var(--s2);border:1px solid var(--br2);box-shadow:var(--shadow-floating);}
        #upl-modal{display:flex;flex-direction:column;width:min(680px,calc(100vw - 48px));max-height:min(820px,calc(100dvh - 48px));overflow:hidden;border-radius:var(--radius-xl,18px);transform:translateY(8px);transition:transform var(--motion-normal,180ms) var(--ease-standard,ease)}
        #upl-backdrop.open #upl-modal{transform:translateY(0)}
        #upl-header{display:flex;align-items:center;gap:16px;padding:20px 24px 17px;border-bottom:1px solid var(--br);flex:none}
        .upl-heading{flex:1;min-width:0}.upl-eyebrow{margin-bottom:5px;color:var(--r);font:500 10px/1.2 var(--font-meta);letter-spacing:.12em;text-transform:uppercase}
        #upl-title{font:600 21px/1.2 var(--font-ui)}.upl-subtitle{margin-top:5px;color:var(--t3);font:12px/1.45 var(--font-ui)}
        #upl-close,.upl-action,#upl-clear,#upl-center button{display:inline-flex;align-items:center;justify-content:center;min-width:40px;min-height:40px;padding:0 11px;border:1px solid transparent;border-radius:var(--radius-sm);background:transparent;color:var(--t2);font:500 12px var(--font-ui);cursor:pointer;transition:background var(--motion-fast) var(--ease-standard),border-color var(--motion-fast) var(--ease-standard),color var(--motion-fast) var(--ease-standard)}
        #upl-close{width:42px;font-size:20px}.upl-action{min-width:38px;padding-inline:9px}.upl-action.retry{border-color:var(--br2);color:var(--t)}
        #upl-close:hover,.upl-action:hover,#upl-clear:hover,#upl-center button:hover{background:var(--s3);border-color:var(--br2);color:var(--t)}
        #upl-drop{position:relative;display:grid;justify-items:center;gap:7px;margin:18px 24px 4px;padding:22px 18px;border:1px dashed var(--br2);border-radius:var(--radius-lg);background:var(--s);text-align:center;cursor:pointer;outline:none;transition:border-color var(--motion-fast) var(--ease-standard),background var(--motion-fast) var(--ease-standard)}
        #upl-drop:hover,#upl-drop:focus-visible{border-color:var(--r);background:var(--r2)}
        #upl-drop.drag{border-color:var(--r);background:var(--r2);box-shadow:inset 0 0 0 1px var(--r)}
        .upl-drop-icon{display:grid;place-items:center;width:36px;height:36px;border:1px solid var(--br2);border-radius:50%;color:var(--r);font-size:17px}
        .upl-drop-title{color:var(--t);font:600 15px var(--font-ui)}.upl-drop-note{color:var(--t3);font:11px/1.45 var(--font-ui)}
        #upl-file{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;clip-path:inset(50%)}
        #upl-queue{flex:1;min-height:0;max-height:min(42vh,390px);overflow:auto;padding:8px 24px 14px;overscroll-behavior:contain;scrollbar-color:var(--br2) transparent;scrollbar-width:thin}
        #upl-queue:empty{display:none}
        .upl-item{display:grid;grid-template-columns:minmax(0,1fr) auto auto;align-items:center;gap:12px;padding:11px 0;border-bottom:1px solid var(--br)}
        .upl-info{min-width:0}.upl-name{overflow:hidden;color:var(--t);font:500 12px/1.4 var(--font-ui);text-overflow:ellipsis;white-space:nowrap}
        .upl-meta,.upl-status{color:var(--t3);font:10px/1.4 var(--font-meta)}.upl-meta{margin-top:3px;overflow-wrap:anywhere}.upl-status{min-width:78px;text-align:right;white-space:nowrap}
        .upl-status.uploading{color:var(--t2)}.upl-status.error{color:var(--danger)}.upl-status.done{color:var(--success)}.upl-status.cancelled{color:var(--t3)}
        .upl-bar,.upl-progress{height:3px;overflow:hidden;border-radius:3px;background:var(--br2)}.upl-bar{margin-top:8px}.upl-bar i,.upl-progress i{display:block;width:0;height:100%;background:var(--r);transition:width 140ms linear}.upl-bar.done i,.upl-progress.done i{background:var(--success)}.upl-bar.error i{background:var(--danger)}
        .upl-error{margin-top:5px;color:var(--danger);font:11px/1.4 var(--font-ui);overflow-wrap:anywhere}
        #upl-footer{display:flex;align-items:center;gap:9px;padding:14px 24px calc(14px + env(safe-area-inset-bottom,0px));border-top:1px solid var(--br);flex:none;background:var(--s2)}
        #upl-footer-count{flex:1;min-width:0;color:var(--t3);font:10px/1.5 var(--font-meta)}
        #upl-clear{font-size:11px}#upl-start{min-height:42px;padding:0 18px;border:1px solid var(--r);border-radius:var(--radius-sm);background:var(--r);color:#fff;font:600 12px var(--font-ui);cursor:pointer;transition:filter var(--motion-fast) var(--ease-standard),opacity var(--motion-fast) var(--ease-standard)}#upl-start:hover:not(:disabled){filter:brightness(1.08)}#upl-start:disabled{opacity:.48;cursor:not-allowed}
        #upl-center{position:fixed;right:20px;bottom:20px;z-index:250;width:min(360px,calc(100vw - 40px));overflow:hidden;border-radius:var(--radius-lg);opacity:0;visibility:hidden;transform:translateY(8px);pointer-events:none;transition:opacity var(--motion-normal) var(--ease-standard),transform var(--motion-normal) var(--ease-standard),visibility var(--motion-normal)}
        #upl-center.on{opacity:1;visibility:visible;transform:translateY(0);pointer-events:auto}.upl-head{display:flex;align-items:center;gap:10px;padding:12px 14px 10px}.upl-head strong{flex:1;font:600 12px var(--font-ui)}
        .upl-progress{height:3px;border-radius:0}.upl-summary{padding:8px 14px 10px;color:var(--t3);font:10px/1.5 var(--font-meta)}.upl-actions{display:flex;gap:6px;padding:0 10px 10px}.upl-actions button{min-height:36px;border-color:var(--br)}
        body.uploader-open{overflow:hidden}
        @media(min-width:1200px){#upl-modal{width:min(720px,calc(100vw - 64px))}#upl-queue{max-height:min(44vh,430px)}}
        @media(max-width:640px){#upl-backdrop{align-items:end;padding:0;background:rgba(7,8,12,.54)}#upl-modal{width:100%;max-height:min(92dvh,820px);border-radius:20px 20px 0 0;border-bottom:0;transform:translateY(16px)}#upl-backdrop.open #upl-modal{transform:translateY(0)}#upl-header{padding:17px 18px 14px}.upl-eyebrow{font-size:9px}#upl-title{font-size:19px}.upl-subtitle{font-size:11px}#upl-drop{margin:14px 16px 2px;padding:17px 12px;gap:5px}.upl-drop-icon{width:32px;height:32px}#upl-queue{max-height:34dvh;padding:6px 18px 12px}.upl-item{grid-template-columns:minmax(0,1fr) auto;gap:7px 9px;padding:10px 0}.upl-info{grid-column:1}.upl-status{grid-column:2;grid-row:1;min-width:0;font-size:9px}.upl-action{grid-column:2;grid-row:2;min-height:36px}.upl-bar,.upl-error{grid-column:1 / -1}#upl-footer{flex-wrap:wrap;gap:7px;padding:11px 16px calc(12px + env(safe-area-inset-bottom,0px))}#upl-footer-count{flex-basis:100%;font-size:9px}#upl-clear{margin-left:auto;min-height:42px}#upl-start{min-width:104px;min-height:44px}#upl-center{right:10px;bottom:calc(72px + env(safe-area-inset-bottom,0px));width:calc(100vw - 20px)}}
        @media(max-height:620px) and (max-width:640px){#upl-backdrop{align-items:center;padding:8px}#upl-modal{max-height:calc(100dvh - 16px);border-radius:16px}#upl-header{padding-block:10px}.upl-subtitle{display:none}#upl-drop{margin-block:8px;padding-block:11px}#upl-queue{max-height:26dvh}#upl-footer{padding-top:8px}}
        @media(prefers-reduced-motion:reduce){#upl-backdrop,#upl-modal,#upl-center,#upl-bar i,#upl-progress i,#upl-drop{transition:none!important}}
    `;
    document.head.appendChild(style);

    document.body.insertAdjacentHTML('beforeend', `
        <div id="upl-backdrop" aria-hidden="true">
            <section id="upl-modal" role="dialog" aria-modal="true" aria-labelledby="upl-title" aria-describedby="upl-subtitle" tabindex="-1">
                <header id="upl-header">
                    <div class="upl-heading"><div class="upl-eyebrow">Your library, growing</div><h2 id="upl-title">Upload</h2><p id="upl-subtitle" class="upl-subtitle">Add a few moments to your private collection.</p></div>
                    <button id="upl-close" type="button" aria-label="Close upload dialog">×</button>
                </header>
                <div id="upl-drop" role="button" tabindex="0" aria-label="Choose files or drop media here">
                    <span class="upl-drop-icon" aria-hidden="true">↑</span>
                    <span class="upl-drop-title">Drop your media here</span>
                    <span class="upl-drop-note">or <span class="upl-choose">choose files</span> · images and videos, multiple files supported</span>
                    <input id="upl-file" type="file" tabindex="-1" multiple accept="image/*,video/*" aria-label="Choose media files">
                </div>
                <div id="upl-queue" aria-label="Selected files" aria-live="polite"></div>
                <footer id="upl-footer">
                    <span id="upl-footer-count" aria-live="polite">No files selected</span>
                    <button id="upl-clear" type="button">Clear completed</button>
                    <button id="upl-start" type="button" disabled>Upload</button>
                </footer>
            </section>
        </div>
        <aside id="upl-center" aria-label="Upload Center">
            <div class="upl-head"><strong>Upload Center</strong><span id="upl-state" class="upl-status" role="status" aria-live="polite"></span><button id="upl-open" type="button" aria-label="Open upload details">↗</button></div>
            <div class="upl-progress" role="progressbar" aria-label="Overall upload progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><i id="upl-totalbar"></i></div>
            <div id="upl-summary" class="upl-summary"></div>
            <div class="upl-actions"><button id="upl-center-open" type="button">View details</button><button id="upl-center-clear" type="button">Clear completed</button></div>
        </aside>
    `);

    const backdrop = document.getElementById('upl-backdrop');
    const modal = document.getElementById('upl-modal');
    const drop = document.getElementById('upl-drop');
    const input = document.getElementById('upl-file');

    drop.addEventListener('click', (event) => {
        if (!event.target.closest('#upl-file')) input.click();
    });
    drop.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            input.click();
        }
    });
    input.addEventListener('change', (event) => {
        add([...event.target.files]);
        event.target.value = '';
    });
    ['dragenter', 'dragover'].forEach((name) => drop.addEventListener(name, (event) => {
        event.preventDefault();
        event.stopPropagation();
        drop.classList.add('drag');
    }));
    ['dragleave', 'drop'].forEach((name) => drop.addEventListener(name, (event) => {
        event.preventDefault();
        event.stopPropagation();
        drop.classList.remove('drag');
    }));
    drop.addEventListener('drop', (event) => add([...(event.dataTransfer?.files || [])]));

    document.addEventListener('dragenter', (event) => {
        if (!event.dataTransfer?.types.includes('Files')) return;
        event.preventDefault();
        dragDepth++;
        if (!uploaderOpen) openUploader();
        drop.classList.add('drag');
    });
    document.addEventListener('dragover', (event) => {
        if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
    });
    document.addEventListener('dragleave', (event) => {
        if (!event.dataTransfer?.types.includes('Files')) return;
        dragDepth = Math.max(0, dragDepth - 1);
        if (!dragDepth) drop.classList.remove('drag');
    });
    document.addEventListener('drop', (event) => {
        if (!event.dataTransfer?.types.includes('Files')) return;
        event.preventDefault();
        dragDepth = 0;
        drop.classList.remove('drag');
        if (!event.target.closest('#upl-drop')) add([...(event.dataTransfer.files || [])]);
    });

    document.getElementById('upl-close').addEventListener('click', closeUploader);
    document.getElementById('upl-start').addEventListener('click', start);
    document.getElementById('upl-clear').addEventListener('click', clear);
    document.getElementById('upl-open').addEventListener('click', openUploader);
    document.getElementById('upl-center-open').addEventListener('click', openUploader);
    document.getElementById('upl-center-clear').addEventListener('click', clear);
    backdrop.addEventListener('click', (event) => {
        if (event.target === backdrop) closeUploader();
    });
    document.addEventListener('keydown', (event) => {
        if (!uploaderOpen) return;
        if (event.key === 'Escape') {
            event.preventDefault();
            closeUploader();
        } else if (event.key === 'Tab') {
            const focusable = [...modal.querySelectorAll('button:not(:disabled), [tabindex="0"]')]
                .filter((element) => element.offsetParent !== null);
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (!modal.contains(document.activeElement)) {
                event.preventDefault();
                (event.shiftKey ? last : first)?.focus();
            } else if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last?.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first?.focus();
            }
        }
    });
})();

function openUploader() {
    const backdrop = document.getElementById('upl-backdrop');
    if (uploaderOpen) return;
    uploadOrigin = document.activeElement;
    uploaderOpen = true;
    document.body.classList.add('uploader-open');
    backdrop.classList.add('open');
    backdrop.setAttribute('aria-hidden', 'false');
    setTimeout(() => {
        if (uploaderOpen) document.getElementById('upl-drop').focus();
    }, 80);
}

function closeUploader() {
    if (!uploaderOpen) return;
    uploaderOpen = false;
    const backdrop = document.getElementById('upl-backdrop');
    backdrop.classList.remove('open');
    backdrop.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('uploader-open');
    uploadOrigin?.focus();
}

function add(files) {
    let bad = 0;
    files.forEach((file) => {
        if (!allowed.test(file.name)) {
            bad++;
            return;
        }
        const duplicate = queue.some((item) => item.file.name === file.name && item.file.size === file.size);
        if (!duplicate) queue.push({ id: nextUploadId++, file, status: 'pending', progress: 0, error: '', xhr: null });
    });
    if (bad && typeof showToast === 'function') {
        showToast(`${bad} unsupported file${bad > 1 ? 's' : ''} skipped`, 'err');
    }
    render();
}

function formatSize(bytes) {
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
}

function fileStatus(item) {
    if (item.status === 'uploading') return `Uploading · ${item.progress}%`;
    if (item.status === 'done') return 'Completed';
    if (item.status === 'error') return 'Needs attention';
    if (item.status === 'cancelled') return 'Cancelled';
    return 'Ready';
}

function render() {
    const list = document.getElementById('upl-queue');
    list.replaceChildren();
    queue.forEach((item) => {
        const row = document.createElement('div');
        row.className = 'upl-item';
        row.dataset.uploadId = String(item.id);
        row.dataset.status = item.status;

        const info = document.createElement('div');
        info.className = 'upl-info';
        const name = document.createElement('div');
        name.className = 'upl-name';
        name.textContent = item.file.name;
        name.title = item.file.name;
        const meta = document.createElement('div');
        meta.className = 'upl-meta';
        meta.textContent = `${formatSize(item.file.size)} · ${item.file.type?.startsWith('video/') ? 'Video' : item.file.type?.startsWith('image/') ? 'Image' : 'Media'}`;
        const bar = document.createElement('div');
        bar.className = `upl-bar ${item.status}`;
        bar.setAttribute('role', 'progressbar');
        bar.setAttribute('aria-label', `Upload progress for ${item.file.name}`);
        bar.setAttribute('aria-valuemin', '0');
        bar.setAttribute('aria-valuemax', '100');
        bar.setAttribute('aria-valuenow', String(item.progress));
        const fill = document.createElement('i');
        fill.style.width = `${item.progress}%`;
        bar.append(fill);
        info.append(name, meta, bar);
        if (item.error) {
            const error = document.createElement('div');
            error.className = 'upl-error';
            error.textContent = item.error;
            info.append(error);
        }

        const status = document.createElement('span');
        status.className = `upl-status ${item.status}`;
        status.textContent = fileStatus(item);
        const action = document.createElement('button');
        action.type = 'button';
        action.className = `upl-action${item.status === 'error' ? ' retry' : ''}`;
        action.setAttribute('aria-label', `${item.status === 'error' ? 'Retry' : item.status === 'uploading' ? 'Cancel' : 'Remove'} ${item.file.name}`);
        action.textContent = item.status === 'error' ? 'Retry' : item.status === 'uploading' ? 'Cancel' : '×';
        action.addEventListener('click', () => {
            if (item.status === 'error') {
                item.status = 'pending';
                item.progress = 0;
                item.error = '';
                render();
                start();
            } else if (item.status === 'uploading') {
                item.xhr?.abort();
            } else {
                queue = queue.filter((entry) => entry !== item);
                render();
            }
        });
        row.append(info, status, action);
        list.append(row);
    });
    update();
}

function updateItem(item) {
    const row = document.querySelector(`.upl-item[data-upload-id="${item.id}"]`);
    if (!row) return render();
    row.dataset.status = item.status;
    const bar = row.querySelector('.upl-bar');
    bar.className = `upl-bar ${item.status}`;
    bar.setAttribute('aria-valuenow', String(item.progress));
    bar.firstElementChild.style.width = `${item.progress}%`;
    row.querySelector('.upl-status').className = `upl-status ${item.status}`;
    row.querySelector('.upl-status').textContent = fileStatus(item);
    let error = row.querySelector('.upl-error');
    if (item.error) {
        if (!error) {
            error = document.createElement('div');
            error.className = 'upl-error';
            row.querySelector('.upl-info').append(error);
        }
        error.textContent = item.error;
    } else {
        error?.remove();
    }
    const button = row.querySelector('.upl-action');
    button.className = `upl-action${item.status === 'error' ? ' retry' : ''}`;
    button.setAttribute('aria-label', `${item.status === 'error' ? 'Retry' : item.status === 'uploading' ? 'Cancel' : 'Remove'} ${item.file.name}`);
    button.textContent = item.status === 'error' ? 'Retry' : item.status === 'uploading' ? 'Cancel' : '×';
    update();
}

function update() {
    const done = queue.filter((item) => item.status === 'done').length;
    const active = queue.filter((item) => item.status === 'uploading').length;
    const pending = queue.filter((item) => item.status === 'pending').length;
    const failed = queue.filter((item) => item.status === 'error').length;
    const total = queue.length;
    const percent = total ? Math.round(queue.reduce((sum, item) => sum + (item.status === 'done' ? 100 : item.status === 'uploading' ? item.progress : 0), 0) / total) : 0;
    document.getElementById('upl-footer-count').textContent = total
        ? `${done} complete · ${active} uploading · ${pending} waiting${failed ? ` · ${failed} failed` : ''}`
        : 'No files selected';
    document.getElementById('upl-start').disabled = !pending || uploading;
    const center = document.getElementById('upl-center');
    center.classList.toggle('on', !!total);
    const progress = document.querySelector('#upl-center .upl-progress');
    progress.setAttribute('aria-valuenow', String(percent));
    progress.classList.toggle('done', !!total && done === total);
    document.getElementById('upl-totalbar').style.width = `${percent}%`;
    document.getElementById('upl-summary').textContent = `${percent}% complete · ${done} of ${total} files${active ? ` · ${active} uploading` : ''}${pending ? ` · ${pending} waiting` : ''}${failed ? ` · ${failed} need attention` : ''}`;
    document.getElementById('upl-state').textContent = uploading ? 'Uploading' : failed ? 'Needs attention' : total && done === total ? 'Complete' : done ? 'In progress' : 'Ready';
}

function clear() {
    queue = queue.filter((item) => !['done', 'cancelled'].includes(item.status));
    render();
}

async function start() {
    if (uploading) return;
    const work = queue.filter((item) => item.status === 'pending');
    if (!work.length) return;
    uploading = true;
    update();
    closeUploader();
    const completedBefore = queue.filter((item) => item.status === 'done').length;
    let index = 0;
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, work.length) }, async () => {
        while (index < work.length) await one(work[index++]);
    }));
    uploading = false;
    render();
    if (typeof loadFiles === 'function') await loadFiles();
    const completed = queue.filter((item) => item.status === 'done').length - completedBefore;
    const failed = queue.filter((item) => item.status === 'error').length;
    if (typeof showToast === 'function' && completed) {
        showToast(`${completed} upload${completed === 1 ? '' : 's'} complete${failed ? ` · ${failed} need attention` : ''}`, failed ? 'err' : 'ok');
    }
}

function humanUploadError(xhr) {
    if (xhr.status === 413) return 'This file is larger than the 500 MB limit.';
    if (xhr.status === 401 || xhr.status === 403) return 'Your session needs attention. Sign in again, then retry.';
    if (xhr.status >= 500) return 'VaultOS could not save this file. Please retry.';
    return 'VaultOS did not accept this file. Check that it is a supported image or video, then retry.';
}

function one(item) {
    return new Promise((resolve) => {
        item.status = 'uploading';
        item.progress = 0;
        updateItem(item);
        const xhr = item.xhr = new XMLHttpRequest();
        const form = new FormData();
        form.append('files', item.file, item.file.name);
        xhr.upload.onprogress = (event) => {
            if (!event.lengthComputable) return;
            item.progress = Math.round((event.loaded / event.total) * 100);
            updateItem(item);
        };
        xhr.onload = () => {
            item.status = xhr.status >= 200 && xhr.status < 300 ? 'done' : 'error';
            item.progress = item.status === 'done' ? 100 : item.progress;
            item.error = item.status === 'error' ? humanUploadError(xhr) : '';
            item.xhr = null;
            updateItem(item);
            resolve();
        };
        xhr.onerror = () => {
            item.status = 'error';
            item.error = 'Connection interrupted before this file was saved. Check your connection and retry.';
            item.xhr = null;
            updateItem(item);
            resolve();
        };
        xhr.onabort = () => {
            item.status = 'cancelled';
            item.error = '';
            item.xhr = null;
            updateItem(item);
            resolve();
        };
        xhr.open('POST', '/api/upload');
        xhr.send(form);
    });
}

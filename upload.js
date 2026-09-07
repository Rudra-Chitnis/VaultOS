'use strict';

const CONCURRENCY = 5;
const allowed = /\.(jpg|jpeg|png|gif|webp|bmp|tiff|tif|avif|heic|svg|jfif|mp4|webm|ogg|mov|avi|mkv|m4v|flv|wmv|3gp)$/i;

let queue = [];
let uploading = false;
let uploaderOpen = false;
let uploadOrigin = null;

(function () {
    const s = document.createElement('style');

    s.textContent = `
        #upl-backdrop {
            position: fixed;
            inset: 0;
            z-index: 300;
            display: grid;
            place-items: center;
            background: #0009;
            backdrop-filter: blur(6px);
            opacity: 0;
            pointer-events: none;
            transition: .18s;
        }

        #upl-backdrop.open {
            opacity: 1;
            pointer-events: auto;
        }

        #upl-modal,
        #upl-center {
            background: var(--s2, #111);
            border: 1px solid var(--br2, #333);
            border-radius: 14px;
            box-shadow: 0 18px 60px #0009;
            color: var(--t, #eee);
        }

        #upl-modal {
            width: min(610px, 94vw);
            max-height: 84vh;
            overflow: auto;
        }

        #upl-header,
        #upl-footer,
        .upl-head {
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 15px 18px;
            border-bottom: 1px solid var(--br, #222);
        }

        #upl-footer {
            border: 0;
            border-top: 1px solid var(--br, #222);
        }

        #upl-title,
        .upl-head strong {
            flex: 1;
            font: 700 15px 'Space Grotesk', sans-serif;
        }

        #upl-close,
        .upl-action,
        #upl-clear,
        #upl-center button {
            border: 0;
            background: none;
            color: var(--t2, #aaa);
            cursor: pointer;
            min-height: 38px;
            padding: 0 9px;
            border-radius: 7px;
        }

        #upl-drop {
            display: block;
            margin: 18px;
            padding: 30px 16px;
            text-align: center;
            border: 2px dashed var(--br2, #333);
            border-radius: 12px;
            cursor: pointer;
            font: 12px 'IBM Plex Mono', monospace;
            color: var(--t2);
        }

        #upl-drop.drag {
            border-color: var(--r);
            background: var(--r2);
        }

        #upl-drop small {
            display: block;
            margin-top: 8px;
            color: var(--t3);
        }

        #upl-file {
            display: none;
        }

        #upl-queue {
            padding: 0 18px 12px;
            max-height: 320px;
            overflow: auto;
        }

        .upl-item {
            display: flex;
            gap: 10px;
            align-items: center;
            padding: 9px;
            border-radius: 9px;
            background: var(--s3, #1a1a1a);
            margin-top: 8px;
        }

        .upl-info {
            flex: 1;
            min-width: 0;
        }

        .upl-name {
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            font: 600 11px 'IBM Plex Mono', monospace;
        }

        .upl-meta,
        .upl-status {
            font: 10px 'IBM Plex Mono', monospace;
            color: var(--t3);
        }

        .upl-status {
            min-width: 70px;
            text-align: right;
        }

        .upl-status.error {
            color: #ff7777;
        }

        .upl-status.done {
            color: #7ddd9d;
        }

        .upl-bar {
            height: 3px;
            margin-top: 6px;
            background: #fff2;
            border-radius: 2px;
            overflow: hidden;
        }

        .upl-bar i {
            display: block;
            height: 100%;
            background: var(--r);
            transition: width .12s;
        }

        .upl-bar.done i {
            background: #57c783;
        }

        #upl-start {
            margin-left: auto;
            min-height: 40px;
            padding: 0 15px;
            border: 0;
            border-radius: 8px;
            background: var(--r);
            color: #fff;
            font-weight: 700;
            cursor: pointer;
        }

        #upl-start:disabled {
            opacity: .45;
        }

        #upl-footer-count {
            flex: 1;
            font: 10px 'IBM Plex Mono', monospace;
            color: var(--t2);
        }

        #upl-center {
            display: none;
            position: fixed;
            right: 16px;
            bottom: 16px;
            z-index: 250;
            width: min(350px, calc(100vw - 32px));
            overflow: hidden;
        }

        #upl-center.on {
            display: block;
        }

        .upl-progress {
            height: 4px;
            background: #fff2;
        }

        .upl-progress i {
            display: block;
            height: 100%;
            background: var(--r);
            transition: width .16s;
        }

        .upl-summary {
            padding: 8px 12px;
            font: 10px 'IBM Plex Mono', monospace;
            color: var(--t3);
        }

        .upl-actions {
            display: flex;
            padding: 0 12px 10px;
            gap: 7px;
        }

        .upl-actions button {
            border: 1px solid var(--br2);
            background: var(--s3);
        }

        @media (max-width: 640px) {
            #upl-center {
                right: 10px;
                bottom: 70px;
                width: calc(100vw - 20px);
            }
        }
    `;

    document.head.appendChild(s);

    document.body.insertAdjacentHTML(
        'beforeend',
        `
        <div id="upl-backdrop" aria-hidden="true">
            <section
                id="upl-modal"
                role="dialog"
                aria-modal="true"
                aria-labelledby="upl-title"
            >
                <header id="upl-header">
                    <h2 id="upl-title">Upload media</h2>

                    <button
                        id="upl-close"
                        aria-label="Close upload dialog"
                    >
                        ×
                    </button>
                </header>

                <label id="upl-drop" for="upl-file">
                    ⇧ Choose files or drop media here

                    <small>
                        Images, GIFs and videos · multiple files supported
                    </small>

                    <input
                        id="upl-file"
                        type="file"
                        multiple
                        accept="image/*,video/*"
                    >
                </label>

                <div
                    id="upl-queue"
                    aria-live="polite"
                ></div>

                <footer id="upl-footer">
                    <span id="upl-footer-count">
                        No files selected
                    </span>

                    <button id="upl-clear">
                        Clear completed
                    </button>

                    <button id="upl-start" disabled>
                        Upload
                    </button>
                </footer>
            </section>
        </div>

        <aside
            id="upl-center"
            aria-live="polite"
            aria-label="Upload Center"
        >
            <div class="upl-head">
                <strong>Upload Center</strong>

                <span
                    id="upl-state"
                    class="upl-status"
                ></span>

                <button
                    id="upl-open"
                    aria-label="Open upload details"
                >
                    ⌃
                </button>
            </div>

            <div
                class="upl-progress"
                role="progressbar"
                aria-label="Overall upload progress"
                aria-valuemin="0"
                aria-valuemax="100"
            >
                <i id="upl-totalbar"></i>
            </div>

            <div
                id="upl-summary"
                class="upl-summary"
            ></div>

            <div class="upl-actions">
                <button id="upl-center-open">
                    View details
                </button>

                <button id="upl-center-clear">
                    Clear completed
                </button>
            </div>
        </aside>
        `
    );

    const drop = document.getElementById('upl-drop');

    document.getElementById('upl-file').onchange = (e) => {
        add([...e.target.files]);
        e.target.value = '';
    };

    ['dragover', 'dragenter'].forEach((eventName) => {
        drop.addEventListener(eventName, (e) => {
            e.preventDefault();
            drop.classList.add('drag');
        });
    });

    ['drop', 'dragleave'].forEach((eventName) => {
        drop.addEventListener(eventName, (e) => {
            e.preventDefault();
            drop.classList.remove('drag');
        });
    });

    drop.addEventListener('drop', (e) => {
        add([...e.dataTransfer.files]);
    });

    document.addEventListener('dragenter', (e) => {
        if (e.dataTransfer?.types.includes('Files')) {
            openUploader();
        }
    });

    document.getElementById('upl-close').onclick = closeUploader;
    document.getElementById('upl-start').onclick = start;
    document.getElementById('upl-clear').onclick = clear;
    document.getElementById('upl-open').onclick = openUploader;
    document.getElementById('upl-center-open').onclick = openUploader;
    document.getElementById('upl-center-clear').onclick = clear;

    document.addEventListener('keydown', (e) => {
        if (uploaderOpen && e.key === 'Escape') {
            closeUploader();
        }
    });
})();


function openUploader() {
    uploadOrigin = document.activeElement;
    uploaderOpen = true;

    document
        .getElementById('upl-backdrop')
        .classList.add('open');

    document
        .getElementById('upl-backdrop')
        .setAttribute('aria-hidden', 'false');

    setTimeout(() => {
        document.getElementById('upl-drop').focus();
    }, 0);
}


function closeUploader() {
    uploaderOpen = false;

    document
        .getElementById('upl-backdrop')
        .classList.remove('open');

    document
        .getElementById('upl-backdrop')
        .setAttribute('aria-hidden', 'true');

    uploadOrigin?.focus();
}


function add(files) {
    let bad = 0;

    files.forEach((file) => {
        if (!allowed.test(file.name)) {
            bad++;
            return;
        }

        const duplicate = queue.some(
            (x) =>
                x.file.name === file.name &&
                x.file.size === file.size
        );

        if (!duplicate) {
            queue.push({
                file,
                status: 'pending',
                progress: 0,
                error: '',
                xhr: null
            });
        }
    });

    if (
        bad &&
        typeof showToast === 'function'
    ) {
        showToast(
            `${bad} unsupported file${bad > 1 ? 's' : ''} skipped`,
            'err'
        );
    }

    render();
}


function render() {
    const q = document.getElementById('upl-queue');

    q.innerHTML = '';

    queue.forEach((x) => {
        const e = document.createElement('div');

        e.className = 'upl-item';

        e.innerHTML = `
            <div class="upl-info">
                <div class="upl-name">
                    ${x.file.name}
                </div>

                <div class="upl-meta">
                    ${Math.max(
                        1,
                        Math.round(x.file.size / 1024)
                    )} KB
                    ${x.error ? ' · Retry available' : ''}
                </div>

                <div class="upl-bar ${x.status}">
                    <i style="width:${x.progress}%"></i>
                </div>
            </div>

            <span class="upl-status ${x.status}">
                ${
                    x.status === 'uploading'
                        ? `Uploading ${x.progress}%`
                        : x.status === 'done'
                            ? 'Completed'
                            : x.status === 'error'
                                ? 'Failed'
                                : x.status === 'cancelled'
                                    ? 'Cancelled'
                                    : 'Waiting'
                }
            </span>

            <button
                class="upl-action"
                aria-label="${
                    x.status === 'error'
                        ? 'Retry'
                        : x.status === 'uploading'
                            ? 'Cancel'
                            : 'Remove'
                } ${x.file.name}"
            >
                ${
                    x.status === 'error'
                        ? 'Retry'
                        : x.status === 'uploading'
                            ? 'Cancel'
                            : '×'
                }
            </button>
        `;

        e.querySelector('button').onclick = () => {
            if (x.status === 'error') {
                x.status = 'pending';
                x.progress = 0;
                x.error = '';

                render();
                start();

            } else if (x.status === 'uploading') {
                x.xhr.abort();

            } else {
                queue = queue.filter((y) => y !== x);
                render();
            }
        };

        q.appendChild(e);
    });

    update();
}


function update() {
    const d = queue.filter(
        (x) => x.status === 'done'
    ).length;

    const a = queue.filter(
        (x) => x.status === 'uploading'
    ).length;

    const p = queue.filter(
        (x) => x.status === 'pending'
    ).length;

    const f = queue.filter(
        (x) => x.status === 'error'
    ).length;

    const n = queue.length;

    const percent = n
        ? Math.round(
            queue.reduce(
                (sum, x) =>
                    sum +
                    (
                        x.status === 'done' ||
                        x.status === 'error' ||
                        x.status === 'cancelled'
                            ? 100
                            : x.progress
                    ),
                0
            ) / n
        )
        : 0;

    document.getElementById(
        'upl-footer-count'
    ).textContent = n
        ? `${d} complete · ${a} uploading · ${p} waiting${
            f ? ` · ${f} failed` : ''
        }`
        : 'No files selected';

    document.getElementById(
        'upl-start'
    ).disabled = !p || uploading;

    document.getElementById(
        'upl-center'
    ).classList.toggle('on', !!n);

    document.getElementById(
        'upl-totalbar'
    ).style.width = percent + '%';

    document.getElementById(
        'upl-summary'
    ).textContent =
        `${percent}% · ${d} complete · ${a} uploading · ${p} remaining${
            f ? ` · ${f} failed` : ''
        }`;

    document.getElementById(
        'upl-state'
    ).textContent =
        uploading
            ? 'Uploading'
            : f
                ? 'Needs attention'
                : d
                    ? 'Complete'
                    : 'Ready';
}


function clear() {
    queue = queue.filter(
        (x) =>
            ![
                'done',
                'error',
                'cancelled'
            ].includes(x.status)
    );

    render();
}


async function start() {
    if (uploading) return;

    uploading = true;
    update();
    closeUploader();

    let i = 0;

    const work = queue.filter(
        (x) => x.status === 'pending'
    );

    await Promise.all(
        Array.from(
            {
                length: Math.min(
                    CONCURRENCY,
                    work.length
                )
            },
            async () => {
                while (i < work.length) {
                    await one(work[i++]);
                }
            }
        )
    );

    uploading = false;

    render();

    if (typeof loadFiles === 'function') {
        await loadFiles();
    }

    if (typeof showToast === 'function') {
        showToast(
            `${queue.filter(
                (x) => x.status === 'done'
            ).length} upload(s) complete`,
            'ok'
        );
    }
}


function one(x) {
    return new Promise((ok) => {
        x.status = 'uploading';

        render();

        const xhr = x.xhr = new XMLHttpRequest();
        const fd = new FormData();

        fd.append(
            'files',
            x.file,
            x.file.name
        );

        xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) {
                x.progress = Math.round(
                    (e.loaded / e.total) * 100
                );

                render();
            }
        };

        xhr.onload = () => {
            x.status =
                xhr.status >= 200 &&
                xhr.status < 300
                    ? 'done'
                    : 'error';

            x.progress = 100;

            x.error =
                x.status === 'error'
                    ? 'Upload was not accepted'
                    : '';

            x.xhr = null;

            ok();
        };

        xhr.onerror = () => {
            x.status = 'error';
            x.progress = 100;
            x.error = 'Network connection failed';
            x.xhr = null;

            ok();
        };

        xhr.onabort = () => {
            x.status = 'cancelled';
            x.xhr = null;

            ok();
        };

        xhr.open(
            'POST',
            '/api/upload'
        );

        xhr.send(fd);
    });
}
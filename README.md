<div align="center">

# 🔐 VaultOS

### Your media. Your machine. Your faces — recognized, never uploaded.

**A self-hosted, privacy-first media vault with on-device AI face clustering.**

[![License: ISC](https://img.shields.io/badge/license-ISC-blue.svg?style=flat-square)](./LICENSE)
[![Node](https://img.shields.io/badge/Node.js-20%20LTS-339933?style=flat-square&logo=node.js&logoColor=white)](#requirements)
[![Python](https://img.shields.io/badge/Python-3.10%20%7C%203.11-3776AB?style=flat-square&logo=python&logoColor=white)](#requirements)
[![Express](https://img.shields.io/badge/Express-^5.2.1-000000?style=flat-square&logo=express&logoColor=white)](#tech-stack)
[![FastAPI](https://img.shields.io/badge/FastAPI-0.115.5-009688?style=flat-square&logo=fastapi&logoColor=white)](#tech-stack)
[![SQLite](https://img.shields.io/badge/SQLite-face--index-07405E?style=flat-square&logo=sqlite&logoColor=white)](#tech-stack)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20Linux%20%7C%20macOS-lightgrey?style=flat-square)](#requirements)

</div>

---

## ✨ Why VaultOS Exists

Cloud photo apps are convenient — right up until you remember that "convenient" means a company somewhere has a searchable index of your face, your family's faces, and every place you've ever taken a photo.

**VaultOS is the alternative.** It's a media vault that runs entirely on hardware you own, with an AI service that detects and clusters faces locally, so you get the "browse by person" experience of a big cloud photo app — without a single byte ever leaving your machine.

> 🧠 No cloud AI calls. 🔒 Password-gated UI. 💾 Your SQLite index, on your disk, under your control.

---

## 🚀 Feature Highlights

<table>
<tr>
<td width="50%" valign="top">

**🖼️ Media Gallery**
- Unified browsing for images, GIFs, and video
- Drag-and-drop uploads with live progress
- Fast thumbnail + preview generation (Sharp + FFmpeg)
- Favorites, Recent, and Most Viewed tabs

</td>
<td width="50%" valign="top">

**🧑‍🤝‍🧑 Face Intelligence**
- Automatic face detection across your whole library
- AI clustering groups photos by person
- Manual correction tools for mis-grouped faces
- Background scan queue — new uploads are picked up automatically

</td>
</tr>
<tr>
<td width="50%" valign="top">

**🔒 Privacy & Security**
- Password-protected local web UI
- Hashed, authenticated routes for every media/thumbnail request
- Nothing ever sent to a third-party API

</td>
<td width="50%" valign="top">

**⚙️ Built to Run, Not Just Demo**
- One-command setup scripts
- Optional PM2 process management
- CPU by default, GPU acceleration opt-in
- Clone-and-run design — no hardcoded paths

</td>
</tr>
</table>

---

## 🏗️ Architecture

VaultOS runs as **two cooperating services** — a Node/Express app that owns the UI, auth, media, and thumbnails, and a Python FastAPI microservice that owns the AI pipeline. This keeps the web app snappy even while a full library face-scan grinds away in the background.

```text
                        🌐  Browser UI  (index.html / login.html)
                                        │
              /api/login   /api/files   /api/upload   /thumbs/*
                                        │
                                        ▼
                     🟩  Node.js  server.js   (Express)
                     ├─ stores media in media/
                     ├─ generates thumbnails in media/.thumbs/  (Sharp + FFmpeg)
                     ├─ opens media/face_index.db   (SQLite)
                     └─ forks face-worker.js
                                        │
                          IPC:  enqueue · rescan · cluster · status
                                        ▼
                     ⚙️  face-worker.js   (background worker)
                     ├─ reconciles the media directory with the scan queue
                     ├─ extracts video/GIF frames via FFmpeg when needed
                     └─ writes face rows + thumbnails to SQLite / media/.face-thumbs/
                                        │
                               HTTP  /health · /detect · /cluster
                                        ▼
                     🐍  Python FastAPI service   (face_service/main.py)
                     ├─ InsightFace (buffalo_l) — detection + embeddings
                     ├─ HDBSCAN — clustering over stored embeddings
                     └─ CPU by default · CUDA if onnxruntime-gpu is installed
```

**Why split it?** The heavy CPU/GPU face-recognition work runs in its own Python process instead of blocking the Node event loop — so uploading, browsing, and previewing stay instant no matter how big your library scan is.

---

## 🧰 Tech Stack

| Layer | Technology | Version | Required? |
| :-- | :-- | :-- | :-- |
| Runtime | Node.js | 20 LTS+ | ✅ |
| Backend | Express | ^5.2.1 | ✅ |
| Uploads | Busboy | ^1.6.0 | ✅ |
| Media pipeline | Sharp | ^0.34.5 | ✅ |
| Face index | sqlite / sqlite3 | ^5.1.x | ✅ |
| AI runtime | Python | 3.10 / 3.11 | ✅ for faces |
| AI API | FastAPI | 0.115.5 | ✅ for faces |
| AI server | Uvicorn | 0.32.1 | ✅ for faces |
| Face detection | InsightFace | 0.7.3 | ✅ for faces |
| Inference | ONNX Runtime | 1.20.1 (CPU default) | ✅ for faces |
| Clustering | HDBSCAN | 0.8.39 | ✅ for clustering |
| Similarity search | FAISS (CPU) | 1.9.0 | ⭐ recommended |
| Video/frames | FFmpeg | system install | ⭐ recommended |
| Process manager | PM2 | latest (global) | ➕ optional |

---

## ⚡ Quick Start

### Requirements

| | |
|---|---|
| **Required** | Windows 10/11, Linux, or macOS · Node.js 20 LTS+ · Python 3.10/3.11 · internet access on first run (for model download) |
| **Recommended** | FFmpeg on `PATH` · 8 GB+ RAM for large libraries |
| **Optional** | NVIDIA GPU + `onnxruntime-gpu` for faster inference · PM2 for background deployment |

### One-Command Setup (Windows)

```powershell
git clone https://github.com/Rudra-Chitnis/VaultOS.git
cd VaultOS
Set-ExecutionPolicy -Scope Process Bypass
.\setup.ps1
.\start.ps1
```

`setup.ps1` checks your Node/Python versions, creates `.env`, prompts for a login password, creates required data directories, installs npm packages, sets up `face_service/venv`, installs Python dependencies, and warns if FFmpeg is missing.

<details>
<summary><strong>🔧 Manual setup (step-by-step)</strong></summary>

```powershell
copy .env.example .env
# edit PASS_HASH in .env — see Configuration below

npm ci

python -m venv face_service\venv
face_service\venv\Scripts\python.exe -m pip install --upgrade pip
face_service\venv\Scripts\python.exe -m pip install -r face_service\requirements.txt

npm start
```

</details>

<details>
<summary><strong>🖥️ Running the two services separately</strong></summary>

```powershell
# Terminal 1 — AI service
face_service\venv\Scripts\python.exe -m uvicorn face_service.main:app --host 127.0.0.1 --port 7860

# Terminal 2 — Web app
npm start
```

</details>

Then open:

```text
http://localhost:8000
```

---

## ⚙️ Configuration

Copy `.env.example` → `.env`. **Never commit `.env`.**

| Variable | Purpose |
| :-- | :-- |
| `PASS_HASH` | Required SHA-256 hash of your login password |
| `PORT` | Node/Express port (default `8000`) |
| `FACE_SERVICE_URL` | URL the Node worker uses to reach the AI service (default `http://127.0.0.1:7860`) |
| `FACE_SERVICE_HOST` / `FACE_SERVICE_PORT` | Used by start scripts and PM2 |
| `FACE_WORKER_CONCURRENCY` | Parallel face-worker jobs |
| `FACE_*` | Detection and clustering thresholds |

Generate a password hash:

```powershell
node -e "const c=require('crypto');console.log(c.createHash('sha256').update('YOUR_PASSWORD').digest('hex'))"
```

---

## 🔁 Running as a Background Service (PM2)

```powershell
npm install -g pm2
```

Once setup has run:

```powershell
npm run pm2:start     # start
npm run pm2:status    # check status
npm run pm2:logs      # tail logs
npm run pm2:restart   # restart
npm run pm2:stop      # stop
```

The bundled PM2 scripts point `PM2_HOME` at a repo-local, git-ignored `.pm2/` directory, so no machine-specific PM2 settings leak into the deployment. `ecosystem.config.js` is portable — it uses the repo directory as `cwd` and the repo-local virtualenv by default. Override the Python interpreter with:

```powershell
$env:VAULTOS_PYTHON="C:\Path\To\python.exe"
```

---

## 📁 Project Structure

```text
.
├── server.js              Node/Express app — auth, media APIs, thumbnails, worker lifecycle
├── index.html              Main app UI
├── login.html                Login screen
├── upload.js                   Upload modal / client-side logic
├── face-worker.js             Background scan queue + face-indexing worker
├── face-db.js                    SQLite schema and data-access helpers
├── face-cluster.js                  Incremental assignment + full recluster writer
├── face-infer.js                       Deprecated v1 ONNX implementation (kept for reference)
├── face-logger.js                         Face subsystem logger
├── face_service/                            Python FastAPI AI service
│   ├── main.py                                /health, /detect, /cluster
│   ├── detector.py                               InsightFace detector/embedder
│   ├── clusterer.py                                 HDBSCAN clustering pipeline
│   ├── requirements.txt                                Python dependencies
│   └── start.bat / start.sh                               AI-only start helpers
├── face_models/                            Legacy model notes (ONNX binaries are git-ignored)
├── media/                                User media + generated state (git-ignored)
├── setup.ps1                          Fresh-clone setup script
├── start.ps1                       Starts the AI service and Node server together
├── ecosystem.config.js          Optional PM2 configuration
└── .env.example              Safe configuration template
```

---

## 🗂️ Data & Git Policy

Excluded from version control by design — either secrets or fully regenerable local data:

- `.env` and any real secrets
- `media/` — your actual files
- `media/.thumbs/` and `media/.face-thumbs/` — generated thumbnails and face chips
- `media/face_index.db*` — SQLite database and WAL files
- `node_modules/`, `face_service/venv/`, `__pycache__/`
- ONNX / model binaries

> InsightFace downloads its model weights to a user-level cache (typically `~/.insightface/models/buffalo_l/`) the first time it runs.

---

## 🩺 Troubleshooting

<details>
<summary><strong>Python packages fail to build</strong></summary>

Use Python 3.10 or 3.11 — some dependencies don't yet support 3.12.
</details>

<details>
<summary><strong>No video thumbnails / video face scan fails</strong></summary>

Install FFmpeg and make sure it's on `PATH` (`winget install Gyan.FFmpeg` on Windows), then restart your terminal.
</details>

<details>
<summary><strong>"AI service unavailable"</strong></summary>

Confirm `FACE_SERVICE_URL` in `.env` matches the running port, and check `http://127.0.0.1:7860/health`.
</details>

<details>
<summary><strong>Face inference stuck on CPU</strong></summary>

That's expected with the default `onnxruntime`. For GPU acceleration, swap in `onnxruntime-gpu` with a matching CUDA/cuDNN install.
</details>

<details>
<summary><strong>Port already in use</strong></summary>

Change `PORT` or `FACE_SERVICE_PORT` in `.env`, keeping `FACE_SERVICE_URL` aligned with the new port.
</details>

<details>
<summary><strong>Permission errors on Windows</strong></summary>

Run `Set-ExecutionPolicy -Scope Process Bypass` and confirm the project directory is writable.
</details>

<details>
<summary><strong>Model download fails on first run</strong></summary>

InsightFace needs internet access the first time it runs. If you're behind a proxy, set `HTTPS_PROXY`.
</details>

---

## 🧭 Design Principles

- **Clone-and-run.** Works from any path — runtime directories are created by `setup.ps1` and, where possible, by the Node server itself. Machine-specific values live only in local `.env`, local shell config, or PM2 overrides — never in source.
- **CPU-first, GPU-optional.** The default install runs entirely on CPU. GPU acceleration is an explicit opt-in, never a requirement.
- **Local by default, always.** No telemetry, no cloud AI calls, no external face database.

---

## 🤝 Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](./CONTRIBUTING.md) first. In short: keep changes focused and portable, never commit secrets or generated data, and validate JS with `node --check` and Python with `python -m py_compile` before opening a PR.

## 📄 License

VaultOS is licensed under the [ISC License](./LICENSE).

<div align="center">

---

*Built for people who want their photo library to be smart — not surveilled.*

</div>

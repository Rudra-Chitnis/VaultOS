# VaultOS

VaultOS is a private local media vault for browsing, uploading, previewing, favoriting, and face-clustering personal images, GIFs, and videos. It runs as a Node.js/Express web app with a Python FastAPI face-recognition service.

## Features

- Password-protected local web UI
- Image, GIF, and video gallery
- Uploads with progress UI
- Hashed thumbnail URLs served through authenticated routes
- Video/GIF thumbnail and preview support
- Favorites, Recent, and Most Viewed tabs stored locally in the browser
- People/face clustering with manual correction tools
- SQLite-backed face index and scan queue
- Optional PM2 process management

## Architecture

```text
Browser UI
  |
  | /api/login, /api/files, /api/upload, /thumbs/*
  v
Node.js server.js (Express)
  |-- stores media in media/
  |-- generates thumbnails in media/.thumbs/ using sharp/FFmpeg
  |-- opens media/face_index.db with SQLite
  |-- forks face-worker.js
  |
  | IPC: enqueue/rescan/cluster/status
  v
face-worker.js
  |-- reconciles media directory with scan_queue
  |-- extracts video/GIF frames with FFmpeg when needed
  |-- writes face rows and thumbnails to SQLite/media/.face-thumbs/
  |
  | HTTP /health, /detect, /cluster
  v
Python FastAPI service (face_service/main.py)
  |-- InsightFace buffalo_l detection + embeddings
  |-- HDBSCAN clustering over SQLite embeddings
  |-- CPU by default, CUDA if onnxruntime-gpu is installed and available
```

## Tech Stack

| Technology | Version | Purpose | Importance | Required? |
| --- | --- | --- | --- | --- |
| Node.js | 20 LTS recommended | Runs Express backend and worker | Core runtime | Yes |
| npm | bundled with Node | Installs Node dependencies | Setup | Yes |
| Express | ^5.2.1 | HTTP app/API/static serving | Core backend | Yes |
| Busboy | ^1.6.0 | Streaming uploads | Uploads | Yes |
| Sharp | ^0.34.5 | Image/GIF thumbnails | Media pipeline | Yes |
| SQLite/sqlite3 | ^5.1.x | Face index, queues, people | Face system | Yes for faces |
| Python | 3.10 or 3.11 recommended | AI microservice | Face system | Yes for faces |
| FastAPI | 0.115.5 | Python HTTP API | AI service | Yes for faces |
| Uvicorn | 0.32.1 | Python ASGI server | AI service | Yes for faces |
| InsightFace | 0.7.3 | Face detection/embeddings | AI service | Yes for faces |
| ONNX Runtime | 1.20.1 CPU by default | InsightFace inference | AI service | Yes for faces |
| HDBSCAN | 0.8.39 | Face clustering | AI service | Yes for clustering |
| FAISS CPU | 1.9.0 | Fast nearest-neighbor step | Clustering performance | Recommended |
| FFmpeg | system install | Video thumbnails/frame extraction | Video support | Recommended |
| PM2 | latest global npm package | Process supervisor | Deployment | Optional |

## Requirements

Required:

- Windows 10/11, Linux, or macOS
- Node.js 20 LTS or newer
- Python 3.10 or 3.11
- Internet access on first AI-service setup so InsightFace can download models

Recommended:

- FFmpeg available on PATH for video thumbnails and video face scanning
- 8 GB RAM or more for large libraries

Optional:

- NVIDIA CUDA + `onnxruntime-gpu` for faster AI inference
- PM2 for background/service-style deployment

## Installation From A Fresh Clone

Windows PowerShell:

```powershell
git clone <repository>
cd <project>
Set-ExecutionPolicy -Scope Process Bypass
.\setup.ps1
.\start.ps1
```

`setup.ps1` checks Node/Python, creates `.env`, asks for a login password, creates required directories, installs npm packages, creates `face_service/venv`, installs Python packages, and warns if FFmpeg is missing.

Manual equivalent:

```powershell
copy .env.example .env
# edit PASS_HASH in .env
npm ci
python -m venv face_service\venv
face_service\venv\Scripts\python.exe -m pip install --upgrade pip
face_service\venv\Scripts\python.exe -m pip install -r face_service\requirements.txt
npm start
```

## Running

Start everything on Windows:

```powershell
.\start.ps1
```

Start services separately:

```powershell
# Terminal 1
face_service\venv\Scripts\python.exe -m uvicorn face_service.main:app --host 127.0.0.1 --port 7860

# Terminal 2
npm start
```

Open:

```text
http://localhost:8000
```

## Configuration

Copy `.env.example` to `.env`. Do not commit `.env`.

Important values:

- `PASS_HASH`: required SHA-256 password hash for login
- `PORT`: Node/Express port, default `8000`
- `FACE_SERVICE_URL`: Node worker URL for Python AI service, default `http://127.0.0.1:7860`
- `FACE_SERVICE_HOST` / `FACE_SERVICE_PORT`: used by scripts and PM2
- `FACE_WORKER_CONCURRENCY`: parallel face-worker jobs
- `FACE_*`: detection and clustering thresholds

Generate a password hash:

```powershell
node -e "const c=require('crypto');console.log(c.createHash('sha256').update('YOUR_PASSWORD').digest('hex'))"
```

## PM2

PM2 is optional. Install globally:

```powershell
npm install -g pm2
```

After running setup:

```powershell
npm run pm2:start
npm run pm2:status
npm run pm2:logs
npm run pm2:restart
npm run pm2:stop
```

The npm PM2 scripts set `PM2_HOME` to the repo-local ignored `.pm2/` directory so inherited machine-specific PM2 settings do not leak into the deployment. `ecosystem.config.js` is portable: it uses the repository directory as `cwd` and the repo-local Python virtualenv by default. Override Python with:

```powershell
$env:VAULTOS_PYTHON="C:\Path\To\python.exe"
```

## Project Structure

```text
.
|-- server.js                  Node/Express app, auth, media APIs, thumbnails, worker lifecycle
|-- index.html                 Main app UI
|-- login.html                 Login screen
|-- upload.js                  Upload modal/client logic
|-- face-worker.js             Background scan queue and face indexing worker
|-- face-db.js                 SQLite schema and data-access helpers
|-- face-cluster.js            Incremental assignment and full recluster writer
|-- face-infer.js              Deprecated v1 ONNX implementation, retained as reference
|-- face-logger.js             Face subsystem logger
|-- face_service/              Python FastAPI AI service
|   |-- main.py                /health, /detect, /cluster
|   |-- detector.py            InsightFace detector/embedder
|   |-- clusterer.py           HDBSCAN clustering pipeline
|   |-- requirements.txt       Python dependencies
|   |-- start.bat/start.sh     AI-only start helpers
|-- face_models/               Legacy model notes; ONNX binaries are ignored
|-- media/                     User media and generated state; ignored by Git
|-- setup.ps1                  Fresh-clone setup
|-- start.ps1                  Starts AI service and Node server
|-- ecosystem.config.js        Optional PM2 configuration
|-- .env.example               Safe configuration template
|-- .gitignore                 Excludes secrets, dependencies, media, generated data
```

## Data And Git Policy

Do not commit:

- `.env` or any real secrets
- `media/` user files
- `media/.thumbs/` generated thumbnails
- `media/.face-thumbs/` generated face chips
- `media/face_index.db*` SQLite database/WAL files
- `node_modules/`
- `face_service/venv/`
- `__pycache__/`
- ONNX/model binaries

These are regenerated or local user data. InsightFace downloads model files to the user cache (usually `~/.insightface/models/buffalo_l/`) on first run.

## Troubleshooting

Python version mismatch:

- Use Python 3.10 or 3.11. Some packages may fail to build on Python 3.12.

FFmpeg missing:

- Video thumbnails and video face scanning need FFmpeg.
- Windows: `winget install Gyan.FFmpeg`
- Restart the terminal after installing.

AI service unavailable:

- Confirm `FACE_SERVICE_URL` in `.env` matches the service port.
- Check `http://127.0.0.1:7860/health`.

CUDA unavailable:

- CPU mode is expected with `onnxruntime`.
- For GPU, replace `onnxruntime` with compatible `onnxruntime-gpu` and install matching CUDA/cuDNN.

Port already in use:

- Change `PORT` or `FACE_SERVICE_PORT` in `.env`.
- Keep `FACE_SERVICE_URL` aligned with host/port.

Permission errors:

- Ensure the project directory is writable.
- PowerShell users may need `Set-ExecutionPolicy -Scope Process Bypass`.

Model download fails:

- InsightFace downloads models on first run.
- If behind a proxy, configure `HTTPS_PROXY`.

## Clone-And-Run Status

The project is designed to run from any clone path. Runtime directories are created by setup and also by the Node server when possible. Machine-specific paths should live only in local `.env`, local shells, or optional PM2 overrides.

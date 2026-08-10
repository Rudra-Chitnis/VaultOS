# Vault OS AI Microservice — Setup & Migration Guide

## What Changed

The old ONNX pipeline (Node.js `face-infer.js`) has been replaced with a Python
microservice that uses **InsightFace buffalo_l** for detection and **HDBSCAN** for
clustering. This gives dramatically better identity clustering accuracy.

| Component        | Old (v1.3)                     | New (v2.0)                        |
|-----------------|--------------------------------|-----------------------------------|
| Detection        | SCRFD-10G via onnxruntime-node | InsightFace buffalo_l (same model, Python) |
| Alignment        | Hand-rolled similarity transform | InsightFace norm_crop (upstream, tested) |
| Embedding        | ArcFace R50 via ONNX           | InsightFace buffalo_l ArcFace     |
| Clustering       | Greedy single-linkage JS       | HDBSCAN (density-based, global)   |
| Video tracking   | Cosine dedup of frames         | Cosine dedup with better embeddings |
| Thumbnails       | Aligned 112×112 chip (JS)      | InsightFace norm_crop → 128×128 JPEG |

---

## Prerequisites

- Python **3.10 or 3.11** (3.12 has hdbscan build issues on some Windows setups)
- pip / venv
- Internet connection for first-run model download (~400 MB)
- The rest of Vault OS (Node.js, FFmpeg) unchanged

---

## Quick Start (Windows)

```bat
:: From the repository root
setup.ps1
start.ps1
```

To run the AI service separately:

```bat
cd face_service
start.bat
```

---

## Quick Start (Linux / macOS)

```bash
# Terminal 1 — start AI service first
cd /path/to/vault/face_service
chmod +x start.sh
./start.sh

# Terminal 2 — start Node server
cd /path/to/vault
node server.js
```

---

## Manual Installation (if start scripts fail)

```bash
cd face_service

# Create virtualenv
python -m venv venv
venv\Scripts\activate          # Windows
# source venv/bin/activate     # Linux/Mac

# Install in order (avoids numpy ABI conflicts)
pip install "numpy==1.26.4"
pip install onnxruntime          # or onnxruntime-gpu for CUDA
pip install insightface==0.7.3
pip install -r requirements.txt

# Start
cd ..
python -m uvicorn face_service.main:app --host 127.0.0.1 --port 7860
```

---

## First-Run Model Download

InsightFace downloads **buffalo_l** to `~/.insightface/models/buffalo_l/` automatically.
Only two models are downloaded (detection + recognition):
- `det_10g.onnx`    — SCRFD-10G face detector   (~40 MB)
- `w600k_r50.onnx`  — ArcFace R50 embedder      (~166 MB)

Total: ~206 MB (the old `face_models/` ONNX files are no longer used but can be deleted).

---

## .env Configuration

Add these to your project `.env` to tune the AI service:

```dotenv
# Python AI service URL (default: http://127.0.0.1:7860)
FACE_SERVICE_URL=http://127.0.0.1:7860

# Detection quality thresholds (Python service reads these)
FACE_MIN_CONFIDENCE=0.45        # min InsightFace detection score
FACE_MIN_SIZE=80                # min face bounding-box size in px
FACE_BLUR_THRESHOLD=80          # Laplacian variance; 0 to disable
FACE_FRONTAL_MAX_DEV=0.40       # max nose deviation from inter-eye midpoint
FACE_EYE_ROLL_MAX=0.45          # max vertical eye disparity ratio
FACE_MAX_PER_IMAGE=10           # max faces accepted per image

# HDBSCAN clustering
FACE_HDBSCAN_MIN_CLUSTER=2      # min faces to form a cluster (2 = allow pairs)
FACE_HDBSCAN_MIN_SAMPLES=1      # HDBSCAN sensitivity (lower = more clusters)
FACE_CENTROID_MERGE_SIM=0.72    # merge clusters with cosine sim >= this
FACE_NOISE_REASSIGN_DIST=1.0    # reassign noise within this euclidean distance

# Existing Node.js thresholds (unchanged)
FACE_SIMILARITY_THRESHOLD=0.55
FACE_WORKER_CONCURRENCY=2
```

---

## Migration Steps

After upgrading from v1.3:

### 1. Back up your database (optional but recommended)
```bat
copy media\face_index.db media\face_index.db.v13.bak
```

### 2. Wipe the old face database
The old database contains embeddings from the ONNX pipeline. While the same
ArcFace R50 model is used, minor preprocessing differences mean old and new
embeddings are not comparable. A clean rescan gives the best results.

```bat
del media\face_index.db
rmdir /s /q media\.face-thumbs
```

Or via the UI: People page → Rescan All.

### 3. Start the AI service
```bat
cd face_service && start.bat
```

### 4. Start the Node server
```bat
node server.js
```

The face worker will automatically begin scanning all media files.

### 5. After scanning completes — trigger HDBSCAN recluster
In the UI: People page → Recluster. This runs HDBSCAN over all collected
embeddings, replacing the greedy incremental assignments with a globally
optimal clustering.

---

## GPU Acceleration

For CUDA GPU (10–50× faster detection on large libraries):

```bash
pip uninstall onnxruntime
pip install onnxruntime-gpu      # requires CUDA 11.x or 12.x + cuDNN
```

InsightFace will automatically use the GPU.

For AMD GPU on Windows, DirectML is not supported by InsightFace Python.
Use CPU mode (still reasonable: ~30–100ms per image).

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│  Vault OS  (Windows)                                                │
│                                                                     │
│  ┌─────────────────┐  IPC (fork)  ┌──────────────────────────────┐ │
│  │   server.js     │◄────────────►│   face-worker.js             │ │
│  │  (Express API)  │              │   (queue + DB orchestration)  │ │
│  └─────────────────┘              └──────────┬───────────────────┘ │
│                                              │ HTTP POST            │
│                                              ▼                      │
│                                   ┌──────────────────────────────┐ │
│                                   │  face_service/main.py        │ │
│                                   │  FastAPI  :7860              │ │
│                                   │                              │ │
│                                   │  /detect  → InsightFace      │ │
│                                   │  /cluster → HDBSCAN + Faiss  │ │
│                                   └──────────────────────────────┘ │
│                                                                     │
│  face_index.db (SQLite WAL)                                        │
│    ← written by face-worker.js                                      │
│    ← read by face_service (read-only, for /cluster)                 │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Troubleshooting

**"InsightFace not found"**
→ Make sure you activated the venv before running uvicorn.

**"Model download fails"**
→ InsightFace downloads from GitHub. If behind a proxy, set `HTTPS_PROXY`.
   Alternatively, manually download buffalo_l from the InsightFace releases
   and place files in `~/.insightface/models/buffalo_l/`.

**"Port 7860 already in use"**
→ Change `FACE_SERVICE_URL` in `.env` to e.g. `http://127.0.0.1:7861` and
   restart both services.

**"Worker can't connect to Python service"**
→ Start `face_service/start.bat` first, wait for "Face detector ready", then
   start `node server.js`. The worker retries for 2 minutes before giving up.

**Thumbnails look wrong / body parts showing**
→ Trigger a full rescan (wipe face_index.db and restart). Old bbox-crop
   thumbnails from v1.3 may remain on disk until files are rescanned.

**Clustering still fragmented after recluster**
→ Try lowering `FACE_HDBSCAN_MIN_CLUSTER=2` (already the minimum) or
   increasing `FACE_NOISE_REASSIGN_DIST=1.2`. If a person appears rarely,
   HDBSCAN may classify them as noise — the noise reassignment will handle it.

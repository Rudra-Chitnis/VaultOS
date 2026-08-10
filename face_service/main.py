"""
face_service/main.py
====================
Vault OS AI Microservice — FastAPI entry point.

Architecture:
  Node.js face-worker.js  ──HTTP──▶  this service  ──ONNX──▶  InsightFace buffalo_l
                                                    ──SQLite read──▶ face_index.db (read-only)

Endpoints:
  GET  /health          liveness + readiness check
  POST /detect          detect faces in an image (path or base64)
  POST /cluster         run HDBSCAN over all embeddings in face_index.db

Start with:
  uvicorn face_service.main:app --host 127.0.0.1 --port 7860

Or use the provided start.bat / start.sh scripts.
"""

import base64
import logging
import os
import sys
import traceback
from contextlib import asynccontextmanager
from typing import Any, Dict, List, Optional

import cv2
import numpy as np
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

# ── Optional dotenv support ───────────────────────────────────────────────────
try:
    from dotenv import load_dotenv
    _service_dir = os.path.dirname(__file__)
    _root_env_path = os.path.abspath(os.path.join(_service_dir, '..', '.env'))
    _service_env_path = os.path.join(_service_dir, '.env')
    if os.path.exists(_root_env_path):
        load_dotenv(_root_env_path)
    if os.path.exists(_service_env_path):
        load_dotenv(_service_env_path)
except ImportError:
    pass

# ── Logging ───────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(name)-18s] %(levelname)-7s %(message)s',
    stream=sys.stdout,
)
log = logging.getLogger('vault.ai')

# Suppress noisy onnxruntime and insightface startup chatter
logging.getLogger('onnxruntime').setLevel(logging.WARNING)
logging.getLogger('insightface').setLevel(logging.INFO)

# Lazy imports for heavy deps (loaded once at startup)
from .detector  import FaceDetector
from .clusterer import run_full_cluster, ClusterResult

# ─────────────────────────────────────────────────────────────────────────────
#  GLOBAL STATE  (initialised in lifespan)
# ─────────────────────────────────────────────────────────────────────────────

_detector: Optional[FaceDetector] = None


def _get_detector() -> FaceDetector:
    if _detector is None:
        raise HTTPException(status_code=503, detail='Models not yet loaded — try again in a few seconds')
    return _detector


# ─────────────────────────────────────────────────────────────────────────────
#  LIFESPAN  (model loading on startup)
# ─────────────────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    global _detector
    log.info('╔══════════════════════════════════════════════════')
    log.info('║  Vault OS AI Microservice  v2.0.0  (InsightFace)')
    log.info('╚══════════════════════════════════════════════════')

    log.info('Loading InsightFace buffalo_l …')
    try:
        _detector = FaceDetector()
        log.info('✅ Face detector ready')
    except Exception as exc:
        log.error('❌ Failed to load detector: %s', exc)
        log.error(traceback.format_exc())
        # Don't crash the server — /health will report not-ready and worker will retry

    yield  # server handles requests here

    log.info('Shutting down AI microservice')
    _detector = None


# ─────────────────────────────────────────────────────────────────────────────
#  APP
# ─────────────────────────────────────────────────────────────────────────────

app = FastAPI(
    title='Vault OS AI Microservice',
    version='2.0.0',
    description='InsightFace buffalo_l detection + HDBSCAN clustering for Vault OS',
    lifespan=lifespan,
)

# Allow requests from localhost only (the Node.js server)
app.add_middleware(
    CORSMiddleware,
    allow_origins=['http://127.0.0.1:*', 'http://localhost:*'],
    allow_methods=['GET', 'POST'],
    allow_headers=['*'],
)

# Global error handler — always return JSON, never an HTML error page
@app.exception_handler(Exception)
async def _global_exc(request: Request, exc: Exception):
    log.error('Unhandled error on %s %s: %s', request.method, request.url.path, exc)
    log.debug(traceback.format_exc())
    return JSONResponse(status_code=500, content={'error': str(exc)})


# ─────────────────────────────────────────────────────────────────────────────
#  REQUEST / RESPONSE MODELS
# ─────────────────────────────────────────────────────────────────────────────

class DetectRequest(BaseModel):
    """
    Detect faces in an image.
    Provide EITHER path (absolute path on disk, preferred) OR image_b64 (base64 JPEG).
    Path-based requests avoid base64 encoding overhead and are preferred for normal images.
    image_b64 is used for in-memory video frames extracted by FFmpeg.
    """
    path:       Optional[str] = Field(None, description='Absolute path to the image file')
    image_b64:  Optional[str] = Field(None, description='Base64-encoded JPEG/PNG bytes')


class ClusterRequest(BaseModel):
    """
    Run a full HDBSCAN recluster of all faces in the database.
    Python reads embeddings directly from db_path (read-only SQLite).
    """
    db_path:          str   = Field(..., description='Absolute path to face_index.db')
    min_cluster_size: int   = Field(2,    ge=2, description='Minimum faces to form a cluster')
    min_samples:      int   = Field(1,    ge=1, description='HDBSCAN min_samples parameter')
    merge_threshold:  float = Field(0.72, ge=0, le=1, description='Cosine threshold to merge near-identical clusters')


# ─────────────────────────────────────────────────────────────────────────────
#  ENDPOINTS
# ─────────────────────────────────────────────────────────────────────────────

@app.get('/health', summary='Liveness + readiness check')
async def health() -> Dict[str, Any]:
    """
    Returns 200 with ready=true once InsightFace models are loaded.
    Node.js face-worker polls this on startup before beginning to process files.
    """
    return {
        'status':  'ok',
        'ready':   _detector is not None,
        'model':   'buffalo_l',
        'version': '2.0.0',
    }


@app.post('/detect', summary='Detect + embed faces in an image')
async def detect(request: DetectRequest) -> Dict[str, Any]:
    """
    Run the full detection → quality filter → alignment → embedding pipeline.

    Returns a list of face objects, each containing:
      bbox             [x1, y1, x2, y2] in original image pixels
      bbox_norm        [x, y, w, h] normalised 0-1
      score            detection confidence (0-1)
      embedding        list[float]  512-dim L2-normalised ArcFace embedding
      aligned_thumb_b64  base64 JPEG  128×128 aligned face thumbnail
      kps              [[x,y] × 5]  5-point landmarks
      orig_w, orig_h   original image dimensions

    Performance tip: for files on disk, always use 'path' not 'image_b64'.
    The path variant avoids ~33% base64 encoding overhead.
    """
    det = _get_detector()

    # ── Load image ────────────────────────────────────────────────────────────
    img_bgr: Optional[np.ndarray] = None

    if request.path:
        img_bgr = _load_image_from_path(request.path)
    elif request.image_b64:
        img_bgr = _load_image_from_b64(request.image_b64)
    else:
        raise HTTPException(status_code=422, detail="Provide 'path' or 'image_b64'")

    if img_bgr is None or img_bgr.size == 0:
        raise HTTPException(status_code=422, detail='Cannot decode image — empty or invalid')

    # ── Detect ────────────────────────────────────────────────────────────────
    try:
        faces = det.detect(img_bgr)
    except Exception as exc:
        log.error('Detection failed: %s', exc)
        raise HTTPException(status_code=500, detail=f'Detection error: {exc}')

    return {'faces': faces}


@app.post('/cluster', summary='HDBSCAN full recluster from face_index.db')
async def cluster(request: ClusterRequest) -> Dict[str, Any]:
    """
    Read all face embeddings from the SQLite database (read-only), run HDBSCAN,
    and return cluster assignments + per-cluster centroids for Node.js to write back.

    This replaces the old greedy single-linkage recluster with a proper density-based
    clustering algorithm that:
      - Does not require pre-specifying the number of people
      - Is not order-dependent
      - Explicitly handles outliers (noise = -1)
      - Merges clusters that are very similar (same person split across two clusters)

    The response is consumed by face-worker.js handleCluster() which writes the
    person rows and face assignments into SQLite within a single transaction.

    Response schema:
      assignments   dict  face_id → cluster_id  (-1 = unclustered noise)
      centroids     dict  cluster_id → list[float]  512-dim L2-normed centroid
      cover_faces   dict  cluster_id → face_id with highest det_score
      face_counts   dict  cluster_id → int
      n_clusters    int
      n_noise       int
      n_total       int
    """
    log.info('Full recluster requested | db=%s', request.db_path)
    try:
        result: ClusterResult = run_full_cluster(
            db_path=request.db_path,
            min_cluster_size=request.min_cluster_size,
            min_samples=request.min_samples,
            merge_threshold=request.merge_threshold,
        )
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except Exception as exc:
        log.error('Clustering failed: %s', exc)
        log.debug(traceback.format_exc())
        raise HTTPException(status_code=500, detail=f'Clustering error: {exc}')

    return {
        'assignments':  result.assignments,   # {face_id_str: cluster_id}
        'centroids':    result.centroids,     # {cluster_id_str: [512 floats]}
        'cover_faces':  result.cover_faces,   # {cluster_id_str: face_id}
        'face_counts':  result.face_counts,   # {cluster_id_str: int}
        'n_clusters':   result.n_clusters,
        'n_noise':      result.n_noise,
        'n_total':      result.n_total,
    }


# ─────────────────────────────────────────────────────────────────────────────
#  IMAGE LOADING HELPERS
# ─────────────────────────────────────────────────────────────────────────────

def _load_image_from_path(path: str) -> Optional[np.ndarray]:
    """
    Load an image from disk into a BGR numpy array.

    Uses Pillow as primary loader with EXIF-based auto-rotation, then
    falls back to cv2.imread() for formats Pillow can't handle (e.g. some HEICs).
    """
    try:
        from PIL import Image, ImageOps
        with Image.open(path) as pil_img:
            pil_img = ImageOps.exif_transpose(pil_img)         # honour EXIF rotation
            rgb = np.array(pil_img.convert('RGB'), dtype=np.uint8)
        bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
        return bgr
    except Exception as pil_err:
        log.debug('PIL failed for %s (%s) — trying cv2.imread', path, pil_err)

    # Fallback: OpenCV direct read (handles most RAW-like formats)
    img = cv2.imread(path)
    if img is not None:
        return img

    log.error('Cannot load image from %s', path)
    return None


def _load_image_from_b64(b64: str) -> Optional[np.ndarray]:
    """Decode a base64-encoded JPEG/PNG into a BGR numpy array."""
    try:
        raw = base64.b64decode(b64)
        arr = np.frombuffer(raw, dtype=np.uint8)
        img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        return img
    except Exception as exc:
        log.error('base64 decode failed: %s', exc)
        return None

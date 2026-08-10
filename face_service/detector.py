"""
face_service/detector.py
========================
InsightFace-powered face detector and embedder.

Wraps FaceAnalysis (buffalo_l) with a 6-stage quality filter pipeline
that mirrors and improves upon the old ONNX pipeline in face-infer.js:

  Stage 1: Detection score threshold   (env: FACE_MIN_CONFIDENCE, default 0.45)
  Stage 2: Minimum face bounding-box   (env: FACE_MIN_SIZE, default 80 px)
  Stage 3: Aspect ratio guard          (w/h must be 0.60 – 1.60)
  Stage 4: Frontalness check           (nose must be near inter-eye midpoint)
  Stage 5: Eye-roll / tilt check       (vertical eye disparity < 45%)
  Stage 6: Laplacian blur on 112×112   (env: FACE_BLUR_THRESHOLD, default 80)

Each accepted face yields:
  bbox            [x1, y1, x2, y2]  original image pixels
  bbox_norm       [x, y, w, h]      normalised 0-1
  score           detection confidence
  embedding       list[float]  512-dim L2-normalised ArcFace embedding
  aligned_thumb_b64  base64 JPEG of 128×128 aligned face (ready to write to disk)
  kps             [[x,y] × 5]  5-point landmarks (lEye, rEye, nose, lMouth, rMouth)
  orig_w, orig_h  original image dimensions

Note on coordinate convention:
  InsightFace and OpenCV both use BGR. We load BGR from disk and pass it
  directly to FaceAnalysis.get(). The aligned thumbnail is converted to
  RGB before JPEG encoding so colours are correct when viewed.
"""

import os
import base64
import logging
import traceback
from typing import List, Dict, Any, Optional

import cv2
import numpy as np

from insightface.app import FaceAnalysis
from insightface.utils import face_align

log = logging.getLogger(__name__)

# ─────────────────────────────────────────────────────────────────────────────
#  THRESHOLD CONSTANTS  (all env-overridable)
# ─────────────────────────────────────────────────────────────────────────────

MIN_SCORE       = float(os.environ.get('FACE_MIN_CONFIDENCE',  '0.45'))
MIN_FACE_PX     = int(  os.environ.get('FACE_MIN_SIZE',        '80'))
BLUR_THRESHOLD  = float(os.environ.get('FACE_BLUR_THRESHOLD',  '80.0'))
FRONTAL_MAX_DEV = float(os.environ.get('FACE_FRONTAL_MAX_DEV', '0.40'))  # nose ± 40 % of eye dist
EYE_ROLL_MAX    = float(os.environ.get('FACE_EYE_ROLL_MAX',    '0.45'))  # |Δy| / eye_dist < 45 %
MAX_PER_IMAGE   = int(  os.environ.get('FACE_MAX_PER_IMAGE',   '10'))
THUMB_SIZE      = 128  # output thumbnail px

# High-confidence gate — very confident detections skip the softer checks
HIGH_CONF = min(0.96, MIN_SCORE + 0.18)


# ─────────────────────────────────────────────────────────────────────────────
#  UTILITY FUNCTIONS
# ─────────────────────────────────────────────────────────────────────────────

def _l2_normalize(v: np.ndarray) -> np.ndarray:
    """Return L2-normalised version of a 1-D float array."""
    norm = np.linalg.norm(v)
    return v / norm if norm > 1e-8 else v


def _laplacian_variance(gray: np.ndarray) -> float:
    """
    Compute Laplacian variance of a grayscale image patch.
    High variance = sharp edges = good quality.
    Low variance  = blurry = reject.
    Uses OpenCV's built-in Laplacian, which is both faster and more numerically
    stable than a manual Python loop.
    """
    lap = cv2.Laplacian(gray.astype(np.float64), cv2.CV_64F)
    return float(lap.var())


def _check_frontalness(kps: np.ndarray, face_w: float, score: float) -> bool:
    """
    Reject strongly turned / profile faces.

    Strategy: the nose tip should be close to the horizontal midpoint of
    the two eyes in a frontal face. A large deviation → profile view.

    kps layout (InsightFace convention): [lEye, rEye, nose, lMouth, rMouth]
    """
    if score >= HIGH_CONF:
        return True  # trust the detector at very high confidence
    if kps is None or len(kps) < 3:
        return True  # can't check — allow

    l_eye, r_eye, nose = kps[0], kps[1], kps[2]
    eye_dist = float(r_eye[0] - l_eye[0])
    if eye_dist <= 0:
        return False

    eye_mid_x = (float(l_eye[0]) + float(r_eye[0])) / 2.0
    deviation  = abs(float(nose[0]) - eye_mid_x) / eye_dist

    if deviation > FRONTAL_MAX_DEV:
        log.debug('REJECT frontalness: dev=%.3f threshold=%.3f score=%.3f',
                  deviation, FRONTAL_MAX_DEV, score)
        return False
    return True


def _check_eye_roll(kps: np.ndarray, score: float) -> bool:
    """
    Reject faces with excessive in-plane tilt (camera roll).

    A large vertical disparity between left and right eye signals a strongly
    tilted / sideways face that will produce a bad aligned chip.
    """
    if score >= HIGH_CONF:
        return True
    if kps is None or len(kps) < 2:
        return True

    l_eye, r_eye = kps[0], kps[1]
    eye_dist = float(r_eye[0] - l_eye[0])
    if eye_dist <= 0:
        return False

    roll = abs(float(r_eye[1]) - float(l_eye[1])) / eye_dist
    if roll > EYE_ROLL_MAX:
        log.debug('REJECT eye-roll: roll=%.3f threshold=%.3f score=%.3f',
                  roll, EYE_ROLL_MAX, score)
        return False
    return True


def _check_blur(aligned_bgr: np.ndarray, score: float) -> bool:
    """
    Laplacian variance blur check on the 112×112 aligned face chip.
    Converts to grayscale, computes variance — low variance = blurry = reject.
    Very high confidence detections skip this check.
    """
    if BLUR_THRESHOLD <= 0 or score >= HIGH_CONF:
        return True

    gray = cv2.cvtColor(aligned_bgr, cv2.COLOR_BGR2GRAY)
    variance = _laplacian_variance(gray)
    if variance < BLUR_THRESHOLD:
        log.debug('REJECT blur: var=%.1f threshold=%.1f score=%.3f',
                  variance, BLUR_THRESHOLD, score)
        return False
    return True


def _encode_thumb(aligned_bgr: np.ndarray, size: int = THUMB_SIZE) -> str:
    """
    Resize aligned BGR chip → JPEG → base64 string.

    IMPORTANT: cv2.imencode expects BGR input — do NOT convert to RGB first.
    The JPEG format stores luminance (Y) + chrominance (Cb/Cr), not raw RGB.
    OpenCV's imencode internally converts BGR→YCbCr correctly; if you pass
    RGB, R and B channels swap, producing a blue/orange tint in browsers.
    Returns empty string on failure.
    """
    try:
        resized = cv2.resize(aligned_bgr, (size, size), interpolation=cv2.INTER_LANCZOS4)
        # Pass BGR directly — imencode handles the colour-space conversion internally
        ok, buf = cv2.imencode('.jpg', resized, [cv2.IMWRITE_JPEG_QUALITY, 90])
        if not ok:
            return ''
        return base64.b64encode(buf.tobytes()).decode('ascii')
    except Exception as exc:
        log.warning('Thumbnail encode failed: %s', exc)
        return ''


# ─────────────────────────────────────────────────────────────────────────────
#  FACE DETECTOR CLASS
# ─────────────────────────────────────────────────────────────────────────────

class FaceDetector:
    """
    Thread-safe face detector backed by InsightFace buffalo_l.

    Loads SCRFD-10G (detection) and ArcFace R50 (recognition) via ONNX Runtime.
    The `allowed_modules` parameter ensures we only load the two models we need,
    avoiding the ~1.2 GB download of the full buffalo_l pack on first run.

    Execution providers (in priority order):
      1. CUDAExecutionProvider  — NVIDIA GPU (requires onnxruntime-gpu)
      2. CPUExecutionProvider   — always available
    """

    def __init__(self) -> None:
        providers = self._build_providers()
        log.info('Loading InsightFace buffalo_l (providers: %s) …', providers)

        self._app = FaceAnalysis(
            name='buffalo_l',
            allowed_modules=['detection', 'recognition'],
            providers=providers,
        )
        # ctx_id=0 → first GPU; ctx_id=-1 → CPU
        ctx_id = 0 if self._has_cuda(providers) else -1
        self._app.prepare(
            ctx_id=ctx_id,
            det_size=(640, 640),
            det_thresh=max(0.30, MIN_SCORE - 0.10),  # slightly looser so our pipeline decides
        )
        log.info(
            'FaceDetector ready | score_thresh=%.2f min_px=%d blur_thresh=%.0f frontal_max=%.2f',
            MIN_SCORE, MIN_FACE_PX, BLUR_THRESHOLD, FRONTAL_MAX_DEV,
        )

    # ── Provider selection ────────────────────────────────────────────────────

    @staticmethod
    def _has_cuda(providers: list) -> bool:
        return 'CUDAExecutionProvider' in providers

    @staticmethod
    def _build_providers() -> list:
        """
        Try CUDA first; fall back gracefully to CPU.
        Importing onnxruntime to check available providers avoids spawning
        a GPU process if CUDA is unavailable.
        """
        try:
            import onnxruntime as ort
            available = ort.get_available_providers()
            if 'CUDAExecutionProvider' in available:
                log.info('CUDA detected — using GPU inference')
                return ['CUDAExecutionProvider', 'CPUExecutionProvider']
        except Exception:
            pass
        log.info('CUDA not available — using CPU inference (slower but stable)')
        return ['CPUExecutionProvider']

    # ── Main detection entry point ────────────────────────────────────────────

    def detect(self, img_bgr: np.ndarray) -> List[Dict[str, Any]]:
        """
        Detect, filter, and embed faces in a BGR uint8 image.

        Returns a list of face dicts (sorted by score desc, truncated to
        MAX_PER_IMAGE). Empty list if no valid faces found.
        """
        if img_bgr is None or img_bgr.size == 0:
            log.warning('detect() called with empty image — returning []')
            return []

        h, w = img_bgr.shape[:2]

        try:
            raw_faces = self._app.get(img_bgr)
        except Exception as exc:
            log.error('InsightFace.get() raised: %s', exc)
            log.debug(traceback.format_exc())
            return []

        if not raw_faces:
            return []

        # Sort by detection score descending so we process best faces first
        raw_faces = sorted(raw_faces, key=lambda f: float(f.det_score), reverse=True)

        results: List[Dict[str, Any]] = []
        rejected = {'score': 0, 'size': 0, 'aspect': 0, 'frontal': 0, 'roll': 0, 'blur': 0, 'warp': 0}

        for face in raw_faces:
            score = float(face.det_score)

            # Stage 1: score threshold
            if score < MIN_SCORE:
                rejected['score'] += 1
                continue

            bbox = face.bbox.astype(np.float32)  # [x1, y1, x2, y2]
            x1, y1, x2, y2 = bbox
            fw, fh = float(x2 - x1), float(y2 - y1)

            # Stage 2: minimum face size
            if fw < MIN_FACE_PX or fh < MIN_FACE_PX:
                rejected['size'] += 1
                continue

            # Stage 3: aspect ratio (real faces are roughly square)
            if fh > 0 and not (0.60 <= fw / fh <= 1.60):
                rejected['aspect'] += 1
                continue

            kps = face.kps  # shape (5, 2) or None

            # Stage 4: frontalness
            if not _check_frontalness(kps, fw, score):
                rejected['frontal'] += 1
                continue

            # Stage 5: eye roll / tilt
            if not _check_eye_roll(kps, score):
                rejected['roll'] += 1
                continue

            # Compute aligned 112×112 face chip using InsightFace norm_crop.
            # norm_crop applies a similarity transform mapping the 5-point keypoints
            # to the ArcFace canonical positions — same algorithm as face-infer.js
            # but implemented and tested extensively by InsightFace upstream.
            try:
                aligned_bgr = face_align.norm_crop(img_bgr, landmark=kps, image_size=112)
            except Exception as exc:
                log.debug('norm_crop failed: %s score=%.3f', exc, score)
                rejected['warp'] += 1
                continue

            # Stage 6: blur check on aligned chip
            if not _check_blur(aligned_bgr, score):
                rejected['blur'] += 1
                continue

            # ── All checks passed — assemble result ───────────────────────
            # Use normed_embedding (L2-normalised) from InsightFace directly.
            # Fall back to manual normalisation if the attribute is absent.
            if hasattr(face, 'normed_embedding') and face.normed_embedding is not None:
                emb = face.normed_embedding.astype(np.float32)
            elif face.embedding is not None:
                emb = _l2_normalize(face.embedding.astype(np.float32))
            else:
                log.debug('Face has no embedding — skipping (score=%.3f)', score)
                continue

            thumb_b64 = _encode_thumb(aligned_bgr, THUMB_SIZE)

            results.append({
                'bbox':             [float(x1), float(y1), float(x2), float(y2)],
                'bbox_norm':        [float(x1) / w, float(y1) / h, fw / w, fh / h],
                'score':            score,
                'embedding':        emb.tolist(),
                'kps':              kps.tolist() if kps is not None else [],
                'aligned_thumb_b64': thumb_b64,
                'orig_w':           w,
                'orig_h':           h,
            })

            if len(results) >= MAX_PER_IMAGE:
                break

        total_rejected = sum(rejected.values())
        log.info(
            'Detection: raw=%d accepted=%d rejected=%d %s',
            len(raw_faces), len(results), total_rejected,
            {k: v for k, v in rejected.items() if v > 0},
        )
        return results

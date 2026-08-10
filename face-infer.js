'use strict';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  DEPRECATED — face-infer.js  (Vault OS v1.x ONNX pipeline)             ║
 * ║                                                                          ║
 * ║  This file is NO LONGER USED at runtime.                                 ║
 * ║  As of v2.0.0, detection + embedding is handled by the Python AI         ║
 * ║  microservice (face_service/main.py) using InsightFace buffalo_l.        ║
 * ║                                                                          ║
 * ║  Kept here for reference only. Safe to delete after migration.           ║
 * ║  See face_service/SETUP.md for upgrade instructions.                     ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * face-infer.js
 * ONNX-based face detection and recognition engine.
 *
 * Models (place in <project>/face_models/):
 *   det_10g.onnx    — SCRFD-10G detection   (~40 MB, buffalo_l pack)
 *   w600k_r50.onnx  — ArcFace R50 embedding (~166 MB, buffalo_l pack)
 *
 * Download: see face_models/HOW_TO_DOWNLOAD.txt
 *
 * Detection filtering pipeline (precision-first, tuned for personal media):
 *   1. SCRFD base confidence threshold (FACE_MIN_CONFIDENCE env, default 0.70)
 *   2. Minimum face size in pixels    (FACE_MIN_SIZE env, default 50)
 *   3. Aspect ratio guard             (width/height must be 0.5–2.0)
 *   4. Image-border rejection         (rejects edge false-positives at low confidence)
 *   5. Laplacian-variance blur check  (FACE_BLUR_THRESHOLD env, default 60)
 *   6. Landmark geometry sanity       (eye-distance must be plausible)
 *   7. ArcFace embedding only after ALL checks pass
 *
 * Execution providers: tries DirectML (GPU) first, falls back to CPU.
 * Sessions are loaded once per worker process and reused for all inference.
 */

try { require('dotenv').config(); } catch {}

const path  = require('path');
const sharp = require('sharp');
const { FaceLogger } = require('./face-logger');

const log = new FaceLogger('INFER');

// ─────────────────────────────────────────────────────────────
//  THRESHOLD CONFIG  (all env-overridable)
// ─────────────────────────────────────────────────────────────

/** Minimum SCRFD score to even decode a candidate (first pass). */
const SCORE_THRESHOLD = parseFloat(process.env.FACE_MIN_CONFIDENCE) || 0.84;

/**
 * High-confidence gate — detections above this skip the secondary checks.
 * Very high confidence from SCRFD is a strong signal even if size is borderline.
 */
const SCORE_HIGH_CONFIDENCE = Math.min(0.96, SCORE_THRESHOLD + 0.18);

/** Minimum face bounding-box dimension (px) in original image coordinates. */
const MIN_FACE_PX = parseInt(process.env.FACE_MIN_SIZE) || 96;

/**
 * Laplacian variance threshold for blur rejection.
 * Lower value = allow blurrier faces.  Default 160 is strict but fair on aligned chips.
 * Set to 0 to disable blur check.
 */
const BLUR_THRESHOLD = parseFloat(process.env.FACE_BLUR_THRESHOLD) || 160;

/** IoU threshold for Non-Maximum Suppression. */
const NMS_IOU_THRESHOLD = 0.40;

/** Border margin (fraction of face size) below which we apply extra confidence penalty. */
const BORDER_MARGIN_FRAC = 0.40;

/** Detection input size (SCRFD fixed-shape model: 640×640). */
const DET_INPUT_SIZE = 640;

/** Recognition input size (ArcFace: 112×112). */
const REC_INPUT_SIZE = 112;

/** FPN strides used by SCRFD-10G. */
const FPN_STRIDES = [8, 16, 32];

/** Number of anchors per grid cell (same for all FPN levels in SCRFD). */
const NUM_ANCHORS = 2;

/**
 * ArcFace standard 5-point landmark positions in the 112×112 output space.
 * Order: left-eye, right-eye, nose-tip, left-mouth-corner, right-mouth-corner.
 */
const TARGET_KPS_112 = [
  [38.2946, 51.6963],
  [73.5318, 51.5014],
  [56.0252, 71.7366],
  [41.5493, 92.3655],
  [70.7299, 92.2041],
];

// Log active thresholds at startup
log.info('Detection thresholds', {
  FACE_MIN_CONFIDENCE: SCORE_THRESHOLD,
  FACE_HIGH_CONFIDENCE: SCORE_HIGH_CONFIDENCE,
  FACE_MIN_SIZE: MIN_FACE_PX,
  FACE_BLUR_THRESHOLD: BLUR_THRESHOLD,
  NMS_IOU: NMS_IOU_THRESHOLD,
});

// ─────────────────────────────────────────────────────────────
//  SESSION MANAGEMENT
// ─────────────────────────────────────────────────────────────

async function loadModels(detModelPath, recModelPath) {
  let ort;
  try {
    ort = require('onnxruntime-node');
  } catch (e) {
    throw new Error('onnxruntime-node not installed. Run: npm install onnxruntime-node');
  }

  const options = {
    graphOptimizationLevel: 'all',
    enableCpuMemArena:       true,
    executionMode:           'sequential',
  };

  async function createSession(modelPath, label) {
    for (const ep of ['dml', 'cpu']) {
      try {
        const t = log.timer(`Load ${label}`);
        const session = await ort.InferenceSession.create(modelPath, {
          ...options,
          executionProviders: [ep],
        });
        t.end({ ep, inputs: session.inputNames, outputs: session.outputNames.length });
        return session;
      } catch (err) {
        if (ep === 'dml') {
          log.debug('DirectML unavailable, using CPU', { error: err.message });
        } else {
          throw new Error(`Failed to load ${label}: ${err.message}`);
        }
      }
    }
  }

  const [det, rec] = await Promise.all([
    createSession(detModelPath, 'SCRFD-10G'),
    createSession(recModelPath, 'ArcFace-R50'),
  ]);

  return { det, rec, ort };
}

// ─────────────────────────────────────────────────────────────
//  IMAGE PREPROCESSING UTILITIES
// ─────────────────────────────────────────────────────────────

async function letterboxToBuffer(pipeline, origW, origH, targetSize = DET_INPUT_SIZE) {
  const scale  = Math.min(targetSize / origW, targetSize / origH);
  const newW   = Math.round(origW * scale);
  const newH   = Math.round(origH * scale);
  const padX   = Math.floor((targetSize - newW) / 2);
  const padY   = Math.floor((targetSize - newH) / 2);

  const { data } = await pipeline
    .resize(newW, newH, { fit: 'fill', kernel: 'lanczos3' })
    .extend({
      top:    padY,
      bottom: targetSize - newH - padY,
      left:   padX,
      right:  targetSize - newW - padX,
      background: { r: 114, g: 114, b: 114 },
    })
    .raw()
    .toBuffer({ resolveWithObject: true });

  return { data, scale, padX, padY };
}

function rgbToNchw(rgbBuffer, width, height) {
  const n   = width * height;
  const out = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    out[i]         = (rgbBuffer[i * 3]     - 127.5) / 128.0;
    out[n + i]     = (rgbBuffer[i * 3 + 1] - 127.5) / 128.0;
    out[2 * n + i] = (rgbBuffer[i * 3 + 2] - 127.5) / 128.0;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
//  SCRFD ANCHOR GENERATION
// ─────────────────────────────────────────────────────────────

function buildAnchorCenters(stride, inputSize = DET_INPUT_SIZE) {
  const gridH  = Math.floor(inputSize / stride);
  const gridW  = Math.floor(inputSize / stride);
  const nCells = gridH * gridW;

  const cx1 = new Float32Array(nCells * 2);
  for (let row = 0; row < gridH; row++) {
    for (let col = 0; col < gridW; col++) {
      const i = row * gridW + col;
      cx1[i * 2]     = col * stride;
      cx1[i * 2 + 1] = row * stride;
    }
  }

  const out = new Float32Array(nCells * NUM_ANCHORS * 2);
  for (let a = 0; a < NUM_ANCHORS; a++) {
    out.set(cx1, a * nCells * 2);
  }
  return out;
}

const _anchorCache = new Map();
function getAnchors(stride) {
  if (!_anchorCache.has(stride)) {
    _anchorCache.set(stride, buildAnchorCenters(stride));
  }
  return _anchorCache.get(stride);
}

// ─────────────────────────────────────────────────────────────
//  SCRFD OUTPUT DECODING
// ─────────────────────────────────────────────────────────────

function parseOutputTensors(session, results) {
  const tensors = session.outputNames.map(n => results[n]);

  const scores = [], bboxes = [], kpss = [];
  for (const t of tensors) {
    const dims    = Array.from(t.dims);
    const lastDim = dims[dims.length - 1];
    if      (lastDim === 1)  scores.push(t);
    else if (lastDim === 4)  bboxes.push(t);
    else if (lastDim === 10) kpss.push(t);
  }

  const anchorCount  = t => t.dims[t.dims.length - 2];
  const byAnchorDesc = (a, b) => anchorCount(b) - anchorCount(a);
  scores.sort(byAnchorDesc);
  bboxes.sort(byAnchorDesc);
  kpss.sort(byAnchorDesc);

  if (scores.length !== 3 || bboxes.length !== 3 || kpss.length !== 3) {
    throw new Error(
      `Unexpected SCRFD output count: scores=${scores.length} bboxes=${bboxes.length} kps=${kpss.length}`
    );
  }

  return { scores, bboxes, kpss };
}

function decodeLevel(anchorCenters, scoreData, bboxData, kpsData, stride) {
  const n     = scoreData.length;
  const boxes = [], scores = [], kpss = [];

  for (let i = 0; i < n; i++) {
    const s = scoreData[i];
    if (s < SCORE_THRESHOLD) continue;

    const cx = anchorCenters[i * 2];
    const cy = anchorCenters[i * 2 + 1];

    const d0 = bboxData[i * 4]     * stride;
    const d1 = bboxData[i * 4 + 1] * stride;
    const d2 = bboxData[i * 4 + 2] * stride;
    const d3 = bboxData[i * 4 + 3] * stride;

    boxes.push([cx - d0, cy - d1, cx + d2, cy + d3]);
    scores.push(s);

    const kp = [];
    for (let k = 0; k < 5; k++) {
      kp.push([
        cx + kpsData[i * 10 + k * 2]     * stride,
        cy + kpsData[i * 10 + k * 2 + 1] * stride,
      ]);
    }
    kpss.push(kp);
  }

  return { boxes, scores, kpss };
}

// ─────────────────────────────────────────────────────────────
//  NON-MAXIMUM SUPPRESSION
// ─────────────────────────────────────────────────────────────

function iou(a, b) {
  const ix1 = Math.max(a[0], b[0]), iy1 = Math.max(a[1], b[1]);
  const ix2 = Math.min(a[2], b[2]), iy2 = Math.min(a[3], b[3]);
  const inter = Math.max(0, ix2 - ix1) * Math.max(0, iy2 - iy1);
  if (inter === 0) return 0;
  const aA = (a[2] - a[0]) * (a[3] - a[1]);
  const aB = (b[2] - b[0]) * (b[3] - b[1]);
  return inter / (aA + aB - inter);
}

function nms(boxes, scores, iouThresh = NMS_IOU_THRESHOLD) {
  const n     = scores.length;
  const order = Array.from({ length: n }, (_, i) => i)
    .sort((a, b) => scores[b] - scores[a]);

  const suppressed = new Uint8Array(n);
  const keep       = [];

  for (let oi = 0; oi < order.length; oi++) {
    const i = order[oi];
    if (suppressed[i]) continue;
    keep.push(i);
    for (let oj = oi + 1; oj < order.length; oj++) {
      const j = order[oj];
      if (!suppressed[j] && iou(boxes[i], boxes[j]) > iouThresh) {
        suppressed[j] = 1;
      }
    }
  }
  return keep;
}

// ─────────────────────────────────────────────────────────────
//  QUALITY FILTERS
// ─────────────────────────────────────────────────────────────

/**
 * Aspect ratio check — a real face bbox should be roughly square-ish.
 * Extreme ratios (very wide or very tall) = not a face.
 * Returns true if the aspect ratio is acceptable.
 */
function checkAspectRatio(faceW, faceH) {
  if (faceH <= 0) return false;
  const ratio = faceW / faceH;
  return ratio >= 0.75 && ratio <= 1.35;
}

/**
 * Border proximity check.
 * Detections that are clipped against the image border at low confidence
 * are very likely partial-object false positives (e.g. arms, textures).
 * Returns true if the detection passes (should be kept).
 *
 * @param {number} x1, y1, x2, y2   bbox in original image coordinates
 * @param {number} imgW, imgH        original image dimensions
 * @param {number} score             detection confidence
 * @param {number} margin            pixels from edge to consider "near border"
 */
function checkBorderProximity(x1, y1, x2, y2, imgW, imgH, score, faceW, faceH) {
  // At very high confidence, skip this check entirely
  if (score >= SCORE_HIGH_CONFIDENCE) return true;

  // Dynamic border margin: face-relative so large faces aren't penalised
  const marginPx = Math.max(10, Math.min(faceW, faceH) * BORDER_MARGIN_FRAC);

  const nearLeft   = x1 < marginPx;
  const nearTop    = y1 < marginPx;
  const nearRight  = x2 > imgW - marginPx;
  const nearBottom = y2 > imgH - marginPx;

  // Allow up to one border touch at medium confidence, reject if touching 2+ borders
  const borderTouches = [nearLeft, nearTop, nearRight, nearBottom].filter(Boolean).length;

  if (borderTouches >= 2) {
    log.debug('REJECT border (2+ touches)', { score: score.toFixed(3), x1: x1.toFixed(0), y1: y1.toFixed(0), x2: x2.toFixed(0), y2: y2.toFixed(0), imgW, imgH });
    return false;
  }

  // Single border touch at low-medium confidence — require higher score
  if (borderTouches === 1 && score < SCORE_THRESHOLD + 0.10) {
    log.debug('REJECT border (1 touch, low score)', { score: score.toFixed(3) });
    return false;
  }

  return true;
}

/**
 * Landmark geometry sanity check.
 * Verifies that the 5 detected keypoints have a plausible face geometry:
 * - Left eye must be left of right eye
 * - Eye midpoint should be above mouth midpoint
 * - Eye distance must be a reasonable fraction of face width
 * Returns true if geometry looks like a real face.
 *
 * @param {[number,number][]} kps   5 keypoints [lEye, rEye, nose, lMouth, rMouth]
 * @param {number} faceW            face bounding box width
 * @param {number} faceH            face bounding box height
 * @param {number} score            detection confidence
 */
function checkLandmarkGeometry(kps, faceW, faceH, score) {
  // Skip at very high confidence
  if (score >= SCORE_HIGH_CONFIDENCE) return true;
  if (!kps || kps.length < 5) return false;

  const [lEye, rEye, nose, lMouth, rMouth] = kps;

  // Eyes: left eye x should be less than right eye x
  if (lEye[0] >= rEye[0]) {
    log.debug('REJECT landmarks: eyes reversed', { lEye, rEye, score: score.toFixed(3) });
    return false;
  }

  // Eye distance plausibility (should be 20–90% of face width)
  const eyeDist = rEye[0] - lEye[0];
  const eyeRatio = eyeDist / faceW;

if (eyeRatio < 0.32) {
  log.debug('REJECT profile face', {
    eyeRatio: eyeRatio.toFixed(2),
    score: score.toFixed(3),
  });
  return false;
}
  const minEyeDist = faceW * 0.15;
  const maxEyeDist = faceW * 0.95;
  if (eyeDist < minEyeDist || eyeDist > maxEyeDist) {
    log.debug('REJECT landmarks: eye distance out of range', { eyeDist: eyeDist.toFixed(1), faceW: faceW.toFixed(1), score: score.toFixed(3) });
    return false;
  }

  // Eye midpoint should be above mouth midpoint (in image coords, y increases downward)
  const eyeMidY   = (lEye[1] + rEye[1]) / 2;
  const mouthMidY = (lMouth[1] + rMouth[1]) / 2;
  if (eyeMidY >= mouthMidY) {
    log.debug('REJECT landmarks: eyes below mouth', { eyeMidY: eyeMidY.toFixed(1), mouthMidY: mouthMidY.toFixed(1), score: score.toFixed(3) });
    return false;
  }

  // Nose tip should be vertically between eyes and mouth
  const noseY = nose[1];
  if (noseY <= eyeMidY || noseY >= mouthMidY) {
    log.debug('REJECT landmarks: nose outside eye-mouth range', {
      noseY: noseY.toFixed(1), eyeMidY: eyeMidY.toFixed(1), mouthMidY: mouthMidY.toFixed(1), score: score.toFixed(3),
    });
    return false;
  }

  return true;
}

/**
 * Frontalness check — rejects strongly turned/profile faces.
 * In a frontal face, the nose tip is horizontally close to the midpoint of
 * the inter-eye segment. A large lateral offset signals a side/profile view.
 *
 * @param {[number,number][]} kps   [lEye, rEye, nose, lMouth, rMouth]
 * @param {number} faceW
 * @param {number} score
 */
function checkFrontalness(kps, faceW, score) {
  if (score >= SCORE_HIGH_CONFIDENCE) return true;
  if (!kps || kps.length < 5) return false;

  const [lEye, rEye, nose] = kps;
  const eyeDist = rEye[0] - lEye[0];
  if (eyeDist <= 0) return false;

  const eyeMidX       = (lEye[0] + rEye[0]) / 2;
  const noseDeviation = Math.abs(nose[0] - eyeMidX) / eyeDist;

  // Reject if nose is more than 30% of eye-distance off-centre
  if (noseDeviation > 0.30) {
    log.debug('REJECT frontalness: nose off-centre', {
      noseDeviation: noseDeviation.toFixed(3),
      score: score.toFixed(3),
    });
    return false;
  }

  return true;
}

/**
 * Eye-roll check — rejects faces with excessive in-plane rotation (tilt).
 * Computes vertical disparity between left and right eye as a fraction of
 * the inter-eye horizontal distance.  A ratio > 0.50 ≈ ~27° roll.
 *
 * @param {[number,number][]} kps   [lEye, rEye, ...]
 * @param {number} score
 */
function checkEyeRoll(kps, score) {
  if (score >= SCORE_HIGH_CONFIDENCE) return true;
  if (!kps || kps.length < 2) return false;

  const [lEye, rEye] = kps;
  const eyeDist = rEye[0] - lEye[0];
  if (eyeDist <= 0) return false;

  const rollRatio = Math.abs(rEye[1] - lEye[1]) / eyeDist;

  if (rollRatio > 0.50) {
    log.debug('REJECT eye roll', {
      rollRatio: rollRatio.toFixed(3),
      score: score.toFixed(3),
    });
    return false;
  }

  return true;
}

/**
 * Blur/sharpness check using a Laplacian-approximation on the aligned face chip.
 * Computes the variance of a discrete Laplacian filter — low variance = blurry.
 *
 * The check runs on a grayscale version of the 112×112 face chip for speed.
 * Returns true if the face chip is sharp enough to be worth embedding.
 *
 * @param {Buffer} alignedRgb   112×112 raw RGB uint8
 * @param {number} score        detection confidence
 */
function checkFaceSharpness(alignedRgb, score) {
  // Skip blur check at very high confidence (trust SCRFD)
  if (score >= SCORE_HIGH_CONFIDENCE) return true;
  // If blur threshold is 0, skip entirely
  if (BLUR_THRESHOLD <= 0) return true;

  const size = REC_INPUT_SIZE; // 112

  // Convert to grayscale
  const gray = new Float32Array(size * size);
  for (let i = 0; i < size * size; i++) {
    gray[i] = 0.299 * alignedRgb[i * 3] + 0.587 * alignedRgb[i * 3 + 1] + 0.114 * alignedRgb[i * 3 + 2];
  }

  // Compute Laplacian values (4-connected): L(i,j) = |4*p - N - S - E - W|
  // Skip border pixels
  const lap = new Float32Array((size - 2) * (size - 2));
  let lapIdx = 0;
  for (let y = 1; y < size - 1; y++) {
    for (let x = 1; x < size - 1; x++) {
      const p  = gray[y * size + x];
      const n  = gray[(y - 1) * size + x];
      const s  = gray[(y + 1) * size + x];
      const e  = gray[y * size + (x + 1)];
      const w  = gray[y * size + (x - 1)];
      lap[lapIdx++] = 4 * p - n - s - e - w;
    }
  }

  // Compute variance of Laplacian values
  let mean = 0;
  for (let i = 0; i < lap.length; i++) mean += lap[i];
  mean /= lap.length;

  let variance = 0;
  for (let i = 0; i < lap.length; i++) {
    const d = lap[i] - mean;
    variance += d * d;
  }
  variance /= lap.length;

  if (variance < BLUR_THRESHOLD) {
    log.debug('REJECT blur', { variance: variance.toFixed(1), threshold: BLUR_THRESHOLD, score: score.toFixed(3) });
    return false;
  }

  return true;
}

// ─────────────────────────────────────────────────────────────
//  FACE ALIGNMENT — SIMILARITY TRANSFORM
// ─────────────────────────────────────────────────────────────

function estimateSimilarityTransform(srcPts, dstPts) {
  const n = srcPts.length;

  let msx = 0, msy = 0, mdx = 0, mdy = 0;
  for (let i = 0; i < n; i++) {
    msx += srcPts[i][0]; msy += srcPts[i][1];
    mdx += dstPts[i][0]; mdy += dstPts[i][1];
  }
  msx /= n; msy /= n; mdx /= n; mdy /= n;

  let numA = 0, numB = 0, denom = 0;
  for (let i = 0; i < n; i++) {
    const scx = srcPts[i][0] - msx,  scy = srcPts[i][1] - msy;
    const dcx = dstPts[i][0] - mdx,  dcy = dstPts[i][1] - mdy;
    numA  += dcx * scx + dcy * scy;
    numB  += dcy * scx - dcx * scy;
    denom += scx * scx + scy * scy;
  }

  if (Math.abs(denom) < 1e-10) return null;

  const a  = numA / denom;
  const b  = numB / denom;
  const tx = mdx - a * msx + b * msy;
  const ty = mdy - b * msx - a * msy;

  return [[a, -b, tx], [b, a, ty]];
}

function invertSimilarityTransform(M) {
  const a = M[0][0], b = M[1][0];
  const tx = M[0][2], ty = M[1][2];
  const det = a * a + b * b;
  if (Math.abs(det) < 1e-10) return null;
  const id = 1.0 / det;
  return [
    [ a * id,  b * id, -(a * tx + b * ty) * id],
    [-b * id,  a * id,  (b * tx - a * ty) * id],
  ];
}

function warpFace(rawData, srcW, srcH, srcKps, outputSize = REC_INPUT_SIZE) {
  const M = estimateSimilarityTransform(srcKps, TARGET_KPS_112);
  if (!M) return null;

  const Minv = invertSimilarityTransform(M);
  if (!Minv) return null;

  const m00 = Minv[0][0], m01 = Minv[0][1], m02 = Minv[0][2];
  const m10 = Minv[1][0], m11 = Minv[1][1], m12 = Minv[1][2];

  const out = Buffer.alloc(outputSize * outputSize * 3, 114);

  for (let oy = 0; oy < outputSize; oy++) {
    for (let ox = 0; ox < outputSize; ox++) {
      const ix = m00 * ox + m01 * oy + m02;
      const iy = m10 * ox + m11 * oy + m12;

      const x0 = ix | 0;
      const y0 = iy | 0;

      if (x0 < 0 || y0 < 0 || x0 >= srcW - 1 || y0 >= srcH - 1) continue;

      const x1 = x0 + 1, y1 = y0 + 1;
      const fx = ix - x0, fy = iy - y0;
      const w00 = (1 - fx) * (1 - fy);
      const w10 = fx       * (1 - fy);
      const w01 = (1 - fx) * fy;
      const w11 = fx       * fy;

      const outBase = (oy * outputSize + ox) * 3;
      const p00 = (y0 * srcW + x0) * 3;
      const p10 = (y0 * srcW + x1) * 3;
      const p01 = (y1 * srcW + x0) * 3;
      const p11 = (y1 * srcW + x1) * 3;

      for (let c = 0; c < 3; c++) {
        out[outBase + c] = Math.round(
          rawData[p00 + c] * w00 +
          rawData[p10 + c] * w10 +
          rawData[p01 + c] * w01 +
          rawData[p11 + c] * w11,
        );
      }
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
//  ArcFace EMBEDDING
// ─────────────────────────────────────────────────────────────

function l2Normalize(embedding) {
  let norm = 0;
  for (let i = 0; i < embedding.length; i++) norm += embedding[i] * embedding[i];
  norm = Math.sqrt(norm);
  if (norm < 1e-10) return embedding;
  for (let i = 0; i < embedding.length; i++) embedding[i] /= norm;
  return embedding;
}

async function embedFace(ort, recSession, alignedRgb) {
  const n    = REC_INPUT_SIZE * REC_INPUT_SIZE;
  const nchw = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    nchw[i]         = (alignedRgb[i * 3]     - 127.5) / 128.0;
    nchw[n + i]     = (alignedRgb[i * 3 + 1] - 127.5) / 128.0;
    nchw[2 * n + i] = (alignedRgb[i * 3 + 2] - 127.5) / 128.0;
  }

  const inputName = recSession.inputNames[0];
  const tensor    = new ort.Tensor('float32', nchw, [1, 3, REC_INPUT_SIZE, REC_INPUT_SIZE]);
  const result    = await recSession.run({ [inputName]: tensor });

  const embedding = new Float32Array(result[recSession.outputNames[0]].data);
  return l2Normalize(embedding);
}

// ─────────────────────────────────────────────────────────────
//  FULL DETECTION + EMBEDDING PIPELINE
// ─────────────────────────────────────────────────────────────

/**
 * Run the full detection + quality-gated embedding pipeline on a single image.
 *
 * Filter pipeline (in order):
 *   1. SCRFD score ≥ FACE_MIN_CONFIDENCE
 *   2. NMS
 *   3. Minimum face size ≥ FACE_MIN_SIZE px
 *   4. Aspect ratio (w/h 0.5–2.0)
 *   5. Border proximity check
 *   6. Landmark geometry sanity
 *   7. Warp face chip for alignment
 *   8. Laplacian sharpness / blur check
 *   9. ArcFace embedding  ← only after all checks pass
 *
 * All rejections are logged at debug level with the reason.
 */
async function detectAndEmbed(models, source, opts = {}) {
  const { det, rec, ort } = models;

  // ── 1. Load image ─────────────────────────────────────────
  const pipeline = sharp(source).rotate();
  const meta     = await pipeline.metadata();
  const origW    = meta.width;
  const origH    = meta.height;

  // ── 2. Letterbox resize → detection tensor ───────────────
  const { data: lbData, scale, padX, padY } =
    await letterboxToBuffer(sharp(source).rotate(), origW, origH);

  const detInput  = rgbToNchw(lbData, DET_INPUT_SIZE, DET_INPUT_SIZE);
  const inputName = det.inputNames[0];
  const detTensor = new ort.Tensor('float32', detInput, [1, 3, DET_INPUT_SIZE, DET_INPUT_SIZE]);

  // ── 3. SCRFD inference ────────────────────────────────────
  const detResults = await det.run({ [inputName]: detTensor });
  const { scores: scoreTensors, bboxes: bboxTensors, kpss: kpsTensors } =
    parseOutputTensors(det, detResults);

  // ── 4. Decode all FPN levels ──────────────────────────────
  let allBoxes = [], allScores = [], allKpss = [];

  for (let lvl = 0; lvl < FPN_STRIDES.length; lvl++) {
    const stride = FPN_STRIDES[lvl];
    const anc    = getAnchors(stride);

    const scoreData = new Float32Array(scoreTensors[lvl].data);
    const bboxData  = new Float32Array(bboxTensors[lvl].data);
    const kpsData   = new Float32Array(kpsTensors[lvl].data);

    const { boxes, scores, kpss } = decodeLevel(anc, scoreData, bboxData, kpsData, stride);

    allBoxes  = allBoxes.concat(boxes);
    allScores = allScores.concat(scores);
    allKpss   = allKpss.concat(kpss);
  }

  const rawCount = allBoxes.length;
  if (rawCount === 0) {
    log.debug('No candidates above score threshold', { threshold: SCORE_THRESHOLD, origW, origH });
    return [];
  }

  // ── 5. NMS ────────────────────────────────────────────────
  const keepIdx = nms(allBoxes, allScores);
  log.debug('Post-NMS candidates', { raw: rawCount, afterNms: keepIdx.length });

  // ── 6. Load full-res image for alignment warping ──────────
  const MAX_ALIGN = 1920;
  const alignScale = Math.min(1, MAX_ALIGN / Math.max(origW, origH));
  const alignW     = Math.round(origW * alignScale);
  const alignH     = Math.round(origH * alignScale);

  const { data: alignData } = await sharp(source)
    .rotate()
    .resize(alignW, alignH, { fit: 'fill', kernel: 'lanczos3' })
    .raw()
    .toBuffer({ resolveWithObject: true });

  // ── 7. Per-detection quality filters + embedding ──────────
  const faces = [];
  let rejected = { size: 0, aspect: 0, border: 0, landmarks: 0, frontal: 0, roll: 0, blur: 0, warp: 0 };

  for (const idx of keepIdx) {
    const box   = allBoxes[idx];
    const kps   = allKpss[idx];
    const score = allScores[idx];

    // Un-letterbox: map from 640×640 detection space → original image space
    const toOrig = (v, offset, s) => (v - offset) / s;
    const x1 = toOrig(box[0], padX, scale);
    const y1 = toOrig(box[1], padY, scale);
    const x2 = toOrig(box[2], padX, scale);
    const y2 = toOrig(box[3], padY, scale);

    const faceW = x2 - x1;
    const faceH = y2 - y1;

    // Filter 1: Minimum size
    if (faceW < MIN_FACE_PX || faceH < MIN_FACE_PX) {
      log.debug('REJECT size', { faceW: faceW.toFixed(0), faceH: faceH.toFixed(0), min: MIN_FACE_PX, score: score.toFixed(3) });
      rejected.size++;
      continue;
    }

    // Filter 2: Aspect ratio
    if (!checkAspectRatio(faceW, faceH)) {
      log.debug('REJECT aspect', { ratio: (faceW / faceH).toFixed(2), score: score.toFixed(3) });
      rejected.aspect++;
      continue;
    }

    // Filter 3: Border proximity
    if (!checkBorderProximity(x1, y1, x2, y2, origW, origH, score, faceW, faceH)) {
      rejected.border++;
      continue;
    }

    // Remap keypoints to original image space
    const origKps = kps.map(([kx, ky]) => [
      toOrig(kx, padX, scale),
      toOrig(ky, padY, scale),
    ]);

    // Filter 4: Landmark geometry
    if (!checkLandmarkGeometry(origKps, faceW, faceH, score)) {
      rejected.landmarks++;
      continue;
    }

    // Filter 4b: Frontalness — reject profile / strongly turned faces
    if (!checkFrontalness(origKps, faceW, score)) {
      rejected.frontal++;
      continue;
    }

    // Filter 4c: Eye roll — reject excessively tilted faces
    if (!checkEyeRoll(origKps, score)) {
      rejected.roll++;
      continue;
    }

    // Scale keypoints to alignment-resolution image
    const alignKps = origKps.map(([kx, ky]) => [kx * alignScale, ky * alignScale]);

    // Warp aligned face chip
    const alignedRgb = warpFace(alignData, alignW, alignH, alignKps);
    if (!alignedRgb) {
      log.debug('REJECT warp failed', { score: score.toFixed(3) });
      rejected.warp++;
      continue;
    }

    // Filter 5: Blur / sharpness
    if (!checkFaceSharpness(alignedRgb, score)) {
      rejected.blur++;
      continue;
    }

    // ── All checks passed — generate ArcFace embedding ────────
    log.debug('ACCEPT face', { score: score.toFixed(3), faceW: faceW.toFixed(0), faceH: faceH.toFixed(0) });

    const embedding = await embedFace(ort, rec, alignedRgb);

    faces.push({
      bbox:       [x1, y1, x2, y2],
      bboxNorm:   [x1 / origW, y1 / origH, faceW / origW, faceH / origH],
      kps:        origKps,
      score,
      embedding,
      alignedRgb, // 112×112 raw RGB — used by worker for clean face thumbnails
      origW,
      origH,
    });
  }

  const totalRejected = Object.values(rejected).reduce((a, b) => a + b, 0);
  if (keepIdx.length > 0 || totalRejected > 0) {
    log.info('Detection summary', {
      afterNms: keepIdx.length,
      accepted: faces.length,
      rejected,
      score_threshold: SCORE_THRESHOLD,
    });
  }

  faces.sort((a, b) => {
  const areaA = a.bboxNorm[2] * a.bboxNorm[3];
  const areaB = b.bboxNorm[2] * b.bboxNorm[3];

  return (
    (b.score * areaB) -
    (a.score * areaA)
  );
});

return faces.slice(0, 3);
}

/**
 * Detect faces in a raw JPEG frame buffer (used for image files and video frames).
 */
async function detectFacesInBuffer(models, buffer, opts) {
  return detectAndEmbed(models, buffer, opts);
}

/**
 * Detect faces directly from a file path (used for GIF/image files on disk).
 */
async function detectFacesInFile(models, filePath, opts) {
  return detectAndEmbed(models, filePath, opts);
}

/**
 * Extract an aligned 128×128 face thumbnail (JPEG buffer) from a source image.
 */
async function extractFaceThumb(source, bbox, origW, origH, thumbSize = 128) {
  const [x1, y1, x2, y2] = bbox;
  const fw = x2 - x1, fh = y2 - y1;
  const margin = Math.max(fw, fh) * 0.25;

  const left   = Math.max(0, Math.round(x1 - margin));
  const top    = Math.max(0, Math.round(y1 - margin));
  const right  = Math.min(origW, Math.round(x2 + margin));
  const bottom = Math.min(origH, Math.round(y2 + margin));

  return sharp(source)
    .rotate()
    .extract({ left, top, width: right - left, height: bottom - top })
    .resize(thumbSize, thumbSize, { fit: 'cover', position: 'centre' })
    .jpeg({ quality: 88 })
    .toBuffer();
}

// ─────────────────────────────────────────────────────────────
//  EXPORTS
// ─────────────────────────────────────────────────────────────

module.exports = {
  loadModels,
  detectFacesInBuffer,
  detectFacesInFile,
  extractFaceThumb,
  l2Normalize,
  // Exposed for unit-testing
  estimateSimilarityTransform,
  invertSimilarityTransform,
  warpFace,
  nms,
  // Quality filters (exported for testing)
  checkAspectRatio,
  checkBorderProximity,
  checkLandmarkGeometry,
  checkFrontalness,
  checkEyeRoll,
  checkFaceSharpness,
};

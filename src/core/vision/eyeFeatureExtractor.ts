import { GestureConfig, sanitizeGestureConfig } from '../config/gestureConfig';
import {
  BlendshapeCategory,
  EyeObservation,
  EyeState,
  GazeDirection,
  NormalizedLandmark,
  RawFaceFrame,
} from './types';

// MediaPipe 478-point Face Landmarker indices for eye contours and iris centers.
const LEFT_EYE_EAR = { p1: 33, p2: 160, p3: 158, p4: 133, p5: 153, p6: 144 } as const;
const RIGHT_EYE_EAR = { p1: 362, p2: 385, p3: 387, p4: 263, p5: 373, p6: 380 } as const;

const LEFT_IRIS_CENTER = 468;
const RIGHT_IRIS_CENTER = 473;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function dist2D(a: NormalizedLandmark, b: NormalizedLandmark): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function computeEar(
  landmarks: NormalizedLandmark[],
  idx: { p1: number; p2: number; p3: number; p4: number; p5: number; p6: number },
): number | null {
  const p1 = landmarks[idx.p1];
  const p2 = landmarks[idx.p2];
  const p3 = landmarks[idx.p3];
  const p4 = landmarks[idx.p4];
  const p5 = landmarks[idx.p5];
  const p6 = landmarks[idx.p6];
  if (!p1 || !p2 || !p3 || !p4 || !p5 || !p6) return null;

  const horiz = dist2D(p1, p4);
  if (horiz < 1e-5) return null;
  const vert = dist2D(p2, p6) + dist2D(p3, p5);
  return vert / (2 * horiz);
}

function computeIrisHorizontalGaze(
  landmarks: NormalizedLandmark[],
  mirrorHorizontal: boolean,
): number | null {
  const leftCornerA = landmarks[LEFT_EYE_EAR.p1];
  const leftCornerB = landmarks[LEFT_EYE_EAR.p4];
  const leftIris = landmarks[LEFT_IRIS_CENTER];

  const rightCornerA = landmarks[RIGHT_EYE_EAR.p1];
  const rightCornerB = landmarks[RIGHT_EYE_EAR.p4];
  const rightIris = landmarks[RIGHT_IRIS_CENTER];

  const samples: number[] = [];

  if (leftCornerA && leftCornerB && leftIris) {
    const minX = Math.min(leftCornerA.x, leftCornerB.x);
    const maxX = Math.max(leftCornerA.x, leftCornerB.x);
    const span = maxX - minX;
    if (span > 1e-4) {
      const ratio = (leftIris.x - minX) / span; // 0..1 across image-x
      samples.push(ratio);
    }
  }

  if (rightCornerA && rightCornerB && rightIris) {
    const minX = Math.min(rightCornerA.x, rightCornerB.x);
    const maxX = Math.max(rightCornerA.x, rightCornerB.x);
    const span = maxX - minX;
    if (span > 1e-4) {
      const ratio = (rightIris.x - minX) / span;
      samples.push(ratio);
    }
  }

  if (samples.length === 0) return null;
  const avgRatio = samples.reduce((acc, v) => acc + v, 0) / samples.length;

  // In a standard non-mirrored webcam frame, looking toward the user's right moves the iris
  // toward smaller image-x (avgRatio < 0.5). Scaling by 4 maps realistic iris travel (~0.25..0.75) to [-1, +1].
  const rawSigned = mirrorHorizontal ? (0.5 - avgRatio) * 4 : (avgRatio - 0.5) * 4;
  return clamp(rawSigned, -1, 1);
}

function getBlendshapeScore(map: Map<string, number>, name: string): number | null {
  const val = map.get(name);
  return typeof val === 'number' && Number.isFinite(val) ? val : null;
}

function computeBlendshapeHorizontalGaze(map: Map<string, number>): number | null {
  const outLeft = getBlendshapeScore(map, 'eyeLookOutLeft');
  const inRight = getBlendshapeScore(map, 'eyeLookInRight');
  const outRight = getBlendshapeScore(map, 'eyeLookOutRight');
  const inLeft = getBlendshapeScore(map, 'eyeLookInLeft');

  if (outLeft === null || inRight === null || outRight === null || inLeft === null) {
    return null;
  }

  // Subject anatomical convention:
  // Looking to subject's RIGHT => eyeLookOutRight + eyeLookInLeft increase
  // Looking to subject's LEFT  => eyeLookOutLeft  + eyeLookInRight increase
  const lookRight = (outRight + inLeft) / 2;
  const lookLeft = (outLeft + inRight) / 2;
  return clamp(lookRight - lookLeft, -1, 1);
}

function buildBlendshapeMap(blendshapes?: BlendshapeCategory[]): Map<string, number> {
  const map = new Map<string, number>();
  if (!blendshapes) return map;
  for (const cat of blendshapes) {
    map.set(cat.categoryName, cat.score);
  }
  return map;
}

const NOSE_TIP_INDEX = 1;
const LEFT_CHEEK_INDEX = 234;
const RIGHT_CHEEK_INDEX = 454;

/**
 * Estimates horizontal head yaw angle in degrees (negative = one side, positive = opposite side).
 * Primary: MediaPipe 4x4 facial transformation matrix (supports column-major OpenGL and row-major).
 * Fallback: Geometric nose-to-cheek asymmetry from face landmarks.
 */
export function computeHeadYawDeg(
  matrix?: number[],
  landmarks?: NormalizedLandmark[],
): number | null {
  if (matrix && matrix.length >= 16) {
    const r22 = matrix[10];
    if (typeof r22 === 'number' && Number.isFinite(r22)) {
      const colTrans =
        Math.abs(matrix[12] ?? 0) + Math.abs(matrix[13] ?? 0) + Math.abs(matrix[14] ?? 0);
      const rowTrans =
        Math.abs(matrix[3] ?? 0) + Math.abs(matrix[7] ?? 0) + Math.abs(matrix[11] ?? 0);
      const isRowMajor = rowTrans > colTrans + 1e-3;
      const r02 = isRowMajor ? matrix[2] : matrix[8];
      if (typeof r02 === 'number' && Number.isFinite(r02)) {
        const yawRad = Math.atan2(r02, r22);
        return clamp((yawRad * 180) / Math.PI, -90, 90);
      }
    }
  }

  if (landmarks) {
    const nose = landmarks[NOSE_TIP_INDEX];
    const leftCheek = landmarks[LEFT_CHEEK_INDEX];
    const rightCheek = landmarks[RIGHT_CHEEK_INDEX];
    if (nose && leftCheek && rightCheek) {
      const minX = Math.min(leftCheek.x, rightCheek.x);
      const maxX = Math.max(leftCheek.x, rightCheek.x);
      const span = maxX - minX;
      if (span > 0.05) {
        const ratio = (nose.x - minX) / span; // 0.5 when frontal
        return clamp((ratio - 0.5) * 90, -90, 90);
      }
    }
  }

  return null;
}

/**
 * Pure feature extractor converting raw MediaPipe Face Landmarker outputs into
 * hysteresis-stabilized EyeState and smoothed GazeDirection observations.
 */
export class EyeFeatureExtractor {
  private config: GestureConfig;
  private currentEyeState: EyeState = 'OPEN';
  private currentGazeDirection: GazeDirection = 'UNKNOWN';
  private smoothedGaze: number | null = null;

  constructor(config?: Partial<GestureConfig>) {
    this.config = sanitizeGestureConfig(config);
  }

  updateConfig(config: Partial<GestureConfig>): void {
    this.config = sanitizeGestureConfig({ ...this.config, ...config });
  }

  reset(): void {
    this.currentEyeState = 'OPEN';
    this.currentGazeDirection = 'UNKNOWN';
    this.smoothedGaze = null;
  }

  extract(frame: RawFaceFrame): EyeObservation {
    if (!frame.faceDetected) {
      this.currentEyeState = 'OPEN';
      this.currentGazeDirection = 'UNKNOWN';
      this.smoothedGaze = null;
      return {
        timestampMs: frame.timestampMs,
        faceDetected: false,
        blinkLeft: 0,
        blinkRight: 0,
        blinkMin: 0,
        blinkMax: 0,
        earLeft: null,
        earRight: null,
        eyeState: 'OPEN',
        gazeRawBlendshape: null,
        gazeRawIris: null,
        gazeSmoothed: null,
        gazeDirection: 'UNKNOWN',
        headYawDeg: null,
        gazeSuppressedByHeadTurn: false,
      };
    }

    const blendMap = buildBlendshapeMap(frame.blendshapes);
    const earLeft = frame.landmarks ? computeEar(frame.landmarks, LEFT_EYE_EAR) : null;
    const earRight = frame.landmarks ? computeEar(frame.landmarks, RIGHT_EYE_EAR) : null;

    const bsLeft = getBlendshapeScore(blendMap, 'eyeBlinkLeft');
    const bsRight = getBlendshapeScore(blendMap, 'eyeBlinkRight');

    // Fallback to EAR-derived blink score if blendshapes are unavailable.
    const earToBlink = (ear: number | null): number => {
      if (ear === null) return 0;
      // Typical open EAR ~0.28-0.36, closed EAR ~0.08-0.16
      return clamp((0.28 - ear) / 0.16, 0, 1);
    };

    const blinkLeft = bsLeft ?? earToBlink(earLeft);
    const blinkRight = bsRight ?? earToBlink(earRight);
    const blinkMin = Math.min(blinkLeft, blinkRight);
    const blinkMax = Math.max(blinkLeft, blinkRight);

    // Hysteresis requires BOTH eyes closed to enter CLOSED (prevents single-eye wink false positives)
    // and both eyes sufficiently open to return to OPEN.
    if (this.currentEyeState === 'OPEN') {
      if (blinkMin >= this.config.blinkCloseThreshold) {
        this.currentEyeState = 'CLOSED';
      }
    } else if (blinkMax <= this.config.blinkOpenThreshold) {
      this.currentEyeState = 'OPEN';
    }

    const headYawDeg = computeHeadYawDeg(frame.facialTransformationMatrix, frame.landmarks);
    const gazeSuppressedByHeadTurn =
      this.config.headYawGateEnabled &&
      headYawDeg !== null &&
      Math.abs(headYawDeg) > this.config.headYawMaxDeg;

    const rawBlendshape = computeBlendshapeHorizontalGaze(blendMap);
    const rawIris = frame.landmarks
      ? computeIrisHorizontalGaze(frame.landmarks, this.config.mirrorHorizontal)
      : null;

    const sign = this.config.invertGazeDirection ? -1 : 1;
    const gazeRawBlendshape = rawBlendshape !== null ? clamp(rawBlendshape * sign, -1, 1) : null;
    const gazeRawIris = rawIris !== null ? clamp(rawIris * sign, -1, 1) : null;

    let gazeDirection: GazeDirection = 'UNKNOWN';

    // Mask gaze when eyes are closed (eyelids occlude iris) OR head is turned beyond headYawMaxDeg
    // to prevent head rotation perspective distortion from firing false LEFT/RIGHT gaze events.
    if (this.currentEyeState === 'CLOSED' || gazeSuppressedByHeadTurn) {
      this.currentGazeDirection = 'UNKNOWN';
      gazeDirection = 'UNKNOWN';
    } else {
      const selectedRaw = this.selectGazeSignal(gazeRawBlendshape, gazeRawIris);
      if (selectedRaw === null) {
        this.currentGazeDirection = 'UNKNOWN';
        gazeDirection = 'UNKNOWN';
      } else {
        const alpha = this.config.gazeEmaAlpha;
        this.smoothedGaze =
          this.smoothedGaze === null
            ? selectedRaw
            : alpha * selectedRaw + (1 - alpha) * this.smoothedGaze;

        gazeDirection = this.classifyGazeWithHysteresis(this.smoothedGaze);
        this.currentGazeDirection = gazeDirection;
      }
    }

    return {
      timestampMs: frame.timestampMs,
      faceDetected: true,
      blinkLeft,
      blinkRight,
      blinkMin,
      blinkMax,
      earLeft,
      earRight,
      eyeState: this.currentEyeState,
      gazeRawBlendshape,
      gazeRawIris,
      gazeSmoothed: this.smoothedGaze,
      gazeDirection,
      headYawDeg,
      gazeSuppressedByHeadTurn,
    };
  }

  private selectGazeSignal(blendshape: number | null, iris: number | null): number | null {
    switch (this.config.gazeMethod) {
      case 'blendshape':
        return blendshape ?? iris;
      case 'iris':
        return iris ?? blendshape;
      case 'hybrid':
        if (blendshape !== null && iris !== null) {
          return (blendshape + iris) / 2;
        }
        return blendshape ?? iris;
    }
  }

  private classifyGazeWithHysteresis(gaze: number): GazeDirection {
    const enter = this.config.gazeEnterThreshold;
    const exit = this.config.gazeExitThreshold;

    if (this.currentGazeDirection === 'RIGHT') {
      if (gaze <= -enter) return 'LEFT';
      if (gaze <= exit) return 'CENTER';
      return 'RIGHT';
    }

    if (this.currentGazeDirection === 'LEFT') {
      if (gaze >= enter) return 'RIGHT';
      if (gaze >= -exit) return 'CENTER';
      return 'LEFT';
    }

    if (gaze >= enter) return 'RIGHT';
    if (gaze <= -enter) return 'LEFT';
    return 'CENTER';
  }
}

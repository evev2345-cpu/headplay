import { describe, expect, it } from 'vitest';
import { EyeFeatureExtractor } from '../../src/core/vision/eyeFeatureExtractor';
import { BlendshapeCategory, NormalizedLandmark } from '../../src/core/vision/types';

function makeBlendshapes(scores: Record<string, number>): BlendshapeCategory[] {
  return Object.entries(scores).map(([categoryName, score]) => ({ categoryName, score }));
}

function makeSyntheticLandmarks(irisOffsetFromCenter = 0): NormalizedLandmark[] {
  const arr: NormalizedLandmark[] = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5, z: 0 }));

  // Left eye corners (33, 133) + vertical eyelids
  arr[33] = { x: 0.3, y: 0.5 };
  arr[133] = { x: 0.4, y: 0.5 };
  arr[160] = { x: 0.33, y: 0.485 };
  arr[144] = { x: 0.33, y: 0.515 };
  arr[158] = { x: 0.37, y: 0.485 };
  arr[153] = { x: 0.37, y: 0.515 };
  arr[468] = { x: 0.35 + irisOffsetFromCenter, y: 0.5 };

  // Right eye corners (362, 263) + vertical eyelids
  arr[362] = { x: 0.6, y: 0.5 };
  arr[263] = { x: 0.7, y: 0.5 };
  arr[385] = { x: 0.63, y: 0.485 };
  arr[380] = { x: 0.63, y: 0.515 };
  arr[387] = { x: 0.67, y: 0.485 };
  arr[373] = { x: 0.67, y: 0.515 };
  arr[473] = { x: 0.65 + irisOffsetFromCenter, y: 0.5 };

  return arr;
}

describe('EyeFeatureExtractor', () => {
  it('requires both eyes closed to enter CLOSED and applies blink hysteresis', () => {
    const extractor = new EyeFeatureExtractor({
      blinkCloseThreshold: 0.55,
      blinkOpenThreshold: 0.35,
    });

    // Single-eye wink should NOT enter CLOSED
    const wink = extractor.extract({
      timestampMs: 100,
      faceDetected: true,
      blendshapes: makeBlendshapes({ eyeBlinkLeft: 0.85, eyeBlinkRight: 0.1 }),
    });
    expect(wink.eyeState).toBe('OPEN');

    // Bilateral closure enters CLOSED
    const closed = extractor.extract({
      timestampMs: 140,
      faceDetected: true,
      blendshapes: makeBlendshapes({ eyeBlinkLeft: 0.72, eyeBlinkRight: 0.65 }),
    });
    expect(closed.eyeState).toBe('CLOSED');
    expect(closed.gazeDirection).toBe('UNKNOWN');

    // Intermediate score stays CLOSED due to hysteresis
    const mid = extractor.extract({
      timestampMs: 180,
      faceDetected: true,
      blendshapes: makeBlendshapes({ eyeBlinkLeft: 0.45, eyeBlinkRight: 0.42 }),
    });
    expect(mid.eyeState).toBe('CLOSED');

    // Both eyes below open threshold returns to OPEN
    const open = extractor.extract({
      timestampMs: 220,
      faceDetected: true,
      blendshapes: makeBlendshapes({ eyeBlinkLeft: 0.2, eyeBlinkRight: 0.18 }),
    });
    expect(open.eyeState).toBe('OPEN');
  });

  it('classifies LEFT, CENTER, and RIGHT gaze with blendshapes and masks gaze when closed', () => {
    const extractor = new EyeFeatureExtractor({
      gazeMethod: 'blendshape',
      gazeEmaAlpha: 1.0,
      gazeEnterThreshold: 0.35,
      gazeExitThreshold: 0.2,
    });

    const center = extractor.extract({
      timestampMs: 100,
      faceDetected: true,
      blendshapes: makeBlendshapes({
        eyeBlinkLeft: 0.05,
        eyeBlinkRight: 0.05,
        eyeLookOutRight: 0.1,
        eyeLookInLeft: 0.1,
        eyeLookOutLeft: 0.1,
        eyeLookInRight: 0.1,
      }),
    });
    expect(center.gazeDirection).toBe('CENTER');

    const right = extractor.extract({
      timestampMs: 140,
      faceDetected: true,
      blendshapes: makeBlendshapes({
        eyeBlinkLeft: 0.05,
        eyeBlinkRight: 0.05,
        eyeLookOutRight: 0.7,
        eyeLookInLeft: 0.65,
        eyeLookOutLeft: 0.05,
        eyeLookInRight: 0.05,
      }),
    });
    expect(right.gazeDirection).toBe('RIGHT');

    const left = extractor.extract({
      timestampMs: 180,
      faceDetected: true,
      blendshapes: makeBlendshapes({
        eyeBlinkLeft: 0.05,
        eyeBlinkRight: 0.05,
        eyeLookOutRight: 0.05,
        eyeLookInLeft: 0.05,
        eyeLookOutLeft: 0.72,
        eyeLookInRight: 0.68,
      }),
    });
    expect(left.gazeDirection).toBe('LEFT');
  });

  it('computes iris-based horizontal gaze and respects invertGazeDirection', () => {
    const extractor = new EyeFeatureExtractor({
      gazeMethod: 'iris',
      gazeEmaAlpha: 1.0,
      mirrorHorizontal: true,
      invertGazeDirection: false,
      gazeEnterThreshold: 0.35,
    });

    // In non-mirrored webcam frame, iris shifted left (-x) corresponds to user looking RIGHT
    const rightObs = extractor.extract({
      timestampMs: 100,
      faceDetected: true,
      landmarks: makeSyntheticLandmarks(-0.02),
      blendshapes: makeBlendshapes({ eyeBlinkLeft: 0.05, eyeBlinkRight: 0.05 }),
    });
    expect(rightObs.gazeDirection).toBe('RIGHT');
    expect(rightObs.earLeft).toBeGreaterThan(0.25);

    extractor.updateConfig({ invertGazeDirection: true });
    const invertedObs = extractor.extract({
      timestampMs: 140,
      faceDetected: true,
      landmarks: makeSyntheticLandmarks(-0.02),
      blendshapes: makeBlendshapes({ eyeBlinkLeft: 0.05, eyeBlinkRight: 0.05 }),
    });
    expect(invertedObs.gazeDirection).toBe('LEFT');
  });

  it('returns UNKNOWN gaze and faceDetected=false when no face is present', () => {
    const extractor = new EyeFeatureExtractor();
    const obs = extractor.extract({ timestampMs: 100, faceDetected: false });
    expect(obs.faceDetected).toBe(false);
    expect(obs.eyeState).toBe('OPEN');
    expect(obs.gazeDirection).toBe('UNKNOWN');
    expect(obs.headYawDeg).toBeNull();
    expect(obs.gazeSuppressedByHeadTurn).toBe(false);
  });

  it('suppresses false LEFT/RIGHT gaze when head yaw exceeds headYawMaxDeg', () => {
    const extractor = new EyeFeatureExtractor({
      gazeMethod: 'blendshape',
      gazeEmaAlpha: 1.0,
      headYawGateEnabled: true,
      headYawMaxDeg: 22,
    });

    const makeYawMatrixColMajor = (deg: number): number[] => {
      const rad = (deg * Math.PI) / 180;
      const c = Math.cos(rad);
      const s = Math.sin(rad);
      // Column-major 4x4 Y-rotation matrix (OpenGL / MediaPipe face_geometry layout)
      return [
        c, 0, -s, 0,
        0, 1, 0, 0,
        s, 0, c, 0,
        0, 0, -50, 1,
      ];
    };

    // 32-degree head turn with strong rightward blendshape artifact -> must be suppressed
    const turned = extractor.extract({
      timestampMs: 100,
      faceDetected: true,
      facialTransformationMatrix: makeYawMatrixColMajor(32),
      blendshapes: makeBlendshapes({
        eyeBlinkLeft: 0.05,
        eyeBlinkRight: 0.05,
        eyeLookOutRight: 0.75,
        eyeLookInLeft: 0.75,
        eyeLookOutLeft: 0.05,
        eyeLookInRight: 0.05,
      }),
    });
    expect(turned.headYawDeg).toBeCloseTo(32, 0);
    expect(turned.gazeSuppressedByHeadTurn).toBe(true);
    expect(turned.gazeDirection).toBe('UNKNOWN');

    // Frontal/small 8-degree head yaw -> true eye gaze must still classify RIGHT
    const frontal = extractor.extract({
      timestampMs: 140,
      faceDetected: true,
      facialTransformationMatrix: makeYawMatrixColMajor(8),
      blendshapes: makeBlendshapes({
        eyeBlinkLeft: 0.05,
        eyeBlinkRight: 0.05,
        eyeLookOutRight: 0.75,
        eyeLookInLeft: 0.75,
        eyeLookOutLeft: 0.05,
        eyeLookInRight: 0.05,
      }),
    });
    expect(frontal.headYawDeg).toBeCloseTo(8, 0);
    expect(frontal.gazeSuppressedByHeadTurn).toBe(false);
    expect(frontal.gazeDirection).toBe('RIGHT');
  });

  it('estimates head yaw from landmarks fallback when transformation matrix is absent', () => {
    const extractor = new EyeFeatureExtractor({
      gazeMethod: 'blendshape',
      gazeEmaAlpha: 1.0,
      headYawGateEnabled: true,
      headYawMaxDeg: 20,
    });

    const lm = makeSyntheticLandmarks(0);
    lm[234] = { x: 0.2, y: 0.5 };
    lm[454] = { x: 0.8, y: 0.5 };
    lm[1] = { x: 0.7, y: 0.5 }; // strongly shifted nose -> ~(0.833 - 0.5) * 90 = 30 deg

    const obs = extractor.extract({
      timestampMs: 100,
      faceDetected: true,
      landmarks: lm,
      blendshapes: makeBlendshapes({
        eyeBlinkLeft: 0.05,
        eyeBlinkRight: 0.05,
        eyeLookOutRight: 0.8,
        eyeLookInLeft: 0.8,
        eyeLookOutLeft: 0.0,
        eyeLookInRight: 0.0,
      }),
    });

    expect(obs.headYawDeg).not.toBeNull();
    expect(Math.abs(obs.headYawDeg ?? 0)).toBeGreaterThan(20);
    expect(obs.gazeSuppressedByHeadTurn).toBe(true);
    expect(obs.gazeDirection).toBe('UNKNOWN');
  });
});

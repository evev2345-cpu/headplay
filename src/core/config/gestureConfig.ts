export type GazeMethod = 'blendshape' | 'iris' | 'hybrid';
export type CaptureMode = 'track_processor' | 'timer_fallback';
export type DelegatePreference = 'GPU' | 'CPU';
export type CameraCaptureResolution = '320x240' | '640x480' | 'default';

export interface GestureConfig {
  // Blink detection thresholds (0..1 MediaPipe eyeBlink score)
  blinkCloseThreshold: number;
  blinkOpenThreshold: number;

  // Blink duration thresholds (ms)
  minBlinkMs: number;
  maxShortBlinkMs: number;
  longBlinkMinMs: number;
  longBlinkMaxMs: number;

  // Double blink timing window (ms)
  doubleBlinkGapMinMs: number;
  doubleBlinkGapMaxMs: number;

  // Gaze classification thresholds (normalized -1..+1)
  gazeMethod: GazeMethod;
  gazeEnterThreshold: number;
  gazeExitThreshold: number;
  gazeEmaAlpha: number;
  gazeSettleMs: number;
  gazeHoldMs: number;
  gazeWindowMs: number;
  headYawGateEnabled: boolean;
  headYawMaxDeg: number;

  // Safety, cooldown, and throttling guards (ms)
  cooldownMs: number;
  faceLostResetMs: number;
  maxFrameGapMs: number;
  stallThresholdMs: number;

  // Coordinate / camera orientation
  mirrorHorizontal: boolean;
  invertGazeDirection: boolean;

  // Runtime pipeline preferences (Phase 1 verification toggles)
  captureMode: CaptureMode;
  delegatePreference: DelegatePreference;
  targetFps: number;
  cameraCaptureResolution: CameraCaptureResolution;
  inputMaxWidth: number;
  directVideoFrameGpu: boolean;
  diagnosticBypassInference: boolean;
}

export const DEFAULT_GESTURE_CONFIG: Readonly<GestureConfig> = Object.freeze({
  blinkCloseThreshold: 0.55,
  blinkOpenThreshold: 0.35,

  minBlinkMs: 60,
  maxShortBlinkMs: 350,
  longBlinkMinMs: 480,
  longBlinkMaxMs: 1500,

  doubleBlinkGapMinMs: 40,
  doubleBlinkGapMaxMs: 450,

  gazeMethod: 'hybrid',
  gazeEnterThreshold: 0.35,
  gazeExitThreshold: 0.2,
  gazeEmaAlpha: 0.4,
  gazeSettleMs: 100,
  gazeHoldMs: 280,
  gazeWindowMs: 1500,
  headYawGateEnabled: true,
  headYawMaxDeg: 22,

  cooldownMs: 1000,
  faceLostResetMs: 300,
  maxFrameGapMs: 250,
  stallThresholdMs: 1000,

  mirrorHorizontal: true,
  invertGazeDirection: false,

  captureMode: 'track_processor',
  delegatePreference: 'GPU',
  targetFps: 30,
  cameraCaptureResolution: '320x240',
  inputMaxWidth: 320,
  directVideoFrameGpu: true,
  diagnosticBypassInference: false,
});

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Validates and clamps partial user configuration while preserving structural invariants
 * (hysteresis gaps and guard bands).
 */
export function sanitizeGestureConfig(partial?: Partial<GestureConfig>): GestureConfig {
  const input = partial ?? {};
  const d = DEFAULT_GESTURE_CONFIG;

  const blinkCloseThreshold = clamp(finiteOr(input.blinkCloseThreshold, d.blinkCloseThreshold), 0.2, 0.95);
  const blinkOpenThreshold = clamp(
    finiteOr(input.blinkOpenThreshold, d.blinkOpenThreshold),
    0.05,
    Math.max(0.05, blinkCloseThreshold - 0.05),
  );

  const minBlinkMs = clamp(finiteOr(input.minBlinkMs, d.minBlinkMs), 20, 200);
  const maxShortBlinkMs = clamp(finiteOr(input.maxShortBlinkMs, d.maxShortBlinkMs), minBlinkMs + 40, 600);
  const longBlinkMinMs = clamp(
    finiteOr(input.longBlinkMinMs, d.longBlinkMinMs),
    maxShortBlinkMs + 40,
    1200,
  );
  const longBlinkMaxMs = clamp(
    finiteOr(input.longBlinkMaxMs, d.longBlinkMaxMs),
    longBlinkMinMs + 200,
    4000,
  );

  const doubleBlinkGapMinMs = clamp(finiteOr(input.doubleBlinkGapMinMs, d.doubleBlinkGapMinMs), 10, 200);
  const doubleBlinkGapMaxMs = clamp(
    finiteOr(input.doubleBlinkGapMaxMs, d.doubleBlinkGapMaxMs),
    doubleBlinkGapMinMs + 80,
    1200,
  );

  const gazeEnterThreshold = clamp(finiteOr(input.gazeEnterThreshold, d.gazeEnterThreshold), 0.1, 0.9);
  const gazeExitThreshold = clamp(
    finiteOr(input.gazeExitThreshold, d.gazeExitThreshold),
    0.05,
    Math.max(0.05, gazeEnterThreshold - 0.05),
  );
  const gazeEmaAlpha = clamp(finiteOr(input.gazeEmaAlpha, d.gazeEmaAlpha), 0.05, 1.0);
  const gazeSettleMs = clamp(finiteOr(input.gazeSettleMs, d.gazeSettleMs), 0, 500);
  const gazeHoldMs = clamp(finiteOr(input.gazeHoldMs, d.gazeHoldMs), 80, 1500);
  const gazeWindowMs = clamp(
    finiteOr(input.gazeWindowMs, d.gazeWindowMs),
    gazeSettleMs + gazeHoldMs + 100,
    5000,
  );
  const headYawMaxDeg = clamp(finiteOr(input.headYawMaxDeg, d.headYawMaxDeg), 8, 45);

  const cooldownMs = clamp(finiteOr(input.cooldownMs, d.cooldownMs), 200, 5000);
  const faceLostResetMs = clamp(finiteOr(input.faceLostResetMs, d.faceLostResetMs), 50, 2000);
  const maxFrameGapMs = clamp(finiteOr(input.maxFrameGapMs, d.maxFrameGapMs), 80, 2000);
  const stallThresholdMs = clamp(
    finiteOr(input.stallThresholdMs, d.stallThresholdMs),
    Math.max(400, maxFrameGapMs * 2),
    10000,
  );

  const gazeMethod: GazeMethod =
    input.gazeMethod === 'blendshape' || input.gazeMethod === 'iris' || input.gazeMethod === 'hybrid'
      ? input.gazeMethod
      : d.gazeMethod;

  const captureMode: CaptureMode =
    input.captureMode === 'track_processor' || input.captureMode === 'timer_fallback'
      ? input.captureMode
      : d.captureMode;

  const delegatePreference: DelegatePreference =
    input.delegatePreference === 'GPU' || input.delegatePreference === 'CPU'
      ? input.delegatePreference
      : d.delegatePreference;

  const cameraCaptureResolution: CameraCaptureResolution =
    input.cameraCaptureResolution === '320x240' ||
    input.cameraCaptureResolution === '640x480' ||
    input.cameraCaptureResolution === 'default'
      ? input.cameraCaptureResolution
      : d.cameraCaptureResolution;

  const targetFps = clamp(finiteOr(input.targetFps, d.targetFps), 10, 30);
  const inputMaxWidth = Math.round(clamp(finiteOr(input.inputMaxWidth, d.inputMaxWidth), 160, 640));

  return {
    blinkCloseThreshold,
    blinkOpenThreshold,
    minBlinkMs,
    maxShortBlinkMs,
    longBlinkMinMs,
    longBlinkMaxMs,
    doubleBlinkGapMinMs,
    doubleBlinkGapMaxMs,
    gazeMethod,
    gazeEnterThreshold,
    gazeExitThreshold,
    gazeEmaAlpha,
    gazeSettleMs,
    gazeHoldMs,
    gazeWindowMs,
    headYawGateEnabled:
      typeof input.headYawGateEnabled === 'boolean' ? input.headYawGateEnabled : d.headYawGateEnabled,
    headYawMaxDeg,
    cooldownMs,
    faceLostResetMs,
    maxFrameGapMs,
    stallThresholdMs,
    mirrorHorizontal: typeof input.mirrorHorizontal === 'boolean' ? input.mirrorHorizontal : d.mirrorHorizontal,
    invertGazeDirection:
      typeof input.invertGazeDirection === 'boolean' ? input.invertGazeDirection : d.invertGazeDirection,
    captureMode,
    delegatePreference,
    targetFps,
    cameraCaptureResolution,
    inputMaxWidth,
    directVideoFrameGpu:
      typeof input.directVideoFrameGpu === 'boolean' ? input.directVideoFrameGpu : d.directVideoFrameGpu,
    diagnosticBypassInference:
      typeof input.diagnosticBypassInference === 'boolean'
        ? input.diagnosticBypassInference
        : d.diagnosticBypassInference,
  };
}

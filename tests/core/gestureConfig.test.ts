import { describe, expect, it } from 'vitest';
import { DEFAULT_GESTURE_CONFIG, sanitizeGestureConfig } from '../../src/core/config/gestureConfig';

describe('GestureConfig', () => {
  it('returns default config when no overrides are given', () => {
    const cfg = sanitizeGestureConfig();
    expect(cfg).toEqual(DEFAULT_GESTURE_CONFIG);
  });

  it('enforces hysteresis and guard-band invariants on invalid overrides', () => {
    const cfg = sanitizeGestureConfig({
      blinkCloseThreshold: 0.4,
      blinkOpenThreshold: 0.8, // invalid: >= close
      minBlinkMs: 100,
      maxShortBlinkMs: 80, // invalid: <= min
      longBlinkMinMs: 90, // invalid: <= maxShort
      longBlinkMaxMs: 100, // invalid: <= longMin
      gazeEnterThreshold: 0.25,
      gazeExitThreshold: 0.4, // invalid: >= enter
      gazeEmaAlpha: 2.5,
      targetFps: 120,
    });

    expect(cfg.blinkOpenThreshold).toBeLessThan(cfg.blinkCloseThreshold);
    expect(cfg.maxShortBlinkMs).toBeGreaterThan(cfg.minBlinkMs);
    expect(cfg.longBlinkMinMs).toBeGreaterThan(cfg.maxShortBlinkMs);
    expect(cfg.longBlinkMaxMs).toBeGreaterThan(cfg.longBlinkMinMs);
    expect(cfg.gazeExitThreshold).toBeLessThan(cfg.gazeEnterThreshold);
    expect(cfg.gazeEmaAlpha).toBeLessThanOrEqual(1);
    expect(cfg.targetFps).toBeLessThanOrEqual(30);
  });

  it('falls back to defaults for NaN or invalid enum values', () => {
    const cfg = sanitizeGestureConfig({
      blinkCloseThreshold: Number.NaN,
      gazeMethod: 'invalid' as never,
      captureMode: 'invalid' as never,
      delegatePreference: 'TPU' as never,
    });

    expect(cfg.blinkCloseThreshold).toBe(DEFAULT_GESTURE_CONFIG.blinkCloseThreshold);
    expect(cfg.gazeMethod).toBe(DEFAULT_GESTURE_CONFIG.gazeMethod);
    expect(cfg.captureMode).toBe(DEFAULT_GESTURE_CONFIG.captureMode);
    expect(cfg.delegatePreference).toBe(DEFAULT_GESTURE_CONFIG.delegatePreference);
  });
});

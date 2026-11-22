import { describe, expect, it } from 'vitest';
import { computeScaledDimensions, LatestFrameSlot } from '../../src/core/vision/frameScheduler';

interface FakeFrame {
  id: number;
  closed: boolean;
  close(): void;
}

function makeFakeFrame(id: number): FakeFrame {
  return {
    id,
    closed: false,
    close() {
      this.closed = true;
    },
  };
}

describe('LatestFrameSlot & computeScaledDimensions', () => {
  it('always keeps the newest frame and immediately closes superseded older frames', () => {
    const slot = new LatestFrameSlot<FakeFrame>(30);
    const f1 = makeFakeFrame(1);
    const f2 = makeFakeFrame(2);
    const f3 = makeFakeFrame(3);

    expect(slot.push(f1, 0)).toBe(false);
    expect(slot.push(f2, 33)).toBe(true);
    expect(f1.closed).toBe(true);
    expect(f2.closed).toBe(false);

    expect(slot.push(f3, 66)).toBe(true);
    expect(f2.closed).toBe(true);
    expect(f3.closed).toBe(false);

    const taken = slot.takeIfReady(70);
    expect(taken.droppedByRateLimit).toBe(false);
    expect(taken.item?.frame.id).toBe(3);
    expect(taken.item?.arrivalMs).toBe(66);
    expect(slot.hasPending()).toBe(false);
  });

  it('never clips native 30fps (~33.3ms) frames when targetFps is 30', () => {
    const slot = new LatestFrameSlot<FakeFrame>(30);
    let accepted = 0;
    for (let i = 0; i < 30; i++) {
      const t = i * 33.33;
      slot.push(makeFakeFrame(i), t);
      const { item, droppedByRateLimit } = slot.takeIfReady(t + 1);
      expect(droppedByRateLimit).toBe(false);
      if (item) {
        accepted += 1;
        item.frame.close();
      }
    }
    expect(accepted).toBe(30);
  });

  it('rate-limits cleanly when targetFps is below 30 without clipping steady cadence', () => {
    const slot = new LatestFrameSlot<FakeFrame>(15); // 66.7ms interval, tolerance -> 62.7ms
    const f1 = makeFakeFrame(1);
    const f2 = makeFakeFrame(2);
    const f3 = makeFakeFrame(3);

    slot.push(f1, 0);
    expect(slot.takeIfReady(0).item?.frame.id).toBe(1);

    // 33ms later: dropped by rate limit and closed immediately
    slot.push(f2, 33);
    const r2 = slot.takeIfReady(33);
    expect(r2.droppedByRateLimit).toBe(true);
    expect(r2.item).toBeNull();
    expect(f2.closed).toBe(true);

    // 66ms later: accepted
    slot.push(f3, 66);
    expect(slot.takeIfReady(66).item?.frame.id).toBe(3);
  });

  it('computes aspect-preserving even dimensions capped at maxWidth', () => {
    expect(computeScaledDimensions(320, 240, 320)).toEqual({
      width: 320,
      height: 240,
      needsDownscale: false,
    });
    expect(computeScaledDimensions(1280, 720, 320)).toEqual({
      width: 320,
      height: 180,
      needsDownscale: true,
    });
    expect(computeScaledDimensions(640, 480, 256)).toEqual({
      width: 256,
      height: 192,
      needsDownscale: true,
    });
  });
});

export interface ClosableFrame {
  close(): void;
}

export interface PendingFrameItem<T extends ClosableFrame> {
  frame: T;
  arrivalMs: number;
}

/**
 * Pure latest-frame-wins single-slot buffer.
 * Ensures incoming frames never queue behind slow inference: older unread frames are immediately
 * closed and counted as dropped so downstream inference always sees the freshest webcam frame.
 */
export class LatestFrameSlot<T extends ClosableFrame> {
  private pending: PendingFrameItem<T> | null = null;
  private lastAcceptedMs: number | null = null;
  private targetFps: number;

  constructor(targetFps = 30) {
    this.targetFps = targetFps;
  }

  setTargetFps(targetFps: number): void {
    this.targetFps = Math.max(5, Math.min(30, targetFps));
  }

  /**
   * Stores the newest frame. If a previous frame was still waiting, closes it immediately
   * and returns true (dropped = true).
   */
  push(frame: T, arrivalMs: number): boolean {
    let droppedPrevious = false;
    if (this.pending) {
      this.pending.frame.close();
      droppedPrevious = true;
    }
    this.pending = { frame, arrivalMs };
    return droppedPrevious;
  }

  hasPending(): boolean {
    return this.pending !== null;
  }

  /**
   * Pops the latest frame if ready under targetFps rate-limiting.
   * When targetFps >= 30, no artificial software gate is applied so native 30fps webcams
   * (~33.3ms intervals) are never clipped in half.
   */
  takeIfReady(nowMs: number): { item: PendingFrameItem<T> | null; droppedByRateLimit: boolean } {
    if (!this.pending) {
      return { item: null, droppedByRateLimit: false };
    }

    if (this.targetFps < 30 && this.lastAcceptedMs !== null) {
      const minIntervalMs = 1000 / this.targetFps;
      // Use a small 4ms tolerance so slight camera jitter near targetFps does not drop alternating frames.
      if (nowMs - this.lastAcceptedMs < Math.max(0, minIntervalMs - 4)) {
        this.pending.frame.close();
        this.pending = null;
        return { item: null, droppedByRateLimit: true };
      }
    }

    const item = this.pending;
    this.pending = null;
    this.lastAcceptedMs = nowMs;
    return { item, droppedByRateLimit: false };
  }

  clear(): void {
    if (this.pending) {
      this.pending.frame.close();
      this.pending = null;
    }
    this.lastAcceptedMs = null;
  }
}

/**
 * Computes aspect-ratio-preserving scaled dimensions capped at maxWidth (even integers).
 */
export function computeScaledDimensions(
  srcWidth: number,
  srcHeight: number,
  maxWidth: number,
): { width: number; height: number; needsDownscale: boolean } {
  const safeSrcW = Math.max(1, Math.round(srcWidth));
  const safeSrcH = Math.max(1, Math.round(srcHeight));
  const safeMaxW = Math.max(64, Math.round(maxWidth));

  if (safeSrcW <= safeMaxW) {
    return { width: safeSrcW, height: safeSrcH, needsDownscale: false };
  }

  const scale = safeMaxW / safeSrcW;
  const width = Math.max(2, Math.round(safeMaxW / 2) * 2);
  const height = Math.max(2, Math.round((safeSrcH * scale) / 2) * 2);
  return { width, height, needsDownscale: true };
}

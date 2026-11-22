import { GestureConfig, sanitizeGestureConfig } from '../config/gestureConfig';
import { EyeObservation, GazeDirection } from '../vision/types';

export type GestureFsmState =
  | 'IDLE'
  | 'EYE_CLOSED_1'
  | 'WAIT_SECOND_BLINK'
  | 'EYE_CLOSED_2'
  | 'ARMED_GAZE'
  | 'COOLDOWN';

export type GestureCommand = 'TOGGLE_PLAY_PAUSE' | 'NEXT_VIDEO' | 'PREV_VIDEO';

export type BlinkClassification = 'NOISE' | 'SHORT' | 'GUARD_BAND' | 'LONG' | 'TOO_LONG';

export type GestureEvent =
  | {
      type: 'STATE_TRANSITION';
      timestampMs: number;
      from: GestureFsmState;
      to: GestureFsmState;
      reason: string;
      durationMs?: number;
    }
  | {
      type: 'BLINK_MEASURED';
      timestampMs: number;
      durationMs: number;
      closedDurationMs: number;
      openGapMs: number | null;
      frameCount: number;
      maxDtDuringCloseMs: number;
      minBlinkAvgDuringClose: number;
      peakBlinkAvgDuringClose: number;
      suspectedMissedOpenValley: boolean;
      classification: BlinkClassification;
      blinkIndex: 1 | 2;
    }
  | {
      type: 'DOUBLE_BLINK_DETECTED';
      timestampMs: number;
      blink1Ms: number;
      gapMs: number;
      blink2Ms: number;
    }
  | {
      type: 'GESTURE_COMMAND';
      timestampMs: number;
      command: GestureCommand;
      details: Record<string, number | string>;
    }
  | {
      type: 'FRAME_GAP_WARNING';
      timestampMs: number;
      gapMs: number;
      resetFromState: GestureFsmState;
    };

export interface GestureStateSnapshot {
  state: GestureFsmState;
  currentClosedDurationMs: number | null;
  armedRemainingMs: number | null;
  gazeHoldDirection: 'LEFT' | 'RIGHT' | null;
  gazeHoldDurationMs: number;
  awaitingOpenAfterLongClose: boolean;
}

export interface GestureUpdateResult {
  state: GestureFsmState;
  events: GestureEvent[];
  snapshot: GestureStateSnapshot;
}

interface ActiveClosureTelemetry {
  openGapMs: number | null;
  frameCount: number;
  maxDtDuringCloseMs: number;
  peakBlinkAvg: number;
  minBlinkAvg: number;
  preValleyPeak: number;
  valleyMin: number;
  suspectedMissedOpenValley: boolean;
}

/**
 * Deterministic time-based Finite State Machine for HEADPLAY eye gestures.
 * All time progression relies strictly on observation.timestampMs for testability.
 */
export class GestureStateMachine {
  private config: GestureConfig;
  private state: GestureFsmState = 'IDLE';

  private lastTimestampMs: number | null = null;
  private lastFrameDtMs = 0;
  private faceLostSinceMs: number | null = null;

  private close1StartMs: number | null = null;
  private blink1DurationMs: number | null = null;
  private open1StartMs: number | null = null;
  private close2StartMs: number | null = null;
  private blinkGapMs: number | null = null;
  private lastBlinkEndedMs: number | null = null;
  private activeClosure: ActiveClosureTelemetry | null = null;

  private armedStartMs: number | null = null;
  private gazeHoldDir: 'LEFT' | 'RIGHT' | null = null;
  private gazeHoldStartMs: number | null = null;

  private cooldownStartMs: number | null = null;

  // Prevents immediate re-entry into EYE_CLOSED_1 after a >longBlinkMaxMs rest/sleep timeout
  // while the user's eyes remain closed.
  private awaitingOpenAfterLongClose = false;

  constructor(config?: Partial<GestureConfig>) {
    this.config = sanitizeGestureConfig(config);
  }

  updateConfig(config: Partial<GestureConfig>): void {
    this.config = sanitizeGestureConfig({ ...this.config, ...config });
  }

  getState(): GestureFsmState {
    return this.state;
  }

  reset(): void {
    this.state = 'IDLE';
    this.lastTimestampMs = null;
    this.lastFrameDtMs = 0;
    this.faceLostSinceMs = null;
    this.lastBlinkEndedMs = null;
    this.clearTimingState();
    this.awaitingOpenAfterLongClose = false;
  }

  private clearTimingState(): void {
    this.close1StartMs = null;
    this.blink1DurationMs = null;
    this.open1StartMs = null;
    this.close2StartMs = null;
    this.blinkGapMs = null;
    this.activeClosure = null;
    this.armedStartMs = null;
    this.gazeHoldDir = null;
    this.gazeHoldStartMs = null;
    this.cooldownStartMs = null;
  }

  private beginClosureTelemetry(obs: EyeObservation): void {
    const blinkAvg = (obs.blinkLeft + obs.blinkRight) / 2;
    const openGapMs =
      this.lastBlinkEndedMs !== null ? Math.max(0, obs.timestampMs - this.lastBlinkEndedMs) : null;
    this.activeClosure = {
      openGapMs,
      frameCount: 1,
      maxDtDuringCloseMs: this.lastFrameDtMs,
      peakBlinkAvg: blinkAvg,
      minBlinkAvg: blinkAvg,
      preValleyPeak: blinkAvg,
      valleyMin: blinkAvg,
      suspectedMissedOpenValley: false,
    };
  }

  private updateClosureTelemetry(obs: EyeObservation): void {
    if (!this.activeClosure) {
      this.beginClosureTelemetry(obs);
      return;
    }
    const c = this.activeClosure;
    const blinkAvg = (obs.blinkLeft + obs.blinkRight) / 2;
    c.frameCount += 1;
    if (this.lastFrameDtMs > c.maxDtDuringCloseMs) {
      c.maxDtDuringCloseMs = this.lastFrameDtMs;
    }
    if (blinkAvg > c.peakBlinkAvg) c.peakBlinkAvg = blinkAvg;
    if (blinkAvg < c.minBlinkAvg) c.minBlinkAvg = blinkAvg;

    // Detect W-shaped valley (peak -> drop >= 0.18 -> rise >= 0.14) inside a single CLOSED interval,
    // indicating a likely missed OPEN dip between two rapid short blinks.
    if (!c.suspectedMissedOpenValley) {
      if (blinkAvg > c.preValleyPeak && c.preValleyPeak - c.valleyMin < 0.18) {
        c.preValleyPeak = blinkAvg;
        c.valleyMin = blinkAvg;
      } else if (blinkAvg < c.valleyMin) {
        c.valleyMin = blinkAvg;
      } else if (c.preValleyPeak - c.valleyMin >= 0.18 && blinkAvg - c.valleyMin >= 0.14) {
        c.suspectedMissedOpenValley = true;
      }
    }
  }

  private makeBlinkMeasuredEvent(
    timestampMs: number,
    durationMs: number,
    classification: BlinkClassification,
    blinkIndex: 1 | 2,
  ): Extract<GestureEvent, { type: 'BLINK_MEASURED' }> {
    const c = this.activeClosure;
    return {
      type: 'BLINK_MEASURED',
      timestampMs,
      durationMs,
      closedDurationMs: durationMs,
      openGapMs: c ? c.openGapMs : null,
      frameCount: c ? c.frameCount : 1,
      maxDtDuringCloseMs: Math.round(
        Math.max(c ? c.maxDtDuringCloseMs : 0, this.lastFrameDtMs),
      ),
      minBlinkAvgDuringClose: c ? Math.round(c.minBlinkAvg * 1000) / 1000 : 0,
      peakBlinkAvgDuringClose: c ? Math.round(c.peakBlinkAvg * 1000) / 1000 : 0,
      suspectedMissedOpenValley: c ? c.suspectedMissedOpenValley : false,
      classification,
      blinkIndex,
    };
  }

  update(obs: EyeObservation): GestureUpdateResult {
    const events: GestureEvent[] = [];
    const now = obs.timestampMs;

    // Reject non-monotonic timestamps safely.
    if (this.lastTimestampMs !== null && now < this.lastTimestampMs) {
      return { state: this.state, events, snapshot: this.buildSnapshot(now) };
    }

    // Frame gap guard: if background throttling or camera stall causes a large gap,
    // blink durations can be inflated into false long-blinks. Reset any in-progress sequence.
    if (this.lastTimestampMs !== null) {
      const dt = now - this.lastTimestampMs;
      this.lastFrameDtMs = dt;
      if (dt > this.config.maxFrameGapMs) {
        const prevState = this.state;
        events.push({
          type: 'FRAME_GAP_WARNING',
          timestampMs: now,
          gapMs: dt,
          resetFromState: prevState,
        });
        if (this.state !== 'IDLE' && this.state !== 'COOLDOWN') {
          this.transition('IDLE', now, `frame_gap_exceeded:${Math.round(dt)}ms`, events);
          this.clearTimingState();
          if (obs.eyeState === 'CLOSED') {
            this.awaitingOpenAfterLongClose = true;
          }
        }
        this.lastTimestampMs = now;
        return { state: this.state, events, snapshot: this.buildSnapshot(now) };
      }
    } else {
      this.lastFrameDtMs = 0;
    }
    this.lastTimestampMs = now;

    // Face lost guard
    if (!obs.faceDetected) {
      if (this.faceLostSinceMs === null) {
        this.faceLostSinceMs = now;
      }
      if (now - this.faceLostSinceMs >= this.config.faceLostResetMs) {
        if (this.state !== 'IDLE') {
          this.transition('IDLE', now, 'face_lost_timeout', events);
          this.clearTimingState();
        }
        this.awaitingOpenAfterLongClose = false;
      }
      return { state: this.state, events, snapshot: this.buildSnapshot(now) };
    }
    this.faceLostSinceMs = null;

    // Clear long-close lockout once eyes reopen
    if (this.awaitingOpenAfterLongClose) {
      if (obs.eyeState === 'OPEN') {
        this.awaitingOpenAfterLongClose = false;
        this.lastBlinkEndedMs = now;
      } else {
        return { state: this.state, events, snapshot: this.buildSnapshot(now) };
      }
    }

    switch (this.state) {
      case 'IDLE':
        this.handleIdle(obs, events);
        break;
      case 'EYE_CLOSED_1':
        this.handleEyeClosed1(obs, events);
        break;
      case 'WAIT_SECOND_BLINK':
        this.handleWaitSecondBlink(obs, events);
        break;
      case 'EYE_CLOSED_2':
        this.handleEyeClosed2(obs, events);
        break;
      case 'ARMED_GAZE':
        this.handleArmedGaze(obs, events);
        break;
      case 'COOLDOWN':
        this.handleCooldown(obs, events);
        break;
    }

    return {
      state: this.state,
      events,
      snapshot: this.buildSnapshot(now),
    };
  }

  private handleIdle(obs: EyeObservation, events: GestureEvent[]): void {
    if (obs.eyeState === 'CLOSED') {
      this.close1StartMs = obs.timestampMs;
      this.beginClosureTelemetry(obs);
      this.transition('EYE_CLOSED_1', obs.timestampMs, 'eyes_closed', events);
    }
  }

  private handleEyeClosed1(obs: EyeObservation, events: GestureEvent[]): void {
    const now = obs.timestampMs;
    const start = this.close1StartMs ?? now;
    const duration = now - start;

    // Exceeded maximum long-blink duration while still closed (resting/sleeping eyes).
    if (obs.eyeState === 'CLOSED') {
      this.updateClosureTelemetry(obs);
      if (duration > this.config.longBlinkMaxMs) {
        events.push(this.makeBlinkMeasuredEvent(now, duration, 'TOO_LONG', 1));
        this.awaitingOpenAfterLongClose = true;
        this.clearTimingState();
        this.transition('IDLE', now, 'long_close_exceeded_max', events, duration);
      }
      return;
    }

    // Eyes opened: classify duration
    const classification = this.classifyBlinkDuration(duration);
    const measured = this.makeBlinkMeasuredEvent(now, duration, classification, 1);
    events.push(measured);
    this.lastBlinkEndedMs = now;

    switch (classification) {
      case 'NOISE':
        this.clearTimingState();
        this.transition('IDLE', now, 'blink1_too_short_noise', events, duration);
        break;
      case 'SHORT':
        this.blink1DurationMs = duration;
        this.open1StartMs = now;
        this.activeClosure = null;
        this.transition('WAIT_SECOND_BLINK', now, 'short_blink1_detected', events, duration);
        break;
      case 'GUARD_BAND':
        this.clearTimingState();
        this.transition('IDLE', now, 'blink1_in_guard_band', events, duration);
        break;
      case 'LONG':
        events.push({
          type: 'GESTURE_COMMAND',
          timestampMs: now,
          command: 'TOGGLE_PLAY_PAUSE',
          details: {
            durationMs: Math.round(duration),
            closedDurationMs: Math.round(duration),
            frameCount: measured.frameCount,
            maxDtDuringCloseMs: measured.maxDtDuringCloseMs,
            suspectedMissedOpenValley: measured.suspectedMissedOpenValley ? 'true' : 'false',
          },
        });
        this.clearTimingState();
        this.cooldownStartMs = now;
        this.transition('COOLDOWN', now, 'long_blink_play_pause', events, duration);
        break;
      case 'TOO_LONG':
        this.clearTimingState();
        this.transition('IDLE', now, 'blink1_too_long_ignored', events, duration);
        break;
    }
  }

  private handleWaitSecondBlink(obs: EyeObservation, events: GestureEvent[]): void {
    const now = obs.timestampMs;
    const openStart = this.open1StartMs ?? now;
    const gap = now - openStart;

    if (gap > this.config.doubleBlinkGapMaxMs) {
      this.clearTimingState();
      this.transition('IDLE', now, 'single_blink_timeout', events, gap);
      return;
    }

    if (obs.eyeState === 'CLOSED' && gap >= this.config.doubleBlinkGapMinMs) {
      this.blinkGapMs = gap;
      this.close2StartMs = now;
      this.beginClosureTelemetry(obs);
      this.transition('EYE_CLOSED_2', now, 'second_blink_started', events, gap);
    }
  }

  private handleEyeClosed2(obs: EyeObservation, events: GestureEvent[]): void {
    const now = obs.timestampMs;
    const start = this.close2StartMs ?? now;
    const duration = now - start;

    if (obs.eyeState === 'CLOSED') {
      this.updateClosureTelemetry(obs);
      if (duration > this.config.maxShortBlinkMs) {
        events.push(
          this.makeBlinkMeasuredEvent(
            now,
            duration,
            duration > this.config.longBlinkMaxMs ? 'TOO_LONG' : 'GUARD_BAND',
            2,
          ),
        );
        this.awaitingOpenAfterLongClose = true;
        this.clearTimingState();
        this.transition('IDLE', now, 'blink2_exceeded_short_max', events, duration);
      }
      return;
    }

    const classification = this.classifyBlinkDuration(duration);
    events.push(this.makeBlinkMeasuredEvent(now, duration, classification, 2));
    this.lastBlinkEndedMs = now;

    if (classification === 'SHORT') {
      const blink1Ms = this.blink1DurationMs ?? 0;
      const gapMs = this.blinkGapMs ?? 0;
      events.push({
        type: 'DOUBLE_BLINK_DETECTED',
        timestampMs: now,
        blink1Ms,
        gapMs,
        blink2Ms: duration,
      });
      this.armedStartMs = now;
      this.activeClosure = null;
      this.gazeHoldDir = null;
      this.gazeHoldStartMs = null;
      this.transition('ARMED_GAZE', now, 'double_blink_confirmed', events, duration);
    } else {
      this.clearTimingState();
      this.transition('IDLE', now, `blink2_invalid:${classification}`, events, duration);
    }
  }

  private handleArmedGaze(obs: EyeObservation, events: GestureEvent[]): void {
    const now = obs.timestampMs;
    const armedStart = this.armedStartMs ?? now;
    const elapsed = now - armedStart;

    if (elapsed > this.config.gazeWindowMs) {
      this.clearTimingState();
      this.transition('IDLE', now, 'gaze_window_timeout', events, elapsed);
      return;
    }

    // Re-closing eyes cancels armed gaze safely to avoid confusing subsequent blinks.
    if (obs.eyeState === 'CLOSED') {
      this.clearTimingState();
      this.awaitingOpenAfterLongClose = true;
      this.transition('IDLE', now, 'armed_gaze_cancelled_by_blink', events, elapsed);
      return;
    }

    // Settle window right after eyelids open.
    if (elapsed < this.config.gazeSettleMs) {
      this.gazeHoldDir = null;
      this.gazeHoldStartMs = null;
      return;
    }

    const dir: GazeDirection = obs.gazeDirection;
    if (dir === 'LEFT' || dir === 'RIGHT') {
      if (this.gazeHoldDir !== dir) {
        this.gazeHoldDir = dir;
        this.gazeHoldStartMs = now;
        return;
      }

      const holdMs = now - (this.gazeHoldStartMs ?? now);
      if (holdMs >= this.config.gazeHoldMs) {
        const command: GestureCommand = dir === 'RIGHT' ? 'NEXT_VIDEO' : 'PREV_VIDEO';
        events.push({
          type: 'GESTURE_COMMAND',
          timestampMs: now,
          command,
          details: {
            direction: dir,
            holdMs: Math.round(holdMs),
            armedElapsedMs: Math.round(elapsed),
          },
        });
        this.clearTimingState();
        this.cooldownStartMs = now;
        this.transition('COOLDOWN', now, `double_blink_gaze_${dir.toLowerCase()}`, events, holdMs);
      }
    } else {
      this.gazeHoldDir = null;
      this.gazeHoldStartMs = null;
    }
  }

  private handleCooldown(obs: EyeObservation, events: GestureEvent[]): void {
    const now = obs.timestampMs;
    const start = this.cooldownStartMs ?? now;
    if (now - start >= this.config.cooldownMs) {
      // Ensure eyes are open before returning to IDLE so a prolonged hold doesn't immediately retrigger.
      if (obs.eyeState === 'OPEN') {
        this.clearTimingState();
        this.transition('IDLE', now, 'cooldown_complete', events, now - start);
      }
    }
  }

  private classifyBlinkDuration(durationMs: number): BlinkClassification {
    if (durationMs < this.config.minBlinkMs) return 'NOISE';
    if (durationMs <= this.config.maxShortBlinkMs) return 'SHORT';
    if (durationMs < this.config.longBlinkMinMs) return 'GUARD_BAND';
    if (durationMs <= this.config.longBlinkMaxMs) return 'LONG';
    return 'TOO_LONG';
  }

  private transition(
    to: GestureFsmState,
    timestampMs: number,
    reason: string,
    events: GestureEvent[],
    durationMs?: number,
  ): void {
    const from = this.state;
    this.state = to;
    events.push({
      type: 'STATE_TRANSITION',
      timestampMs,
      from,
      to,
      reason,
      ...(durationMs !== undefined ? { durationMs } : {}),
    });
  }

  private buildSnapshot(now: number): GestureStateSnapshot {
    let currentClosedDurationMs: number | null = null;
    if (this.state === 'EYE_CLOSED_1' && this.close1StartMs !== null) {
      currentClosedDurationMs = Math.max(0, now - this.close1StartMs);
    } else if (this.state === 'EYE_CLOSED_2' && this.close2StartMs !== null) {
      currentClosedDurationMs = Math.max(0, now - this.close2StartMs);
    }

    let armedRemainingMs: number | null = null;
    if (this.state === 'ARMED_GAZE' && this.armedStartMs !== null) {
      armedRemainingMs = Math.max(0, this.config.gazeWindowMs - (now - this.armedStartMs));
    }

    const gazeHoldDurationMs =
      this.gazeHoldDir !== null && this.gazeHoldStartMs !== null
        ? Math.max(0, now - this.gazeHoldStartMs)
        : 0;

    return {
      state: this.state,
      currentClosedDurationMs,
      armedRemainingMs,
      gazeHoldDirection: this.gazeHoldDir,
      gazeHoldDurationMs,
      awaitingOpenAfterLongClose: this.awaitingOpenAfterLongClose,
    };
  }
}

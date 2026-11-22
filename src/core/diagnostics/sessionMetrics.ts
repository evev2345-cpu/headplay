import { CaptureMode, DelegatePreference } from '../config/gestureConfig';
import { GestureEvent, GestureFsmState } from '../gesture/gestureStateMachine';
import { EyeObservation, EyeState, GazeDirection } from '../vision/types';

export type DiagnosticEventKind =
  | 'SESSION'
  | 'MARKER'
  | 'BLINK'
  | 'GAZE_CHANGE'
  | 'DOUBLE_BLINK'
  | 'GESTURE_COMMAND'
  | 'STATE_TRANSITION'
  | 'FRAME_GAP_WARNING'
  | 'STALL_DETECTED'
  | 'STALL_RECOVERED'
  | 'ERROR';

export interface DiagnosticLogEntry {
  id: number;
  wallTimeIso: string;
  timestampMs: number;
  kind: DiagnosticEventKind;
  summary: string;
  data?: Record<string, unknown>;
}

export type FrameInputPath =
  | 'video_frame_zero_copy'
  | 'canvas_downscale'
  | 'timer_video_canvas'
  | 'unknown';

export interface FrameProcessingTiming {
  queueDelayMs?: number;
  blitMs?: number;
  inferMs?: number;
  totalProcessMs?: number;
  inputPath?: FrameInputPath;
}

export interface SegmentMetricsSummary {
  marker: string;
  frames: number;
  avgDtMs: number;
  maxDtMs: number;
  frameGapWarnings: number;
  stallCount: number;
  totalStallMs: number;
  maxStallMs: number;
  commands: number;
}

export interface SessionMetricsSnapshot {
  startedAtIso: string | null;
  uptimeMs: number;
  captureMode: CaptureMode;
  activeDelegate: DelegatePreference | 'UNINITIALIZED';
  cameraResolution: string;
  inputPath: FrameInputPath;
  cameraInputFrames: number;
  cameraInputFps: number;
  avgCameraIntervalMs: number;
  totalFrames: number;
  droppedFrames: number;
  faceDetectedFrames: number;
  rollingFps: number;
  avgFps: number;
  lastDtMs: number;
  avgDtMs: number;
  maxDtMs: number;
  p95DtMs: number;
  avgQueueDelayMs: number;
  avgBlitMs: number;
  avgInferMs: number;
  avgProcessMs: number;
  frameGapWarnings: number;
  stallThresholdMs: number;
  stallCount: number;
  totalStallMs: number;
  maxStallMs: number;
  activeStallOngoing: boolean;
  activeStallDurationMs: number;
  currentEyeState: EyeState;
  currentGazeDirection: GazeDirection;
  currentFsmState: GestureFsmState;
  headYawDeg: number | null;
  gazeSuppressedByHeadTurn: boolean;
  blinkLeft: number;
  blinkRight: number;
  earLeft: number | null;
  earRight: number | null;
  gazeRawBlendshape: number | null;
  gazeRawIris: number | null;
  gazeSmoothed: number | null;
  lastBlinkClosedMs: number | null;
  lastBlinkOpenGapMs: number | null;
  currentMarker: string;
  blinkCounts: {
    short: number;
    long: number;
    doubleBlink: number;
    commands: number;
  };
  segmentStats: Record<string, SegmentMetricsSummary>;
}

interface InternalSegmentBucket {
  frames: number;
  dtSum: number;
  dtCount: number;
  maxDtMs: number;
  frameGapWarnings: number;
  stallCount: number;
  totalStallMs: number;
  maxStallMs: number;
  commands: number;
}

interface ActiveStallState {
  startPerfMs: number;
  startWallMs: number;
  marker: string;
}

const MAX_LOG_ENTRIES = 600;
const DT_WINDOW_SIZE = 300;
const FPS_WINDOW_MS = 1000;

/**
 * Bounded-memory telemetry and structured log collector for Phase 1 verification.
 *
 * Stall detection uses two complementary layers:
 * 1) Active watchdog (`checkWatchdog`) while timers remain alive.
 * 2) Timestamp discontinuity comparison (`recordFrame` / `finalizeStallAtStop`) comparing BOTH
 *    monotonic `performance.now()` and wall-clock `Date.now()` so stalls are still detected even
 *    if the watchdog timer itself was frozen alongside frame capture.
 *
 * Known unobservable limits:
 * - If Chrome/OS terminates the offscreen process before recovery or stop, in-memory timestamps
 *   since the last archive cannot be finalized by this collector.
 * - While completely frozen, exact sub-interval transitions inside `[startWallMs, resumeWallMs]`
 *   cannot be distinguished beyond total outage duration.
 */
export class SessionMetrics {
  private startedAtWallMs: number | null = null;
  private startedAtPerfMs: number | null = null;
  private lastPerfMs: number | null = null;
  private lastWallMs: number | null = null;

  private captureMode: CaptureMode = 'track_processor';
  private activeDelegate: DelegatePreference | 'UNINITIALIZED' = 'UNINITIALIZED';
  private cameraResolution = '-';
  private inputPath: FrameInputPath = 'unknown';
  private stallThresholdMs = 1000;

  private cameraInputFrames = 0;
  private lastCameraArrivalMs: number | null = null;
  private cameraIntervalSum = 0;
  private cameraIntervalCount = 0;
  private recentCameraTimestamps: number[] = [];

  private totalFrames = 0;
  private droppedFrames = 0;
  private faceDetectedFrames = 0;
  private frameGapWarnings = 0;

  private stallCount = 0;
  private totalStallMs = 0;
  private maxStallMs = 0;
  private activeStall: ActiveStallState | null = null;

  private dtSum = 0;
  private dtCount = 0;
  private lastDtMs = 0;
  private maxDtMs = 0;
  private recentDts: number[] = [];
  private recentFrameTimestamps: number[] = [];

  private queueDelaySum = 0;
  private queueDelayCount = 0;
  private blitSum = 0;
  private blitCount = 0;
  private inferSum = 0;
  private inferCount = 0;
  private processSum = 0;
  private processCount = 0;

  private currentEyeState: EyeState = 'OPEN';
  private currentGazeDirection: GazeDirection = 'UNKNOWN';
  private currentFsmState: GestureFsmState = 'IDLE';
  private lastGazeLogged: GazeDirection = 'UNKNOWN';
  private headYawDeg: number | null = null;
  private gazeSuppressedByHeadTurn = false;

  private blinkLeft = 0;
  private blinkRight = 0;
  private earLeft: number | null = null;
  private earRight: number | null = null;
  private gazeRawBlendshape: number | null = null;
  private gazeRawIris: number | null = null;
  private gazeSmoothed: number | null = null;
  private lastBlinkClosedMs: number | null = null;
  private lastBlinkOpenGapMs: number | null = null;

  private currentMarker = 'FOREGROUND_POPUP';
  private blinkCounts = { short: 0, long: 0, doubleBlink: 0, commands: 0 };
  private segments = new Map<string, InternalSegmentBucket>();

  private nextLogId = 1;
  private logs: DiagnosticLogEntry[] = [];

  setStallThresholdMs(ms: number): void {
    if (Number.isFinite(ms) && ms >= 400) {
      this.stallThresholdMs = Math.round(ms);
    }
  }

  setCameraInfo(
    resolution: string,
    inputPath: FrameInputPath,
    timestampMs?: number,
    wallTimeMs = Date.now(),
  ): void {
    this.cameraResolution = resolution;
    this.inputPath = inputPath;
    if (timestampMs !== undefined) {
      this.pushLog(
        timestampMs,
        'SESSION',
        `Camera negotiated: ${resolution}, inputPath=${inputPath}`,
        { resolution, inputPath },
        wallTimeMs,
      );
    }
  }

  recordCameraArrival(arrivalPerfMs: number): void {
    this.cameraInputFrames += 1;
    if (this.lastCameraArrivalMs !== null && arrivalPerfMs >= this.lastCameraArrivalMs) {
      this.cameraIntervalSum += arrivalPerfMs - this.lastCameraArrivalMs;
      this.cameraIntervalCount += 1;
    }
    this.lastCameraArrivalMs = arrivalPerfMs;
    this.recentCameraTimestamps.push(arrivalPerfMs);
    while (
      this.recentCameraTimestamps.length > 0 &&
      arrivalPerfMs - (this.recentCameraTimestamps[0] ?? arrivalPerfMs) > FPS_WINDOW_MS
    ) {
      this.recentCameraTimestamps.shift();
    }
  }

  startSession(
    timestampMs: number,
    captureMode: CaptureMode,
    activeDelegate: DelegatePreference,
    wallTimeMs = Date.now(),
    stallThresholdMs?: number,
  ): void {
    const keepThreshold = stallThresholdMs ?? this.stallThresholdMs;
    this.reset();
    this.setStallThresholdMs(keepThreshold);
    this.startedAtWallMs = wallTimeMs;
    this.startedAtPerfMs = timestampMs;
    this.lastPerfMs = timestampMs;
    this.lastWallMs = wallTimeMs;
    this.captureMode = captureMode;
    this.activeDelegate = activeDelegate;
    this.getOrCreateSegment(this.currentMarker);
    this.pushLog(
      timestampMs,
      'SESSION',
      `Tracking started (${captureMode}, delegate=${activeDelegate}, stallThreshold=${this.stallThresholdMs}ms)`,
      {
        captureMode,
        activeDelegate,
        stallThresholdMs: this.stallThresholdMs,
      },
      wallTimeMs,
    );
  }

  reset(): void {
    this.startedAtWallMs = null;
    this.startedAtPerfMs = null;
    this.lastPerfMs = null;
    this.lastWallMs = null;
    this.cameraResolution = '-';
    this.inputPath = 'unknown';
    this.cameraInputFrames = 0;
    this.lastCameraArrivalMs = null;
    this.cameraIntervalSum = 0;
    this.cameraIntervalCount = 0;
    this.recentCameraTimestamps = [];
    this.totalFrames = 0;
    this.droppedFrames = 0;
    this.faceDetectedFrames = 0;
    this.frameGapWarnings = 0;
    this.stallCount = 0;
    this.totalStallMs = 0;
    this.maxStallMs = 0;
    this.activeStall = null;
    this.dtSum = 0;
    this.dtCount = 0;
    this.lastDtMs = 0;
    this.maxDtMs = 0;
    this.recentDts = [];
    this.recentFrameTimestamps = [];
    this.queueDelaySum = 0;
    this.queueDelayCount = 0;
    this.blitSum = 0;
    this.blitCount = 0;
    this.inferSum = 0;
    this.inferCount = 0;
    this.processSum = 0;
    this.processCount = 0;
    this.currentEyeState = 'OPEN';
    this.currentGazeDirection = 'UNKNOWN';
    this.currentFsmState = 'IDLE';
    this.lastGazeLogged = 'UNKNOWN';
    this.headYawDeg = null;
    this.gazeSuppressedByHeadTurn = false;
    this.blinkLeft = 0;
    this.blinkRight = 0;
    this.earLeft = null;
    this.earRight = null;
    this.gazeRawBlendshape = null;
    this.gazeRawIris = null;
    this.gazeSmoothed = null;
    this.lastBlinkClosedMs = null;
    this.lastBlinkOpenGapMs = null;
    this.currentMarker = 'FOREGROUND_POPUP';
    this.blinkCounts = { short: 0, long: 0, doubleBlink: 0, commands: 0 };
    this.segments.clear();
    this.nextLogId = 1;
    this.logs = [];
  }

  setActiveDelegate(delegate: DelegatePreference, timestampMs: number, wallTimeMs = Date.now()): void {
    this.activeDelegate = delegate;
    this.pushLog(timestampMs, 'SESSION', `Delegate switched to ${delegate}`, { delegate }, wallTimeMs);
  }

  recordDroppedFrame(): void {
    this.droppedFrames += 1;
  }

  addMarker(
    label: string,
    timestampMs: number,
    wallTimeMs = Date.now(),
    extraData?: Record<string, unknown>,
  ): void {
    this.currentMarker = label;
    this.getOrCreateSegment(label);
    this.pushLog(
      timestampMs,
      'MARKER',
      `Environment marker: ${label}`,
      { marker: label, ...(extraData ?? {}) },
      wallTimeMs,
    );
  }

  /**
   * Layer 1 active watchdog tick. Detects 0 FPS stalls while JS timers remain alive.
   */
  checkWatchdog(nowPerfMs: number, wallTimeMs = Date.now()): boolean {
    if (this.lastPerfMs === null || this.lastWallMs === null) {
      return false;
    }

    const { effectiveGapMs, perfGapMs, wallGapMs } = this.computeGap(nowPerfMs, wallTimeMs);
    if (effectiveGapMs >= this.stallThresholdMs && !this.activeStall) {
      this.activeStall = {
        startPerfMs: this.lastPerfMs,
        startWallMs: this.lastWallMs,
        marker: this.currentMarker,
      };
      this.pushLog(
        nowPerfMs,
        'STALL_DETECTED',
        `0 FPS stall detected [${this.currentMarker}]: ${Math.round(effectiveGapMs)}ms since last frame`,
        {
          marker: this.currentMarker,
          perfGapMs: Math.round(perfGapMs),
          wallGapMs: Math.round(wallGapMs),
          effectiveGapMs: Math.round(effectiveGapMs),
          startWallIso: new Date(this.lastWallMs).toISOString(),
        },
        wallTimeMs,
      );
      return true;
    }
    return false;
  }

  /**
   * Layer 2 timestamp discontinuity finalizer invoked on stop/export so a permanent freeze that
   * froze BOTH capture and watchdog timers is still recorded upon restoration/stop.
   */
  finalizeStallAtStop(nowPerfMs: number, wallTimeMs = Date.now()): boolean {
    if (this.lastPerfMs === null || this.lastWallMs === null) {
      return false;
    }

    const { effectiveGapMs, perfGapMs, wallGapMs } = this.computeGap(nowPerfMs, wallTimeMs);
    if (this.activeStall || effectiveGapMs >= this.stallThresholdMs) {
      const startWallMs = this.activeStall?.startWallMs ?? this.lastWallMs;
      const stallMarker = this.activeStall?.marker ?? this.currentMarker;
      const detectedBy = this.activeStall
        ? 'watchdog_then_stop'
        : 'timestamp_discontinuity_at_stop';
      this.completeStallEpisode(
        nowPerfMs,
        wallTimeMs,
        startWallMs,
        stallMarker,
        effectiveGapMs,
        perfGapMs,
        wallGapMs,
        detectedBy,
      );
      this.lastPerfMs = nowPerfMs;
      this.lastWallMs = wallTimeMs;
      return true;
    }
    return false;
  }

  recordHeartbeat(timestampMs: number, wallTimeMs = Date.now()): void {
    const snap = this.getSnapshot(timestampMs, wallTimeMs);
    this.pushLog(
      timestampMs,
      'SESSION',
      `HEARTBEAT [${snap.currentMarker}]: inFps=${snap.cameraInputFps}, fps=${snap.rollingFps}(avg=${snap.avgFps}), avgDt=${snap.avgDtMs}ms, q=${snap.avgQueueDelayMs}ms, blit=${snap.avgBlitMs}ms, infer=${snap.avgInferMs}ms, stalls=${snap.stallCount}(${snap.totalStallMs}ms)`,
      {
        marker: snap.currentMarker,
        cameraResolution: snap.cameraResolution,
        inputPath: snap.inputPath,
        cameraInputFps: snap.cameraInputFps,
        avgCameraIntervalMs: snap.avgCameraIntervalMs,
        rollingFps: snap.rollingFps,
        avgFps: snap.avgFps,
        avgDtMs: snap.avgDtMs,
        maxDtMs: snap.maxDtMs,
        p95DtMs: snap.p95DtMs,
        avgQueueDelayMs: snap.avgQueueDelayMs,
        avgBlitMs: snap.avgBlitMs,
        avgInferMs: snap.avgInferMs,
        avgProcessMs: snap.avgProcessMs,
        droppedFrames: snap.droppedFrames,
        frameGapWarnings: snap.frameGapWarnings,
        stallCount: snap.stallCount,
        totalStallMs: snap.totalStallMs,
        maxStallMs: snap.maxStallMs,
        delegate: snap.activeDelegate,
        captureMode: snap.captureMode,
      },
      wallTimeMs,
    );
  }

  recordError(message: string, timestampMs: number, data?: Record<string, unknown>, wallTimeMs = Date.now()): void {
    this.pushLog(timestampMs, 'ERROR', message, data, wallTimeMs);
  }

  recordFrame(
    obs: EyeObservation,
    fsmState: GestureFsmState,
    events: GestureEvent[],
    wallTimeMs = Date.now(),
    timing?: FrameProcessingTiming,
  ): void {
    const now = obs.timestampMs;
    if (this.startedAtPerfMs === null) {
      this.startedAtPerfMs = now;
      this.startedAtWallMs = wallTimeMs;
    }

    const seg = this.getOrCreateSegment(this.currentMarker);

    // Layer 2: detect stall recovery via timestamp comparison even if watchdog itself was frozen.
    if (this.lastPerfMs !== null && this.lastWallMs !== null) {
      const { effectiveGapMs, perfGapMs, wallGapMs } = this.computeGap(now, wallTimeMs);
      if (this.activeStall || effectiveGapMs >= this.stallThresholdMs) {
        const startWallMs = this.activeStall?.startWallMs ?? this.lastWallMs;
        const stallMarker = this.activeStall?.marker ?? this.currentMarker;
        const detectedBy = this.activeStall
          ? 'watchdog_then_resume'
          : 'timestamp_discontinuity_on_resume';
        this.completeStallEpisode(
          now,
          wallTimeMs,
          startWallMs,
          stallMarker,
          effectiveGapMs,
          perfGapMs,
          wallGapMs,
          detectedBy,
        );
      }
    }

    const hadPreviousFrame = this.totalFrames > 0 && this.lastPerfMs !== null && now >= this.lastPerfMs;
    if (hadPreviousFrame && this.lastPerfMs !== null) {
      const dt = now - this.lastPerfMs;
      this.lastDtMs = dt;
      this.dtSum += dt;
      this.dtCount += 1;
      if (dt > this.maxDtMs) this.maxDtMs = dt;
      this.recentDts.push(dt);
      if (this.recentDts.length > DT_WINDOW_SIZE) {
        this.recentDts.shift();
      }

      seg.dtSum += dt;
      seg.dtCount += 1;
      if (dt > seg.maxDtMs) seg.maxDtMs = dt;
    }

    this.totalFrames += 1;
    seg.frames += 1;
    if (obs.faceDetected) {
      this.faceDetectedFrames += 1;
    }

    if (timing?.queueDelayMs !== undefined && Number.isFinite(timing.queueDelayMs)) {
      this.queueDelaySum += timing.queueDelayMs;
      this.queueDelayCount += 1;
    }
    if (timing?.blitMs !== undefined && Number.isFinite(timing.blitMs)) {
      this.blitSum += timing.blitMs;
      this.blitCount += 1;
    }
    if (timing?.inferMs !== undefined && Number.isFinite(timing.inferMs)) {
      this.inferSum += timing.inferMs;
      this.inferCount += 1;
    }
    if (timing?.totalProcessMs !== undefined && Number.isFinite(timing.totalProcessMs)) {
      this.processSum += timing.totalProcessMs;
      this.processCount += 1;
    }
    if (timing?.inputPath) {
      this.inputPath = timing.inputPath;
    }

    this.lastPerfMs = now;
    this.lastWallMs = wallTimeMs;

    this.recentFrameTimestamps.push(now);
    while (
      this.recentFrameTimestamps.length > 0 &&
      now - (this.recentFrameTimestamps[0] ?? now) > FPS_WINDOW_MS
    ) {
      this.recentFrameTimestamps.shift();
    }

    this.currentEyeState = obs.eyeState;
    this.currentGazeDirection = obs.gazeDirection;
    this.currentFsmState = fsmState;
    this.headYawDeg = obs.headYawDeg;
    this.gazeSuppressedByHeadTurn = obs.gazeSuppressedByHeadTurn;
    this.blinkLeft = obs.blinkLeft;
    this.blinkRight = obs.blinkRight;
    this.earLeft = obs.earLeft;
    this.earRight = obs.earRight;
    this.gazeRawBlendshape = obs.gazeRawBlendshape;
    this.gazeRawIris = obs.gazeRawIris;
    this.gazeSmoothed = obs.gazeSmoothed;

    if (obs.gazeDirection !== this.lastGazeLogged) {
      const prev = this.lastGazeLogged;
      this.lastGazeLogged = obs.gazeDirection;
      this.pushLog(
        now,
        'GAZE_CHANGE',
        `Gaze ${prev} -> ${obs.gazeDirection} (sm=${formatNullable(obs.gazeSmoothed)}, bs=${formatNullable(obs.gazeRawBlendshape)}, ir=${formatNullable(obs.gazeRawIris)}, yaw=${formatNullable(obs.headYawDeg)}deg${obs.gazeSuppressedByHeadTurn ? ' [HEAD_TURN_GATED]' : ''})`,
        {
          from: prev,
          to: obs.gazeDirection,
          gazeSmoothed: obs.gazeSmoothed,
          gazeRawBlendshape: obs.gazeRawBlendshape,
          gazeRawIris: obs.gazeRawIris,
          headYawDeg: obs.headYawDeg,
          gazeSuppressedByHeadTurn: obs.gazeSuppressedByHeadTurn,
          marker: this.currentMarker,
        },
        wallTimeMs,
      );
    }

    for (const ev of events) {
      switch (ev.type) {
        case 'BLINK_MEASURED': {
          if (ev.classification === 'SHORT') this.blinkCounts.short += 1;
          if (ev.classification === 'LONG') this.blinkCounts.long += 1;
          const closedMs = Math.round(ev.closedDurationMs);
          const openGapMs = ev.openGapMs !== null ? Math.round(ev.openGapMs) : null;
          this.lastBlinkClosedMs = closedMs;
          this.lastBlinkOpenGapMs = openGapMs;
          const valleyTag = ev.suspectedMissedOpenValley ? ' [VALLEY_SUSPECTED]' : '';
          this.pushLog(
            ev.timestampMs,
            'BLINK',
            `Blink #${ev.blinkIndex}: closed=${closedMs}ms, openGap=${openGapMs !== null ? `${openGapMs}ms` : 'n/a'}, frames=${ev.frameCount}, maxDt=${ev.maxDtDuringCloseMs}ms, blinkAvg=[${ev.minBlinkAvgDuringClose.toFixed(2)}..${ev.peakBlinkAvgDuringClose.toFixed(2)}] [${ev.classification}]${valleyTag}`,
            {
              blinkIndex: ev.blinkIndex,
              durationMs: closedMs,
              closedDurationMs: closedMs,
              openGapMs,
              frameCount: ev.frameCount,
              maxDtDuringCloseMs: ev.maxDtDuringCloseMs,
              minBlinkAvgDuringClose: ev.minBlinkAvgDuringClose,
              peakBlinkAvgDuringClose: ev.peakBlinkAvgDuringClose,
              suspectedMissedOpenValley: ev.suspectedMissedOpenValley,
              classification: ev.classification,
              marker: this.currentMarker,
            },
            wallTimeMs,
          );
          break;
        }
        case 'DOUBLE_BLINK_DETECTED':
          this.blinkCounts.doubleBlink += 1;
          this.pushLog(
            ev.timestampMs,
            'DOUBLE_BLINK',
            `Double blink detected (b1=${Math.round(ev.blink1Ms)}ms, openGap=${Math.round(ev.gapMs)}ms, b2=${Math.round(ev.blink2Ms)}ms)`,
            {
              blink1Ms: Math.round(ev.blink1Ms),
              gapMs: Math.round(ev.gapMs),
              openGapMs: Math.round(ev.gapMs),
              blink2Ms: Math.round(ev.blink2Ms),
              marker: this.currentMarker,
            },
            wallTimeMs,
          );
          break;
        case 'GESTURE_COMMAND':
          this.blinkCounts.commands += 1;
          seg.commands += 1;
          this.pushLog(
            ev.timestampMs,
            'GESTURE_COMMAND',
            `COMMAND: ${ev.command}`,
            {
              command: ev.command,
              ...ev.details,
              marker: this.currentMarker,
            },
            wallTimeMs,
          );
          break;
        case 'FRAME_GAP_WARNING':
          this.frameGapWarnings += 1;
          seg.frameGapWarnings += 1;
          this.pushLog(
            ev.timestampMs,
            'FRAME_GAP_WARNING',
            `Frame gap ${Math.round(ev.gapMs)}ms (reset from ${ev.resetFromState})`,
            {
              gapMs: Math.round(ev.gapMs),
              resetFromState: ev.resetFromState,
              marker: this.currentMarker,
            },
            wallTimeMs,
          );
          break;
        case 'STATE_TRANSITION':
          this.pushLog(
            ev.timestampMs,
            'STATE_TRANSITION',
            `${ev.from} -> ${ev.to} (${ev.reason})`,
            {
              from: ev.from,
              to: ev.to,
              reason: ev.reason,
              durationMs: ev.durationMs !== undefined ? Math.round(ev.durationMs) : undefined,
              marker: this.currentMarker,
            },
            wallTimeMs,
          );
          break;
      }
    }
  }

  getSnapshot(nowPerfMs?: number, nowWallMs = Date.now()): SessionMetricsSnapshot {
    const refNow = nowPerfMs ?? this.lastPerfMs ?? this.startedAtPerfMs ?? 0;
    const uptimeMs = this.startedAtPerfMs !== null ? Math.max(0, refNow - this.startedAtPerfMs) : 0;
    const avgFps = uptimeMs > 0 ? (this.totalFrames * 1000) / uptimeMs : 0;
    const avgDtMs = this.dtCount > 0 ? this.dtSum / this.dtCount : 0;
    const avgCameraIntervalMs =
      this.cameraIntervalCount > 0 ? this.cameraIntervalSum / this.cameraIntervalCount : 0;
    const p95DtMs = computePercentile(this.recentDts, 0.95);
    const avgQueueDelayMs = this.queueDelayCount > 0 ? this.queueDelaySum / this.queueDelayCount : 0;
    const avgBlitMs = this.blitCount > 0 ? this.blitSum / this.blitCount : 0;
    const avgInferMs = this.inferCount > 0 ? this.inferSum / this.inferCount : 0;
    const avgProcessMs = this.processCount > 0 ? this.processSum / this.processCount : 0;

    let activeStallDurationMs = 0;
    if (this.activeStall && nowPerfMs !== undefined) {
      const perfElapsed = Math.max(0, nowPerfMs - this.activeStall.startPerfMs);
      const wallElapsed = Math.max(0, nowWallMs - this.activeStall.startWallMs);
      activeStallDurationMs = Math.round(Math.max(perfElapsed, wallElapsed));
    }

    const segmentStats: Record<string, SegmentMetricsSummary> = {};
    for (const [marker, b] of this.segments.entries()) {
      segmentStats[marker] = {
        marker,
        frames: b.frames,
        avgDtMs: round2(b.dtCount > 0 ? b.dtSum / b.dtCount : 0),
        maxDtMs: round2(b.maxDtMs),
        frameGapWarnings: b.frameGapWarnings,
        stallCount: b.stallCount,
        totalStallMs: Math.round(b.totalStallMs),
        maxStallMs: Math.round(b.maxStallMs),
        commands: b.commands,
      };
    }

    return {
      startedAtIso: this.startedAtWallMs !== null ? new Date(this.startedAtWallMs).toISOString() : null,
      uptimeMs: Math.round(uptimeMs),
      captureMode: this.captureMode,
      activeDelegate: this.activeDelegate,
      cameraResolution: this.cameraResolution,
      inputPath: this.inputPath,
      cameraInputFrames: this.cameraInputFrames,
      cameraInputFps: this.recentCameraTimestamps.length,
      avgCameraIntervalMs: round2(avgCameraIntervalMs),
      totalFrames: this.totalFrames,
      droppedFrames: this.droppedFrames,
      faceDetectedFrames: this.faceDetectedFrames,
      rollingFps: this.recentFrameTimestamps.length,
      avgFps: round2(avgFps),
      lastDtMs: round2(this.lastDtMs),
      avgDtMs: round2(avgDtMs),
      maxDtMs: round2(this.maxDtMs),
      p95DtMs: round2(p95DtMs),
      avgQueueDelayMs: round2(avgQueueDelayMs),
      avgBlitMs: round2(avgBlitMs),
      avgInferMs: round2(avgInferMs),
      avgProcessMs: round2(avgProcessMs),
      frameGapWarnings: this.frameGapWarnings,
      stallThresholdMs: this.stallThresholdMs,
      stallCount: this.stallCount,
      totalStallMs: Math.round(this.totalStallMs),
      maxStallMs: Math.round(this.maxStallMs),
      activeStallOngoing: this.activeStall !== null,
      activeStallDurationMs,
      currentEyeState: this.currentEyeState,
      currentGazeDirection: this.currentGazeDirection,
      currentFsmState: this.currentFsmState,
      headYawDeg: this.headYawDeg !== null ? round2(this.headYawDeg) : null,
      gazeSuppressedByHeadTurn: this.gazeSuppressedByHeadTurn,
      blinkLeft: round3(this.blinkLeft),
      blinkRight: round3(this.blinkRight),
      earLeft: this.earLeft !== null ? round3(this.earLeft) : null,
      earRight: this.earRight !== null ? round3(this.earRight) : null,
      gazeRawBlendshape: this.gazeRawBlendshape !== null ? round3(this.gazeRawBlendshape) : null,
      gazeRawIris: this.gazeRawIris !== null ? round3(this.gazeRawIris) : null,
      gazeSmoothed: this.gazeSmoothed !== null ? round3(this.gazeSmoothed) : null,
      lastBlinkClosedMs: this.lastBlinkClosedMs,
      lastBlinkOpenGapMs: this.lastBlinkOpenGapMs,
      currentMarker: this.currentMarker,
      blinkCounts: { ...this.blinkCounts },
      segmentStats,
    };
  }

  getLogs(limit?: number): DiagnosticLogEntry[] {
    if (limit !== undefined && limit > 0) {
      return this.logs.slice(-limit);
    }
    return [...this.logs];
  }

  exportJson(): string {
    return JSON.stringify(
      {
        exportedAtIso: new Date().toISOString(),
        metrics: this.getSnapshot(),
        logs: this.logs,
      },
      null,
      2,
    );
  }

  exportCsv(): string {
    const header = 'id,wallTimeIso,timestampMs,kind,summary,dataJson';
    const rows = this.logs.map((entry) => {
      const cells = [
        String(entry.id),
        entry.wallTimeIso,
        String(Math.round(entry.timestampMs)),
        entry.kind,
        entry.summary,
        entry.data ? JSON.stringify(entry.data) : '',
      ];
      return cells.map(escapeCsvCell).join(',');
    });
    return [header, ...rows].join('\n');
  }

  private computeGap(
    nowPerfMs: number,
    wallTimeMs: number,
  ): { perfGapMs: number; wallGapMs: number; effectiveGapMs: number } {
    const refPerf = this.activeStall?.startPerfMs ?? this.lastPerfMs ?? nowPerfMs;
    const refWall = this.activeStall?.startWallMs ?? this.lastWallMs ?? wallTimeMs;
    const perfGapMs = Math.max(0, nowPerfMs - refPerf);
    const wallGapMs = Math.max(0, wallTimeMs - refWall);
    return {
      perfGapMs,
      wallGapMs,
      effectiveGapMs: Math.max(perfGapMs, wallGapMs),
    };
  }

  private completeStallEpisode(
    nowPerfMs: number,
    wallTimeMs: number,
    startWallMs: number,
    stallMarker: string,
    effectiveGapMs: number,
    perfGapMs: number,
    wallGapMs: number,
    detectedBy: string,
  ): void {
    const durationMs = Math.round(effectiveGapMs);
    this.stallCount += 1;
    this.totalStallMs += durationMs;
    if (durationMs > this.maxStallMs) {
      this.maxStallMs = durationMs;
    }

    const seg = this.getOrCreateSegment(stallMarker);
    seg.stallCount += 1;
    seg.totalStallMs += durationMs;
    if (durationMs > seg.maxStallMs) {
      seg.maxStallMs = durationMs;
    }

    this.activeStall = null;

    this.pushLog(
      nowPerfMs,
      'STALL_RECOVERED',
      `Stall ended [${stallMarker}]: ${durationMs}ms (perf=${Math.round(perfGapMs)}ms, wall=${Math.round(wallGapMs)}ms, via=${detectedBy})`,
      {
        marker: stallMarker,
        durationMs,
        perfGapMs: Math.round(perfGapMs),
        wallGapMs: Math.round(wallGapMs),
        startWallIso: new Date(startWallMs).toISOString(),
        endWallIso: new Date(wallTimeMs).toISOString(),
        detectedBy,
      },
      wallTimeMs,
    );
  }

  private getOrCreateSegment(marker: string): InternalSegmentBucket {
    let bucket = this.segments.get(marker);
    if (!bucket) {
      bucket = {
        frames: 0,
        dtSum: 0,
        dtCount: 0,
        maxDtMs: 0,
        frameGapWarnings: 0,
        stallCount: 0,
        totalStallMs: 0,
        maxStallMs: 0,
        commands: 0,
      };
      this.segments.set(marker, bucket);
    }
    return bucket;
  }

  private pushLog(
    timestampMs: number,
    kind: DiagnosticEventKind,
    summary: string,
    data: Record<string, unknown> | undefined,
    wallTimeMs: number,
  ): void {
    this.logs.push({
      id: this.nextLogId++,
      wallTimeIso: new Date(wallTimeMs).toISOString(),
      timestampMs: Math.round(timestampMs),
      kind,
      summary,
      ...(data ? { data } : {}),
    });
    if (this.logs.length > MAX_LOG_ENTRIES) {
      this.logs.shift();
    }
  }
}

function escapeCsvCell(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function computePercentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx] ?? 0;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function formatNullable(n: number | null): string {
  return n === null ? 'null' : n.toFixed(2);
}

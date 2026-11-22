import { DEFAULT_GESTURE_CONFIG, GestureConfig, sanitizeGestureConfig } from '../../core/config/gestureConfig';
import { SessionMetrics } from '../../core/diagnostics/sessionMetrics';
import { GestureStateMachine } from '../../core/gesture/gestureStateMachine';
import { EyeFeatureExtractor } from '../../core/vision/eyeFeatureExtractor';
import {
  BackgroundMessage,
  OffscreenDiagnosticsResponse,
  OffscreenMessage,
  TrackingErrorCode,
} from '../../shared/messages';
import { CameraCapture } from './cameraCapture';
import { FaceTracker } from './faceTracker';

const HEARTBEAT_INTERVAL_MS = 15_000;
const WATCHDOG_INTERVAL_MS = 1_000;

let config: GestureConfig = sanitizeGestureConfig(DEFAULT_GESTURE_CONFIG);
const capture = new CameraCapture(320, 240, false);
const tracker = new FaceTracker();
const extractor = new EyeFeatureExtractor(config);
const fsm = new GestureStateMachine(config);
const metrics = new SessionMetrics();

let lastHeartbeatMs = 0;
let watchdogTimerId: number | null = null;
let isStarting = false;

function notifyBackground(msg: BackgroundMessage): void {
  chrome.runtime.sendMessage(msg).catch(() => {
    // Background service worker may briefly be spinning up; ignore transient disconnect.
  });
}

function stopWatchdog(): void {
  if (watchdogTimerId !== null) {
    window.clearInterval(watchdogTimerId);
    watchdogTimerId = null;
  }
}

function startWatchdog(): void {
  stopWatchdog();
  watchdogTimerId = window.setInterval(() => {
    if (!capture.isRunning()) return;
    metrics.checkWatchdog(performance.now(), Date.now());
  }, WATCHDOG_INTERVAL_MS);
}

function classifyStartError(err: unknown): { code: TrackingErrorCode; message: string } {
  const name = err instanceof Error ? err.name : '';
  const message = err instanceof Error ? err.message : String(err);

  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
    return {
      code: 'PERMISSION_DENIED',
      message: 'Camera permission is not granted. Open the permission setup tab and choose "Always allow".',
    };
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return {
      code: 'NO_CAMERA',
      message: 'No webcam device was found.',
    };
  }
  if (message.toLowerCase().includes('mediapipe') || message.toLowerCase().includes('wasm')) {
    return {
      code: 'MEDIAPIPE_INIT_FAILED',
      message: `MediaPipe initialization failed: ${message}`,
    };
  }
  return { code: 'UNKNOWN', message };
}

async function startTracking(nextConfig: GestureConfig): Promise<{ ok: boolean; error?: string; code?: TrackingErrorCode }> {
  if (isStarting) {
    return { ok: false, error: 'Already starting' };
  }
  isStarting = true;

  try {
    await stopTrackingInternal('restarting');

    config = sanitizeGestureConfig(nextConfig);
    extractor.updateConfig(config);
    extractor.reset();
    fsm.updateConfig(config);
    fsm.reset();
    metrics.setStallThresholdMs(config.stallThresholdMs);

    const initResult = await tracker.init(config.delegatePreference);
    const preferDirectVideoFrame =
      initResult.activeDelegate === 'GPU' && config.directVideoFrameGpu;

    const startTs = performance.now();
    lastHeartbeatMs = startTs;
    metrics.startSession(
      startTs,
      config.captureMode,
      initResult.activeDelegate,
      Date.now(),
      config.stallThresholdMs,
    );
    if (initResult.fellBackToCpu) {
      metrics.recordError('GPU delegate unavailable at startup; using CPU delegate', startTs);
    }

    const startResult = await capture.start(
      {
        mode: config.captureMode,
        targetFps: config.targetFps,
        inputMaxWidth: config.inputMaxWidth,
        // Use CPU-optimized 2D canvas readback only when MediaPipe runs on CPU delegate.
        willReadFrequently: initResult.activeDelegate === 'CPU',
        preferDirectVideoFrame,
      },
      {
        onCameraArrival: (arrivalMs) => {
          metrics.recordCameraArrival(arrivalMs);
        },
        onFrame: ({ source, isDirectVideoFrame, inputPath, timestampMs, queueDelayMs, blitMs }) => {
          const procStart = performance.now();
          const { frame: rawFrame, inferMs } = tracker.detect(source, timestampMs, {
            isDirectVideoFrame,
            onDirectVideoFrameUnsupported: () => {
              capture.setPreferDirectVideoFrame(false);
              metrics.recordError(
                'Direct VideoFrame input unsupported on this GPU; switched to canvas copy',
                timestampMs,
              );
            },
            onFallbackToCpu: () => {
              capture.setPreferDirectVideoFrame(false);
              capture.setWillReadFrequently(true);
              metrics.setActiveDelegate('CPU', timestampMs);
            },
          });

          const obs = extractor.extract(rawFrame);
          const fsmResult = fsm.update(obs);
          const totalProcessMs = blitMs + (performance.now() - procStart);
          metrics.recordFrame(obs, fsmResult.state, fsmResult.events, Date.now(), {
            queueDelayMs,
            blitMs,
            inferMs,
            totalProcessMs,
            inputPath,
          });

          // Periodic diagnostic heartbeat to verify continuity while Chrome is minimized.
          if (lastHeartbeatMs === 0) {
            lastHeartbeatMs = timestampMs;
          } else if (timestampMs - lastHeartbeatMs >= HEARTBEAT_INTERVAL_MS) {
            lastHeartbeatMs = timestampMs;
            metrics.recordHeartbeat(timestampMs);
          }

          // Wake background SW only when an actionable gesture command is emitted.
          for (const ev of fsmResult.events) {
            if (ev.type === 'GESTURE_COMMAND') {
              console.info('[HEADPLAY][Phase1] Gesture command:', ev.command, ev.details);
              notifyBackground({
                target: 'background',
                type: 'OFFSCREEN_GESTURE_COMMAND',
                command: ev.command,
                timestampMs: ev.timestampMs,
                details: ev.details,
              });
            }
          }
        },
        onFrameDropped: () => {
          metrics.recordDroppedFrame();
        },
        onStreamEnded: (reason) => {
          const now = performance.now();
          metrics.finalizeStallAtStop(now, Date.now());
          metrics.recordError(`Stream ended: ${reason}`, now);
          void stopTrackingInternal('stream_ended');
          notifyBackground({
            target: 'background',
            type: 'OFFSCREEN_TRACKING_ERROR',
            code: 'STREAM_ENDED',
            message: reason,
          });
        },
        onError: (err) => {
          const now = performance.now();
          const message = err instanceof Error ? err.message : String(err);
          metrics.recordError(`Capture error: ${message}`, now);
        },
      },
    );

    const initialInputPath =
      startResult.activeMode === 'timer_fallback'
        ? 'timer_video_canvas'
        : preferDirectVideoFrame && startResult.negotiatedWidth <= config.inputMaxWidth
          ? 'video_frame_zero_copy'
          : 'canvas_downscale';
    metrics.setCameraInfo(startResult.resolutionLabel, initialInputPath, performance.now());
    startWatchdog();

    notifyBackground({
      target: 'background',
      type: 'OFFSCREEN_TRACKING_STARTED',
      captureMode: startResult.activeMode,
      activeDelegate: initResult.activeDelegate,
    });

    return { ok: true };
  } catch (err) {
    await stopTrackingInternal('start_failed');
    const classified = classifyStartError(err);
    metrics.recordError(classified.message, performance.now(), { code: classified.code });
    notifyBackground({
      target: 'background',
      type: 'OFFSCREEN_TRACKING_ERROR',
      code: classified.code,
      message: classified.message,
    });
    return { ok: false, error: classified.message, code: classified.code };
  } finally {
    isStarting = false;
  }
}

async function stopTrackingInternal(reason: string): Promise<void> {
  const wasRunning = capture.isRunning();
  stopWatchdog();
  if (wasRunning && reason === 'user_stop') {
    metrics.finalizeStallAtStop(performance.now(), Date.now());
  }
  await capture.stop();
  tracker.close();
  extractor.reset();
  fsm.reset();
  lastHeartbeatMs = 0;

  if (wasRunning && reason === 'user_stop') {
    notifyBackground({
      target: 'background',
      type: 'OFFSCREEN_TRACKING_STOPPED',
      reason,
    });
  }
}

chrome.runtime.onMessage.addListener((raw: unknown, _sender, sendResponse) => {
  const msg = raw as OffscreenMessage | undefined;
  if (!msg || msg.target !== 'offscreen') {
    return false;
  }

  switch (msg.type) {
    case 'OFFSCREEN_START': {
      void startTracking(msg.config).then((res) => sendResponse(res));
      return true;
    }

    case 'OFFSCREEN_STOP': {
      void stopTrackingInternal('user_stop').then(() => sendResponse({ ok: true }));
      return true;
    }

    case 'OFFSCREEN_UPDATE_CONFIG': {
      config = sanitizeGestureConfig(msg.config);
      extractor.updateConfig(config);
      fsm.updateConfig(config);
      capture.updateTargetFps(config.targetFps);
      capture.setInputMaxWidth(config.inputMaxWidth);
      capture.setPreferDirectVideoFrame(
        tracker.getActiveDelegate() === 'GPU' && config.directVideoFrameGpu,
      );
      metrics.setStallThresholdMs(config.stallThresholdMs);
      sendResponse({ ok: true });
      return false;
    }

    case 'OFFSCREEN_GET_DIAGNOSTICS': {
      const now = performance.now();
      const wall = Date.now();
      if (capture.isRunning()) {
        metrics.checkWatchdog(now, wall);
      }
      const response: OffscreenDiagnosticsResponse = {
        ok: true,
        running: capture.isRunning(),
        metrics: metrics.getSnapshot(now, wall),
        logs: metrics.getLogs(msg.logLimit ?? 120),
      };
      sendResponse(response);
      return false;
    }

    case 'OFFSCREEN_ADD_MARKER': {
      metrics.addMarker(msg.label, performance.now(), Date.now(), msg.meta);
      sendResponse({ ok: true });
      return false;
    }

    case 'OFFSCREEN_CLEAR_LOGS': {
      metrics.reset();
      if (capture.isRunning()) {
        metrics.startSession(
          performance.now(),
          capture.getActiveMode(),
          tracker.getActiveDelegate(),
          Date.now(),
          config.stallThresholdMs,
        );
      }
      sendResponse({ ok: true });
      return false;
    }

    case 'OFFSCREEN_EXPORT_LOGS': {
      if (capture.isRunning()) {
        metrics.checkWatchdog(performance.now(), Date.now());
      }
      const content = msg.format === 'csv' ? metrics.exportCsv() : metrics.exportJson();
      sendResponse({ ok: true, content });
      return false;
    }
  }
});

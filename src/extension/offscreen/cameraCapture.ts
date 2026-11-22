import { CameraCaptureResolution, CaptureMode } from '../../core/config/gestureConfig';
import { FrameInputPath, ReadArrivalTelemetry } from '../../core/diagnostics/sessionMetrics';
import { computeScaledDimensions, LatestFrameSlot } from '../../core/vision/frameScheduler';

// Minimal ambient declaration for Chromium's MediaStreamTrackProcessor API (Insertable Streams).
interface TrackProcessorInstance {
  readable: ReadableStream<VideoFrame>;
  totalFrames?: number;
  discardedFrames?: number;
}

interface TrackProcessorCtor {
  new (init: { track: MediaStreamTrack; maxBufferSize?: number }): TrackProcessorInstance;
}

declare global {
  interface Window {
    MediaStreamTrackProcessor?: TrackProcessorCtor;
  }
}

export interface CapturedFrame {
  source: TexImageSource | null;
  isDirectVideoFrame: boolean;
  inputPath: FrameInputPath;
  timestampMs: number;
  arrivalMs: number;
  scheduleDelayMs: number;
  queueDelayMs: number;
  blitMs: number;
}

export interface CameraStartResult {
  activeMode: CaptureMode;
  resolutionLabel: string;
  negotiatedWidth: number;
  negotiatedHeight: number;
  negotiatedFps: number | null;
  capabilitiesSummary: string;
}

export interface CameraCaptureCallbacks {
  onCameraArrival: (telemetry: ReadArrivalTelemetry) => void;
  onFrame: (frame: CapturedFrame) => void;
  onFrameDropped: () => void;
  onStreamEnded: (reason: string) => void;
  onError: (err: unknown) => void;
}

export interface CameraCaptureOptions {
  mode: CaptureMode;
  targetFps: number;
  cameraCaptureResolution: CameraCaptureResolution;
  inputMaxWidth: number;
  willReadFrequently?: boolean;
  preferDirectVideoFrame?: boolean;
  bypassInference?: boolean;
}

const DEFAULT_WIDTH = 320;
const DEFAULT_HEIGHT = 240;

function formatCapabilities(track: MediaStreamTrack): string {
  if (typeof track.getCapabilities !== 'function') return 'n/a';
  try {
    const caps = track.getCapabilities() as MediaTrackCapabilities & {
      width?: { min?: number; max?: number };
      height?: { min?: number; max?: number };
      frameRate?: { min?: number; max?: number };
    };
    const w = caps.width ? `${caps.width.min ?? '?'}..${caps.width.max ?? '?'}` : '?';
    const h = caps.height ? `${caps.height.min ?? '?'}..${caps.height.max ?? '?'}` : '?';
    const fps = caps.frameRate ? `${caps.frameRate.min ?? '?'}..${caps.frameRate.max ?? '?'}` : '?';
    return `w:${w}, h:${h}, fps:${fps}`;
  } catch {
    return 'n/a';
  }
}

/**
 * Webcam frame capture controller for MV3 Offscreen Document.
 * Primary path uses MediaStreamTrackProcessor(maxBufferSize: 1) with a decoupled latest-frame-wins
 * reader and MessageChannel scheduler, instrumenting reader.read() wait/call intervals,
 * hardware VideoFrame.timestamp deltas, and MessageChannel dispatch latency.
 */
export class CameraCapture {
  private stream: MediaStream | null = null;
  private reader: ReadableStreamDefaultReader<VideoFrame> | null = null;
  private videoEl: HTMLVideoElement | null = null;
  private fallbackTimerId: number | null = null;
  private channel: MessageChannel | null = null;

  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private willReadFrequently = false;
  private preferDirectVideoFrame = true;
  private bypassInference = false;
  private inputMaxWidth = DEFAULT_WIDTH;

  private slot = new LatestFrameSlot<VideoFrame>(30);
  private running = false;
  private draining = false;
  private drainScheduled = false;
  private activeMode: CaptureMode = 'track_processor';
  private targetFps = 30;

  constructor(width = DEFAULT_WIDTH, height = DEFAULT_HEIGHT, willReadFrequently = false) {
    this.willReadFrequently = willReadFrequently;
    this.inputMaxWidth = width;
    this.canvas = document.createElement('canvas');
    this.canvas.width = width;
    this.canvas.height = height;
    this.ctx = this.create2dContext(this.canvas, willReadFrequently);
  }

  private create2dContext(
    canvas: HTMLCanvasElement,
    willReadFrequently: boolean,
  ): CanvasRenderingContext2D {
    const ctx = canvas.getContext('2d', { willReadFrequently });
    if (!ctx) {
      throw new Error('Failed to acquire 2D canvas context in offscreen document');
    }
    return ctx;
  }

  /**
   * Re-creates the backing canvas when switching between GPU (willReadFrequently=false)
   * and CPU (willReadFrequently=true) MediaPipe delegates to avoid GPU<->CPU readback overhead.
   */
  setWillReadFrequently(flag: boolean): void {
    if (this.willReadFrequently === flag) return;
    this.willReadFrequently = flag;
    const nextCanvas = document.createElement('canvas');
    nextCanvas.width = this.canvas.width;
    nextCanvas.height = this.canvas.height;
    this.canvas = nextCanvas;
    this.ctx = this.create2dContext(nextCanvas, flag);
  }

  setPreferDirectVideoFrame(flag: boolean): void {
    this.preferDirectVideoFrame = flag;
  }

  setInputMaxWidth(maxWidth: number): void {
    this.inputMaxWidth = Math.max(160, Math.min(640, Math.round(maxWidth)));
  }

  getActiveMode(): CaptureMode {
    return this.activeMode;
  }

  isRunning(): boolean {
    return this.running;
  }

  updateTargetFps(targetFps: number): void {
    this.targetFps = Math.max(5, Math.min(30, targetFps));
    this.slot.setTargetFps(this.targetFps);
  }

  async start(options: CameraCaptureOptions, callbacks: CameraCaptureCallbacks): Promise<CameraStartResult> {
    await this.stop();

    this.setInputMaxWidth(options.inputMaxWidth);
    this.setWillReadFrequently(Boolean(options.willReadFrequently));
    this.setPreferDirectVideoFrame(Boolean(options.preferDirectVideoFrame));
    this.bypassInference = Boolean(options.bypassInference);
    this.updateTargetFps(options.targetFps);

    const idealHeight = Math.round((this.inputMaxWidth * 3) / 4);
    this.canvas.width = this.inputMaxWidth;
    this.canvas.height = idealHeight;

    const stream = await this.acquireCameraStream(options.cameraCaptureResolution, this.targetFps);

    const videoTrack = stream.getVideoTracks()[0];
    if (!videoTrack) {
      stream.getTracks().forEach((t) => t.stop());
      throw new Error('Webcam stream has no video track');
    }

    const settings = videoTrack.getSettings();
    const negotiatedWidth = settings.width ?? this.inputMaxWidth;
    const negotiatedHeight = settings.height ?? idealHeight;
    const negotiatedFps =
      typeof settings.frameRate === 'number' && Number.isFinite(settings.frameRate)
        ? Math.round(settings.frameRate * 10) / 10
        : null;
    const resolutionLabel = `${negotiatedWidth}x${negotiatedHeight}@${negotiatedFps ?? '?'}fps`;
    const capabilitiesSummary = formatCapabilities(videoTrack);

    this.stream = stream;
    this.running = true;
    this.draining = false;
    this.drainScheduled = false;
    this.slot.clear();

    videoTrack.onended = () => {
      if (this.running) {
        this.running = false;
        callbacks.onStreamEnded('Video track ended by browser or OS');
      }
    };

    const processorCtor = window.MediaStreamTrackProcessor;
    if (options.mode === 'track_processor' && typeof processorCtor === 'function') {
      this.activeMode = 'track_processor';
      this.startTrackProcessorLoop(processorCtor, videoTrack, callbacks);
    } else {
      this.activeMode = 'timer_fallback';
      await this.startTimerFallbackLoop(stream, callbacks);
    }

    return {
      activeMode: this.activeMode,
      resolutionLabel,
      negotiatedWidth,
      negotiatedHeight,
      negotiatedFps,
      capabilitiesSummary,
    };
  }

  private async acquireCameraStream(
    preset: CameraCaptureResolution,
    targetFps: number,
  ): Promise<MediaStream> {
    const dimConstraints =
      preset === '320x240'
        ? { width: { ideal: 320 }, height: { ideal: 240 } }
        : preset === '640x480'
          ? { width: { ideal: 640 }, height: { ideal: 480 } }
          : {};

    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          ...dimConstraints,
          frameRate: { ideal: targetFps, min: 15, max: 30 },
          facingMode: 'user',
        },
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'OverconstrainedError') {
        return navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            ...dimConstraints,
            frameRate: { ideal: targetFps },
            facingMode: 'user',
          },
        });
      }
      throw err;
    }
  }

  private startTrackProcessorLoop(
    ProcessorCtor: TrackProcessorCtor,
    track: MediaStreamTrack,
    callbacks: CameraCaptureCallbacks,
  ): void {
    const processor = new ProcessorCtor({ track, maxBufferSize: 1 });
    const reader = processor.readable.getReader();
    this.reader = reader;

    // MessageChannel schedules macrotasks without requestAnimationFrame pause or timer clamping.
    const channel = new MessageChannel();
    this.channel = channel;
    let lastPostMessageMs = 0;

    const scheduleDrain = () => {
      if (!this.running || this.drainScheduled || this.draining) return;
      this.drainScheduled = true;
      lastPostMessageMs = performance.now();
      channel.port1.postMessage(null);
    };

    channel.port2.onmessage = () => {
      this.drainScheduled = false;
      if (!this.running || this.draining) return;

      const startNow = performance.now();
      const scheduleDelayMs = lastPostMessageMs > 0 ? Math.max(0, startNow - lastPostMessageMs) : 0;

      const { item, droppedByRateLimit } = this.slot.takeIfReady(startNow);
      if (droppedByRateLimit) {
        callbacks.onFrameDropped();
        return;
      }
      if (!item) return;

      this.draining = true;
      const { frame: videoFrame, arrivalMs } = item;
      const queueDelayMs = Math.max(0, startNow - arrivalMs);

      try {
        if (this.bypassInference) {
          // Diagnostic mode: close VideoFrame immediately without any copy or MediaPipe/WebGL call.
          videoFrame.close();
          callbacks.onFrame({
            source: null,
            isDirectVideoFrame: false,
            inputPath: 'bypass_inference',
            timestampMs: arrivalMs,
            arrivalMs,
            scheduleDelayMs,
            queueDelayMs,
            blitMs: 0,
          });
          return;
        }

        const srcW = videoFrame.displayWidth || videoFrame.codedWidth || this.inputMaxWidth;
        const srcH =
          videoFrame.displayHeight || videoFrame.codedHeight || Math.round((this.inputMaxWidth * 3) / 4);
        const scaled = computeScaledDimensions(srcW, srcH, this.inputMaxWidth);

        if (this.preferDirectVideoFrame && !scaled.needsDownscale) {
          try {
            callbacks.onFrame({
              source: videoFrame,
              isDirectVideoFrame: true,
              inputPath: 'video_frame_zero_copy',
              timestampMs: arrivalMs,
              arrivalMs,
              scheduleDelayMs,
              queueDelayMs,
              blitMs: 0,
            });
          } finally {
            videoFrame.close();
          }
        } else {
          if (this.canvas.width !== scaled.width || this.canvas.height !== scaled.height) {
            this.canvas.width = scaled.width;
            this.canvas.height = scaled.height;
          }
          const blitStart = performance.now();
          try {
            this.ctx.drawImage(videoFrame, 0, 0, scaled.width, scaled.height);
          } finally {
            videoFrame.close();
          }
          const blitMs = performance.now() - blitStart;

          callbacks.onFrame({
            source: this.canvas,
            isDirectVideoFrame: false,
            inputPath: 'canvas_downscale',
            timestampMs: arrivalMs,
            arrivalMs,
            scheduleDelayMs,
            queueDelayMs,
            blitMs,
          });
        }
      } catch (err) {
        if (this.running) {
          callbacks.onError(err);
        }
      } finally {
        this.draining = false;
        if (this.running && this.slot.hasPending()) {
          scheduleDrain();
        }
      }
    };

    // Decoupled reader loop with exact read() call interval, wait duration, and VideoFrame.timestamp logging.
    const pumpReader = async () => {
      let prevReadCallStartMs: number | null = null;
      let prevReadResolveMs: number | null = null;

      try {
        while (this.running) {
          const readCallStartMs = performance.now();
          const readCallIntervalMs =
            prevReadCallStartMs !== null ? Math.max(0, readCallStartMs - prevReadCallStartMs) : null;
          const readToNextReadCallMs =
            prevReadResolveMs !== null ? Math.max(0, readCallStartMs - prevReadResolveMs) : null;
          prevReadCallStartMs = readCallStartMs;

          const { value: videoFrame, done } = await reader.read();
          if (done) {
            if (this.running) {
              this.running = false;
              callbacks.onStreamEnded('MediaStreamTrackProcessor stream completed');
            }
            break;
          }

          const readResolveMs = performance.now();
          const readWaitMs = Math.max(0, readResolveMs - readCallStartMs);
          prevReadResolveMs = readResolveMs;

          callbacks.onCameraArrival({
            readCallStartMs,
            readResolveMs,
            readWaitMs,
            readCallIntervalMs,
            readToNextReadCallMs,
            videoFrameTimestampUs:
              typeof videoFrame.timestamp === 'number' && Number.isFinite(videoFrame.timestamp)
                ? videoFrame.timestamp
                : null,
            processorTotalFrames:
              typeof processor.totalFrames === 'number' ? processor.totalFrames : null,
            processorDiscardedFrames:
              typeof processor.discardedFrames === 'number' ? processor.discardedFrames : null,
          });

          const droppedOlder = this.slot.push(videoFrame, readResolveMs);
          if (droppedOlder) {
            callbacks.onFrameDropped();
          }
          scheduleDrain();
        }
      } catch (err) {
        if (this.running) {
          callbacks.onError(err);
        }
      }
    };

    void pumpReader();
  }

  private async startTimerFallbackLoop(
    stream: MediaStream,
    callbacks: CameraCaptureCallbacks,
  ): Promise<void> {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.autoplay = true;
    video.srcObject = stream;
    this.videoEl = video;

    await video.play();

    let prevTickMs: number | null = null;
    const intervalMs = Math.max(33, Math.round(1000 / this.targetFps));
    this.fallbackTimerId = window.setInterval(() => {
      if (!this.running || !this.videoEl) return;
      if (this.videoEl.readyState < 2) return;

      const arrivalMs = performance.now();
      const callInterval = prevTickMs !== null ? Math.max(0, arrivalMs - prevTickMs) : null;
      prevTickMs = arrivalMs;

      callbacks.onCameraArrival({
        readCallStartMs: arrivalMs,
        readResolveMs: arrivalMs,
        readWaitMs: 0,
        readCallIntervalMs: callInterval,
        readToNextReadCallMs: callInterval,
        videoFrameTimestampUs: null,
        processorTotalFrames: null,
        processorDiscardedFrames: null,
      });

      if (this.draining) {
        callbacks.onFrameDropped();
        return;
      }

      this.draining = true;
      try {
        if (this.bypassInference) {
          callbacks.onFrame({
            source: null,
            isDirectVideoFrame: false,
            inputPath: 'bypass_inference',
            timestampMs: arrivalMs,
            arrivalMs,
            scheduleDelayMs: 0,
            queueDelayMs: 0,
            blitMs: 0,
          });
          return;
        }

        const scaled = computeScaledDimensions(
          this.videoEl.videoWidth || this.inputMaxWidth,
          this.videoEl.videoHeight || Math.round((this.inputMaxWidth * 3) / 4),
          this.inputMaxWidth,
        );
        if (this.canvas.width !== scaled.width || this.canvas.height !== scaled.height) {
          this.canvas.width = scaled.width;
          this.canvas.height = scaled.height;
        }
        const blitStart = performance.now();
        this.ctx.drawImage(this.videoEl, 0, 0, scaled.width, scaled.height);
        const blitMs = performance.now() - blitStart;
        callbacks.onFrame({
          source: this.canvas,
          isDirectVideoFrame: false,
          inputPath: 'timer_video_canvas',
          timestampMs: arrivalMs,
          arrivalMs,
          scheduleDelayMs: 0,
          queueDelayMs: 0,
          blitMs,
        });
      } catch (err) {
        callbacks.onError(err);
      } finally {
        this.draining = false;
      }
    }, intervalMs);
  }

  async stop(): Promise<void> {
    this.running = false;
    this.drainScheduled = false;
    this.slot.clear();

    if (this.channel) {
      this.channel.port1.close();
      this.channel.port2.close();
      this.channel = null;
    }

    if (this.fallbackTimerId !== null) {
      window.clearInterval(this.fallbackTimerId);
      this.fallbackTimerId = null;
    }

    if (this.reader) {
      try {
        await this.reader.cancel();
      } catch {
        // Ignore reader cancel errors during teardown.
      }
      this.reader.releaseLock();
      this.reader = null;
    }

    if (this.videoEl) {
      this.videoEl.pause();
      this.videoEl.srcObject = null;
      this.videoEl = null;
    }

    if (this.stream) {
      for (const track of this.stream.getTracks()) {
        track.onended = null;
        track.stop();
      }
      this.stream = null;
    }

    this.draining = false;
  }
}

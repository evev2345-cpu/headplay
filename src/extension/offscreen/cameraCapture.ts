import { CaptureMode } from '../../core/config/gestureConfig';

// Minimal ambient declaration for Chromium's MediaStreamTrackProcessor API (Insertable Streams).
interface TrackProcessorCtor {
  new (init: { track: MediaStreamTrack }): {
    readable: ReadableStream<VideoFrame>;
  };
}

declare global {
  interface Window {
    MediaStreamTrackProcessor?: TrackProcessorCtor;
  }
}

export interface CapturedFrame {
  canvas: HTMLCanvasElement;
  timestampMs: number;
  blitMs: number;
}

export interface CameraCaptureCallbacks {
  onFrame: (frame: CapturedFrame) => void;
  onFrameDropped: () => void;
  onStreamEnded: (reason: string) => void;
  onError: (err: unknown) => void;
}

export interface CameraCaptureOptions {
  mode: CaptureMode;
  targetFps: number;
  willReadFrequently?: boolean;
  width?: number;
  height?: number;
}

const DEFAULT_WIDTH = 320;
const DEFAULT_HEIGHT = 240;

/**
 * Webcam frame capture controller for MV3 Offscreen Document.
 * Primary path uses MediaStreamTrackProcessor (event-driven, independent of requestAnimationFrame).
 * Secondary path (timer_fallback) exists explicitly for Phase 1 comparison experiments.
 */
export class CameraCapture {
  private stream: MediaStream | null = null;
  private reader: ReadableStreamDefaultReader<VideoFrame> | null = null;
  private videoEl: HTMLVideoElement | null = null;
  private fallbackTimerId: number | null = null;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private willReadFrequently = false;

  private running = false;
  private processingFrame = false;
  private lastAcceptedMs = 0;
  private activeMode: CaptureMode = 'track_processor';
  private minFrameIntervalMs = 40;

  constructor(width = DEFAULT_WIDTH, height = DEFAULT_HEIGHT, willReadFrequently = false) {
    this.willReadFrequently = willReadFrequently;
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

  getActiveMode(): CaptureMode {
    return this.activeMode;
  }

  isRunning(): boolean {
    return this.running;
  }

  updateTargetFps(targetFps: number): void {
    const safeFps = Math.max(5, Math.min(30, targetFps));
    this.minFrameIntervalMs = 1000 / safeFps;
  }

  async start(options: CameraCaptureOptions, callbacks: CameraCaptureCallbacks): Promise<CaptureMode> {
    await this.stop();

    const width = options.width ?? DEFAULT_WIDTH;
    const height = options.height ?? DEFAULT_HEIGHT;
    this.setWillReadFrequently(Boolean(options.willReadFrequently));
    this.canvas.width = width;
    this.canvas.height = height;
    this.updateTargetFps(options.targetFps);

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        width: { ideal: width },
        height: { ideal: height },
        frameRate: { ideal: options.targetFps, max: 30 },
        facingMode: 'user',
      },
    });

    const videoTrack = stream.getVideoTracks()[0];
    if (!videoTrack) {
      stream.getTracks().forEach((t) => t.stop());
      throw new Error('Webcam stream has no video track');
    }

    this.stream = stream;
    this.running = true;
    this.processingFrame = false;
    this.lastAcceptedMs = 0;

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

    return this.activeMode;
  }

  private startTrackProcessorLoop(
    ProcessorCtor: TrackProcessorCtor,
    track: MediaStreamTrack,
    callbacks: CameraCaptureCallbacks,
  ): void {
    const processor = new ProcessorCtor({ track });
    const reader = processor.readable.getReader();
    this.reader = reader;

    const pump = async () => {
      try {
        while (this.running) {
          const { value: videoFrame, done } = await reader.read();
          if (done) {
            if (this.running) {
              this.running = false;
              callbacks.onStreamEnded('MediaStreamTrackProcessor stream completed');
            }
            break;
          }

          const now = performance.now();

          // Backpressure & rate-limit drop: release hardware VideoFrame immediately.
          if (this.processingFrame || now - this.lastAcceptedMs < this.minFrameIntervalMs * 0.85) {
            videoFrame.close();
            callbacks.onFrameDropped();
            continue;
          }

          this.processingFrame = true;
          const blitStart = performance.now();
          try {
            this.ctx.drawImage(videoFrame, 0, 0, this.canvas.width, this.canvas.height);
          } finally {
            // Always close VideoFrame immediately after blitting to canvas to avoid buffer leaks.
            videoFrame.close();
          }
          const blitMs = performance.now() - blitStart;

          this.lastAcceptedMs = now;
          try {
            callbacks.onFrame({ canvas: this.canvas, timestampMs: now, blitMs });
          } finally {
            this.processingFrame = false;
          }
        }
      } catch (err) {
        if (this.running) {
          callbacks.onError(err);
        }
      }
    };

    void pump();
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

    const intervalMs = Math.max(33, Math.round(this.minFrameIntervalMs));
    this.fallbackTimerId = window.setInterval(() => {
      if (!this.running || !this.videoEl) return;
      if (this.videoEl.readyState < 2) return;
      if (this.processingFrame) {
        callbacks.onFrameDropped();
        return;
      }

      const now = performance.now();
      this.processingFrame = true;
      try {
        const blitStart = performance.now();
        this.ctx.drawImage(this.videoEl, 0, 0, this.canvas.width, this.canvas.height);
        const blitMs = performance.now() - blitStart;
        this.lastAcceptedMs = now;
        callbacks.onFrame({ canvas: this.canvas, timestampMs: now, blitMs });
      } catch (err) {
        callbacks.onError(err);
      } finally {
        this.processingFrame = false;
      }
    }, intervalMs);
  }

  async stop(): Promise<void> {
    this.running = false;

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

    this.processingFrame = false;
  }
}

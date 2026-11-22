import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';
import { DelegatePreference } from '../../core/config/gestureConfig';
import { RawFaceFrame } from '../../core/vision/types';

export interface FaceTrackerInitResult {
  activeDelegate: DelegatePreference;
  fellBackToCpu: boolean;
}

export interface FaceDetectResult {
  frame: RawFaceFrame;
  inferMs: number;
}

/**
 * Local-only wrapper around MediaPipe FaceLandmarker.
 * All WASM binaries and .task models are loaded strictly via chrome.runtime.getURL().
 */
export class FaceTracker {
  private landmarker: FaceLandmarker | null = null;
  private activeDelegate: DelegatePreference = 'CPU';
  private lastSentTimestampMs = 0;
  private switchingToCpu = false;

  getActiveDelegate(): DelegatePreference {
    return this.activeDelegate;
  }

  async init(preference: DelegatePreference): Promise<FaceTrackerInitResult> {
    this.close();

    const wasmBasePath = chrome.runtime.getURL('vendor/mediapipe/wasm');
    const modelAssetPath = chrome.runtime.getURL('vendor/mediapipe/face_landmarker.task');
    const vision = await FilesetResolver.forVisionTasks(wasmBasePath);

    if (preference === 'GPU') {
      try {
        this.landmarker = await this.createLandmarker(vision, modelAssetPath, 'GPU');
        this.activeDelegate = 'GPU';
        return { activeDelegate: 'GPU', fellBackToCpu: false };
      } catch (gpuErr) {
        console.warn('[HEADPLAY][FaceTracker] GPU delegate init failed; falling back to CPU:', gpuErr);
      }
    }

    this.landmarker = await this.createLandmarker(vision, modelAssetPath, 'CPU');
    this.activeDelegate = 'CPU';
    return { activeDelegate: 'CPU', fellBackToCpu: preference === 'GPU' };
  }

  private async createLandmarker(
    vision: Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>,
    modelAssetPath: string,
    delegate: DelegatePreference,
  ): Promise<FaceLandmarker> {
    return FaceLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath,
        delegate,
      },
      runningMode: 'VIDEO',
      numFaces: 1,
      outputFaceBlendshapes: true,
      outputFacialTransformationMatrixes: true,
      minFaceDetectionConfidence: 0.5,
      minFacePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
  }

  detect(
    canvas: HTMLCanvasElement,
    timestampMs: number,
    onFallbackToCpu?: (err: unknown) => void,
  ): FaceDetectResult {
    if (!this.landmarker || this.switchingToCpu) {
      return { frame: { timestampMs, faceDetected: false }, inferMs: 0 };
    }

    // MediaPipe VIDEO mode requires strictly monotonically increasing integer timestamps.
    const safeTs = Math.max(Math.round(timestampMs), this.lastSentTimestampMs + 1);
    this.lastSentTimestampMs = safeTs;

    const inferStart = performance.now();
    try {
      const result = this.landmarker.detectForVideo(canvas, safeTs);
      const inferMs = performance.now() - inferStart;
      const landmarks = result.faceLandmarks?.[0];
      const blendshapes = result.faceBlendshapes?.[0]?.categories;
      const facialTransformationMatrix = result.facialTransformationMatrixes?.[0]?.data;

      if (!landmarks || landmarks.length === 0) {
        return { frame: { timestampMs, faceDetected: false }, inferMs };
      }

      return {
        frame: {
          timestampMs,
          faceDetected: true,
          landmarks,
          blendshapes,
          facialTransformationMatrix,
        },
        inferMs,
      };
    } catch (err) {
      const inferMs = performance.now() - inferStart;
      // If GPU/WebGL fails mid-session (e.g. context lost on minimize), trigger async CPU fallback.
      if (this.activeDelegate === 'GPU' && !this.switchingToCpu) {
        this.switchingToCpu = true;
        console.warn('[HEADPLAY][FaceTracker] GPU inference error; switching to CPU:', err);
        void this.init('CPU')
          .then(() => {
            this.switchingToCpu = false;
            onFallbackToCpu?.(err);
          })
          .catch((fallbackErr) => {
            this.switchingToCpu = false;
            console.error('[HEADPLAY][FaceTracker] CPU fallback failed:', fallbackErr);
          });
      }
      return { frame: { timestampMs, faceDetected: false }, inferMs };
    }
  }

  close(): void {
    if (this.landmarker) {
      try {
        this.landmarker.close();
      } catch {
        // Ignore teardown errors
      }
      this.landmarker = null;
    }
    this.lastSentTimestampMs = 0;
    this.switchingToCpu = false;
  }
}

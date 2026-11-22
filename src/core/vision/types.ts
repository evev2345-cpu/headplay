export type EyeState = 'OPEN' | 'CLOSED';
export type GazeDirection = 'LEFT' | 'CENTER' | 'RIGHT' | 'UNKNOWN';

export interface NormalizedLandmark {
  x: number;
  y: number;
  z?: number;
}

export interface BlendshapeCategory {
  categoryName: string;
  score: number;
}

export interface RawFaceFrame {
  timestampMs: number;
  faceDetected: boolean;
  landmarks?: NormalizedLandmark[];
  blendshapes?: BlendshapeCategory[];
  facialTransformationMatrix?: number[];
}

export interface EyeObservation {
  timestampMs: number;
  faceDetected: boolean;
  blinkLeft: number;
  blinkRight: number;
  blinkMin: number;
  blinkMax: number;
  earLeft: number | null;
  earRight: number | null;
  eyeState: EyeState;
  gazeRawBlendshape: number | null;
  gazeRawIris: number | null;
  gazeSmoothed: number | null;
  gazeDirection: GazeDirection;
  headYawDeg: number | null;
  gazeSuppressedByHeadTurn: boolean;
}

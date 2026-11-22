import { CaptureMode, DelegatePreference, GestureConfig } from '../core/config/gestureConfig';
import { DiagnosticLogEntry, SessionMetricsSnapshot } from '../core/diagnostics/sessionMetrics';
import { GestureCommand } from '../core/gesture/gestureStateMachine';
import {
  YouTubeControlLogEntry,
  YouTubeControlStatusSummary,
  YouTubeExecutionStatus,
  YouTubePageType,
  YouTubePlayerSnapshot,
  YouTubePlayerStateBrief,
} from '../core/youtube/types';

export type TrackingLifecycleState =
  | 'IDLE'
  | 'STARTING'
  | 'RUNNING'
  | 'STOPPING'
  | 'ERROR';

export type PermissionHint = 'UNKNOWN' | 'GRANTED' | 'DENIED';

export type TrackingErrorCode =
  | 'PERMISSION_DENIED'
  | 'NO_CAMERA'
  | 'MEDIAPIPE_INIT_FAILED'
  | 'STREAM_ENDED'
  | 'UNKNOWN';

export interface LastGestureCommandInfo {
  commandId?: string;
  command: GestureCommand;
  timestampMs: number;
  wallTimeIso: string;
  details: Record<string, number | string>;
}

export interface BackgroundStatusResponse {
  lifecycleState: TrackingLifecycleState;
  offscreenOpen: boolean;
  permissionHint: PermissionHint;
  lastError: { code: TrackingErrorCode; message: string } | null;
  lastCommand: LastGestureCommandInfo | null;
  config: GestureConfig;
  metrics: SessionMetricsSnapshot | null;
  logs: DiagnosticLogEntry[];
  youtubeStatus: YouTubeControlStatusSummary;
  youtubeLogs: YouTubeControlLogEntry[];
}

export type YouTubePlayerEventType =
  | 'MOUNTED'
  | 'PLAY'
  | 'PAUSE'
  | 'ENDED'
  | 'NAVIGATED';

// Messages sent TO Background Service Worker
export type BackgroundMessage =
  | { target: 'background'; type: 'GET_STATUS'; logLimit?: number }
  | { target: 'background'; type: 'START_TRACKING' }
  | { target: 'background'; type: 'STOP_TRACKING' }
  | { target: 'background'; type: 'OPEN_PERMISSION_PAGE'; autoStart?: boolean }
  | { target: 'background'; type: 'PERMISSION_GRANTED'; autoStart?: boolean }
  | { target: 'background'; type: 'PERMISSION_DENIED'; message?: string }
  | { target: 'background'; type: 'UPDATE_CONFIG'; partial: Partial<GestureConfig> }
  | { target: 'background'; type: 'RESET_CONFIG' }
  | { target: 'background'; type: 'ADD_MARKER'; label: string }
  | { target: 'background'; type: 'CLEAR_LOGS' }
  | { target: 'background'; type: 'EXPORT_LOGS'; format: 'json' | 'csv' }
  | {
      target: 'background';
      type: 'OFFSCREEN_TRACKING_STARTED';
      captureMode: CaptureMode;
      activeDelegate: DelegatePreference | 'BYPASS';
    }
  | {
      target: 'background';
      type: 'OFFSCREEN_TRACKING_STOPPED';
      reason: string;
    }
  | {
      target: 'background';
      type: 'OFFSCREEN_TRACKING_ERROR';
      code: TrackingErrorCode;
      message: string;
    }
  | {
      target: 'background';
      type: 'OFFSCREEN_GESTURE_COMMAND';
      command: GestureCommand;
      timestampMs: number;
      details: Record<string, number | string>;
    }
  | {
      target: 'background';
      type: 'YOUTUBE_PLAYER_EVENT';
      eventType: YouTubePlayerEventType;
      snapshot: YouTubePlayerSnapshot;
    };

// Messages sent TO Offscreen Document
export type OffscreenMessage =
  | { target: 'offscreen'; type: 'OFFSCREEN_START'; config: GestureConfig }
  | { target: 'offscreen'; type: 'OFFSCREEN_STOP' }
  | { target: 'offscreen'; type: 'OFFSCREEN_UPDATE_CONFIG'; config: GestureConfig }
  | { target: 'offscreen'; type: 'OFFSCREEN_GET_DIAGNOSTICS'; logLimit?: number }
  | { target: 'offscreen'; type: 'OFFSCREEN_ADD_MARKER'; label: string; meta?: Record<string, unknown> }
  | { target: 'offscreen'; type: 'OFFSCREEN_CLEAR_LOGS' }
  | { target: 'offscreen'; type: 'OFFSCREEN_EXPORT_LOGS'; format: 'json' | 'csv' };

// Messages sent TO YouTube Content Script
export type YouTubeContentMessage =
  | { target: 'youtube-content'; type: 'YOUTUBE_PROBE_STATE' }
  | {
      target: 'youtube-content';
      type: 'YOUTUBE_EXECUTE_COMMAND';
      commandId: string;
      command: GestureCommand;
    };

export interface YouTubeProbeResponse {
  ok: boolean;
  snapshot: YouTubePlayerSnapshot;
}

export interface YouTubeExecuteResponse {
  ok: boolean;
  commandId: string;
  command: GestureCommand;
  status: YouTubeExecutionStatus;
  verified: boolean;
  reason: string;
  pageType: YouTubePageType;
  beforeState: YouTubePlayerStateBrief | null;
  afterState: YouTubePlayerStateBrief | null;
  snapshot: YouTubePlayerSnapshot;
}

export type ExtensionMessage = BackgroundMessage | OffscreenMessage | YouTubeContentMessage;

export interface OffscreenDiagnosticsResponse {
  ok: boolean;
  running: boolean;
  metrics: SessionMetricsSnapshot;
  logs: DiagnosticLogEntry[];
}

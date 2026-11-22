import { WindowVisibilityMarker } from '../diagnostics/windowVisibility';
import { GestureCommand } from '../gesture/gestureStateMachine';

export type YouTubePageType = 'WATCH' | 'PLAYLIST' | 'SHORTS' | 'OTHER';

export interface YouTubePlayerSnapshot {
  /** Unique per content-script mount; changes on full page reload. */
  contentScriptInstanceId: string;
  /** Increments on every SPA navigation / video change within the same tab. */
  navigationEpoch: number;
  url: string;
  title: string;
  pageType: YouTubePageType;
  videoId: string | null;
  hasPlayableVideo: boolean;
  isPlaying: boolean;
  isPaused: boolean;
  isEnded: boolean;
  currentTimeSec: number | null;
  durationSec: number | null;
  /**
   * Timestamp (Date.now()) of the most recent actual DOM play/playing event
   * for the currently mounted playable page. Null if never played since load/navigation.
   */
  lastPlayStartedAtMs: number | null;
  /** Timestamp (Date.now()) of the most recent actual DOM pause event. */
  lastPausedAtMs: number | null;
  canNext: boolean;
  canPrev: boolean;
  capturedAtMs: number;
}

export interface TrackedYouTubeTab {
  tabId: number;
  windowId: number;
  activeInWindow: boolean;
  audible: boolean;
  url: string;
  title: string;
  pageType: YouTubePageType;
  videoId: string | null;
  contentScriptReady: boolean;
  contentScriptInstanceId: string | null;
  navigationEpoch: number;
  hasPlayableVideo: boolean;
  isPlaying: boolean;
  isPaused: boolean;
  lastPlayStartedAtMs: number | null;
  lastPausedAtMs: number | null;
  lastStateUpdatedAtMs: number;
  canNext: boolean;
  canPrev: boolean;
  probeError?: string;
}

export type TargetSelectionReason =
  | 'SINGLE_PLAYING_TAB'
  | 'MOST_RECENT_PLAYING_TAB'
  | 'LAST_CONTROLLED_TAB'
  | 'LAST_PLAYED_PAUSED_TAB'
  | 'SINGLE_PAUSED_PLAYABLE_TAB'
  | 'NO_YOUTUBE_TAB'
  | 'NO_PLAYABLE_YOUTUBE_TAB'
  | 'AMBIGUOUS_TARGET'
  | 'CONTENT_SCRIPT_NOT_READY';

export interface TargetSelectionCandidateSummary {
  tabId: number;
  pageType: YouTubePageType;
  videoId: string | null;
  hasPlayableVideo: boolean;
  isPlaying: boolean;
  contentScriptReady: boolean;
  lastPlayStartedAtMs: number | null;
  isLastControlled: boolean;
}

export interface TargetSelectionResult {
  selectedTab: TrackedYouTubeTab | null;
  reason: TargetSelectionReason;
  candidateCount: number;
  playableCount: number;
  playingCount: number;
  candidates: TargetSelectionCandidateSummary[];
}

export type YouTubeExecutionStatus = 'EXECUTED' | 'UNSUPPORTED' | 'SKIPPED' | 'FAILED';

export interface YouTubePlayerStateBrief {
  url: string;
  pageType: YouTubePageType;
  videoId: string | null;
  paused: boolean | null;
  ended: boolean | null;
  currentTimeSec: number | null;
}

export interface YouTubeExecutionResult {
  commandId: string;
  command: GestureCommand;
  tabId: number | null;
  status: YouTubeExecutionStatus;
  verified: boolean;
  reason: string;
  pageType: YouTubePageType;
  beforeState: YouTubePlayerStateBrief | null;
  afterState: YouTubePlayerStateBrief | null;
  latencyMs: number;
  windowVisibility: WindowVisibilityMarker;
  wallTimeIso: string;
}

export type YouTubeAuditStage =
  | 'YOUTUBE_COMMAND_RECEIVED'
  | 'YOUTUBE_TARGET_SELECTED'
  | 'YOUTUBE_EXECUTION_RESULT';

export interface YouTubeControlLogEntry {
  id: number;
  commandId: string;
  stage: YouTubeAuditStage;
  wallTimeIso: string;
  timestampMs: number;
  windowVisibility: WindowVisibilityMarker;
  summary: string;
  data: Record<string, unknown>;
}

export interface YouTubeControlStatusSummary {
  trackedTabCount: number;
  playableTabCount: number;
  playingTabCount: number;
  lastControlledTabId: number | null;
  lastControlledTitle: string | null;
  lastControlledPageType: YouTubePageType | null;
  lastExecution: YouTubeExecutionResult | null;
}

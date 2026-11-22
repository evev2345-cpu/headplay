import { GestureCommand } from '../gesture/gestureStateMachine';
import { YouTubeExecutionStatus, YouTubePlayerStateBrief } from './types';

export interface VerificationOutcome {
  status: YouTubeExecutionStatus;
  verified: boolean;
  reason: string;
}

/**
 * Verifies that TOGGLE_PLAY_PAUSE actually changed the real <video> paused state.
 * Never marks success based on method invocation alone.
 */
export function verifyTogglePlayPauseOutcome(
  expectedTargetPaused: boolean,
  before: YouTubePlayerStateBrief,
  after: YouTubePlayerStateBrief,
): VerificationOutcome {
  if (before.paused === null || after.paused === null) {
    return {
      status: 'FAILED',
      verified: false,
      reason: 'VIDEO_STATE_UNAVAILABLE',
    };
  }

  if (expectedTargetPaused) {
    if (after.paused === true) {
      return {
        status: 'EXECUTED',
        verified: true,
        reason: 'PAUSED_VERIFIED',
      };
    }
    return {
      status: 'FAILED',
      verified: false,
      reason: 'PAUSE_STATE_NOT_CHANGED',
    };
  }

  // Expected play (paused === false)
  if (after.paused === false) {
    return {
      status: 'EXECUTED',
      verified: true,
      reason: 'PLAYING_VERIFIED',
    };
  }

  return {
    status: 'FAILED',
    verified: false,
    reason: 'PLAY_STATE_NOT_CHANGED',
  };
}

/**
 * Verifies that NEXT_VIDEO or PREV_VIDEO actually transitioned to a different video.
 * Does NOT report success merely because a DOM button was clicked.
 */
export function verifyVideoNavigationOutcome(
  command: Exclude<GestureCommand, 'TOGGLE_PLAY_PAUSE'>,
  before: YouTubePlayerStateBrief,
  after: YouTubePlayerStateBrief,
): VerificationOutcome {
  const beforeId = before.videoId;
  const afterId = after.videoId;

  // Primary check: videoId changed to a valid new videoId
  if (beforeId && afterId && beforeId !== afterId) {
    return {
      status: 'EXECUTED',
      verified: true,
      reason: command === 'NEXT_VIDEO' ? 'NEXT_VIDEO_CHANGED' : 'PREV_VIDEO_CHANGED',
    };
  }

  // Secondary check: playable URL changed to another playable page even if videoId was missing
  if (before.url !== after.url && after.pageType !== 'OTHER' && afterId !== null && afterId !== beforeId) {
    return {
      status: 'EXECUTED',
      verified: true,
      reason: command === 'NEXT_VIDEO' ? 'NEXT_URL_CHANGED' : 'PREV_URL_CHANGED',
    };
  }

  // If clicking PREV_VIDEO restarted the same video instead of changing to the previous video,
  // report honestly as not transitioned rather than falsely claiming video switch succeeded.
  if (
    command === 'PREV_VIDEO' &&
    before.currentTimeSec !== null &&
    after.currentTimeSec !== null &&
    before.currentTimeSec >= 3 &&
    after.currentTimeSec <= 1.5 &&
    beforeId === afterId
  ) {
    return {
      status: 'FAILED',
      verified: false,
      reason: 'PREV_RESTARTED_SAME_VIDEO_NO_SWITCH',
    };
  }

  return {
    status: 'FAILED',
    verified: false,
    reason: command === 'NEXT_VIDEO' ? 'NEXT_VIDEO_NOT_CHANGED' : 'PREV_VIDEO_NOT_CHANGED',
  };
}

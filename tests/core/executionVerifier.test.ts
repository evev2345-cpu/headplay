import { describe, expect, it } from 'vitest';
import {
  verifyTogglePlayPauseOutcome,
  verifyVideoNavigationOutcome,
} from '../../src/core/youtube/executionVerifier';
import { YouTubePlayerStateBrief } from '../../src/core/youtube/types';

function makeBrief(overrides: Partial<YouTubePlayerStateBrief> = {}): YouTubePlayerStateBrief {
  return {
    url: 'https://www.youtube.com/watch?v=vidA',
    pageType: 'WATCH',
    videoId: 'vidA',
    paused: false,
    ended: false,
    currentTimeSec: 12.5,
    ...overrides,
  };
}

describe('executionVerifier', () => {
  it('verifies actual paused/playing state transitions for TOGGLE_PLAY_PAUSE', () => {
    const pauseOk = verifyTogglePlayPauseOutcome(
      true,
      makeBrief({ paused: false }),
      makeBrief({ paused: true }),
    );
    expect(pauseOk).toEqual({ status: 'EXECUTED', verified: true, reason: 'PAUSED_VERIFIED' });

    const playOk = verifyTogglePlayPauseOutcome(
      false,
      makeBrief({ paused: true }),
      makeBrief({ paused: false }),
    );
    expect(playOk).toEqual({ status: 'EXECUTED', verified: true, reason: 'PLAYING_VERIFIED' });

    // Must NOT mark success if paused state did not actually change
    const playNoChange = verifyTogglePlayPauseOutcome(
      false,
      makeBrief({ paused: true }),
      makeBrief({ paused: true }),
    );
    expect(playNoChange).toEqual({
      status: 'FAILED',
      verified: false,
      reason: 'PLAY_STATE_NOT_CHANGED',
    });

    const pauseNoChange = verifyTogglePlayPauseOutcome(
      true,
      makeBrief({ paused: false }),
      makeBrief({ paused: false }),
    );
    expect(pauseNoChange).toEqual({
      status: 'FAILED',
      verified: false,
      reason: 'PAUSE_STATE_NOT_CHANGED',
    });
  });

  it('requires real videoId change to verify NEXT_VIDEO and PREV_VIDEO', () => {
    const nextOk = verifyVideoNavigationOutcome(
      'NEXT_VIDEO',
      makeBrief({ videoId: 'vidA', url: 'https://www.youtube.com/watch?v=vidA' }),
      makeBrief({ videoId: 'vidB', url: 'https://www.youtube.com/watch?v=vidB' }),
    );
    expect(nextOk).toEqual({ status: 'EXECUTED', verified: true, reason: 'NEXT_VIDEO_CHANGED' });

    const prevOk = verifyVideoNavigationOutcome(
      'PREV_VIDEO',
      makeBrief({
        pageType: 'PLAYLIST',
        videoId: 'vidB',
        url: 'https://www.youtube.com/watch?v=vidB&list=PL1',
      }),
      makeBrief({
        pageType: 'PLAYLIST',
        videoId: 'vidA',
        url: 'https://www.youtube.com/watch?v=vidA&list=PL1',
      }),
    );
    expect(prevOk).toEqual({ status: 'EXECUTED', verified: true, reason: 'PREV_VIDEO_CHANGED' });

    // Button clicked, but videoId stayed the same -> FAILED
    const nextUnchanged = verifyVideoNavigationOutcome(
      'NEXT_VIDEO',
      makeBrief({ videoId: 'vidA' }),
      makeBrief({ videoId: 'vidA' }),
    );
    expect(nextUnchanged).toEqual({
      status: 'FAILED',
      verified: false,
      reason: 'NEXT_VIDEO_NOT_CHANGED',
    });
  });

  it('detects when PREV_VIDEO only restarted the same video without switching tracks', () => {
    const restarted = verifyVideoNavigationOutcome(
      'PREV_VIDEO',
      makeBrief({ videoId: 'vidA', currentTimeSec: 25 }),
      makeBrief({ videoId: 'vidA', currentTimeSec: 0.2 }),
    );
    expect(restarted).toEqual({
      status: 'FAILED',
      verified: false,
      reason: 'PREV_RESTARTED_SAME_VIDEO_NO_SWITCH',
    });
  });
});

import { describe, expect, it } from 'vitest';
import { selectYouTubeTargetTab } from '../../src/core/youtube/targetTabSelector';
import { TrackedYouTubeTab } from '../../src/core/youtube/types';

function makeTab(overrides: Partial<TrackedYouTubeTab> & { tabId: number }): TrackedYouTubeTab {
  return {
    windowId: 1,
    activeInWindow: false,
    audible: false,
    url: `https://www.youtube.com/watch?v=vid_${overrides.tabId}`,
    title: `Video ${overrides.tabId}`,
    pageType: 'WATCH',
    videoId: `vid_${overrides.tabId}`,
    contentScriptReady: true,
    contentScriptInstanceId: `inst_${overrides.tabId}`,
    navigationEpoch: 1,
    hasPlayableVideo: true,
    isPlaying: false,
    isPaused: true,
    lastPlayStartedAtMs: null,
    lastPausedAtMs: null,
    lastStateUpdatedAtMs: 1000,
    canNext: true,
    canPrev: false,
    ...overrides,
  };
}

describe('selectYouTubeTargetTab', () => {
  it('selects the single currently playing tab even when another tab was previously controlled', () => {
    const tab1 = makeTab({ tabId: 1, isPlaying: false, isPaused: true, lastPlayStartedAtMs: 5000 });
    const tab2 = makeTab({ tabId: 2, isPlaying: true, isPaused: false, lastPlayStartedAtMs: 9000 });

    const res = selectYouTubeTargetTab({ tabs: [tab1, tab2], lastControlledTabId: 1 });
    expect(res.selectedTab?.tabId).toBe(2);
    expect(res.reason).toBe('SINGLE_PLAYING_TAB');
  });

  it('prefers the most recently started playing tab when multiple YouTube tabs are playing', () => {
    const tab1 = makeTab({ tabId: 10, isPlaying: true, isPaused: false, lastPlayStartedAtMs: 2000 });
    const tab2 = makeTab({ tabId: 20, isPlaying: true, isPaused: false, lastPlayStartedAtMs: 8500 });
    const tab3 = makeTab({ tabId: 30, isPlaying: true, isPaused: false, lastPlayStartedAtMs: 6000 });

    const res = selectYouTubeTargetTab({ tabs: [tab1, tab2, tab3], lastControlledTabId: 10 });
    expect(res.selectedTab?.tabId).toBe(20);
    expect(res.reason).toBe('MOST_RECENT_PLAYING_TAB');
    expect(res.playingCount).toBe(3);
  });

  it('remembers and selects the last controlled tab when all tabs are paused', () => {
    const tab1 = makeTab({ tabId: 10, isPlaying: false, isPaused: true, lastPlayStartedAtMs: 9000 });
    const tab2 = makeTab({ tabId: 20, isPlaying: false, isPaused: true, lastPlayStartedAtMs: 7000 });

    const res = selectYouTubeTargetTab({ tabs: [tab1, tab2], lastControlledTabId: 20 });
    expect(res.selectedTab?.tabId).toBe(20);
    expect(res.reason).toBe('LAST_CONTROLLED_TAB');
  });

  it('ignores lastControlledTabId if that tab navigated to a non-playable Home page', () => {
    const tab1 = makeTab({
      tabId: 10,
      url: 'https://www.youtube.com/',
      pageType: 'OTHER',
      videoId: null,
      hasPlayableVideo: false,
      isPlaying: false,
      isPaused: false,
      lastPlayStartedAtMs: null,
    });
    const tab2 = makeTab({ tabId: 20, isPlaying: false, isPaused: true, lastPlayStartedAtMs: 4000 });

    const res = selectYouTubeTargetTab({ tabs: [tab1, tab2], lastControlledTabId: 10 });
    expect(res.selectedTab?.tabId).toBe(20);
    expect(res.reason).toBe('LAST_PLAYED_PAUSED_TAB');
  });

  it('refuses arbitrary control (AMBIGUOUS_TARGET) when multiple paused tabs have no play or control history', () => {
    const tab1 = makeTab({ tabId: 1, isPlaying: false, isPaused: true, lastPlayStartedAtMs: null });
    const tab2 = makeTab({ tabId: 2, isPlaying: false, isPaused: true, lastPlayStartedAtMs: null });

    const res = selectYouTubeTargetTab({ tabs: [tab1, tab2], lastControlledTabId: null });
    expect(res.selectedTab).toBeNull();
    expect(res.reason).toBe('AMBIGUOUS_TARGET');
    expect(res.playableCount).toBe(2);
  });

  it('allows controlling a single unambiguous paused playable tab', () => {
    const tab1 = makeTab({ tabId: 5, isPlaying: false, isPaused: true, lastPlayStartedAtMs: null });

    const res = selectYouTubeTargetTab({ tabs: [tab1], lastControlledTabId: null });
    expect(res.selectedTab?.tabId).toBe(5);
    expect(res.reason).toBe('SINGLE_PAUSED_PLAYABLE_TAB');
  });

  it('reports CONTENT_SCRIPT_NOT_READY when playable YouTube tabs have not injected content scripts yet', () => {
    const unready = makeTab({
      tabId: 7,
      contentScriptReady: false,
      hasPlayableVideo: false,
      pageType: 'WATCH',
    });

    const res = selectYouTubeTargetTab({ tabs: [unready], lastControlledTabId: null });
    expect(res.selectedTab).toBeNull();
    expect(res.reason).toBe('CONTENT_SCRIPT_NOT_READY');
  });

  it('reports NO_YOUTUBE_TAB and NO_PLAYABLE_YOUTUBE_TAB cleanly', () => {
    expect(selectYouTubeTargetTab({ tabs: [], lastControlledTabId: null }).reason).toBe(
      'NO_YOUTUBE_TAB',
    );

    const homeTab = makeTab({
      tabId: 8,
      url: 'https://www.youtube.com/',
      pageType: 'OTHER',
      videoId: null,
      hasPlayableVideo: false,
    });
    expect(selectYouTubeTargetTab({ tabs: [homeTab], lastControlledTabId: null }).reason).toBe(
      'NO_PLAYABLE_YOUTUBE_TAB',
    );
  });
});

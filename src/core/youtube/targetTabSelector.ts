import {
  TargetSelectionCandidateSummary,
  TargetSelectionResult,
  TrackedYouTubeTab,
} from './types';

export interface TargetSelectionInput {
  tabs: TrackedYouTubeTab[];
  lastControlledTabId: number | null;
}

function summarizeCandidates(
  tabs: TrackedYouTubeTab[],
  lastControlledTabId: number | null,
): TargetSelectionCandidateSummary[] {
  return tabs.map((tab) => ({
    tabId: tab.tabId,
    pageType: tab.pageType,
    videoId: tab.videoId,
    hasPlayableVideo: tab.hasPlayableVideo,
    isPlaying: tab.isPlaying,
    contentScriptReady: tab.contentScriptReady,
    lastPlayStartedAtMs: tab.lastPlayStartedAtMs,
    isLastControlled: tab.tabId === lastControlledTabId,
  }));
}

function compareByRecentPlay(a: TrackedYouTubeTab, b: TrackedYouTubeTab): number {
  const playA = a.lastPlayStartedAtMs ?? -1;
  const playB = b.lastPlayStartedAtMs ?? -1;
  if (playA !== playB) return playB - playA;

  if (a.audible !== b.audible) return a.audible ? -1 : 1;
  if (a.activeInWindow !== b.activeInWindow) return a.activeInWindow ? -1 : 1;
  if (a.lastStateUpdatedAtMs !== b.lastStateUpdatedAtMs) {
    return b.lastStateUpdatedAtMs - a.lastStateUpdatedAtMs;
  }
  return b.tabId - a.tabId;
}

/**
 * Deterministic YouTube target tab selector.
 *
 * Priority:
 * 1. Exactly 1 currently playing playable tab -> SINGLE_PLAYING_TAB
 * 2. Multiple currently playing playable tabs -> MOST_RECENT_PLAYING_TAB (highest lastPlayStartedAtMs)
 * 3. No playing tab, remembered lastControlledTabId is still playable & ready -> LAST_CONTROLLED_TAB
 * 4. No playing tab, no valid lastControlledTabId, at least one playable tab has real play history -> LAST_PLAYED_PAUSED_TAB
 * 5. No playing tab, no play history, exactly 1 playable ready tab -> SINGLE_PAUSED_PLAYABLE_TAB
 * 6. Otherwise refuse cleanly:
 *    - NO_YOUTUBE_TAB
 *    - CONTENT_SCRIPT_NOT_READY (playable YouTube URL tabs exist, none responded to live probe)
 *    - NO_PLAYABLE_YOUTUBE_TAB
 *    - AMBIGUOUS_TARGET (2+ paused playable tabs with no play/control history)
 */
export function selectYouTubeTargetTab(input: TargetSelectionInput): TargetSelectionResult {
  const { tabs, lastControlledTabId } = input;
  const candidates = summarizeCandidates(tabs, lastControlledTabId);

  if (tabs.length === 0) {
    return {
      selectedTab: null,
      reason: 'NO_YOUTUBE_TAB',
      candidateCount: 0,
      playableCount: 0,
      playingCount: 0,
      candidates,
    };
  }

  const readyPlayable = tabs.filter(
    (t) => t.contentScriptReady && t.hasPlayableVideo && t.pageType !== 'OTHER',
  );
  const playingTabs = readyPlayable.filter((t) => t.isPlaying);

  if (playingTabs.length === 1) {
    return {
      selectedTab: playingTabs[0] ?? null,
      reason: 'SINGLE_PLAYING_TAB',
      candidateCount: tabs.length,
      playableCount: readyPlayable.length,
      playingCount: 1,
      candidates,
    };
  }

  if (playingTabs.length > 1) {
    const sorted = [...playingTabs].sort(compareByRecentPlay);
    return {
      selectedTab: sorted[0] ?? null,
      reason: 'MOST_RECENT_PLAYING_TAB',
      candidateCount: tabs.length,
      playableCount: readyPlayable.length,
      playingCount: playingTabs.length,
      candidates,
    };
  }

  if (readyPlayable.length === 0) {
    const hasUnreadyPlayableUrlTab = tabs.some(
      (t) => !t.contentScriptReady && t.pageType !== 'OTHER',
    );
    return {
      selectedTab: null,
      reason: hasUnreadyPlayableUrlTab ? 'CONTENT_SCRIPT_NOT_READY' : 'NO_PLAYABLE_YOUTUBE_TAB',
      candidateCount: tabs.length,
      playableCount: 0,
      playingCount: 0,
      candidates,
    };
  }

  if (lastControlledTabId !== null) {
    const remembered = readyPlayable.find((t) => t.tabId === lastControlledTabId);
    if (remembered) {
      return {
        selectedTab: remembered,
        reason: 'LAST_CONTROLLED_TAB',
        candidateCount: tabs.length,
        playableCount: readyPlayable.length,
        playingCount: 0,
        candidates,
      };
    }
  }

  const playedPreviously = readyPlayable.filter(
    (t) => typeof t.lastPlayStartedAtMs === 'number' && t.lastPlayStartedAtMs > 0,
  );
  if (playedPreviously.length > 0) {
    const sorted = [...playedPreviously].sort(compareByRecentPlay);
    return {
      selectedTab: sorted[0] ?? null,
      reason: 'LAST_PLAYED_PAUSED_TAB',
      candidateCount: tabs.length,
      playableCount: readyPlayable.length,
      playingCount: 0,
      candidates,
    };
  }

  if (readyPlayable.length === 1) {
    return {
      selectedTab: readyPlayable[0] ?? null,
      reason: 'SINGLE_PAUSED_PLAYABLE_TAB',
      candidateCount: tabs.length,
      playableCount: 1,
      playingCount: 0,
      candidates,
    };
  }

  return {
    selectedTab: null,
    reason: 'AMBIGUOUS_TARGET',
    candidateCount: tabs.length,
    playableCount: readyPlayable.length,
    playingCount: 0,
    candidates,
  };
}

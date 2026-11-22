import {
  classifyWindowVisibility,
  WindowVisibilitySummary,
} from '../../core/diagnostics/windowVisibility';
import { GestureCommand } from '../../core/gesture/gestureStateMachine';
import {
  CommandGuardPersistedState,
  EMPTY_COMMAND_GUARD_STATE,
  evaluateCommandGuard,
  releaseCommandGuard,
} from '../../core/youtube/commandGuard';
import { selectYouTubeTargetTab } from '../../core/youtube/targetTabSelector';
import {
  TrackedYouTubeTab,
  YouTubeAuditStage,
  YouTubeControlLogEntry,
  YouTubeControlStatusSummary,
  YouTubeExecutionResult,
  YouTubePageType,
  YouTubePlayerSnapshot,
} from '../../core/youtube/types';
import { parseYouTubeUrl } from '../../core/youtube/youtubeUrl';
import {
  YouTubeContentMessage,
  YouTubeExecuteResponse,
  YouTubePlayerEventType,
  YouTubeProbeResponse,
} from '../../shared/messages';

const YOUTUBE_BRIDGE_STORAGE_KEY = 'headplay_youtube_bridge_v1';
const YOUTUBE_URL_PATTERN = 'https://www.youtube.com/*';
const MAX_YOUTUBE_LOGS = 200;
const PROBE_TIMEOUT_MS = 500;
const EXECUTE_TIMEOUT_MS = 4000;

interface PersistedYouTubeBridgeState {
  tabsById: Record<string, TrackedYouTubeTab>;
  lastControlledTabId: number | null;
  lastControlledTitle: string | null;
  lastControlledPageType: YouTubePageType | null;
  lastExecution: YouTubeExecutionResult | null;
  guardState: CommandGuardPersistedState;
  logs: YouTubeControlLogEntry[];
  nextLogId: number;
}

function createEmptyState(): PersistedYouTubeBridgeState {
  return {
    tabsById: {},
    lastControlledTabId: null,
    lastControlledTitle: null,
    lastControlledPageType: null,
    lastExecution: null,
    guardState: { ...EMPTY_COMMAND_GUARD_STATE },
    logs: [],
    nextLogId: 1,
  };
}

let stateChain: Promise<unknown> = Promise.resolve();

function withSerializedState<T>(fn: () => Promise<T>): Promise<T> {
  const run = stateChain.then(fn, fn);
  stateChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function loadState(): Promise<PersistedYouTubeBridgeState> {
  const stored = await chrome.storage.session.get(YOUTUBE_BRIDGE_STORAGE_KEY);
  const raw = stored[YOUTUBE_BRIDGE_STORAGE_KEY] as
    | Partial<PersistedYouTubeBridgeState>
    | undefined;
  if (!raw) return createEmptyState();
  return {
    tabsById: raw.tabsById ?? {},
    lastControlledTabId: raw.lastControlledTabId ?? null,
    lastControlledTitle: raw.lastControlledTitle ?? null,
    lastControlledPageType: raw.lastControlledPageType ?? null,
    lastExecution: raw.lastExecution ?? null,
    guardState: raw.guardState ?? { ...EMPTY_COMMAND_GUARD_STATE },
    logs: Array.isArray(raw.logs) ? raw.logs : [],
    nextLogId: typeof raw.nextLogId === 'number' ? raw.nextLogId : 1,
  };
}

async function saveState(state: PersistedYouTubeBridgeState): Promise<void> {
  await chrome.storage.session.set({ [YOUTUBE_BRIDGE_STORAGE_KEY]: state });
}

function appendAuditLog(
  state: PersistedYouTubeBridgeState,
  entry: Omit<YouTubeControlLogEntry, 'id'>,
): YouTubeControlLogEntry {
  const created: YouTubeControlLogEntry = {
    id: state.nextLogId++,
    ...entry,
  };
  state.logs.push(created);
  if (state.logs.length > MAX_YOUTUBE_LOGS) {
    state.logs.splice(0, state.logs.length - MAX_YOUTUBE_LOGS);
  }
  return created;
}

async function getCurrentWindowVisibility(): Promise<WindowVisibilitySummary> {
  try {
    const allWindows = await chrome.windows.getAll();
    return classifyWindowVisibility(allWindows);
  } catch {
    return {
      marker: 'NO_CHROME_WINDOWS',
      totalWindows: 0,
      minimizedWindows: 0,
      focusedWindows: 0,
    };
  }
}

function sendTabMessageWithTimeout<T>(
  tabId: number,
  msg: YouTubeContentMessage,
  timeoutMs: number,
): Promise<{ ok: true; response: T } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve({ ok: false, error: `TIMEOUT_${timeoutMs}MS` });
      }
    }, timeoutMs);

    chrome.tabs
      .sendMessage(tabId, msg)
      .then((response) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve({ ok: true, response: response as T });
        }
      })
      .catch((err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          const message = err instanceof Error ? err.message : String(err);
          resolve({ ok: false, error: message });
        }
      });
  });
}

function buildTrackedTabFromSnapshot(
  tab: chrome.tabs.Tab,
  snapshot: YouTubePlayerSnapshot,
): TrackedYouTubeTab {
  const tabId = tab.id ?? -1;
  return {
    tabId,
    windowId: tab.windowId ?? -1,
    activeInWindow: Boolean(tab.active),
    audible: Boolean(tab.audible),
    url: snapshot.url,
    title: snapshot.title || tab.title || snapshot.url,
    pageType: snapshot.pageType,
    videoId: snapshot.videoId,
    contentScriptReady: true,
    contentScriptInstanceId: snapshot.contentScriptInstanceId,
    navigationEpoch: snapshot.navigationEpoch,
    hasPlayableVideo: snapshot.hasPlayableVideo,
    isPlaying: snapshot.isPlaying,
    isPaused: snapshot.isPaused,
    lastPlayStartedAtMs: snapshot.hasPlayableVideo ? snapshot.lastPlayStartedAtMs : null,
    lastPausedAtMs: snapshot.hasPlayableVideo ? snapshot.lastPausedAtMs : null,
    lastStateUpdatedAtMs: snapshot.capturedAtMs,
    canNext: snapshot.canNext,
    canPrev: snapshot.canPrev,
  };
}

function buildUnreadyTrackedTab(tab: chrome.tabs.Tab, probeError: string): TrackedYouTubeTab {
  const url = tab.url ?? '';
  const parsed = parseYouTubeUrl(url);
  return {
    tabId: tab.id ?? -1,
    windowId: tab.windowId ?? -1,
    activeInWindow: Boolean(tab.active),
    audible: Boolean(tab.audible),
    url,
    title: tab.title ?? url,
    pageType: parsed.pageType,
    videoId: parsed.videoId,
    contentScriptReady: false,
    contentScriptInstanceId: null,
    navigationEpoch: 0,
    hasPlayableVideo: false,
    isPlaying: false,
    isPaused: false,
    lastPlayStartedAtMs: null,
    lastPausedAtMs: null,
    lastStateUpdatedAtMs: Date.now(),
    canNext: false,
    canPrev: false,
    probeError,
  };
}

async function probeAllLiveYouTubeTabs(): Promise<TrackedYouTubeTab[]> {
  let chromeTabs: chrome.tabs.Tab[] = [];
  try {
    chromeTabs = await chrome.tabs.query({ url: YOUTUBE_URL_PATTERN });
  } catch {
    return [];
  }

  const validTabs = chromeTabs.filter((t): t is chrome.tabs.Tab & { id: number } => typeof t.id === 'number');
  if (validTabs.length === 0) return [];

  const results = await Promise.all(
    validTabs.map(async (tab) => {
      const probe = await sendTabMessageWithTimeout<YouTubeProbeResponse>(
        tab.id,
        { target: 'youtube-content', type: 'YOUTUBE_PROBE_STATE' },
        PROBE_TIMEOUT_MS,
      );
      if (probe.ok && probe.response?.ok && probe.response.snapshot) {
        return buildTrackedTabFromSnapshot(tab, probe.response.snapshot);
      }
      return buildUnreadyTrackedTab(tab, probe.ok ? 'INVALID_PROBE_RESPONSE' : probe.error);
    }),
  );

  return results;
}

function summarizeStatus(state: PersistedYouTubeBridgeState): YouTubeControlStatusSummary {
  const tabs = Object.values(state.tabsById);
  const playableTabs = tabs.filter(
    (t) => t.contentScriptReady && t.hasPlayableVideo && t.pageType !== 'OTHER',
  );
  const playingTabs = playableTabs.filter((t) => t.isPlaying);
  return {
    trackedTabCount: tabs.length,
    playableTabCount: playableTabs.length,
    playingTabCount: playingTabs.length,
    lastControlledTabId: state.lastControlledTabId,
    lastControlledTitle: state.lastControlledTitle,
    lastControlledPageType: state.lastControlledPageType,
    lastExecution: state.lastExecution,
  };
}

function logStageToConsole(stage: YouTubeAuditStage, entry: YouTubeControlLogEntry): void {
  console.info(`[HEADPLAY][SW][${stage}][${entry.commandId}] ${entry.summary}`, entry.data);
}

/**
 * Handles real DOM playback/navigation events reported by YouTube Content Scripts.
 */
export async function handleYouTubePlayerEvent(
  senderTab: chrome.tabs.Tab | undefined,
  eventType: YouTubePlayerEventType,
  snapshot: YouTubePlayerSnapshot,
): Promise<void> {
  if (!senderTab || typeof senderTab.id !== 'number') return;
  const tabId = senderTab.id;

  await withSerializedState(async () => {
    const state = await loadState();
    const tracked = buildTrackedTabFromSnapshot(senderTab, snapshot);
    state.tabsById[String(tabId)] = tracked;

    // If the previously controlled tab navigated away to a non-playable page, invalidate it immediately.
    if (
      state.lastControlledTabId === tabId &&
      (!tracked.hasPlayableVideo || tracked.pageType === 'OTHER')
    ) {
      state.lastControlledTabId = null;
      state.lastControlledTitle = null;
      state.lastControlledPageType = null;
    } else if (state.lastControlledTabId === tabId) {
      state.lastControlledTitle = tracked.title;
      state.lastControlledPageType = tracked.pageType;
    }

    await saveState(state);
  });

  void eventType;
}

/**
 * Invalidates stale playback history on page reloads or navigation away from YouTube/playable pages.
 */
export async function handleTabUpdated(
  tabId: number,
  changeInfo: chrome.tabs.TabChangeInfo,
  tab: chrome.tabs.Tab,
): Promise<void> {
  if (!changeInfo.url && changeInfo.status !== 'loading') {
    return;
  }

  await withSerializedState(async () => {
    const state = await loadState();
    const key = String(tabId);
    const existing = state.tabsById[key];
    const url = changeInfo.url ?? tab.url ?? '';

    if (url) {
      const parsed = parseYouTubeUrl(url);
      if (!parsed.isYouTube) {
        let changed = false;
        if (existing) {
          delete state.tabsById[key];
          changed = true;
        }
        if (state.lastControlledTabId === tabId) {
          state.lastControlledTabId = null;
          state.lastControlledTitle = null;
          state.lastControlledPageType = null;
          changed = true;
        }
        if (changed) {
          await saveState(state);
        }
        return;
      }

      // Still on YouTube, but navigated to a non-playable page or reloading: invalidate stale playback history
      if (!parsed.isPlayablePage || changeInfo.status === 'loading') {
        let changed = false;
        if (existing) {
          state.tabsById[key] = {
            ...existing,
            url,
            title: tab.title ?? existing.title,
            pageType: parsed.pageType,
            videoId: parsed.videoId,
            hasPlayableVideo: false,
            isPlaying: false,
            isPaused: false,
            lastPlayStartedAtMs: null,
            lastPausedAtMs: null,
            contentScriptReady: changeInfo.status === 'loading' ? false : existing.contentScriptReady,
            contentScriptInstanceId:
              changeInfo.status === 'loading' ? null : existing.contentScriptInstanceId,
            lastStateUpdatedAtMs: Date.now(),
          };
          changed = true;
        }
        if (state.lastControlledTabId === tabId && !parsed.isPlayablePage) {
          state.lastControlledTabId = null;
          state.lastControlledTitle = null;
          state.lastControlledPageType = null;
          changed = true;
        }
        if (changed) {
          await saveState(state);
        }
      }
      return;
    }

    // Reload started without URL info: clear stale playback state if tracked
    if (changeInfo.status === 'loading' && existing) {
      state.tabsById[key] = {
        ...existing,
        hasPlayableVideo: false,
        isPlaying: false,
        isPaused: false,
        lastPlayStartedAtMs: null,
        lastPausedAtMs: null,
        contentScriptReady: false,
        contentScriptInstanceId: null,
        lastStateUpdatedAtMs: Date.now(),
      };
      await saveState(state);
    }
  });
}

export async function handleTabRemoved(tabId: number): Promise<void> {
  await withSerializedState(async () => {
    const state = await loadState();
    const key = String(tabId);
    let changed = false;
    if (state.tabsById[key]) {
      delete state.tabsById[key];
      changed = true;
    }
    if (state.lastControlledTabId === tabId) {
      state.lastControlledTabId = null;
      state.lastControlledTitle = null;
      state.lastControlledPageType = null;
      changed = true;
    }
    if (changed) {
      await saveState(state);
    }
  });
}

/**
 * Main Phase 2 execution pipeline triggered by OFFSCREEN_GESTURE_COMMAND.
 * Produces 3 correlated audit logs sharing the exact same commandId:
 *   1. YOUTUBE_COMMAND_RECEIVED
 *   2. YOUTUBE_TARGET_SELECTED
 *   3. YOUTUBE_EXECUTION_RESULT
 */
export async function handleGestureCommandForYouTube(
  command: GestureCommand,
  gestureTimestampMs: number,
  details: Record<string, number | string>,
): Promise<{ commandId: string; execution: YouTubeExecutionResult }> {
  const startWallMs = Date.now();
  const initialVisibility = await getCurrentWindowVisibility();

  // Stage 1: Evaluate duplicate/in-flight guard and record YOUTUBE_COMMAND_RECEIVED
  const guardOutcome = await withSerializedState(async () => {
    const state = await loadState();
    const decision = evaluateCommandGuard(
      state.guardState,
      command,
      gestureTimestampMs,
      startWallMs,
    );
    state.guardState = decision.nextState;

    const receivedLog = appendAuditLog(state, {
      commandId: decision.commandId,
      stage: 'YOUTUBE_COMMAND_RECEIVED',
      wallTimeIso: new Date(startWallMs).toISOString(),
      timestampMs: gestureTimestampMs,
      windowVisibility: initialVisibility.marker,
      summary: `${command} received (${initialVisibility.marker})`,
      data: {
        command,
        gestureTimestampMs,
        details,
        windowVisibility: initialVisibility.marker,
        windowSummary: initialVisibility,
        guardAccepted: decision.accepted,
        guardRejectReason: decision.accepted ? null : decision.reason,
      },
    });
    logStageToConsole('YOUTUBE_COMMAND_RECEIVED', receivedLog);

    if (!decision.accepted) {
      const targetLog = appendAuditLog(state, {
        commandId: decision.commandId,
        stage: 'YOUTUBE_TARGET_SELECTED',
        wallTimeIso: new Date(startWallMs).toISOString(),
        timestampMs: gestureTimestampMs,
        windowVisibility: initialVisibility.marker,
        summary: `Target skipped: ${decision.reason}`,
        data: {
          command,
          selectedTabId: null,
          selectionReason: decision.reason,
          candidateCount: Object.keys(state.tabsById).length,
          candidates: [],
        },
      });
      logStageToConsole('YOUTUBE_TARGET_SELECTED', targetLog);

      const skippedExec: YouTubeExecutionResult = {
        commandId: decision.commandId,
        command,
        tabId: null,
        status: 'SKIPPED',
        verified: false,
        reason: decision.reason,
        pageType: 'OTHER',
        beforeState: null,
        afterState: null,
        latencyMs: Date.now() - startWallMs,
        windowVisibility: initialVisibility.marker,
        wallTimeIso: new Date().toISOString(),
      };
      state.lastExecution = skippedExec;

      const execLog = appendAuditLog(state, {
        commandId: decision.commandId,
        stage: 'YOUTUBE_EXECUTION_RESULT',
        wallTimeIso: skippedExec.wallTimeIso,
        timestampMs: gestureTimestampMs,
        windowVisibility: initialVisibility.marker,
        summary: `${command} SKIPPED (${decision.reason})`,
        data: { ...skippedExec },
      });
      logStageToConsole('YOUTUBE_EXECUTION_RESULT', execLog);

      await saveState(state);
      return { decision, skippedExec };
    }

    await saveState(state);
    return { decision, skippedExec: null };
  });

  if (!guardOutcome.decision.accepted && guardOutcome.skippedExec) {
    return {
      commandId: guardOutcome.decision.commandId,
      execution: guardOutcome.skippedExec,
    };
  }

  const commandId = guardOutcome.decision.commandId;

  try {
    // Stage 2: Live probe all open YouTube tabs (never rely on stale pre-reload cache)
    const liveTabs = await probeAllLiveYouTubeTabs();

    const selection = await withSerializedState(async () => {
      const state = await loadState();

      // Replace tabsById strictly with live-probed YouTube tabs so closed/stale tabs vanish.
      const nextTabsById: Record<string, TrackedYouTubeTab> = {};
      for (const t of liveTabs) {
        nextTabsById[String(t.tabId)] = t;
      }
      state.tabsById = nextTabsById;

      // Invalidate lastControlledTabId if that tab was closed or left playable YouTube pages.
      if (state.lastControlledTabId !== null) {
        const remembered = nextTabsById[String(state.lastControlledTabId)];
        if (!remembered || !remembered.contentScriptReady || !remembered.hasPlayableVideo) {
          state.lastControlledTabId = null;
          state.lastControlledTitle = null;
          state.lastControlledPageType = null;
        }
      }

      const sel = selectYouTubeTargetTab({
        tabs: liveTabs,
        lastControlledTabId: state.lastControlledTabId,
      });

      const targetSummary = sel.selectedTab
        ? `tab=${sel.selectedTab.tabId} (${sel.selectedTab.pageType}, ${sel.reason})`
        : `none (${sel.reason}, tabs=${sel.candidateCount}, playable=${sel.playableCount})`;

      const targetLog = appendAuditLog(state, {
        commandId,
        stage: 'YOUTUBE_TARGET_SELECTED',
        wallTimeIso: new Date().toISOString(),
        timestampMs: gestureTimestampMs,
        windowVisibility: initialVisibility.marker,
        summary: `Target: ${targetSummary}`,
        data: {
          command,
          selectedTabId: sel.selectedTab?.tabId ?? null,
          selectedPageType: sel.selectedTab?.pageType ?? null,
          selectedTitle: sel.selectedTab?.title ?? null,
          selectedVideoId: sel.selectedTab?.videoId ?? null,
          selectionReason: sel.reason,
          candidateCount: sel.candidateCount,
          playableCount: sel.playableCount,
          playingCount: sel.playingCount,
          candidates: sel.candidates,
          windowVisibility: initialVisibility.marker,
        },
      });
      logStageToConsole('YOUTUBE_TARGET_SELECTED', targetLog);

      await saveState(state);
      return sel;
    });

    // If no unambiguous target tab could be selected, record SKIPPED and never guess another tab.
    if (!selection.selectedTab) {
      const endVisibility = await getCurrentWindowVisibility();
      const skippedExec: YouTubeExecutionResult = {
        commandId,
        command,
        tabId: null,
        status: 'SKIPPED',
        verified: false,
        reason: selection.reason,
        pageType: 'OTHER',
        beforeState: null,
        afterState: null,
        latencyMs: Date.now() - startWallMs,
        windowVisibility: endVisibility.marker,
        wallTimeIso: new Date().toISOString(),
      };

      await withSerializedState(async () => {
        const state = await loadState();
        state.lastExecution = skippedExec;
        const execLog = appendAuditLog(state, {
          commandId,
          stage: 'YOUTUBE_EXECUTION_RESULT',
          wallTimeIso: skippedExec.wallTimeIso,
          timestampMs: gestureTimestampMs,
          windowVisibility: endVisibility.marker,
          summary: `${command} SKIPPED (${selection.reason})`,
          data: { ...skippedExec },
        });
        logStageToConsole('YOUTUBE_EXECUTION_RESULT', execLog);
        await saveState(state);
      });

      return { commandId, execution: skippedExec };
    }

    // Stage 3: Execute on ONLY the selected target tab and verify real player state change
    const targetTab = selection.selectedTab;
    const sendRes = await sendTabMessageWithTimeout<YouTubeExecuteResponse>(
      targetTab.tabId,
      {
        target: 'youtube-content',
        type: 'YOUTUBE_EXECUTE_COMMAND',
        commandId,
        command,
      },
      EXECUTE_TIMEOUT_MS,
    );

    const endVisibility = await getCurrentWindowVisibility();
    const latencyMs = Date.now() - startWallMs;
    const wallTimeIso = new Date().toISOString();

    let execution: YouTubeExecutionResult;
    let updatedSnapshot: YouTubePlayerSnapshot | null = null;

    if (!sendRes.ok || !sendRes.response) {
      execution = {
        commandId,
        command,
        tabId: targetTab.tabId,
        status: 'FAILED',
        verified: false,
        reason: sendRes.ok
          ? 'EMPTY_CONTENT_SCRIPT_RESPONSE'
          : `CONTENT_SCRIPT_SEND_FAILED:${sendRes.error}`,
        pageType: targetTab.pageType,
        beforeState: null,
        afterState: null,
        latencyMs,
        windowVisibility: endVisibility.marker,
        wallTimeIso,
      };
    } else {
      const r = sendRes.response;
      updatedSnapshot = r.snapshot ?? null;
      execution = {
        commandId,
        command,
        tabId: targetTab.tabId,
        status: r.status,
        verified: r.verified,
        reason: r.reason,
        pageType: r.pageType,
        beforeState: r.beforeState,
        afterState: r.afterState,
        latencyMs,
        windowVisibility: endVisibility.marker,
        wallTimeIso,
      };
    }

    await withSerializedState(async () => {
      const state = await loadState();

      // Update tracked tab state from post-execution snapshot
      if (updatedSnapshot) {
        const existing = state.tabsById[String(targetTab.tabId)];
        state.tabsById[String(targetTab.tabId)] = {
          ...(existing ?? targetTab),
          url: updatedSnapshot.url,
          title: updatedSnapshot.title || targetTab.title,
          pageType: updatedSnapshot.pageType,
          videoId: updatedSnapshot.videoId,
          contentScriptReady: true,
          contentScriptInstanceId: updatedSnapshot.contentScriptInstanceId,
          navigationEpoch: updatedSnapshot.navigationEpoch,
          hasPlayableVideo: updatedSnapshot.hasPlayableVideo,
          isPlaying: updatedSnapshot.isPlaying,
          isPaused: updatedSnapshot.isPaused,
          lastPlayStartedAtMs: updatedSnapshot.hasPlayableVideo
            ? updatedSnapshot.lastPlayStartedAtMs
            : null,
          lastPausedAtMs: updatedSnapshot.hasPlayableVideo ? updatedSnapshot.lastPausedAtMs : null,
          lastStateUpdatedAtMs: updatedSnapshot.capturedAtMs,
          canNext: updatedSnapshot.canNext,
          canPrev: updatedSnapshot.canPrev,
        };
      }

      // Remember lastControlledTabId ONLY when execution actually succeeded & was verified.
      if (execution.status === 'EXECUTED' && execution.verified) {
        state.lastControlledTabId = targetTab.tabId;
        state.lastControlledTitle = updatedSnapshot?.title || targetTab.title;
        state.lastControlledPageType = execution.pageType;
      }

      state.lastExecution = execution;

      const stateDiff =
        execution.beforeState && execution.afterState
          ? command === 'TOGGLE_PLAY_PAUSE'
            ? `paused:${String(execution.beforeState.paused)}->${String(execution.afterState.paused)}`
            : `vid:${execution.beforeState.videoId ?? '?'}->${execution.afterState.videoId ?? '?'}`
          : 'no-state';

      const execLog = appendAuditLog(state, {
        commandId,
        stage: 'YOUTUBE_EXECUTION_RESULT',
        wallTimeIso: execution.wallTimeIso,
        timestampMs: gestureTimestampMs,
        windowVisibility: execution.windowVisibility,
        summary: `${command} tab=${targetTab.tabId} ${execution.status} (${execution.reason}, ${stateDiff}, ${execution.latencyMs}ms, ${execution.windowVisibility})`,
        data: {
          ...execution,
          selectionReason: selection.reason,
          targetTitle: targetTab.title,
        },
      });
      logStageToConsole('YOUTUBE_EXECUTION_RESULT', execLog);

      await saveState(state);
    });

    return { commandId, execution };
  } finally {
    await withSerializedState(async () => {
      const state = await loadState();
      state.guardState = releaseCommandGuard(state.guardState, commandId);
      await saveState(state);
    });
  }
}

export async function getYouTubeBridgeStatus(
  logLimit = 80,
): Promise<{ status: YouTubeControlStatusSummary; logs: YouTubeControlLogEntry[] }> {
  const state = await loadState();
  return {
    status: summarizeStatus(state),
    logs: state.logs.slice(-logLimit),
  };
}

export async function getAllYouTubeBridgeLogs(): Promise<YouTubeControlLogEntry[]> {
  const state = await loadState();
  return [...state.logs];
}

export async function clearYouTubeBridgeLogs(): Promise<void> {
  await withSerializedState(async () => {
    const state = await loadState();
    state.logs = [];
    state.lastExecution = null;
    await saveState(state);
  });
}

export function formatYouTubeLogsCsvRows(logs: YouTubeControlLogEntry[]): string[] {
  const escape = (v: unknown): string => {
    const s = String(v ?? '');
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };
  return logs.map((l) =>
    [
      `yt_${l.id}`,
      l.wallTimeIso,
      l.timestampMs.toFixed(1),
      l.stage,
      `[${l.commandId}] ${l.summary}`,
      JSON.stringify({ commandId: l.commandId, windowVisibility: l.windowVisibility, ...l.data }),
    ]
      .map(escape)
      .join(','),
  );
}

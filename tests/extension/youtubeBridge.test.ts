import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearYouTubeBridgeLogs,
  getAllYouTubeBridgeLogs,
  getYouTubeBridgeStatus,
  handleGestureCommandForYouTube,
  handleTabRemoved,
  handleTabUpdated,
  handleYouTubePlayerEvent,
} from '../../src/extension/background/youtubeBridge';
import { YouTubePlayerSnapshot } from '../../src/core/youtube/types';
import {
  YouTubeContentMessage,
  YouTubeExecuteResponse,
  YouTubeProbeResponse,
} from '../../src/shared/messages';

interface MockTabEntry {
  tab: chrome.tabs.Tab;
  snapshot: YouTubePlayerSnapshot;
  onExecute?: (commandId: string, command: string) => YouTubeExecuteResponse;
}

function makeSnapshot(overrides: Partial<YouTubePlayerSnapshot> = {}): YouTubePlayerSnapshot {
  return {
    contentScriptInstanceId: 'ytcs_1',
    navigationEpoch: 1,
    url: 'https://www.youtube.com/watch?v=vidA',
    title: 'Video A - YouTube',
    pageType: 'WATCH',
    videoId: 'vidA',
    hasPlayableVideo: true,
    isPlaying: true,
    isPaused: false,
    isEnded: false,
    currentTimeSec: 15,
    durationSec: 180,
    lastPlayStartedAtMs: 10_000,
    lastPausedAtMs: null,
    canNext: true,
    canPrev: false,
    capturedAtMs: 10_500,
    ...overrides,
  };
}

describe('youtubeBridge SW integration (mocked chrome APIs)', () => {
  let sessionStore: Record<string, unknown>;
  let mockTabs: Map<number, MockTabEntry>;
  let mockWindows: chrome.windows.Window[];
  let sendMessageSpy: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    sessionStore = {};
    mockTabs = new Map();
    mockWindows = [{ id: 1, focused: false, state: 'minimized' } as chrome.windows.Window];

    sendMessageSpy = vi.fn(async (tabId: number, msg: YouTubeContentMessage) => {
      const entry = mockTabs.get(tabId);
      if (!entry) {
        throw new Error('No tab with id');
      }
      if (msg.type === 'YOUTUBE_PROBE_STATE') {
        const res: YouTubeProbeResponse = { ok: true, snapshot: entry.snapshot };
        return res;
      }
      if (msg.type === 'YOUTUBE_EXECUTE_COMMAND') {
        if (entry.onExecute) {
          return entry.onExecute(msg.commandId, msg.command);
        }
        const wasPaused = entry.snapshot.isPaused;
        const nextPaused = !wasPaused;
        entry.snapshot = {
          ...entry.snapshot,
          isPaused: nextPaused,
          isPlaying: !nextPaused,
          lastPlayStartedAtMs: !nextPaused ? Date.now() : entry.snapshot.lastPlayStartedAtMs,
          capturedAtMs: Date.now(),
        };
        const res: YouTubeExecuteResponse = {
          ok: true,
          commandId: msg.commandId,
          command: msg.command,
          status: 'EXECUTED',
          verified: true,
          reason: nextPaused ? 'PAUSED_VERIFIED' : 'PLAYING_VERIFIED',
          pageType: entry.snapshot.pageType,
          beforeState: {
            url: entry.snapshot.url,
            pageType: entry.snapshot.pageType,
            videoId: entry.snapshot.videoId,
            paused: wasPaused,
            ended: false,
            currentTimeSec: 15,
          },
          afterState: {
            url: entry.snapshot.url,
            pageType: entry.snapshot.pageType,
            videoId: entry.snapshot.videoId,
            paused: nextPaused,
            ended: false,
            currentTimeSec: 15.1,
          },
          snapshot: entry.snapshot,
        };
        return res;
      }
      throw new Error('Unexpected message');
    });

    (globalThis as unknown as { chrome: unknown }).chrome = {
      storage: {
        session: {
          get: vi.fn(async (key: string) => ({ [key]: sessionStore[key] })),
          set: vi.fn(async (obj: Record<string, unknown>) => {
            Object.assign(sessionStore, obj);
          }),
        },
      },
      windows: {
        getAll: vi.fn(async () => mockWindows),
      },
      tabs: {
        query: vi.fn(async () => Array.from(mockTabs.values()).map((e) => e.tab)),
        sendMessage: sendMessageSpy,
      },
    };

    await clearYouTubeBridgeLogs();
  });

  it('tracks commandId identically across all 3 stages while Chrome is CHROME_ALL_MINIMIZED', async () => {
    mockTabs.set(101, {
      tab: { id: 101, windowId: 1, active: false, audible: true, url: 'https://www.youtube.com/watch?v=vidA', title: 'Video A' } as chrome.tabs.Tab,
      snapshot: makeSnapshot(),
    });

    const { commandId, execution } = await handleGestureCommandForYouTube('TOGGLE_PLAY_PAUSE', 5000, {
      durationMs: 650,
    });

    expect(execution.status).toBe('EXECUTED');
    expect(execution.verified).toBe(true);
    expect(execution.windowVisibility).toBe('CHROME_ALL_MINIMIZED');
    expect(execution.tabId).toBe(101);

    const logs = await getAllYouTubeBridgeLogs();
    const correlated = logs.filter((l) => l.commandId === commandId);
    expect(correlated.map((l) => l.stage)).toEqual([
      'YOUTUBE_COMMAND_RECEIVED',
      'YOUTUBE_TARGET_SELECTED',
      'YOUTUBE_EXECUTION_RESULT',
    ]);
    for (const entry of correlated) {
      expect(entry.windowVisibility).toBe('CHROME_ALL_MINIMIZED');
    }
  });

  it('remembers paused lastControlledTabId and resumes it even when another paused tab exists', async () => {
    mockTabs.set(101, {
      tab: { id: 101, windowId: 1, active: false, audible: true, url: 'https://www.youtube.com/watch?v=vidA', title: 'Video A' } as chrome.tabs.Tab,
      snapshot: makeSnapshot({ isPlaying: true, isPaused: false, lastPlayStartedAtMs: 20_000 }),
    });
    mockTabs.set(202, {
      tab: { id: 202, windowId: 1, active: true, audible: false, url: 'https://www.youtube.com/watch?v=vidB', title: 'Video B' } as chrome.tabs.Tab,
      snapshot: makeSnapshot({
        contentScriptInstanceId: 'ytcs_2',
        url: 'https://www.youtube.com/watch?v=vidB',
        title: 'Video B',
        videoId: 'vidB',
        isPlaying: false,
        isPaused: true,
        lastPlayStartedAtMs: null,
      }),
    });

    // 1) Pause tab 101
    const r1 = await handleGestureCommandForYouTube('TOGGLE_PLAY_PAUSE', 1000, {});
    expect(r1.execution.status).toBe('EXECUTED');
    expect(r1.execution.tabId).toBe(101);
    expect(r1.execution.afterState?.paused).toBe(true);

    // 2) Resume after dedupe window -> remembers tab 101 (LAST_CONTROLLED_TAB)
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1000);
    const r2 = await handleGestureCommandForYouTube('TOGGLE_PLAY_PAUSE', 2500, {});
    nowSpy.mockRestore();

    expect(r2.execution.status).toBe('EXECUTED');
    expect(r2.execution.tabId).toBe(101);
    expect(r2.execution.afterState?.paused).toBe(false);
  });

  it('invalidates stale state when a previously controlled tab navigates away or reloads', async () => {
    const tab101 = { id: 101, windowId: 1, active: false, audible: true, url: 'https://www.youtube.com/watch?v=vidA', title: 'Video A' } as chrome.tabs.Tab;
    mockTabs.set(101, { tab: tab101, snapshot: makeSnapshot() });

    await handleYouTubePlayerEvent(tab101, 'PLAY', makeSnapshot());
    const first = await handleGestureCommandForYouTube('TOGGLE_PLAY_PAUSE', 1000, {});
    expect(first.execution.status).toBe('EXECUTED');

    // Tab 101 navigates to YouTube Home (non-playable)
    await handleTabUpdated(101, { url: 'https://www.youtube.com/' }, { ...tab101, url: 'https://www.youtube.com/' });
    const statusAfterNav = await getYouTubeBridgeStatus();
    expect(statusAfterNav.status.lastControlledTabId).toBeNull();

    // If tab 101 is removed, tracked tab count drops cleanly
    await handleTabRemoved(101);
    const statusAfterClose = await getYouTubeBridgeStatus();
    expect(statusAfterClose.status.trackedTabCount).toBe(0);
  });

  it('fails safely without falling back to another YouTube tab when DOM control is unavailable', async () => {
    mockTabs.set(101, {
      tab: { id: 101, windowId: 1, active: false, audible: true, url: 'https://www.youtube.com/watch?v=vidA', title: 'Video A' } as chrome.tabs.Tab,
      snapshot: makeSnapshot({ canPrev: false }),
      onExecute: (commandId, command) => ({
        ok: false,
        commandId,
        command: command as 'PREV_VIDEO',
        status: 'UNSUPPORTED',
        verified: false,
        reason: 'PREV_NOT_AVAILABLE_ON_WATCH',
        pageType: 'WATCH',
        beforeState: {
          url: 'https://www.youtube.com/watch?v=vidA',
          pageType: 'WATCH',
          videoId: 'vidA',
          paused: false,
          ended: false,
          currentTimeSec: 15,
        },
        afterState: {
          url: 'https://www.youtube.com/watch?v=vidA',
          pageType: 'WATCH',
          videoId: 'vidA',
          paused: false,
          ended: false,
          currentTimeSec: 15,
        },
        snapshot: makeSnapshot({ canPrev: false }),
      }),
    });
    mockTabs.set(202, {
      tab: { id: 202, windowId: 1, active: false, audible: false, url: 'https://www.youtube.com/watch?v=vidB&list=PL1', title: 'Playlist B' } as chrome.tabs.Tab,
      snapshot: makeSnapshot({
        url: 'https://www.youtube.com/watch?v=vidB&list=PL1',
        pageType: 'PLAYLIST',
        videoId: 'vidB',
        isPlaying: false,
        isPaused: true,
        lastPlayStartedAtMs: null,
        canPrev: true,
      }),
    });

    const res = await handleGestureCommandForYouTube('PREV_VIDEO', 4000, {});
    expect(res.execution.tabId).toBe(101);
    expect(res.execution.status).toBe('UNSUPPORTED');
    expect(res.execution.verified).toBe(false);
    expect(res.execution.reason).toBe('PREV_NOT_AVAILABLE_ON_WATCH');

    // Verify EXECUTE was NEVER sent to tab 202
    const executeCallsTo202 = sendMessageSpy.mock.calls.filter(
      ([tid, msg]) => tid === 202 && (msg as YouTubeContentMessage).type === 'YOUTUBE_EXECUTE_COMMAND',
    );
    expect(executeCallsTo202).toHaveLength(0);
  });
});

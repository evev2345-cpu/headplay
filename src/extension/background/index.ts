import { DEFAULT_GESTURE_CONFIG, GestureConfig, sanitizeGestureConfig } from '../../core/config/gestureConfig';
import {
  classifyWindowVisibility,
  WindowVisibilityMarker,
} from '../../core/diagnostics/windowVisibility';
import {
  BackgroundMessage,
  BackgroundStatusResponse,
  LastGestureCommandInfo,
  OffscreenDiagnosticsResponse,
  OffscreenMessage,
  PermissionHint,
  TrackingErrorCode,
  TrackingLifecycleState,
} from '../../shared/messages';

const OFFSCREEN_DOCUMENT_PATH = 'offscreen.html';
const CONFIG_STORAGE_KEY = 'headplay_gesture_config_v1';
const SESSION_STATE_KEY = 'headplay_session_state_v1';
const LAST_REPORT_STORAGE_KEY = 'headplay_last_session_report_v1';

interface PersistedSessionState {
  lifecycleState: TrackingLifecycleState;
  permissionHint: PermissionHint;
  lastError: { code: TrackingErrorCode; message: string } | null;
  lastCommand: LastGestureCommandInfo | null;
}

interface SavedSessionReport {
  metrics: OffscreenDiagnosticsResponse['metrics'];
  logs: OffscreenDiagnosticsResponse['logs'];
  json: string;
  csv: string;
}

const DEFAULT_SESSION_STATE: PersistedSessionState = {
  lifecycleState: 'IDLE',
  permissionHint: 'UNKNOWN',
  lastError: null,
  lastCommand: null,
};

let creatingOffscreen: Promise<void> | null = null;

async function loadConfig(): Promise<GestureConfig> {
  const stored = await chrome.storage.local.get(CONFIG_STORAGE_KEY);
  return sanitizeGestureConfig(stored[CONFIG_STORAGE_KEY] as Partial<GestureConfig> | undefined);
}

async function saveConfig(partial: Partial<GestureConfig>): Promise<GestureConfig> {
  const current = await loadConfig();
  const next = sanitizeGestureConfig({ ...current, ...partial });
  await chrome.storage.local.set({ [CONFIG_STORAGE_KEY]: next });
  return next;
}

async function loadSessionState(): Promise<PersistedSessionState> {
  const stored = await chrome.storage.session.get(SESSION_STATE_KEY);
  const raw = stored[SESSION_STATE_KEY] as Partial<PersistedSessionState> | undefined;
  return {
    lifecycleState: raw?.lifecycleState ?? DEFAULT_SESSION_STATE.lifecycleState,
    permissionHint: raw?.permissionHint ?? DEFAULT_SESSION_STATE.permissionHint,
    lastError: raw?.lastError ?? null,
    lastCommand: raw?.lastCommand ?? null,
  };
}

async function updateSessionState(patch: Partial<PersistedSessionState>): Promise<PersistedSessionState> {
  const current = await loadSessionState();
  const next: PersistedSessionState = { ...current, ...patch };
  await chrome.storage.session.set({ [SESSION_STATE_KEY]: next });
  await syncBadge(next.lifecycleState);
  return next;
}

async function syncBadge(state: TrackingLifecycleState): Promise<void> {
  try {
    switch (state) {
      case 'RUNNING':
        await chrome.action.setBadgeText({ text: 'ON' });
        await chrome.action.setBadgeBackgroundColor({ color: '#16a34a' });
        break;
      case 'STARTING':
        await chrome.action.setBadgeText({ text: '...' });
        await chrome.action.setBadgeBackgroundColor({ color: '#d97706' });
        break;
      case 'ERROR':
        await chrome.action.setBadgeText({ text: 'ERR' });
        await chrome.action.setBadgeBackgroundColor({ color: '#dc2626' });
        break;
      case 'IDLE':
      case 'STOPPING':
        await chrome.action.setBadgeText({ text: '' });
        break;
    }
  } catch {
    // Ignore badge update errors during teardown.
  }
}

async function hasOffscreenDocument(): Promise<boolean> {
  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);
  if (typeof chrome.runtime.getContexts === 'function') {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
      documentUrls: [offscreenUrl],
    });
    return contexts.length > 0;
  }
  return false;
}

async function ensureOffscreenDocument(): Promise<void> {
  if (await hasOffscreenDocument()) {
    return;
  }

  if (creatingOffscreen) {
    await creatingOffscreen;
    return;
  }

  creatingOffscreen = chrome.offscreen.createDocument({
    url: OFFSCREEN_DOCUMENT_PATH,
    reasons: [chrome.offscreen.Reason.USER_MEDIA],
    justification:
      'Local webcam capture and MediaPipe Face Landmarker eye blink/gaze detection in background and minimized Chrome states.',
  });

  try {
    await creatingOffscreen;
  } finally {
    creatingOffscreen = null;
  }
}

async function closeOffscreenDocumentIfOpen(): Promise<void> {
  if (await hasOffscreenDocument()) {
    try {
      await chrome.offscreen.closeDocument();
    } catch {
      // Document may already be closing.
    }
  }
}

async function sendToOffscreen<T = unknown>(msg: OffscreenMessage): Promise<T | null> {
  if (!(await hasOffscreenDocument())) {
    return null;
  }
  try {
    return (await chrome.runtime.sendMessage(msg)) as T;
  } catch {
    return null;
  }
}

async function openPermissionPage(autoStart = false): Promise<void> {
  const baseUrl = chrome.runtime.getURL('permission.html');
  const url = autoStart ? `${baseUrl}?autoStart=1` : baseUrl;
  await chrome.tabs.create({ url, active: true });
}

async function startTracking(): Promise<{
  ok: boolean;
  needsPermission?: boolean;
  error?: string;
}> {
  const config = await loadConfig();
  await updateSessionState({ lifecycleState: 'STARTING', lastError: null });

  try {
    await ensureOffscreenDocument();
    const res = await sendToOffscreen<{ ok: boolean; error?: string; code?: TrackingErrorCode }>({
      target: 'offscreen',
      type: 'OFFSCREEN_START',
      config,
    });

    if (!res || !res.ok) {
      const code: TrackingErrorCode = res?.code ?? 'UNKNOWN';
      const error = res?.error ?? 'Failed to start tracking in offscreen document.';

      await closeOffscreenDocumentIfOpen();
      await updateSessionState({
        lifecycleState: code === 'PERMISSION_DENIED' ? 'IDLE' : 'ERROR',
        permissionHint: code === 'PERMISSION_DENIED' ? 'DENIED' : (await loadSessionState()).permissionHint,
        lastError: { code, message: error },
      });

      if (code === 'PERMISSION_DENIED') {
        await openPermissionPage(true);
        return { ok: false, needsPermission: true, error };
      }
      return { ok: false, error };
    }

    await updateSessionState({
      lifecycleState: 'RUNNING',
      permissionHint: 'GRANTED',
      lastError: null,
    });
    await reconcileWindowVisibility('tracking_started', true);
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await closeOffscreenDocumentIfOpen();
    await updateSessionState({
      lifecycleState: 'ERROR',
      lastError: { code: 'UNKNOWN', message },
    });
    return { ok: false, error: message };
  }
}

async function archiveOffscreenReport(): Promise<void> {
  if (!(await hasOffscreenDocument())) return;
  const [diag, jsonRes, csvRes] = await Promise.all([
    sendToOffscreen<OffscreenDiagnosticsResponse>({
      target: 'offscreen',
      type: 'OFFSCREEN_GET_DIAGNOSTICS',
      logLimit: 200,
    }),
    sendToOffscreen<{ ok: boolean; content: string }>({
      target: 'offscreen',
      type: 'OFFSCREEN_EXPORT_LOGS',
      format: 'json',
    }),
    sendToOffscreen<{ ok: boolean; content: string }>({
      target: 'offscreen',
      type: 'OFFSCREEN_EXPORT_LOGS',
      format: 'csv',
    }),
  ]);

  if (diag?.ok && diag.metrics) {
    const saved: SavedSessionReport = {
      metrics: diag.metrics,
      logs: diag.logs,
      json: jsonRes?.content ?? '',
      csv: csvRes?.content ?? '',
    };
    await chrome.storage.session.set({ [LAST_REPORT_STORAGE_KEY]: saved });
  }
}

async function loadSavedReport(): Promise<SavedSessionReport | null> {
  const stored = await chrome.storage.session.get(LAST_REPORT_STORAGE_KEY);
  return (stored[LAST_REPORT_STORAGE_KEY] as SavedSessionReport | undefined) ?? null;
}

async function stopTracking(): Promise<{ ok: boolean }> {
  await updateSessionState({ lifecycleState: 'STOPPING' });
  // Stop capture and finalize any ongoing stall BEFORE archiving the report.
  await sendToOffscreen({ target: 'offscreen', type: 'OFFSCREEN_STOP' });
  await archiveOffscreenReport();
  await closeOffscreenDocumentIfOpen();
  lastWindowVisibilityMarker = null;
  await updateSessionState({ lifecycleState: 'IDLE', lastError: null });
  return { ok: true };
}

async function getStatus(logLimit = 120): Promise<BackgroundStatusResponse> {
  const [config, session, offscreenOpen] = await Promise.all([
    loadConfig(),
    loadSessionState(),
    hasOffscreenDocument(),
  ]);

  let lifecycleState = session.lifecycleState;
  let diag: OffscreenDiagnosticsResponse | null = null;

  if (offscreenOpen) {
    diag = await sendToOffscreen<OffscreenDiagnosticsResponse>({
      target: 'offscreen',
      type: 'OFFSCREEN_GET_DIAGNOSTICS',
      logLimit,
    });
    if (diag?.running && lifecycleState !== 'RUNNING') {
      lifecycleState = 'RUNNING';
      await updateSessionState({ lifecycleState: 'RUNNING' });
    }
  } else if (lifecycleState === 'RUNNING' || lifecycleState === 'STARTING') {
    // Reconcile if Chrome closed the offscreen document unexpectedly.
    lifecycleState = 'IDLE';
    await updateSessionState({ lifecycleState: 'IDLE' });
  }

  let metrics = diag?.metrics ?? null;
  let logs = diag?.logs ?? [];
  if (!metrics) {
    const saved = await loadSavedReport();
    if (saved) {
      metrics = saved.metrics;
      logs = saved.logs.slice(-logLimit);
    }
  }

  return {
    lifecycleState,
    offscreenOpen,
    permissionHint: session.permissionHint,
    lastError: session.lastError,
    lastCommand: session.lastCommand,
    config,
    metrics,
    logs,
  };
}

let lastWindowVisibilityMarker: WindowVisibilityMarker | null = null;

/**
 * Queries actual Chrome window states via chrome.windows.getAll() rather than inferring
 * minimization from onFocusChanged alone. Separates CHROME_ALL_MINIMIZED from
 * CHROME_UNFOCUSED_VISIBLE (focus lost while at least one Chrome window remains visible).
 */
async function reconcileWindowVisibility(trigger: string, force = false): Promise<void> {
  if (!(await hasOffscreenDocument())) return;

  try {
    const allWindows = await chrome.windows.getAll();
    const summary = classifyWindowVisibility(allWindows);

    if (!force && summary.marker === lastWindowVisibilityMarker) {
      return;
    }
    lastWindowVisibilityMarker = summary.marker;

    await sendToOffscreen({
      target: 'offscreen',
      type: 'OFFSCREEN_ADD_MARKER',
      label: summary.marker,
      meta: {
        trigger,
        totalWindows: summary.totalWindows,
        minimizedWindows: summary.minimizedWindows,
        focusedWindows: summary.focusedWindows,
      },
    });
  } catch {
    // Ignore transient window inspection errors.
  }
}

chrome.windows.onFocusChanged.addListener(() => {
  void reconcileWindowVisibility('onFocusChanged');
});

chrome.windows.onBoundsChanged.addListener(() => {
  void reconcileWindowVisibility('onBoundsChanged');
});

chrome.windows.onRemoved.addListener(() => {
  void reconcileWindowVisibility('onRemoved');
});

chrome.runtime.onInstalled.addListener(() => {
  void (async () => {
    const existing = await chrome.storage.local.get(CONFIG_STORAGE_KEY);
    if (!existing[CONFIG_STORAGE_KEY]) {
      await chrome.storage.local.set({ [CONFIG_STORAGE_KEY]: DEFAULT_GESTURE_CONFIG });
    }
    await syncBadge('IDLE');
  })();
});

chrome.runtime.onStartup.addListener(() => {
  void syncBadge('IDLE');
});

chrome.runtime.onMessage.addListener((raw: unknown, _sender, sendResponse) => {
  const msg = raw as BackgroundMessage | undefined;
  if (!msg || msg.target !== 'background') {
    return false;
  }

  const handle = async (): Promise<unknown> => {
    switch (msg.type) {
      case 'GET_STATUS':
        return getStatus(msg.logLimit);

      case 'START_TRACKING':
        return startTracking();

      case 'STOP_TRACKING':
        return stopTracking();

      case 'OPEN_PERMISSION_PAGE':
        await openPermissionPage(Boolean(msg.autoStart));
        return { ok: true };

      case 'PERMISSION_GRANTED': {
        await updateSessionState({ permissionHint: 'GRANTED', lastError: null });
        if (msg.autoStart) {
          return startTracking();
        }
        return { ok: true };
      }

      case 'PERMISSION_DENIED':
        await updateSessionState({
          permissionHint: 'DENIED',
          lastError: {
            code: 'PERMISSION_DENIED',
            message: msg.message ?? 'Camera permission denied by user.',
          },
        });
        return { ok: true };

      case 'UPDATE_CONFIG': {
        const nextConfig = await saveConfig(msg.partial);
        await sendToOffscreen({
          target: 'offscreen',
          type: 'OFFSCREEN_UPDATE_CONFIG',
          config: nextConfig,
        });
        return { ok: true, config: nextConfig };
      }

      case 'RESET_CONFIG': {
        await chrome.storage.local.set({ [CONFIG_STORAGE_KEY]: DEFAULT_GESTURE_CONFIG });
        await sendToOffscreen({
          target: 'offscreen',
          type: 'OFFSCREEN_UPDATE_CONFIG',
          config: DEFAULT_GESTURE_CONFIG,
        });
        return { ok: true, config: DEFAULT_GESTURE_CONFIG };
      }

      case 'ADD_MARKER':
        await sendToOffscreen({
          target: 'offscreen',
          type: 'OFFSCREEN_ADD_MARKER',
          label: msg.label,
        });
        return { ok: true };

      case 'CLEAR_LOGS':
        await sendToOffscreen({ target: 'offscreen', type: 'OFFSCREEN_CLEAR_LOGS' });
        await chrome.storage.session.remove(LAST_REPORT_STORAGE_KEY);
        return { ok: true };

      case 'EXPORT_LOGS': {
        const res = await sendToOffscreen<{ ok: boolean; content: string }>({
          target: 'offscreen',
          type: 'OFFSCREEN_EXPORT_LOGS',
          format: msg.format,
        });
        if (res?.ok && res.content) {
          return res;
        }
        const saved = await loadSavedReport();
        if (saved) {
          const content = msg.format === 'csv' ? saved.csv : saved.json;
          return { ok: Boolean(content), content };
        }
        return { ok: false, content: '' };
      }

      case 'OFFSCREEN_TRACKING_STARTED':
        await updateSessionState({
          lifecycleState: 'RUNNING',
          permissionHint: 'GRANTED',
          lastError: null,
        });
        return { ok: true };

      case 'OFFSCREEN_TRACKING_STOPPED':
        await updateSessionState({ lifecycleState: 'IDLE' });
        return { ok: true };

      case 'OFFSCREEN_TRACKING_ERROR':
        await updateSessionState({
          lifecycleState: msg.code === 'PERMISSION_DENIED' ? 'IDLE' : 'ERROR',
          permissionHint:
            msg.code === 'PERMISSION_DENIED' ? 'DENIED' : (await loadSessionState()).permissionHint,
          lastError: { code: msg.code, message: msg.message },
        });
        if (msg.code === 'STREAM_ENDED') {
          await archiveOffscreenReport();
          await closeOffscreenDocumentIfOpen();
        }
        return { ok: true };

      case 'OFFSCREEN_GESTURE_COMMAND': {
        // Phase 1: log gesture command only (YouTube control is intentionally out of scope for Phase 1).
        const cmdInfo: LastGestureCommandInfo = {
          command: msg.command,
          timestampMs: msg.timestampMs,
          wallTimeIso: new Date().toISOString(),
          details: msg.details,
        };
        console.info('[HEADPLAY][SW][Phase1] Received gesture command:', cmdInfo);
        await updateSessionState({ lastCommand: cmdInfo });
        return { ok: true };
      }
    }
  };

  void handle().then((res) => sendResponse(res));
  return true;
});

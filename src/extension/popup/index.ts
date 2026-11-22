import {
  CameraCaptureResolution,
  CaptureMode,
  DelegatePreference,
  GazeMethod,
  GestureConfig,
} from '../../core/config/gestureConfig';
import { DiagnosticLogEntry } from '../../core/diagnostics/sessionMetrics';
import {
  YouTubeControlLogEntry,
  YouTubeControlStatusSummary,
} from '../../core/youtube/types';
import { BackgroundMessage, BackgroundStatusResponse } from '../../shared/messages';

const statusPill = document.getElementById('statusPill') as HTMLSpanElement;
const startBtn = document.getElementById('startBtn') as HTMLButtonElement;
const stopBtn = document.getElementById('stopBtn') as HTMLButtonElement;
const permBtn = document.getElementById('permBtn') as HTMLButtonElement;
const errorBanner = document.getElementById('errorBanner') as HTMLDivElement;

const eyeStateEl = document.getElementById('eyeState') as HTMLElement;
const blinkScoresEl = document.getElementById('blinkScores') as HTMLElement;
const gazeDirEl = document.getElementById('gazeDir') as HTMLElement;
const gazeScoresEl = document.getElementById('gazeScores') as HTMLElement;
const headYawStatEl = document.getElementById('headYawStat') as HTMLElement;
const fsmStateEl = document.getElementById('fsmState') as HTMLElement;
const earScoresEl = document.getElementById('earScores') as HTMLElement;
const lastCommandEl = document.getElementById('lastCommand') as HTMLElement;
const blinkSummaryEl = document.getElementById('blinkSummary') as HTMLElement;
const lastBlinkStatEl = document.getElementById('lastBlinkStat') as HTMLElement;

const youtubeTabCountsEl = document.getElementById('youtubeTabCounts') as HTMLElement;
const youtubeLastTargetEl = document.getElementById('youtubeLastTarget') as HTMLElement;
const youtubeLastExecEl = document.getElementById('youtubeLastExec') as HTMLElement;
const youtubeLogListEl = document.getElementById('youtubeLogList') as HTMLDivElement;

const pipelineMetaEl = document.getElementById('pipelineMeta') as HTMLElement;
const fpsStatEl = document.getElementById('fpsStat') as HTMLElement;
const readStatEl = document.getElementById('readStat') as HTMLElement;
const schedStatEl = document.getElementById('schedStat') as HTMLElement;
const stallStatEl = document.getElementById('stallStat') as HTMLElement;
const timingStatEl = document.getElementById('timingStat') as HTMLElement;
const frameCountsEl = document.getElementById('frameCounts') as HTMLElement;
const cameraCapsEl = document.getElementById('cameraCaps') as HTMLElement;
const currentMarkerEl = document.getElementById('currentMarker') as HTMLElement;

const configForm = document.getElementById('configForm') as HTMLFormElement;
const resetConfigBtn = document.getElementById('resetConfigBtn') as HTMLButtonElement;
const exportJsonBtn = document.getElementById('exportJsonBtn') as HTMLButtonElement;
const exportCsvBtn = document.getElementById('exportCsvBtn') as HTMLButtonElement;
const clearLogsBtn = document.getElementById('clearLogsBtn') as HTMLButtonElement;
const logListEl = document.getElementById('logList') as HTMLDivElement;

let configPopulated = false;
let pollTimerId: number | null = null;

async function sendBg<T = unknown>(msg: BackgroundMessage): Promise<T> {
  return (await chrome.runtime.sendMessage(msg)) as T;
}

function fmt(val: number | null | undefined, digits = 2): string {
  return typeof val === 'number' && Number.isFinite(val) ? val.toFixed(digits) : '-';
}

function truncateText(text: string, maxLen = 42): string {
  return text.length > maxLen ? `${text.slice(0, maxLen - 1)}…` : text;
}

function populateConfigForm(config: GestureConfig): void {
  const setVal = (name: keyof GestureConfig, value: string | number | boolean) => {
    const field = configForm.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement | null;
    if (!field) return;
    if (field instanceof HTMLInputElement && field.type === 'checkbox') {
      field.checked = Boolean(value);
    } else {
      field.value = String(value);
    }
  };

  setVal('blinkCloseThreshold', config.blinkCloseThreshold);
  setVal('blinkOpenThreshold', config.blinkOpenThreshold);
  setVal('maxShortBlinkMs', config.maxShortBlinkMs);
  setVal('longBlinkMinMs', config.longBlinkMinMs);
  setVal('longBlinkMaxMs', config.longBlinkMaxMs);
  setVal('doubleBlinkGapMaxMs', config.doubleBlinkGapMaxMs);
  setVal('gazeMethod', config.gazeMethod);
  setVal('gazeEnterThreshold', config.gazeEnterThreshold);
  setVal('gazeHoldMs', config.gazeHoldMs);
  setVal('headYawMaxDeg', config.headYawMaxDeg);
  setVal('headYawGateEnabled', config.headYawGateEnabled);
  setVal('maxFrameGapMs', config.maxFrameGapMs);
  setVal('stallThresholdMs', config.stallThresholdMs);
  setVal('cameraCaptureResolution', config.cameraCaptureResolution);
  setVal('inputMaxWidth', config.inputMaxWidth);
  setVal('targetFps', config.targetFps);
  setVal('captureMode', config.captureMode);
  setVal('delegatePreference', config.delegatePreference);
  setVal('diagnosticBypassInference', config.diagnosticBypassInference);
  setVal('directVideoFrameGpu', config.directVideoFrameGpu);
  setVal('mirrorHorizontal', config.mirrorHorizontal);
  setVal('invertGazeDirection', config.invertGazeDirection);
}

function renderYouTubeControl(
  yt: YouTubeControlStatusSummary | undefined,
  ytLogs: YouTubeControlLogEntry[] | undefined,
): void {
  if (!yt) {
    youtubeTabCountsEl.textContent = '재생:0 / 가능:0 / 전체:0';
    youtubeLastTargetEl.textContent = '없음';
    youtubeLastExecEl.textContent = '대기 중';
  } else {
    youtubeTabCountsEl.textContent = `재생:${yt.playingTabCount} / 가능:${yt.playableTabCount} / 전체:${yt.trackedTabCount}`;
    if (yt.lastControlledTabId !== null) {
      const title = yt.lastControlledTitle ? truncateText(yt.lastControlledTitle) : '-';
      youtubeLastTargetEl.textContent = `tab#${yt.lastControlledTabId} [${yt.lastControlledPageType ?? '?'}] ${title}`;
    } else {
      youtubeLastTargetEl.textContent = '없음';
    }

    if (yt.lastExecution) {
      const e = yt.lastExecution;
      const tabPart = e.tabId !== null ? `tab#${e.tabId}` : 'tab:none';
      youtubeLastExecEl.textContent = `[${e.commandId}] ${e.command} (${tabPart}) -> ${e.status} (${e.reason}, ${e.windowVisibility})`;
    } else {
      youtubeLastExecEl.textContent = '대기 중';
    }
  }

  if (!ytLogs || ytLogs.length === 0) {
    youtubeLogListEl.textContent = 'YouTube 제어 로그 없음';
    return;
  }

  const fragment = document.createDocumentFragment();
  const recent = [...ytLogs].reverse().slice(0, 30);
  for (const entry of recent) {
    const row = document.createElement('div');
    const isFailedOrSkipped =
      entry.stage === 'YOUTUBE_EXECUTION_RESULT' && entry.data?.status !== 'EXECUTED';
    row.className = `log-row ${
      isFailedOrSkipped ? 'log-stage-YOUTUBE_EXECUTION_FAILED' : `log-stage-${entry.stage}`
    }`;
    const timeShort = entry.wallTimeIso.slice(11, 23);
    const stageShort =
      entry.stage === 'YOUTUBE_COMMAND_RECEIVED'
        ? 'CMD'
        : entry.stage === 'YOUTUBE_TARGET_SELECTED'
          ? 'TARGET'
          : 'EXEC';
    row.textContent = `[${timeShort}] [${stageShort}] [${entry.commandId}] ${entry.summary}`;
    fragment.appendChild(row);
  }
  youtubeLogListEl.replaceChildren(fragment);
}

function renderLogs(logs: DiagnosticLogEntry[]): void {
  if (!logs || logs.length === 0) {
    logListEl.textContent = '로그 없음';
    return;
  }

  const fragment = document.createDocumentFragment();
  // Show newest entries at top for quick validation reading
  const recent = [...logs].reverse().slice(0, 60);
  for (const entry of recent) {
    const row = document.createElement('div');
    row.className = `log-row log-kind-${entry.kind}`;
    const timeShort = entry.wallTimeIso.slice(11, 23);
    row.textContent = `[${timeShort}] [${entry.kind}] ${entry.summary}`;
    fragment.appendChild(row);
  }
  logListEl.replaceChildren(fragment);
}

function renderStatus(status: BackgroundStatusResponse): void {
  const state = status.lifecycleState;
  statusPill.textContent = state;
  statusPill.className = `pill pill-${state.toLowerCase()}`;

  const isActive = state === 'RUNNING' || state === 'STARTING';
  startBtn.disabled = isActive;
  stopBtn.disabled = !isActive && !status.offscreenOpen;

  if (status.lastError) {
    errorBanner.hidden = false;
    errorBanner.textContent = `[${status.lastError.code}] ${status.lastError.message}`;
  } else {
    errorBanner.hidden = true;
    errorBanner.textContent = '';
  }

  if (!configPopulated) {
    populateConfigForm(status.config);
    configPopulated = true;
  }

  if (status.lastCommand) {
    const t = status.lastCommand.wallTimeIso.slice(11, 19);
    const idPart = status.lastCommand.commandId ? ` [${status.lastCommand.commandId}]` : '';
    lastCommandEl.textContent = `${status.lastCommand.command} (${t})${idPart}`;
  } else {
    lastCommandEl.textContent = '없음';
  }

  renderYouTubeControl(status.youtubeStatus, status.youtubeLogs);

  const m = status.metrics;
  if (!m) {
    eyeStateEl.textContent = '-';
    blinkScoresEl.textContent = 'L:- R:-';
    gazeDirEl.textContent = '-';
    gazeScoresEl.textContent = 'sm:- bs:- ir:-';
    headYawStatEl.textContent = 'yaw:-';
    fsmStateEl.textContent = '-';
    earScoresEl.textContent = 'EAR L:- R:-';
    blinkSummaryEl.textContent = '단일:0 | 긴감김:0 | 2연속:0 | 명령:0';
    lastBlinkStatEl.textContent = '최근 깜빡임: closed - | openGap -';
    pipelineMetaEl.textContent = 'OFFSCREEN CLOSED';
    fpsStatEl.textContent = '-';
    readStatEl.textContent = '-';
    schedStatEl.textContent = '-';
    stallStatEl.textContent = '-';
    timingStatEl.textContent = '-';
    frameCountsEl.textContent = '-';
    cameraCapsEl.textContent = 'caps: -';
    currentMarkerEl.textContent = '-';
    renderLogs([]);
    return;
  }

  eyeStateEl.textContent = m.diagnosticBypassInference ? 'BYPASS' : m.currentEyeState;
  blinkScoresEl.textContent = `L:${fmt(m.blinkLeft)} R:${fmt(m.blinkRight)}`;
  gazeDirEl.textContent = m.diagnosticBypassInference
    ? 'BYPASS'
    : m.gazeSuppressedByHeadTurn
      ? 'GATED(고개회전)'
      : m.currentGazeDirection;
  gazeScoresEl.textContent = `sm:${fmt(m.gazeSmoothed)} bs:${fmt(m.gazeRawBlendshape)} ir:${fmt(m.gazeRawIris)}`;
  headYawStatEl.textContent = `yaw:${fmt(m.headYawDeg, 1)}°${m.gazeSuppressedByHeadTurn ? ' [차단]' : ''}`;
  fsmStateEl.textContent = m.diagnosticBypassInference ? 'DIAG_NO_INFER' : m.currentFsmState;
  earScoresEl.textContent = `EAR L:${fmt(m.earLeft)} R:${fmt(m.earRight)}`;
  blinkSummaryEl.textContent = `짧은:${m.blinkCounts.short} | 긴감김:${m.blinkCounts.long} | 2연속:${m.blinkCounts.doubleBlink} | 명령:${m.blinkCounts.commands}`;
  lastBlinkStatEl.textContent = `최근 깜빡임: closed ${m.lastBlinkClosedMs !== null ? `${m.lastBlinkClosedMs}ms` : '-'} | openGap ${m.lastBlinkOpenGapMs !== null ? `${m.lastBlinkOpenGapMs}ms` : '-'}`;

  pipelineMetaEl.textContent = `${m.cameraResolution} | ${m.activeDelegate}`;
  const trackFpsLabel = m.trackReportedFps !== null ? String(m.trackReportedFps) : '?';
  fpsStatEl.textContent = `t:${trackFpsLabel} s:${fmt(m.sourceFrameFps, 1)} r:${m.cameraInputFps} p:${m.rollingFps}(${fmt(m.avgFps, 1)})`;
  readStatEl.textContent = `${fmt(m.avgReadWaitMs, 1)} / ${fmt(m.avgReadCallIntervalMs, 1)}`;
  schedStatEl.textContent = `${fmt(m.avgScheduleDelayMs, 1)} / ${fmt(m.avgReceiveToInferStartMs, 1)} / ${fmt(m.avgInferEndToNextReadResolveMs, 1)}`;
  timingStatEl.textContent = `${fmt(m.avgBlitMs, 1)} / ${fmt(m.avgInferMs, 1)} / ${fmt(m.avgDtMs, 1)}`;
  stallStatEl.textContent = m.activeStallOngoing
    ? `진행중(${m.activeStallDurationMs}ms)`
    : `${fmt(m.maxDtMs, 0)}ms / ${m.frameGapWarnings} / ${m.stallCount}(${m.totalStallMs}ms)`;
  const pathShort =
    m.inputPath === 'bypass_inference'
      ? 'BYPASS'
      : m.inputPath === 'video_frame_zero_copy'
        ? 'ZC'
        : m.inputPath === 'canvas_downscale'
          ? 'CV'
          : m.inputPath === 'timer_video_canvas'
            ? 'TM'
            : '?';
  frameCountsEl.textContent = `${m.totalFrames} / ${m.droppedFrames} (${pathShort})`;
  cameraCapsEl.textContent = `caps: ${m.trackCapabilitiesSummary} | srcΔ:${fmt(m.avgSourceFrameDeltaMs, 1)}ms`;
  currentMarkerEl.textContent = m.currentMarker;

  renderLogs(status.logs);
}

async function refresh(): Promise<void> {
  try {
    const status = await sendBg<BackgroundStatusResponse>({
      target: 'background',
      type: 'GET_STATUS',
      logLimit: 80,
    });
    renderStatus(status);
  } catch (err) {
    errorBanner.hidden = false;
    errorBanner.textContent = `상태 조회 실패: ${err instanceof Error ? err.message : String(err)}`;
  }
}

startBtn.addEventListener('click', () => {
  void (async () => {
    startBtn.disabled = true;
    await sendBg({ target: 'background', type: 'START_TRACKING' });
    await refresh();
  })();
});

stopBtn.addEventListener('click', () => {
  void (async () => {
    stopBtn.disabled = true;
    await sendBg({ target: 'background', type: 'STOP_TRACKING' });
    await refresh();
  })();
});

permBtn.addEventListener('click', () => {
  void sendBg({ target: 'background', type: 'OPEN_PERMISSION_PAGE', autoStart: false });
});

document.querySelectorAll<HTMLButtonElement>('.marker-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const label = btn.dataset.marker;
    if (!label) return;
    void sendBg({ target: 'background', type: 'ADD_MARKER', label }).then(() => refresh());
  });
});

configForm.addEventListener('submit', (ev) => {
  ev.preventDefault();
  const fd = new FormData(configForm);
  const num = (key: string) => Number(fd.get(key));

  const partial: Partial<GestureConfig> = {
    blinkCloseThreshold: num('blinkCloseThreshold'),
    blinkOpenThreshold: num('blinkOpenThreshold'),
    maxShortBlinkMs: num('maxShortBlinkMs'),
    longBlinkMinMs: num('longBlinkMinMs'),
    longBlinkMaxMs: num('longBlinkMaxMs'),
    doubleBlinkGapMaxMs: num('doubleBlinkGapMaxMs'),
    gazeMethod: fd.get('gazeMethod') as GazeMethod,
    gazeEnterThreshold: num('gazeEnterThreshold'),
    gazeHoldMs: num('gazeHoldMs'),
    headYawMaxDeg: num('headYawMaxDeg'),
    headYawGateEnabled: (configForm.elements.namedItem('headYawGateEnabled') as HTMLInputElement).checked,
    maxFrameGapMs: num('maxFrameGapMs'),
    stallThresholdMs: num('stallThresholdMs'),
    cameraCaptureResolution: fd.get('cameraCaptureResolution') as CameraCaptureResolution,
    inputMaxWidth: num('inputMaxWidth'),
    targetFps: num('targetFps'),
    captureMode: fd.get('captureMode') as CaptureMode,
    delegatePreference: fd.get('delegatePreference') as DelegatePreference,
    diagnosticBypassInference: (
      configForm.elements.namedItem('diagnosticBypassInference') as HTMLInputElement
    ).checked,
    directVideoFrameGpu: (configForm.elements.namedItem('directVideoFrameGpu') as HTMLInputElement).checked,
    mirrorHorizontal: (configForm.elements.namedItem('mirrorHorizontal') as HTMLInputElement).checked,
    invertGazeDirection: (configForm.elements.namedItem('invertGazeDirection') as HTMLInputElement).checked,
  };

  void (async () => {
    const res = await sendBg<{ ok: boolean; config: GestureConfig }>({
      target: 'background',
      type: 'UPDATE_CONFIG',
      partial,
    });
    if (res?.config) {
      populateConfigForm(res.config);
    }
    await refresh();
  })();
});

resetConfigBtn.addEventListener('click', () => {
  void (async () => {
    const res = await sendBg<{ ok: boolean; config: GestureConfig }>({
      target: 'background',
      type: 'RESET_CONFIG',
    });
    if (res?.config) {
      populateConfigForm(res.config);
    }
    await refresh();
  })();
});

async function downloadExport(format: 'json' | 'csv'): Promise<void> {
  const res = await sendBg<{ ok: boolean; content: string }>({
    target: 'background',
    type: 'EXPORT_LOGS',
    format,
  });
  if (!res?.ok || !res.content) {
    errorBanner.hidden = false;
    errorBanner.textContent = '내보낼 로그가 없습니다. 트래킹 실행 중에 내보내기를 눌러 주세요.';
    return;
  }

  const mime = format === 'csv' ? 'text/csv;charset=utf-8' : 'application/json;charset=utf-8';
  const blob = new Blob([res.content], { type: mime });
  const url = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const a = document.createElement('a');
  a.href = url;
  a.download = `headplay-phase1-${stamp}.${format}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

exportJsonBtn.addEventListener('click', () => {
  void downloadExport('json');
});

exportCsvBtn.addEventListener('click', () => {
  void downloadExport('csv');
});

clearLogsBtn.addEventListener('click', () => {
  void sendBg({ target: 'background', type: 'CLEAR_LOGS' }).then(() => refresh());
});

// Poll diagnostics only while popup is visible (250ms).
void refresh();
pollTimerId = window.setInterval(() => {
  void refresh();
}, 250);

window.addEventListener('unload', () => {
  if (pollTimerId !== null) {
    window.clearInterval(pollTimerId);
  }
});

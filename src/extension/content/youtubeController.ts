import { GestureCommand } from '../../core/gesture/gestureStateMachine';
import {
  verifyTogglePlayPauseOutcome,
  verifyVideoNavigationOutcome,
} from '../../core/youtube/executionVerifier';
import {
  YouTubePageType,
  YouTubePlayerSnapshot,
  YouTubePlayerStateBrief,
} from '../../core/youtube/types';
import { parseYouTubeUrl } from '../../core/youtube/youtubeUrl';
import { YouTubeExecuteResponse, YouTubePlayerEventType } from '../../shared/messages';

const TOGGLE_VERIFY_TIMEOUT_MS = 700;
const NAV_VERIFY_TIMEOUT_MS = 2500;
const POLL_INTERVAL_MS = 60;

export type PlayerEventCallback = (
  eventType: YouTubePlayerEventType,
  snapshot: YouTubePlayerSnapshot,
) => void;

function createInstanceId(): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `ytcs_${Date.now()}_${rand}`;
}

function isElementHiddenByDisplayOrAttr(el: HTMLElement | null): boolean {
  if (!el || !el.isConnected) return true;
  if (el.hidden || el.getAttribute('aria-hidden') === 'true') return true;
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden') return true;
  return false;
}

/**
 * Checks whether a YouTube control button is genuinely available and enabled.
 * Intentionally does NOT reject opacity: 0 because YouTube auto-hides the
 * player control bar (.ytp-autohide .ytp-chrome-bottom) in background/idle states.
 */
function isControlButtonAvailable(
  el: HTMLElement | null,
  wrapperSelector?: string,
): el is HTMLElement {
  if (!el || !el.isConnected) return false;
  if (isElementHiddenByDisplayOrAttr(el)) return false;

  if (wrapperSelector) {
    const wrapper = el.closest<HTMLElement>(wrapperSelector);
    if (wrapper && isElementHiddenByDisplayOrAttr(wrapper)) {
      return false;
    }
  }

  if (el instanceof HTMLButtonElement && el.disabled) return false;
  if (el.hasAttribute('disabled')) return false;
  if (el.getAttribute('aria-disabled') === 'true') return false;

  if (el instanceof HTMLAnchorElement) {
    const href = el.getAttribute('href')?.trim() ?? '';
    if (!href) return false;
  }

  return true;
}

function findActiveVideoElement(pageType: YouTubePageType): HTMLVideoElement | null {
  if (pageType === 'OTHER') {
    return null;
  }

  if (pageType === 'SHORTS') {
    const activeReelVideo = document.querySelector<HTMLVideoElement>(
      'ytd-reel-video-renderer[is-active] video.html5-main-video, ytd-reel-video-renderer[is-active] video',
    );
    if (activeReelVideo) return activeReelVideo;
    return document.querySelector<HTMLVideoElement>('#shorts-player video');
  }

  // WATCH or PLAYLIST
  return (
    document.querySelector<HTMLVideoElement>('#movie_player video.html5-main-video') ??
    document.querySelector<HTMLVideoElement>('ytd-watch-flexy video.html5-main-video') ??
    document.querySelector<HTMLVideoElement>('.html5-video-player video.html5-main-video')
  );
}

interface NavigationControlCheck {
  button: HTMLElement | null;
  unsupportedReason: string;
}

function findNavigationControl(
  pageType: YouTubePageType,
  direction: 'NEXT' | 'PREV',
): NavigationControlCheck {
  if (pageType === 'OTHER') {
    return { button: null, unsupportedReason: 'NON_PLAYABLE_PAGE' };
  }

  if (pageType === 'SHORTS') {
    const wrapperSel = direction === 'NEXT' ? '#navigation-button-down' : '#navigation-button-up';
    const btn = document.querySelector<HTMLElement>(`${wrapperSel} button`);
    if (!btn) {
      return {
        button: null,
        unsupportedReason:
          direction === 'NEXT' ? 'SHORTS_NEXT_DOM_MISSING' : 'SHORTS_PREV_DOM_MISSING',
      };
    }
    if (!isControlButtonAvailable(btn, wrapperSel)) {
      return {
        button: null,
        unsupportedReason:
          direction === 'NEXT' ? 'SHORTS_NEXT_UNAVAILABLE' : 'SHORTS_PREV_UNAVAILABLE',
      };
    }
    return { button: btn, unsupportedReason: '' };
  }

  // WATCH or PLAYLIST
  const selector =
    direction === 'NEXT'
      ? '#movie_player .ytp-next-button, .html5-video-player .ytp-next-button'
      : '#movie_player .ytp-prev-button, .html5-video-player .ytp-prev-button';
  const btn = document.querySelector<HTMLElement>(selector);
  if (!btn) {
    return {
      button: null,
      unsupportedReason:
        direction === 'NEXT' ? 'PLAYER_NEXT_DOM_MISSING' : 'PLAYER_PREV_DOM_MISSING',
    };
  }
  if (!isControlButtonAvailable(btn)) {
    return {
      button: null,
      unsupportedReason:
        direction === 'NEXT'
          ? 'PLAYER_NEXT_UNAVAILABLE'
          : pageType === 'WATCH'
            ? 'PREV_NOT_AVAILABLE_ON_WATCH'
            : 'PLAYER_PREV_UNAVAILABLE',
    };
  }
  return { button: btn, unsupportedReason: '' };
}

function isVideoActuallyPlaying(video: HTMLVideoElement | null): boolean {
  if (!video) return false;
  return !video.paused && !video.ended && video.readyState >= 2;
}

function roundSec(val: number): number | null {
  return Number.isFinite(val) ? Math.round(val * 100) / 100 : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/**
 * YouTube Content Script controller.
 * - Tracks real DOM play/pause/ended events and SPA navigation epochs.
 * - Invalidates stale playback history whenever URL/video changes or leaves playable pages.
 * - Verifies actual player state changes after every command (never assumes success from click alone).
 * - Never performs history.back() or arbitrary navigation when DOM controls are absent/disabled.
 */
export class YouTubePageController {
  private readonly instanceId = createInstanceId();
  private navigationEpoch = 1;
  private lastKnownUrl = window.location.href;
  private lastKnownVideoId: string | null = parseYouTubeUrl(window.location.href).videoId;
  private lastPlayStartedAtMs: number | null = null;
  private lastPausedAtMs: number | null = null;
  private urlCheckTimerId: number | null = null;
  private disposed = false;

  constructor(private readonly onPlayerEvent: PlayerEventCallback) {}

  start(): void {
    document.addEventListener('play', this.handleCapturePlay, true);
    document.addEventListener('playing', this.handleCapturePlaying, true);
    document.addEventListener('pause', this.handleCapturePause, true);
    document.addEventListener('ended', this.handleCaptureEnded, true);
    window.addEventListener('yt-navigate-finish', this.handleSpaNavigation);
    window.addEventListener('popstate', this.handleSpaNavigation);

    // Light safety net for Shorts/SPA URL updates that don't always emit yt-navigate-finish
    this.urlCheckTimerId = window.setInterval(() => {
      if (window.location.href !== this.lastKnownUrl) {
        this.handleSpaNavigation();
      }
    }, 1000);

    // If the video is already actively playing when the content script mounts, record real active playback once.
    const parsed = parseYouTubeUrl(window.location.href);
    const video = findActiveVideoElement(parsed.pageType);
    if (parsed.isPlayablePage && isVideoActuallyPlaying(video)) {
      this.lastPlayStartedAtMs = Date.now();
    }

    this.onPlayerEvent('MOUNTED', this.getSnapshot());
  }

  dispose(): void {
    this.disposed = true;
    document.removeEventListener('play', this.handleCapturePlay, true);
    document.removeEventListener('playing', this.handleCapturePlaying, true);
    document.removeEventListener('pause', this.handleCapturePause, true);
    document.removeEventListener('ended', this.handleCaptureEnded, true);
    window.removeEventListener('yt-navigate-finish', this.handleSpaNavigation);
    window.removeEventListener('popstate', this.handleSpaNavigation);
    if (this.urlCheckTimerId !== null) {
      window.clearInterval(this.urlCheckTimerId);
      this.urlCheckTimerId = null;
    }
  }

  private syncNavigationStateIfChanged(): boolean {
    const currentUrl = window.location.href;
    if (currentUrl === this.lastKnownUrl) {
      return false;
    }

    const parsed = parseYouTubeUrl(currentUrl);
    const videoChanged = parsed.videoId !== this.lastKnownVideoId;
    this.lastKnownUrl = currentUrl;
    this.lastKnownVideoId = parsed.videoId;
    this.navigationEpoch += 1;

    // Invalidate stale playback timestamps when leaving a playable page or switching videos.
    if (!parsed.isPlayablePage || videoChanged) {
      this.lastPlayStartedAtMs = null;
      this.lastPausedAtMs = null;
      if (parsed.isPlayablePage) {
        const video = findActiveVideoElement(parsed.pageType);
        if (isVideoActuallyPlaying(video)) {
          this.lastPlayStartedAtMs = Date.now();
        }
      }
    }

    return true;
  }

  private readonly handleSpaNavigation = (): void => {
    if (this.disposed) return;
    if (this.syncNavigationStateIfChanged()) {
      this.onPlayerEvent('NAVIGATED', this.getSnapshot());
    }
  };

  private isEventFromActivePlayer(ev: Event): boolean {
    this.syncNavigationStateIfChanged();
    const parsed = parseYouTubeUrl(window.location.href);
    if (!parsed.isPlayablePage) return false;
    const activeVideo = findActiveVideoElement(parsed.pageType);
    return activeVideo !== null && ev.target === activeVideo;
  }

  private readonly handleCapturePlay = (ev: Event): void => {
    if (this.disposed || !this.isEventFromActivePlayer(ev)) return;
    this.lastPlayStartedAtMs = Date.now();
    this.onPlayerEvent('PLAY', this.getSnapshot());
  };

  private readonly handleCapturePlaying = (ev: Event): void => {
    if (this.disposed || !this.isEventFromActivePlayer(ev)) return;
    // Update only if play timestamp wasn't just set within the last 500ms (avoid play+playing double burst)
    const now = Date.now();
    if (this.lastPlayStartedAtMs === null || now - this.lastPlayStartedAtMs > 500) {
      this.lastPlayStartedAtMs = now;
      this.onPlayerEvent('PLAY', this.getSnapshot());
    }
  };

  private readonly handleCapturePause = (ev: Event): void => {
    if (this.disposed || !this.isEventFromActivePlayer(ev)) return;
    this.lastPausedAtMs = Date.now();
    this.onPlayerEvent('PAUSE', this.getSnapshot());
  };

  private readonly handleCaptureEnded = (ev: Event): void => {
    if (this.disposed || !this.isEventFromActivePlayer(ev)) return;
    this.lastPausedAtMs = Date.now();
    this.onPlayerEvent('ENDED', this.getSnapshot());
  };

  getBriefState(): YouTubePlayerStateBrief {
    this.syncNavigationStateIfChanged();
    const url = window.location.href;
    const parsed = parseYouTubeUrl(url);
    const video = findActiveVideoElement(parsed.pageType);
    return {
      url,
      pageType: parsed.pageType,
      videoId: parsed.videoId,
      paused: video ? video.paused : null,
      ended: video ? video.ended : null,
      currentTimeSec: video ? roundSec(video.currentTime) : null,
    };
  }

  getSnapshot(): YouTubePlayerSnapshot {
    this.syncNavigationStateIfChanged();
    const url = window.location.href;
    const parsed = parseYouTubeUrl(url);
    const video = findActiveVideoElement(parsed.pageType);
    const hasPlayableVideo = parsed.isPlayablePage && video !== null;
    const playing = hasPlayableVideo && isVideoActuallyPlaying(video);

    // If video is genuinely playing right now (e.g. autoplay right after navigation before play listener)
    // ensure lastPlayStartedAtMs is populated; if not playing, never fabricate a timestamp.
    if (playing && this.lastPlayStartedAtMs === null) {
      this.lastPlayStartedAtMs = Date.now();
    }

    const nextCheck = hasPlayableVideo
      ? findNavigationControl(parsed.pageType, 'NEXT')
      : { button: null, unsupportedReason: 'NO_VIDEO' };
    const prevCheck = hasPlayableVideo
      ? findNavigationControl(parsed.pageType, 'PREV')
      : { button: null, unsupportedReason: 'NO_VIDEO' };

    return {
      contentScriptInstanceId: this.instanceId,
      navigationEpoch: this.navigationEpoch,
      url,
      title: document.title || url,
      pageType: parsed.pageType,
      videoId: parsed.videoId,
      hasPlayableVideo,
      isPlaying: playing,
      isPaused: hasPlayableVideo ? Boolean(video?.paused) : false,
      isEnded: hasPlayableVideo ? Boolean(video?.ended) : false,
      currentTimeSec: video ? roundSec(video.currentTime) : null,
      durationSec: video ? roundSec(video.duration) : null,
      lastPlayStartedAtMs: hasPlayableVideo ? this.lastPlayStartedAtMs : null,
      lastPausedAtMs: hasPlayableVideo ? this.lastPausedAtMs : null,
      canNext: nextCheck.button !== null,
      canPrev: prevCheck.button !== null,
      capturedAtMs: Date.now(),
    };
  }

  async executeCommand(commandId: string, command: GestureCommand): Promise<YouTubeExecuteResponse> {
    this.syncNavigationStateIfChanged();
    const url = window.location.href;
    const parsed = parseYouTubeUrl(url);
    const beforeState = this.getBriefState();

    if (!parsed.isPlayablePage) {
      return {
        ok: false,
        commandId,
        command,
        status: 'UNSUPPORTED',
        verified: false,
        reason: 'NON_PLAYABLE_PAGE',
        pageType: parsed.pageType,
        beforeState,
        afterState: this.getBriefState(),
        snapshot: this.getSnapshot(),
      };
    }

    const video = findActiveVideoElement(parsed.pageType);
    if (!video) {
      return {
        ok: false,
        commandId,
        command,
        status: 'FAILED',
        verified: false,
        reason: 'VIDEO_ELEMENT_NOT_FOUND',
        pageType: parsed.pageType,
        beforeState,
        afterState: this.getBriefState(),
        snapshot: this.getSnapshot(),
      };
    }

    if (command === 'TOGGLE_PLAY_PAUSE') {
      return this.executeTogglePlayPause(commandId, parsed.pageType, video, beforeState);
    }

    return this.executeVideoNavigation(commandId, command, parsed.pageType, beforeState);
  }

  private async executeTogglePlayPause(
    commandId: string,
    pageType: YouTubePageType,
    video: HTMLVideoElement,
    beforeState: YouTubePlayerStateBrief,
  ): Promise<YouTubeExecuteResponse> {
    const shouldPlay = video.paused || video.ended;
    const expectedTargetPaused = !shouldPlay;

    if (shouldPlay) {
      try {
        await video.play();
      } catch (err) {
        const errName = err instanceof Error ? err.name : 'PlayError';
        const afterState = this.getBriefState();
        return {
          ok: false,
          commandId,
          command: 'TOGGLE_PLAY_PAUSE',
          status: 'FAILED',
          verified: false,
          reason: `PLAY_REJECTED:${errName}`,
          pageType,
          beforeState,
          afterState,
          snapshot: this.getSnapshot(),
        };
      }
    } else {
      video.pause();
    }

    // Wait for real DOM video.paused state confirmation
    await this.waitForCondition(
      () => {
        const currentVideo = findActiveVideoElement(parseYouTubeUrl(window.location.href).pageType);
        if (!currentVideo) return false;
        return currentVideo.paused === expectedTargetPaused;
      },
      TOGGLE_VERIFY_TIMEOUT_MS,
    );

    const afterState = this.getBriefState();
    const verification = verifyTogglePlayPauseOutcome(expectedTargetPaused, beforeState, afterState);

    return {
      ok: verification.status === 'EXECUTED',
      commandId,
      command: 'TOGGLE_PLAY_PAUSE',
      status: verification.status,
      verified: verification.verified,
      reason: verification.reason,
      pageType,
      beforeState,
      afterState,
      snapshot: this.getSnapshot(),
    };
  }

  private async executeVideoNavigation(
    commandId: string,
    command: Exclude<GestureCommand, 'TOGGLE_PLAY_PAUSE'>,
    pageType: YouTubePageType,
    beforeState: YouTubePlayerStateBrief,
  ): Promise<YouTubeExecuteResponse> {
    const direction = command === 'NEXT_VIDEO' ? 'NEXT' : 'PREV';
    const control = findNavigationControl(pageType, direction);

    if (!control.button) {
      return {
        ok: false,
        commandId,
        command,
        status: 'UNSUPPORTED',
        verified: false,
        reason: control.unsupportedReason,
        pageType,
        beforeState,
        afterState: this.getBriefState(),
        snapshot: this.getSnapshot(),
      };
    }

    // Trigger genuine YouTube player button click (never history.back / arbitrary navigation)
    control.button.click();

    // Wait until actual videoId changes (do NOT trust the click alone)
    await this.waitForCondition(() => {
      const current = parseYouTubeUrl(window.location.href);
      return (
        current.isPlayablePage &&
        current.videoId !== null &&
        beforeState.videoId !== null &&
        current.videoId !== beforeState.videoId
      );
    }, NAV_VERIFY_TIMEOUT_MS);

    this.syncNavigationStateIfChanged();
    const afterState = this.getBriefState();
    const verification = verifyVideoNavigationOutcome(command, beforeState, afterState);

    return {
      ok: verification.status === 'EXECUTED',
      commandId,
      command,
      status: verification.status,
      verified: verification.verified,
      reason: verification.reason,
      pageType: afterState.pageType !== 'OTHER' ? afterState.pageType : pageType,
      beforeState,
      afterState,
      snapshot: this.getSnapshot(),
    };
  }

  private async waitForCondition(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
    if (predicate()) return true;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS);
      if (predicate()) return true;
    }
    return predicate();
  }
}

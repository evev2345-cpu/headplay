import {
  BackgroundMessage,
  YouTubeContentMessage,
  YouTubePlayerEventType,
  YouTubeProbeResponse,
} from '../../shared/messages';
import { YouTubePlayerSnapshot } from '../../core/youtube/types';
import { YouTubePageController } from './youtubeController';

function reportToBackground(
  eventType: YouTubePlayerEventType,
  snapshot: YouTubePlayerSnapshot,
): void {
  const msg: BackgroundMessage = {
    target: 'background',
    type: 'YOUTUBE_PLAYER_EVENT',
    eventType,
    snapshot,
  };
  chrome.runtime.sendMessage(msg).catch(() => {
    // Background SW may be reloading or extension context invalidated.
  });
}

const controller = new YouTubePageController(reportToBackground);
controller.start();

chrome.runtime.onMessage.addListener((raw: unknown, _sender, sendResponse) => {
  const msg = raw as YouTubeContentMessage | undefined;
  if (!msg || msg.target !== 'youtube-content') {
    return false;
  }

  if (msg.type === 'YOUTUBE_PROBE_STATE') {
    const res: YouTubeProbeResponse = {
      ok: true,
      snapshot: controller.getSnapshot(),
    };
    sendResponse(res);
    return false;
  }

  if (msg.type === 'YOUTUBE_EXECUTE_COMMAND') {
    void controller
      .executeCommand(msg.commandId, msg.command)
      .then((res) => sendResponse(res))
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        sendResponse({
          ok: false,
          commandId: msg.commandId,
          command: msg.command,
          status: 'FAILED',
          verified: false,
          reason: `CONTENT_SCRIPT_EXCEPTION:${message}`,
          pageType: 'OTHER',
          beforeState: null,
          afterState: null,
          snapshot: controller.getSnapshot(),
        });
      });
    return true;
  }

  return false;
});

import { YouTubePageType } from './types';

export interface ParsedYouTubeUrl {
  isYouTube: boolean;
  pageType: YouTubePageType;
  videoId: string | null;
  playlistId: string | null;
  isPlayablePage: boolean;
}

const SUPPORTED_HOSTS = new Set(['www.youtube.com']);

/**
 * Classifies a YouTube URL into WATCH, PLAYLIST, SHORTS, or OTHER and extracts videoId/playlistId.
 * Pure function with zero DOM or Chrome API dependency.
 */
export function parseYouTubeUrl(rawUrl: string): ParsedYouTubeUrl {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return nonYouTube();
    }
    if (!SUPPORTED_HOSTS.has(parsed.hostname.toLowerCase())) {
      return nonYouTube();
    }

    const pathname = parsed.pathname;

    // Watch / Playlist pages: https://www.youtube.com/watch?v=...(&list=...)
    if (pathname === '/watch') {
      const videoId = cleanId(parsed.searchParams.get('v'));
      const playlistId = cleanId(parsed.searchParams.get('list'));
      if (videoId) {
        return {
          isYouTube: true,
          pageType: playlistId ? 'PLAYLIST' : 'WATCH',
          videoId,
          playlistId,
          isPlayablePage: true,
        };
      }
      return {
        isYouTube: true,
        pageType: 'OTHER',
        videoId: null,
        playlistId,
        isPlayablePage: false,
      };
    }

    // Shorts pages: https://www.youtube.com/shorts/<videoId>
    const shortsMatch = /^\/shorts\/([A-Za-z0-9_-]{6,})/.exec(pathname);
    if (shortsMatch?.[1]) {
      return {
        isYouTube: true,
        pageType: 'SHORTS',
        videoId: shortsMatch[1],
        playlistId: null,
        isPlayablePage: true,
      };
    }

    // Live watch pages: https://www.youtube.com/live/<videoId>
    const liveMatch = /^\/live\/([A-Za-z0-9_-]{6,})/.exec(pathname);
    if (liveMatch?.[1]) {
      return {
        isYouTube: true,
        pageType: 'WATCH',
        videoId: liveMatch[1],
        playlistId: cleanId(parsed.searchParams.get('list')),
        isPlayablePage: true,
      };
    }

    // Non-playable pages (Home, /results, /feed/*, /channel/*, /@handle, /playlist, etc.)
    return {
      isYouTube: true,
      pageType: 'OTHER',
      videoId: null,
      playlistId: cleanId(parsed.searchParams.get('list')),
      isPlayablePage: false,
    };
  } catch {
    return nonYouTube();
  }
}

function cleanId(val: string | null): string | null {
  if (!val) return null;
  const trimmed = val.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function nonYouTube(): ParsedYouTubeUrl {
  return {
    isYouTube: false,
    pageType: 'OTHER',
    videoId: null,
    playlistId: null,
    isPlayablePage: false,
  };
}

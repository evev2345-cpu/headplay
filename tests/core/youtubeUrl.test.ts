import { describe, expect, it } from 'vitest';
import { parseYouTubeUrl } from '../../src/core/youtube/youtubeUrl';

describe('parseYouTubeUrl', () => {
  it('classifies normal watch URLs as WATCH and extracts videoId', () => {
    const res = parseYouTubeUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s');
    expect(res).toEqual({
      isYouTube: true,
      pageType: 'WATCH',
      videoId: 'dQw4w9WgXcQ',
      playlistId: null,
      isPlayablePage: true,
    });
  });

  it('classifies watch URLs with list parameter as PLAYLIST', () => {
    const res = parseYouTubeUrl('https://www.youtube.com/watch?v=abc123XYZ00&list=PL12345&index=3');
    expect(res).toEqual({
      isYouTube: true,
      pageType: 'PLAYLIST',
      videoId: 'abc123XYZ00',
      playlistId: 'PL12345',
      isPlayablePage: true,
    });
  });

  it('classifies Shorts URLs as SHORTS and extracts videoId', () => {
    const res = parseYouTubeUrl('https://www.youtube.com/shorts/shortId_123');
    expect(res).toEqual({
      isYouTube: true,
      pageType: 'SHORTS',
      videoId: 'shortId_123',
      playlistId: null,
      isPlayablePage: true,
    });
  });

  it('classifies Live URLs as WATCH', () => {
    const res = parseYouTubeUrl('https://www.youtube.com/live/liveStream99');
    expect(res.pageType).toBe('WATCH');
    expect(res.videoId).toBe('liveStream99');
    expect(res.isPlayablePage).toBe(true);
  });

  it('excludes non-playable YouTube pages (home, search, feed, playlist overview) and non-YouTube URLs', () => {
    for (const url of [
      'https://www.youtube.com/',
      'https://www.youtube.com/results?search_query=music',
      'https://www.youtube.com/feed/subscriptions',
      'https://www.youtube.com/playlist?list=PL12345',
      'https://www.youtube.com/watch',
    ]) {
      const res = parseYouTubeUrl(url);
      expect(res.isYouTube).toBe(true);
      expect(res.pageType).toBe('OTHER');
      expect(res.isPlayablePage).toBe(false);
    }

    const other = parseYouTubeUrl('https://example.com/watch?v=123');
    expect(other.isYouTube).toBe(false);
    expect(other.isPlayablePage).toBe(false);
  });
});

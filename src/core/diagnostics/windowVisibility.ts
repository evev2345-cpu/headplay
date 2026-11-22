export type WindowVisibilityMarker =
  | 'CHROME_ALL_MINIMIZED'
  | 'CHROME_UNFOCUSED_VISIBLE'
  | 'CHROME_FOCUSED'
  | 'NO_CHROME_WINDOWS';

export interface WindowStateLike {
  state?: string;
  focused?: boolean;
}

export interface WindowVisibilitySummary {
  marker: WindowVisibilityMarker;
  totalWindows: number;
  minimizedWindows: number;
  focusedWindows: number;
}

/**
 * Classifies Chrome's actual window visibility strictly from chrome.windows.getAll() states.
 * Distinguishes "all Chrome windows minimized" from "Chrome unfocused but still visible".
 */
export function classifyWindowVisibility(windows: WindowStateLike[]): WindowVisibilitySummary {
  const totalWindows = windows.length;
  if (totalWindows === 0) {
    return {
      marker: 'NO_CHROME_WINDOWS',
      totalWindows: 0,
      minimizedWindows: 0,
      focusedWindows: 0,
    };
  }

  let minimizedWindows = 0;
  let focusedWindows = 0;
  let anyVisibleFocused = false;

  for (const w of windows) {
    const isMinimized = w.state === 'minimized';
    if (isMinimized) {
      minimizedWindows += 1;
    }
    if (w.focused) {
      focusedWindows += 1;
      if (!isMinimized) {
        anyVisibleFocused = true;
      }
    }
  }

  if (minimizedWindows === totalWindows) {
    return {
      marker: 'CHROME_ALL_MINIMIZED',
      totalWindows,
      minimizedWindows,
      focusedWindows,
    };
  }

  if (anyVisibleFocused) {
    return {
      marker: 'CHROME_FOCUSED',
      totalWindows,
      minimizedWindows,
      focusedWindows,
    };
  }

  return {
    marker: 'CHROME_UNFOCUSED_VISIBLE',
    totalWindows,
    minimizedWindows,
    focusedWindows,
  };
}

import { describe, expect, it } from 'vitest';
import { classifyWindowVisibility } from '../../src/core/diagnostics/windowVisibility';

describe('classifyWindowVisibility', () => {
  it('returns CHROME_ALL_MINIMIZED only when every Chrome window has state=minimized', () => {
    expect(
      classifyWindowVisibility([
        { state: 'minimized', focused: false },
        { state: 'minimized', focused: false },
      ]),
    ).toEqual({
      marker: 'CHROME_ALL_MINIMIZED',
      totalWindows: 2,
      minimizedWindows: 2,
      focusedWindows: 0,
    });
  });

  it('distinguishes focus loss (CHROME_UNFOCUSED_VISIBLE) from full minimization', () => {
    // One window minimized, another window still normal/visible while user switched to Notepad
    expect(
      classifyWindowVisibility([
        { state: 'minimized', focused: false },
        { state: 'normal', focused: false },
      ]),
    ).toEqual({
      marker: 'CHROME_UNFOCUSED_VISIBLE',
      totalWindows: 2,
      minimizedWindows: 1,
      focusedWindows: 0,
    });
  });

  it('returns CHROME_FOCUSED when any visible window is focused', () => {
    expect(
      classifyWindowVisibility([
        { state: 'minimized', focused: false },
        { state: 'maximized', focused: true },
      ]),
    ).toEqual({
      marker: 'CHROME_FOCUSED',
      totalWindows: 2,
      minimizedWindows: 1,
      focusedWindows: 1,
    });
  });

  it('returns NO_CHROME_WINDOWS when window list is empty', () => {
    expect(classifyWindowVisibility([])).toEqual({
      marker: 'NO_CHROME_WINDOWS',
      totalWindows: 0,
      minimizedWindows: 0,
      focusedWindows: 0,
    });
  });
});

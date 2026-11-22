import { describe, expect, it } from 'vitest';
import {
  EMPTY_COMMAND_GUARD_STATE,
  evaluateCommandGuard,
  releaseCommandGuard,
} from '../../src/core/youtube/commandGuard';

describe('commandGuard', () => {
  it('accepts initial command and drops overlapping commands while in-flight', () => {
    const d1 = evaluateCommandGuard(EMPTY_COMMAND_GUARD_STATE, 'TOGGLE_PLAY_PAUSE', 1000, 10_000);
    expect(d1.accepted).toBe(true);
    expect(d1.commandId).toBe('cmd_10000_1');

    const d2 = evaluateCommandGuard(d1.nextState, 'NEXT_VIDEO', 1200, 10_200);
    expect(d2.accepted).toBe(false);
    if (!d2.accepted) {
      expect(d2.reason).toBe('DROPPED_IN_FLIGHT');
    }
  });

  it('drops duplicate identical gesture timestamp and identical command within dedupeWindowMs after release', () => {
    const d1 = evaluateCommandGuard(EMPTY_COMMAND_GUARD_STATE, 'TOGGLE_PLAY_PAUSE', 5000, 20_000);
    expect(d1.accepted).toBe(true);
    const released = releaseCommandGuard(d1.nextState, d1.commandId);

    // Same gesture timestamp -> DROPPED_DUPLICATE_TIMESTAMP
    const dupTs = evaluateCommandGuard(released, 'TOGGLE_PLAY_PAUSE', 5000, 20_900);
    expect(dupTs.accepted).toBe(false);
    if (!dupTs.accepted) {
      expect(dupTs.reason).toBe('DROPPED_DUPLICATE_TIMESTAMP');
    }

    // Different timestamp, same command within 650ms window -> DROPPED_DUPLICATE_WINDOW
    const dupWin = evaluateCommandGuard(released, 'TOGGLE_PLAY_PAUSE', 5300, 20_300);
    expect(dupWin.accepted).toBe(false);
    if (!dupWin.accepted) {
      expect(dupWin.reason).toBe('DROPPED_DUPLICATE_WINDOW');
    }

    // Different command after release is accepted immediately
    const diffCmd = evaluateCommandGuard(released, 'NEXT_VIDEO', 5350, 20_350);
    expect(diffCmd.accepted).toBe(true);

    // Same command after dedupe window is accepted
    const afterWin = evaluateCommandGuard(released, 'TOGGLE_PLAY_PAUSE', 5800, 20_800);
    expect(afterWin.accepted).toBe(true);
  });

  it('auto-expires stuck in-flight lock past inFlightTimeoutMs', () => {
    const d1 = evaluateCommandGuard(EMPTY_COMMAND_GUARD_STATE, 'NEXT_VIDEO', 1000, 50_000);
    expect(d1.accepted).toBe(true);

    // 6 seconds later without release -> lock expires and new command proceeds
    const d2 = evaluateCommandGuard(d1.nextState, 'NEXT_VIDEO', 7000, 56_000);
    expect(d2.accepted).toBe(true);
  });
});

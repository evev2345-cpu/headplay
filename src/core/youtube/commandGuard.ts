import { GestureCommand } from '../gesture/gestureStateMachine';

export interface CommandGuardOptions {
  /** Rejects repeated identical commands arriving within this window (ms). */
  dedupeWindowMs: number;
  /** Safety valve releasing a stuck in-flight lock after this duration (ms). */
  inFlightTimeoutMs: number;
}

export const DEFAULT_COMMAND_GUARD_OPTIONS: CommandGuardOptions = {
  dedupeWindowMs: 650,
  inFlightTimeoutMs: 5000,
};

export interface CommandGuardPersistedState {
  inFlightCommandId: string | null;
  inFlightStartedAtMs: number | null;
  lastAcceptedCommand: GestureCommand | null;
  lastAcceptedGestureTsMs: number | null;
  lastAcceptedWallMs: number | null;
  seq: number;
}

export const EMPTY_COMMAND_GUARD_STATE: CommandGuardPersistedState = {
  inFlightCommandId: null,
  inFlightStartedAtMs: null,
  lastAcceptedCommand: null,
  lastAcceptedGestureTsMs: null,
  lastAcceptedWallMs: null,
  seq: 0,
};

export type CommandGuardDecision =
  | {
      accepted: true;
      commandId: string;
      nextState: CommandGuardPersistedState;
    }
  | {
      accepted: false;
      commandId: string;
      reason: 'DROPPED_IN_FLIGHT' | 'DROPPED_DUPLICATE_TIMESTAMP' | 'DROPPED_DUPLICATE_WINDOW';
      nextState: CommandGuardPersistedState;
    };

/**
 * Pure state-transition guard preventing duplicate commands and overlapping executions,
 * compatible with MV3 Service Worker storage.session persistence.
 */
export function evaluateCommandGuard(
  state: CommandGuardPersistedState,
  command: GestureCommand,
  gestureTimestampMs: number,
  nowWallMs: number,
  options: CommandGuardOptions = DEFAULT_COMMAND_GUARD_OPTIONS,
): CommandGuardDecision {
  const nextSeq = state.seq + 1;
  const commandId = `cmd_${nowWallMs}_${nextSeq}`;

  // Check active in-flight lock (auto-expire only if stuck past safety timeout)
  if (
    state.inFlightCommandId !== null &&
    state.inFlightStartedAtMs !== null &&
    nowWallMs - state.inFlightStartedAtMs < options.inFlightTimeoutMs
  ) {
    return {
      accepted: false,
      commandId,
      reason: 'DROPPED_IN_FLIGHT',
      nextState: {
        ...state,
        seq: nextSeq,
      },
    };
  }

  // Exact duplicate gesture event timestamp for the same command
  if (
    state.lastAcceptedCommand === command &&
    state.lastAcceptedGestureTsMs !== null &&
    Math.abs(gestureTimestampMs - state.lastAcceptedGestureTsMs) < 1
  ) {
    return {
      accepted: false,
      commandId,
      reason: 'DROPPED_DUPLICATE_TIMESTAMP',
      nextState: {
        ...state,
        inFlightCommandId: null,
        inFlightStartedAtMs: null,
        seq: nextSeq,
      },
    };
  }

  // Same command repeated inside dedupe window
  if (
    state.lastAcceptedCommand === command &&
    state.lastAcceptedWallMs !== null &&
    nowWallMs - state.lastAcceptedWallMs >= 0 &&
    nowWallMs - state.lastAcceptedWallMs < options.dedupeWindowMs
  ) {
    return {
      accepted: false,
      commandId,
      reason: 'DROPPED_DUPLICATE_WINDOW',
      nextState: {
        ...state,
        inFlightCommandId: null,
        inFlightStartedAtMs: null,
        seq: nextSeq,
      },
    };
  }

  return {
    accepted: true,
    commandId,
    nextState: {
      inFlightCommandId: commandId,
      inFlightStartedAtMs: nowWallMs,
      lastAcceptedCommand: command,
      lastAcceptedGestureTsMs: gestureTimestampMs,
      lastAcceptedWallMs: nowWallMs,
      seq: nextSeq,
    },
  };
}

export function releaseCommandGuard(
  state: CommandGuardPersistedState,
  commandId: string,
): CommandGuardPersistedState {
  if (state.inFlightCommandId !== commandId) {
    return state;
  }
  return {
    ...state,
    inFlightCommandId: null,
    inFlightStartedAtMs: null,
  };
}

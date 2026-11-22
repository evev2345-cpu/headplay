import { describe, expect, it } from 'vitest';
import { GestureEvent, GestureStateMachine } from '../../src/core/gesture/gestureStateMachine';
import { EyeObservation, EyeState, GazeDirection } from '../../src/core/vision/types';

function makeObs(
  timestampMs: number,
  eyeState: EyeState = 'OPEN',
  gazeDirection: GazeDirection = 'CENTER',
  faceDetected = true,
): EyeObservation {
  return {
    timestampMs,
    faceDetected,
    blinkLeft: eyeState === 'CLOSED' ? 0.8 : 0.05,
    blinkRight: eyeState === 'CLOSED' ? 0.8 : 0.05,
    blinkMin: eyeState === 'CLOSED' ? 0.8 : 0.05,
    blinkMax: eyeState === 'CLOSED' ? 0.8 : 0.05,
    earLeft: eyeState === 'CLOSED' ? 0.1 : 0.32,
    earRight: eyeState === 'CLOSED' ? 0.1 : 0.32,
    eyeState,
    gazeRawBlendshape: gazeDirection === 'RIGHT' ? 0.6 : gazeDirection === 'LEFT' ? -0.6 : 0,
    gazeRawIris: gazeDirection === 'RIGHT' ? 0.6 : gazeDirection === 'LEFT' ? -0.6 : 0,
    gazeSmoothed: gazeDirection === 'RIGHT' ? 0.6 : gazeDirection === 'LEFT' ? -0.6 : 0,
    gazeDirection: eyeState === 'CLOSED' || !faceDetected ? 'UNKNOWN' : gazeDirection,
    headYawDeg: 0,
    gazeSuppressedByHeadTurn: false,
  };
}

function feedSegment(
  fsm: GestureStateMachine,
  startMs: number,
  durationMs: number,
  stepMs: number,
  eyeState: EyeState,
  gazeDirection: GazeDirection = 'CENTER',
  faceDetected = true,
): { endMs: number; events: GestureEvent[] } {
  const events: GestureEvent[] = [];
  let t = startMs;
  const end = startMs + durationMs;
  while (t < end) {
    const res = fsm.update(makeObs(t, eyeState, gazeDirection, faceDetected));
    events.push(...res.events);
    t += stepMs;
  }
  return { endMs: t, events };
}

describe('GestureStateMachine', () => {
  it('ignores natural single blinks (160ms) without emitting commands', () => {
    const fsm = new GestureStateMachine();
    const events: GestureEvent[] = [];

    let t = 0;
    ({ endMs: t } = feedSegment(fsm, t, 200, 40, 'OPEN', 'CENTER'));
    const s1 = feedSegment(fsm, t, 160, 40, 'CLOSED', 'UNKNOWN');
    events.push(...s1.events);
    t = s1.endMs;
    const s2 = feedSegment(fsm, t, 700, 40, 'OPEN', 'CENTER');
    events.push(...s2.events);

    expect(events.filter((e) => e.type === 'GESTURE_COMMAND')).toHaveLength(0);
    expect(fsm.getState()).toBe('IDLE');
  });

  it('ignores guard-band blinks (400ms) between short and long blink thresholds', () => {
    const fsm = new GestureStateMachine();
    const events: GestureEvent[] = [];

    let t = 0;
    ({ endMs: t } = feedSegment(fsm, t, 120, 40, 'OPEN'));
    const closed = feedSegment(fsm, t, 400, 40, 'CLOSED');
    events.push(...closed.events);
    t = closed.endMs;
    const open = feedSegment(fsm, t, 200, 40, 'OPEN');
    events.push(...open.events);

    expect(events.filter((e) => e.type === 'GESTURE_COMMAND')).toHaveLength(0);
    expect(events.some((e) => e.type === 'BLINK_MEASURED' && e.classification === 'GUARD_BAND')).toBe(true);
    expect(fsm.getState()).toBe('IDLE');
  });

  it('triggers TOGGLE_PLAY_PAUSE on a ~600ms long blink and respects cooldown', () => {
    const fsm = new GestureStateMachine();
    const events: GestureEvent[] = [];

    let t = 0;
    ({ endMs: t } = feedSegment(fsm, t, 120, 40, 'OPEN'));
    const closed = feedSegment(fsm, t, 600, 40, 'CLOSED');
    events.push(...closed.events);
    t = closed.endMs;
    const open = feedSegment(fsm, t, 120, 40, 'OPEN');
    events.push(...open.events);
    t = open.endMs;

    const cmds = events.filter((e) => e.type === 'GESTURE_COMMAND');
    expect(cmds).toHaveLength(1);
    expect(cmds[0]?.type === 'GESTURE_COMMAND' && cmds[0].command).toBe('TOGGLE_PLAY_PAUSE');
    expect(fsm.getState()).toBe('COOLDOWN');

    // Another long blink during cooldown must be ignored
    const closedDuringCooldown = feedSegment(fsm, t, 600, 40, 'CLOSED');
    t = closedDuringCooldown.endMs;
    const openDuringCooldown = feedSegment(fsm, t, 600, 40, 'OPEN');
    expect(
      [...closedDuringCooldown.events, ...openDuringCooldown.events].filter(
        (e) => e.type === 'GESTURE_COMMAND',
      ),
    ).toHaveLength(0);
    expect(fsm.getState()).toBe('IDLE');
  });

  it('ignores prolonged eye closure (>1.5s), blocks re-entry until eyes fully open, then allows valid gestures', () => {
    const fsm = new GestureStateMachine({ longBlinkMaxMs: 1500 });
    const events: GestureEvent[] = [];

    let t = 0;
    ({ endMs: t } = feedSegment(fsm, t, 120, 40, 'OPEN'));
    // Eyes closed for 2.4 seconds (resting/sleeping)
    const resting = feedSegment(fsm, t, 2400, 40, 'CLOSED');
    events.push(...resting.events);
    t = resting.endMs;

    // While still closed past 1.5s, lockout must remain active and state must stay IDLE
    const stillClosed = fsm.update(makeObs(t, 'CLOSED'));
    t += 40;
    expect(stillClosed.state).toBe('IDLE');
    expect(stillClosed.snapshot.awaitingOpenAfterLongClose).toBe(true);
    expect(events.filter((e) => e.type === 'GESTURE_COMMAND')).toHaveLength(0);

    // Reopening eyes clears lockout
    const reopened = fsm.update(makeObs(t, 'OPEN'));
    t += 40;
    expect(reopened.snapshot.awaitingOpenAfterLongClose).toBe(false);

    // Subsequent valid 600ms long blink must now work normally
    const closedValid = feedSegment(fsm, t, 600, 40, 'CLOSED');
    t = closedValid.endMs;
    const openValid = feedSegment(fsm, t, 80, 40, 'OPEN');
    const cmds = [...closedValid.events, ...openValid.events].filter((e) => e.type === 'GESTURE_COMMAND');
    expect(cmds).toHaveLength(1);
    expect(cmds[0]?.type === 'GESTURE_COMMAND' && cmds[0].command).toBe('TOGGLE_PLAY_PAUSE');
  });

  it('blocks re-recognition until eyes open when second blink exceeds maxShortBlinkMs', () => {
    const fsm = new GestureStateMachine({ maxShortBlinkMs: 350 });

    let t = 0;
    ({ endMs: t } = feedSegment(fsm, t, 80, 40, 'OPEN'));
    // Valid short blink 1 (160ms) + gap (120ms)
    ({ endMs: t } = feedSegment(fsm, t, 160, 40, 'CLOSED'));
    ({ endMs: t } = feedSegment(fsm, t, 120, 40, 'OPEN'));
    // Second blink held for 720ms (> maxShortBlinkMs)
    const heldBlink2 = feedSegment(fsm, t, 720, 40, 'CLOSED');
    t = heldBlink2.endMs;

    const stillClosed = fsm.update(makeObs(t, 'CLOSED'));
    t += 40;
    expect(stillClosed.state).toBe('IDLE');
    expect(stillClosed.snapshot.awaitingOpenAfterLongClose).toBe(true);
    expect(heldBlink2.events.filter((e) => e.type === 'GESTURE_COMMAND')).toHaveLength(0);

    // Reopening clears lockout cleanly without emitting any command
    const reopened = fsm.update(makeObs(t, 'OPEN'));
    expect(reopened.snapshot.awaitingOpenAfterLongClose).toBe(false);
    expect(reopened.events.filter((e) => e.type === 'GESTURE_COMMAND')).toHaveLength(0);
  });

  it('blocks re-recognition until eyes open when ARMED_GAZE is cancelled by closing eyes', () => {
    const fsm = new GestureStateMachine();

    let t = 0;
    ({ endMs: t } = feedSegment(fsm, t, 80, 40, 'OPEN'));
    ({ endMs: t } = feedSegment(fsm, t, 160, 40, 'CLOSED'));
    ({ endMs: t } = feedSegment(fsm, t, 120, 40, 'OPEN'));
    ({ endMs: t } = feedSegment(fsm, t, 160, 40, 'CLOSED'));
    ({ endMs: t } = feedSegment(fsm, t, 80, 40, 'OPEN'));
    expect(fsm.getState()).toBe('ARMED_GAZE');

    // Re-closing eyes during ARMED_GAZE cancels and locks out until eyes reopen
    const cancelRes = fsm.update(makeObs(t, 'CLOSED'));
    t += 40;
    expect(cancelRes.state).toBe('IDLE');
    expect(cancelRes.snapshot.awaitingOpenAfterLongClose).toBe(true);

    // Holding closed for 600ms must NOT accidentally trigger TOGGLE_PLAY_PAUSE
    const heldClosed = feedSegment(fsm, t, 600, 40, 'CLOSED');
    t = heldClosed.endMs;
    const reopen = fsm.update(makeObs(t, 'OPEN'));
    expect(
      [...heldClosed.events, ...reopen.events].filter((e) => e.type === 'GESTURE_COMMAND'),
    ).toHaveLength(0);
    expect(reopen.snapshot.awaitingOpenAfterLongClose).toBe(false);
  });

  it('triggers NEXT_VIDEO after double blink + right gaze hold', () => {
    const fsm = new GestureStateMachine();
    const events: GestureEvent[] = [];

    let t = 0;
    ({ endMs: t } = feedSegment(fsm, t, 120, 40, 'OPEN', 'CENTER'));
    // Blink 1 (160ms)
    let seg = feedSegment(fsm, t, 160, 40, 'CLOSED');
    events.push(...seg.events);
    t = seg.endMs;
    // Gap (160ms)
    seg = feedSegment(fsm, t, 160, 40, 'OPEN', 'CENTER');
    events.push(...seg.events);
    t = seg.endMs;
    // Blink 2 (160ms)
    seg = feedSegment(fsm, t, 160, 40, 'CLOSED');
    events.push(...seg.events);
    t = seg.endMs;
    // Settle + Right gaze hold (520ms total > 100ms settle + 280ms hold)
    seg = feedSegment(fsm, t, 520, 40, 'OPEN', 'RIGHT');
    events.push(...seg.events);

    expect(events.some((e) => e.type === 'DOUBLE_BLINK_DETECTED')).toBe(true);
    const cmds = events.filter((e) => e.type === 'GESTURE_COMMAND');
    expect(cmds).toHaveLength(1);
    expect(cmds[0]?.type === 'GESTURE_COMMAND' && cmds[0].command).toBe('NEXT_VIDEO');
    expect(fsm.getState()).toBe('COOLDOWN');
  });

  it('triggers PREV_VIDEO after double blink + left gaze hold', () => {
    const fsm = new GestureStateMachine();
    const events: GestureEvent[] = [];

    let t = 0;
    ({ endMs: t } = feedSegment(fsm, t, 80, 40, 'OPEN', 'CENTER'));
    let seg = feedSegment(fsm, t, 160, 40, 'CLOSED');
    events.push(...seg.events);
    t = seg.endMs;
    seg = feedSegment(fsm, t, 160, 40, 'OPEN', 'CENTER');
    events.push(...seg.events);
    t = seg.endMs;
    seg = feedSegment(fsm, t, 160, 40, 'CLOSED');
    events.push(...seg.events);
    t = seg.endMs;
    seg = feedSegment(fsm, t, 520, 40, 'OPEN', 'LEFT');
    events.push(...seg.events);

    const cmds = events.filter((e) => e.type === 'GESTURE_COMMAND');
    expect(cmds).toHaveLength(1);
    expect(cmds[0]?.type === 'GESTURE_COMMAND' && cmds[0].command).toBe('PREV_VIDEO');
  });

  it('never triggers commands on pure left/right gaze shifts without double blink', () => {
    const fsm = new GestureStateMachine();
    const events: GestureEvent[] = [];

    let t = 0;
    let seg = feedSegment(fsm, t, 1000, 40, 'OPEN', 'RIGHT');
    events.push(...seg.events);
    t = seg.endMs;
    seg = feedSegment(fsm, t, 1000, 40, 'OPEN', 'LEFT');
    events.push(...seg.events);

    expect(events.filter((e) => e.type === 'GESTURE_COMMAND')).toHaveLength(0);
    expect(fsm.getState()).toBe('IDLE');
  });

  it('expires ARMED_GAZE cleanly if user stays looking CENTER', () => {
    const fsm = new GestureStateMachine({ gazeWindowMs: 1000 });
    const events: GestureEvent[] = [];

    let t = 0;
    ({ endMs: t } = feedSegment(fsm, t, 80, 40, 'OPEN', 'CENTER'));
    ({ endMs: t } = feedSegment(fsm, t, 160, 40, 'CLOSED'));
    ({ endMs: t } = feedSegment(fsm, t, 160, 40, 'OPEN', 'CENTER'));
    let seg = feedSegment(fsm, t, 160, 40, 'CLOSED');
    events.push(...seg.events);
    t = seg.endMs;

    // Open eyes and look center for 1200ms (> gazeWindowMs)
    seg = feedSegment(fsm, t, 1200, 40, 'OPEN', 'CENTER');
    events.push(...seg.events);

    expect(events.filter((e) => e.type === 'GESTURE_COMMAND')).toHaveLength(0);
    expect(fsm.getState()).toBe('IDLE');
  });

  it('resets active blink on excessive frame gap and locks out if eyes are still CLOSED', () => {
    const fsm = new GestureStateMachine({ maxFrameGapMs: 250 });

    fsm.update(makeObs(0, 'OPEN'));
    fsm.update(makeObs(40, 'CLOSED'));
    expect(fsm.getState()).toBe('EYE_CLOSED_1');

    // Sudden 650ms stall while eyes remain CLOSED
    const stalledClosed = fsm.update(makeObs(690, 'CLOSED'));
    expect(stalledClosed.events.some((e) => e.type === 'FRAME_GAP_WARNING')).toBe(true);
    expect(stalledClosed.state).toBe('IDLE');
    expect(stalledClosed.snapshot.awaitingOpenAfterLongClose).toBe(true);

    // Continued closed frames stay locked out
    const stillClosed = fsm.update(makeObs(730, 'CLOSED'));
    expect(stillClosed.state).toBe('IDLE');
    expect(stillClosed.snapshot.awaitingOpenAfterLongClose).toBe(true);

    // Opening eyes releases lockout with zero commands emitted
    const opened = fsm.update(makeObs(770, 'OPEN'));
    expect(opened.snapshot.awaitingOpenAfterLongClose).toBe(false);
    expect(opened.events.filter((e) => e.type === 'GESTURE_COMMAND')).toHaveLength(0);
  });

  it('resets safely when face is lost longer than faceLostResetMs', () => {
    const fsm = new GestureStateMachine({ faceLostResetMs: 250 });

    fsm.update(makeObs(0, 'OPEN'));
    fsm.update(makeObs(40, 'CLOSED'));
    expect(fsm.getState()).toBe('EYE_CLOSED_1');

    const seg = feedSegment(fsm, 80, 400, 40, 'OPEN', 'UNKNOWN', false);
    expect(seg.events.filter((e) => e.type === 'GESTURE_COMMAND')).toHaveLength(0);
    expect(fsm.getState()).toBe('IDLE');
  });
});

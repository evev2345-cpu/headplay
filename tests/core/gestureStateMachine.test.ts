import { describe, expect, it } from 'vitest';
import { GestureEvent, GestureStateMachine } from '../../src/core/gesture/gestureStateMachine';
import { EyeFeatureExtractor } from '../../src/core/vision/eyeFeatureExtractor';
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

  it('never misclassifies rapid consecutive short blinks as LONG_BLINK when OPEN gaps are sampled (20 FPS)', () => {
    const fsm = new GestureStateMachine();
    const events: GestureEvent[] = [];

    // 4 rapid short blinks: 150ms closed, 100ms open gap, sampled at 20 FPS (dt = 50ms)
    let t = 0;
    ({ endMs: t } = feedSegment(fsm, t, 100, 50, 'OPEN', 'CENTER'));
    for (let i = 0; i < 4; i++) {
      const closed = feedSegment(fsm, t, 150, 50, 'CLOSED');
      events.push(...closed.events);
      t = closed.endMs;

      const open = feedSegment(fsm, t, 100, 50, 'OPEN', 'CENTER');
      events.push(...open.events);
      t = open.endMs;
    }

    const blinkEvents = events.filter(
      (e): e is Extract<GestureEvent, { type: 'BLINK_MEASURED' }> => e.type === 'BLINK_MEASURED',
    );
    expect(blinkEvents.length).toBeGreaterThanOrEqual(2);
    expect(blinkEvents[0]?.closedDurationMs).toBe(150);
    expect(blinkEvents[0]?.openGapMs).toBeNull();
    expect(blinkEvents[1]?.closedDurationMs).toBe(150);
    expect(blinkEvents[1]?.openGapMs).toBe(100);

    // Must never misclassify separated short blinks as LONG_BLINK (TOGGLE_PLAY_PAUSE)
    const longCmds = events.filter(
      (e) => e.type === 'GESTURE_COMMAND' && e.command === 'TOGGLE_PLAY_PAUSE',
    );
    expect(longCmds).toHaveLength(0);
    expect(events.some((e) => e.type === 'DOUBLE_BLINK_DETECTED')).toBe(true);
  });

  it('reproduces how 8.3 FPS (120ms dt) misses a 100ms OPEN gap between rapid blinks while 20 FPS detects it', () => {
    // Underlying continuous blink waveform for two rapid short blinks separated by a 100ms open gap:
    // Blink 1: [100, 260]ms (160ms), Open gap: (260, 360)ms (100ms), Blink 2: [360, 520]ms (160ms)
    const blinkScoreAt = (ms: number): number => {
      if (ms >= 100 && ms <= 260) return 0.82;
      if (ms >= 360 && ms <= 520) return 0.84;
      return 0.08;
    };

    const runAtInterval = (dtMs: number, startPhaseMs: number) => {
      const extractor = new EyeFeatureExtractor();
      const fsm = new GestureStateMachine();
      const events: GestureEvent[] = [];

      for (let t = startPhaseMs; t <= 760; t += dtMs) {
        const s = blinkScoreAt(t);
        const obs = extractor.extract({
          timestampMs: t,
          faceDetected: true,
          blendshapes: [
            { categoryName: 'eyeBlinkLeft', score: s },
            { categoryName: 'eyeBlinkRight', score: s },
          ],
        });
        events.push(...fsm.update(obs).events);
      }
      return events;
    };

    // At 20 FPS (dt = 50ms), intermediate OPEN frames at t=300,350 are captured -> DOUBLE_BLINK, NO LONG_BLINK
    const events20fps = runAtInterval(50, 0);
    expect(events20fps.some((e) => e.type === 'DOUBLE_BLINK_DETECTED')).toBe(true);
    expect(
      events20fps.filter((e) => e.type === 'GESTURE_COMMAND' && e.command === 'TOGGLE_PLAY_PAUSE'),
    ).toHaveLength(0);

    // At 8.3 FPS (dt = 120ms, sampled at t=20, 140, 260, 380, 500, 620), the (260, 360) open gap
    // falls completely between t=260 and t=380 -> intermediate OPEN is missed -> merged 480ms LONG_BLINK!
    const events8fps = runAtInterval(120, 20);
    const mergedLong = events8fps.find(
      (e): e is Extract<GestureEvent, { type: 'BLINK_MEASURED' }> =>
        e.type === 'BLINK_MEASURED' && e.classification === 'LONG',
    );
    expect(mergedLong).toBeDefined();
    expect(mergedLong?.maxDtDuringCloseMs).toBe(120);
    expect(
      events8fps.some((e) => e.type === 'GESTURE_COMMAND' && e.command === 'TOGGLE_PLAY_PAUSE'),
    ).toBe(true);
  });

  it('flags suspectedMissedOpenValley when blink score dips mid-closure without crossing blinkOpenThreshold', () => {
    const extractor = new EyeFeatureExtractor({
      blinkCloseThreshold: 0.55,
      blinkOpenThreshold: 0.35,
    });
    const fsm = new GestureStateMachine();
    const events: GestureEvent[] = [];

    // Partial-reopen valley (0.39 > 0.35) between two rapid blink peaks (0.85 -> 0.39 -> 0.84)
    const scores = [
      0.05, 0.05, // open
      0.75, 0.85, 0.82, // blink 1 peak
      0.42, 0.39, 0.44, // partial reopen valley (misses 0.35 open threshold)
      0.78, 0.84, 0.8, 0.72, 0.6, // blink 2 peak
      0.1, 0.08, // open (total closed ~ 11 * 50ms = 550ms)
    ];

    scores.forEach((score, idx) => {
      const obs = extractor.extract({
        timestampMs: idx * 50,
        faceDetected: true,
        blendshapes: [
          { categoryName: 'eyeBlinkLeft', score },
          { categoryName: 'eyeBlinkRight', score },
        ],
      });
      events.push(...fsm.update(obs).events);
    });

    const blinkEv = events.find(
      (e): e is Extract<GestureEvent, { type: 'BLINK_MEASURED' }> => e.type === 'BLINK_MEASURED',
    );
    expect(blinkEv).toBeDefined();
    expect(blinkEv?.suspectedMissedOpenValley).toBe(true);
    expect(blinkEv?.minBlinkAvgDuringClose).toBeCloseTo(0.39, 2);
    expect(blinkEv?.peakBlinkAvgDuringClose).toBeCloseTo(0.85, 2);
  });
});

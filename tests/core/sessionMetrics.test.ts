import { describe, expect, it } from 'vitest';
import { SessionMetrics } from '../../src/core/diagnostics/sessionMetrics';
import { EyeObservation } from '../../src/core/vision/types';

function obsAt(timestampMs: number, gazeDirection: EyeObservation['gazeDirection'] = 'CENTER'): EyeObservation {
  return {
    timestampMs,
    faceDetected: true,
    blinkLeft: 0.05,
    blinkRight: 0.05,
    blinkMin: 0.05,
    blinkMax: 0.05,
    earLeft: 0.31,
    earRight: 0.31,
    eyeState: 'OPEN',
    gazeRawBlendshape: 0,
    gazeRawIris: 0,
    gazeSmoothed: 0,
    gazeDirection,
    headYawDeg: 2,
    gazeSuppressedByHeadTurn: false,
  };
}

describe('SessionMetrics', () => {
  it('tracks FPS, dt, blit/infer timing, per-segment stats, heartbeat, and JSON/CSV export', () => {
    const metrics = new SessionMetrics();
    metrics.startSession(0, 'track_processor', 'GPU', 1_700_000_000_000, 1000);
    metrics.addMarker('CHROME_ALL_MINIMIZED', 10, 1_700_000_000_010);

    for (let i = 0; i < 25; i++) {
      const ts = 40 * (i + 1);
      metrics.recordFrame(
        obsAt(ts, i === 10 ? 'RIGHT' : 'CENTER'),
        'IDLE',
        i === 15
          ? [
              {
                type: 'GESTURE_COMMAND',
                timestampMs: ts,
                command: 'TOGGLE_PLAY_PAUSE',
                details: { durationMs: 600 },
              },
            ]
          : [],
        1_700_000_000_000 + ts,
        { blitMs: 1.5, inferMs: 8.5 },
      );
    }

    metrics.recordHeartbeat(1000, 1_700_000_001_000);

    const snap = metrics.getSnapshot(1000, 1_700_000_001_000);
    expect(snap.totalFrames).toBe(25);
    expect(snap.avgDtMs).toBe(40);
    expect(snap.maxDtMs).toBe(40);
    expect(snap.avgBlitMs).toBe(1.5);
    expect(snap.avgInferMs).toBe(8.5);
    expect(snap.currentMarker).toBe('CHROME_ALL_MINIMIZED');
    expect(snap.blinkCounts.commands).toBe(1);
    expect(snap.segmentStats['CHROME_ALL_MINIMIZED']?.frames).toBe(25);
    expect(snap.segmentStats['CHROME_ALL_MINIMIZED']?.commands).toBe(1);

    const json = JSON.parse(metrics.exportJson());
    expect(json.metrics.totalFrames).toBe(25);
    expect(Array.isArray(json.logs)).toBe(true);

    const csv = metrics.exportCsv();
    expect(csv.split('\n')[0]).toBe('id,wallTimeIso,timestampMs,kind,summary,dataJson');
    expect(csv).toContain('CHROME_ALL_MINIMIZED');
    expect(csv).toContain('TOGGLE_PLAY_PAUSE');
  });

  it('detects 0 FPS stall via active watchdog and closes it on frame recovery', () => {
    const baseWall = 1_700_000_000_000;
    const metrics = new SessionMetrics();
    metrics.startSession(0, 'track_processor', 'GPU', baseWall, 1000);
    metrics.addMarker('CHROME_ALL_MINIMIZED', 20, baseWall + 20);
    metrics.recordFrame(obsAt(40), 'IDLE', [], baseWall + 40);

    // Watchdog fires after 1200ms with no frames
    expect(metrics.checkWatchdog(1240, baseWall + 1240)).toBe(true);
    const midSnap = metrics.getSnapshot(1640, baseWall + 1640);
    expect(midSnap.activeStallOngoing).toBe(true);
    expect(midSnap.activeStallDurationMs).toBe(1600);

    // Frame resumes at 3040ms (3000ms total stall)
    metrics.recordFrame(obsAt(3040), 'IDLE', [], baseWall + 3040);
    const endSnap = metrics.getSnapshot(3040, baseWall + 3040);
    expect(endSnap.activeStallOngoing).toBe(false);
    expect(endSnap.stallCount).toBe(1);
    expect(endSnap.totalStallMs).toBe(3000);
    expect(endSnap.maxStallMs).toBe(3000);
    expect(endSnap.segmentStats['CHROME_ALL_MINIMIZED']?.totalStallMs).toBe(3000);
  });

  it('detects stall via timestamp discontinuity on resume even if watchdog itself was frozen', () => {
    const baseWall = 1_700_000_000_000;
    const metrics = new SessionMetrics();
    metrics.startSession(0, 'track_processor', 'GPU', baseWall, 1000);
    metrics.addMarker('CHROME_ALL_MINIMIZED', 20, baseWall + 20);
    metrics.recordFrame(obsAt(40), 'IDLE', [], baseWall + 40);

    // Watchdog NEVER runs because the renderer froze completely for 4.5s.
    // On resume, performance.now() jumped only 50ms (simulated OS suspend) while wall clock jumped 4500ms.
    metrics.recordFrame(obsAt(90), 'IDLE', [], baseWall + 4540);

    const snap = metrics.getSnapshot(90, baseWall + 4540);
    expect(snap.stallCount).toBe(1);
    expect(snap.totalStallMs).toBe(4500);
    const recovered = metrics.getLogs().find((l) => l.kind === 'STALL_RECOVERED');
    expect(recovered?.data?.detectedBy).toBe('timestamp_discontinuity_on_resume');
  });

  it('records a permanent freeze that never resumed when finalizeStallAtStop is called', () => {
    const baseWall = 1_700_000_000_000;
    const metrics = new SessionMetrics();
    metrics.startSession(0, 'track_processor', 'GPU', baseWall, 1000);
    metrics.addMarker('CHROME_ALL_MINIMIZED', 20, baseWall + 20);
    metrics.recordFrame(obsAt(40), 'IDLE', [], baseWall + 40);

    // Renderer frozen until user restores Chrome and hits Stop 6 seconds later
    expect(metrics.finalizeStallAtStop(6040, baseWall + 6040)).toBe(true);
    const snap = metrics.getSnapshot(6040, baseWall + 6040);
    expect(snap.stallCount).toBe(1);
    expect(snap.totalStallMs).toBe(6000);
    const recovered = metrics.getLogs().find((l) => l.kind === 'STALL_RECOVERED');
    expect(recovered?.data?.detectedBy).toBe('timestamp_discontinuity_at_stop');
  });

  it('caps log ring buffer to prevent unbounded memory growth', () => {
    const metrics = new SessionMetrics();
    metrics.startSession(0, 'track_processor', 'CPU', 1_700_000_000_000);
    for (let i = 0; i < 800; i++) {
      metrics.addMarker(`M_${i}`, i * 10, 1_700_000_000_000 + i * 10);
    }
    expect(metrics.getLogs().length).toBeLessThanOrEqual(600);
  });
});

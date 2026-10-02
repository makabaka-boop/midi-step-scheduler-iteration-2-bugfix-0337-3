/**
 * Unit tests for the single-track recording session.
 *
 * A controllable beat map plays the role of the scheduler timeline, so
 * quantization, gate conversion and every adjudication verdict can be
 * asserted deterministically. End-to-end tempo changes and commit-time
 * wire ordering are covered in tests/recording.test.ts with the real
 * Scheduler + ManualClock.
 */
import { describe, expect, it } from 'vitest';
import { parseNoteMessage } from '../src/lib/sequencer/midi';
import { RecordingSession, type BeatMap } from '../src/lib/sequencer/recorder';

const STEP = 125; // 120 BPM, 16th grid

/**
 * Controllable beat map: a uniform step grid starting at time 0, plus a
 * mutable playhead and clock. Mirrors Scheduler.locateBeat's math (the
 * boundary at or immediately before the queried time).
 */
class FakeBeatMap implements BeatMap {
  playing = 0;
  /** The fake "now" the session anchors its takes on. */
  clockTime = 0;
  constructor(private readonly stepDur = STEP) {}
  get playingStep(): number {
    return this.playing;
  }
  now(): number {
    return this.clockTime;
  }
  locateBeat(timeMs: number) {
    const k = Math.floor(timeMs / this.stepDur);
    return { step: k, time: k * this.stepDur, stepDur: this.stepDur };
  }
}

function makeSession(length = 4, stepDur = STEP, channel = 0) {
  const beat = new FakeBeatMap(stepDur);
  const session = new RecordingSession(beat);
  session.arm('track-1', channel, length);
  return { beat, session };
}

function cellOf(session: RecordingSession, cell: number) {
  return session.snapshot.cells.find((c) => c.cell === cell) ?? null;
}

describe('note message parsing', () => {
  it('reads note-on with velocity', () => {
    expect(parseNoteMessage([0x90, 60, 100])).toEqual({
      kind: 'on',
      channel: 0,
      pitch: 60,
      velocity: 100,
      zeroVelocity: false
    });
  });

  it('treats a velocity-0 note-on as a note-off (MIDI convention)', () => {
    const parsed = parseNoteMessage([0x93, 64, 0]);
    expect(parsed?.kind).toBe('off');
    expect(parsed?.channel).toBe(3);
    expect(parsed?.zeroVelocity).toBe(true);
  });

  it('reads a real note-off and rejects non-note messages', () => {
    expect(parseNoteMessage([0x82, 48, 0])?.kind).toBe('off');
    expect(parseNoteMessage([0xb0, 123, 0])).toBeNull(); // CC
    expect(parseNoteMessage([0xf0])).toBeNull(); // sysex
    expect(parseNoteMessage([])).toBeNull();
  });
});

describe('RecordingSession quantization and gate', () => {
  it('quantizes a complete note pair onto the step grid and converts the gate', () => {
    const { session } = makeSession(4);
    // On slightly after the step-1 boundary, off halfway through step 2.
    session.noteOn(0, 60, 110, 130);
    expect(cellOf(session, 1)).toMatchObject({ pitch: 60, velocity: 110, open: true });
    session.noteOff(0, 60, 130 + STEP / 2);
    expect(cellOf(session, 1)).toMatchObject({ pitch: 60, velocity: 110, open: false });
    // Gate = 0.5 step relative to step 1's duration.
    expect(cellOf(session, 1)?.gate).toBeCloseTo(0.5, 5);
  });

  it('quantizes to the boundary at or before the onset (same grid rule as playback)', () => {
    const { session } = makeSession(4);
    // Up to (but not reaching) the next boundary the playhead is still on
    // cell 0; at exactly 62.5ms it is not yet time for cell 1.
    session.noteOn(0, 60, 100, STEP - 1);
    session.noteOff(0, 60, STEP - 1);
    expect(session.snapshot.cells.map((c) => c.cell)).toEqual([0]);

    // A clean onset on/after the boundary belongs to that new cell.
    session.cancel();
    session.arm('track-1', 0, 4);
    session.noteOn(0, 60, 100, STEP);
    session.noteOff(0, 60, STEP);
    expect(session.snapshot.cells.map((c) => c.cell)).toEqual([1]);
  });

  it('clamps a gate shorter than 5% and longer than one cell', () => {
    const { session } = makeSession(4);
    session.noteOn(0, 60, 100, 5); // cell 0
    session.noteOff(0, 60, 6); // 1ms gate
    expect(cellOf(session, 0)?.gate).toBe(0.05);

    session.noteOn(0, 64, 100, 250); // cell 2, loop tail ends at step 4
    session.noteOff(0, 64, 250 + 1.5 * STEP); // still inside the same loop
    expect(cellOf(session, 2)?.gate).toBe(1);
    expect(session.snapshot.verdicts.some((v) => v.kind === 'gate-capped')).toBe(true);
  });

  it('records multiple distinct cells in one take', () => {
    const { session } = makeSession(8);
    session.noteOn(0, 60, 100, 0);
    session.noteOff(0, 60, 50);
    session.noteOn(0, 64, 90, 2 * STEP);
    session.noteOff(0, 64, 2 * STEP + 80);
    expect(session.snapshot.cells.map((c) => c.cell)).toEqual([0, 2]);
  });
});

describe('RecordingSession same-pitch retrigger', () => {
  it('closes the previous instance at the new trigger time and emits a verdict', () => {
    const { session } = makeSession(8);
    session.noteOn(0, 60, 100, 0);
    // Replay before releasing: old gate is measured to the new trigger.
    session.noteOn(0, 60, 80, STEP / 2);
    expect(cellOf(session, 0)?.velocity).toBe(80);
    expect(cellOf(session, 0)?.open).toBe(true);
    expect(session.snapshot.verdicts.some((v) => v.kind === 'retrigger')).toBe(true);
    // The old note was finalized at the trigger (half-step gate), not lost.
    // Its verdict reports cell 0.
    const rt = session.snapshot.verdicts.find((v) => v.kind === 'retrigger');
    expect(rt?.cell).toBe(0);
    // The eventual physical off closes the *new* instance.
    session.noteOff(0, 60, STEP);
    expect(cellOf(session, 0)?.gate).toBeCloseTo(0.5, 5);
  });

  it('a retrigger that lands in a later cell finalizes the old note at its own cell', () => {
    const { session } = makeSession(4);
    session.noteOn(0, 60, 100, 0); // cell 0, held
    session.noteOn(0, 60, 100, 2 * STEP + 10); // retrigger -> quantizes to cell 2
    session.noteOff(0, 60, 2 * STEP + 50);
    // The closed predecessor survives on its own cell (gate clamped to the
    // span until the new trigger) — MIDI retrigger closes, it does not
    // erase. The new instance occupies cell 2.
    expect(cellOf(session, 0)).toMatchObject({ pitch: 60, open: false, gate: 1 });
    expect(cellOf(session, 2)?.open).toBe(false);
  });
});

describe('RecordingSession loop tail', () => {
  it('holds the note across the loop and clamps the gate without smearing cells', () => {
    const { session } = makeSession(4);
    session.noteOn(0, 60, 100, 3 * STEP); // cell 3
    session.noteOff(0, 60, 5 * STEP); // releases during the next pass
    expect(cellOf(session, 3)?.gate).toBe(1); // clamped, one cell only
    expect(
      session.snapshot.verdicts.some((v) => v.kind === 'cross-loop-gate')
    ).toBe(true);
    // No draft leaked into the next loop's cell 1 (global step 5).
    expect(cellOf(session, 1)).toBeNull();
  });

  it('keeps a note that merely runs to the next cell of the same pass gated at 100%', () => {
    const { session } = makeSession(8);
    session.noteOn(0, 60, 100, 0);
    session.noteOff(0, 60, 2 * STEP);
    expect(cellOf(session, 0)?.gate).toBe(1);
    expect(
      session.snapshot.verdicts.some((v) => v.kind === 'cross-loop-gate')
    ).toBe(false);
  });
});

describe('RecordingSession same-cell competition', () => {
  it('the later onset wins, the earlier record is reported as displaced', () => {
    const { session } = makeSession(8);
    session.noteOn(0, 60, 100, 2 * STEP); // cell 2
    session.noteOff(0, 60, 2 * STEP + 40);
    session.noteOn(0, 72, 100, 2 * STEP + 30); // also quantizes to cell 2, later
    session.noteOff(0, 72, 2 * STEP + 90);
    expect(cellOf(session, 2)?.pitch).toBe(72);
    const ow = session.snapshot.verdicts.filter((v) => v.kind === 'cell-overwrite');
    expect(ow.length).toBe(1);
    expect(ow[0]?.cell).toBe(2);
  });

  it('a still-held note in the cell is displaced when another pitch wins it', () => {
    const { session } = makeSession(8);
    session.noteOn(0, 60, 100, 0); // held, provisional on cell 0
    session.noteOn(0, 64, 100, 20); // later onset, same cell
    // Releasing the displaced pitch cannot overwrite the winner.
    session.noteOff(0, 60, 40);
    expect(cellOf(session, 0)?.pitch).toBe(64);
    expect(cellOf(session, 0)?.open).toBe(true);
    session.noteOff(0, 64, 80);
    expect(cellOf(session, 0)?.pitch).toBe(64);
  });
});

describe('RecordingSession zero velocity and stray events', () => {
  it('a velocity-0 note-on closes the note and is reported as such', () => {
    const { session } = makeSession(4);
    session.noteOn(0, 60, 100, 0);
    session.noteOff(0, 60, 60, true); // zero-velocity note-on convention
    expect(cellOf(session, 0)?.open).toBe(false);
    expect(
      session.snapshot.verdicts.some((v) => v.kind === 'zero-velocity-off')
    ).toBe(true);
  });

  it('ignores an off without an on and reports it', () => {
    const { session } = makeSession(4);
    session.noteOff(0, 60, 30);
    expect(session.snapshot.cells.length).toBe(0);
    expect(session.snapshot.verdicts.some((v) => v.kind === 'orphan-off')).toBe(true);
  });

  it('ignores every channel except the armed track channel', () => {
    const { session } = makeSession(4, STEP, 2);
    session.noteOn(0, 60, 100, 0);
    session.noteOff(0, 60, 50);
    expect(session.snapshot.cells.length).toBe(0);
    session.noteOn(2, 60, 100, 0);
    session.noteOff(2, 60, 50);
    expect(cellOf(session, 0)).not.toBeNull();
  });
});

describe('RecordingSession take-time and arrival-order evidence', () => {
  it('rejects messages timestamped before the take was armed', () => {
    const beat = new FakeBeatMap();
    beat.clockTime = 1000; // the take starts at t=1000 on the shared clock
    const session = new RecordingSession(beat);
    session.arm('track-1', 0, 4);
    // Leftovers from a previous round, delivered late: never drafted.
    session.noteOn(0, 60, 100, 500);
    session.noteOff(0, 60, 600);
    expect(session.snapshot.cells.length).toBe(0);
    expect(
      session.snapshot.verdicts.filter((v) => v.kind === 'stale-message').length
    ).toBe(2);
    expect(session.snapshot.verdicts.some((v) => v.kind === 'orphan-off')).toBe(false);
    // Messages of this take still record normally.
    session.noteOn(0, 64, 100, 1100);
    session.noteOff(0, 64, 1150);
    expect(session.snapshot.cells.length).toBe(1);
  });

  it('same-cell competition is decided by onset time, not delivery order', () => {
    const { session } = makeSession(8);
    // The newer onset (t=+30) is delivered first; the older one (t=+10)
    // arrives late and must not overwrite the newer performance.
    session.noteOn(0, 72, 100, 2 * STEP + 30);
    session.noteOff(0, 72, 2 * STEP + 90);
    session.noteOn(0, 60, 100, 2 * STEP + 10);
    session.noteOff(0, 60, 2 * STEP + 40);
    expect(cellOf(session, 2)?.pitch).toBe(72);
    expect(session.snapshot.verdicts.some((v) => v.kind === 'stale-message')).toBe(true);
    // The late loser's note-off still paired cleanly: no orphan verdict.
    expect(session.snapshot.verdicts.some((v) => v.kind === 'orphan-off')).toBe(false);
  });

  it('a late older onset does not displace a newer note still being held', () => {
    const { session } = makeSession(8);
    session.noteOn(0, 72, 100, 2 * STEP + 30); // held, owns cell 2
    session.noteOn(0, 60, 100, 2 * STEP + 10); // older onset, delivered late
    session.noteOff(0, 72, 2 * STEP + 90);
    expect(cellOf(session, 2)?.pitch).toBe(72);
    expect(cellOf(session, 2)?.open).toBe(false);
  });

  it('an out-of-order onset does not close the newer held note of the same pitch', () => {
    const { session } = makeSession(8);
    session.noteOn(0, 60, 100, 100); // held
    session.noteOn(0, 60, 80, 50); // stale duplicate: ignored, no retrigger
    session.noteOff(0, 60, 220);
    expect(cellOf(session, 0)?.velocity).toBe(100); // the newer note intact
    expect(cellOf(session, 0)?.gate).toBeCloseTo(120 / STEP, 5);
    expect(session.snapshot.verdicts.some((v) => v.kind === 'retrigger')).toBe(false);
  });

  it('a note-off older than the held onset is ignored as stale', () => {
    const { session } = makeSession(8);
    session.noteOn(0, 60, 100, 100);
    session.noteOff(0, 60, 80); // predates the onset: not this note's close
    expect(cellOf(session, 0)?.open).toBe(true);
    session.noteOff(0, 60, 220);
    expect(cellOf(session, 0)?.open).toBe(false);
    expect(cellOf(session, 0)?.gate).toBeCloseTo(120 / STEP, 5);
  });
});

describe('RecordingSession cancel / confirm', () => {
  it('cancel discards the whole draft and open notes', () => {
    const { session } = makeSession(4);
    session.noteOn(0, 60, 100, 0);
    session.noteOff(0, 60, 50);
    session.noteOn(0, 64, 100, STEP); // still held
    session.cancel();
    expect(session.isArmed).toBe(false);
    expect(session.snapshot.armed).toBe(false);
    expect(session.snapshot.cells.length).toBe(0);
    // A new take starts clean.
    session.arm('track-1', 0, 4);
    expect(session.snapshot.verdicts.length).toBe(0);
  });

  it('confirm returns the complete cells in ascending order once', () => {
    const { session } = makeSession(8);
    session.noteOn(0, 64, 90, 2 * STEP);
    session.noteOff(0, 64, 2 * STEP + 50);
    session.noteOn(0, 60, 100, 0);
    session.noteOff(0, 60, 50);
    const { commit } = session.confirm();
    expect(commit?.cells.map((c) => c.cell)).toEqual([0, 2]);
    expect(commit?.cells[0]?.step).toEqual({
      enabled: true,
      pitch: 60,
      velocity: 100,
      gate: 0.4
    });
    expect(session.isArmed).toBe(false);
    // Confirming again is a no-op now that the draft is gone.
    expect(session.confirm().commit).toBeNull();
  });

  it('drops incomplete pairs at confirm and reports the count', () => {
    const { session } = makeSession(8);
    session.noteOn(0, 60, 100, 0);
    session.noteOff(0, 60, 40); // complete on cell 0
    session.noteOn(0, 64, 100, 2 * STEP); // never released
    const result = session.confirm();
    expect(result.commit?.cells.map((c) => c.cell)).toEqual([0]);
    expect(result.dropped).toBe(1);
  });

  it('confirm with no complete note returns a null commit', () => {
    const { session } = makeSession(8);
    session.noteOn(0, 60, 100, 0); // only a hanging note
    const result = session.confirm();
    expect(result.commit).toBeNull();
    expect(result.dropped).toBe(1);
  });
});

describe('RecordingSession arming preconditions', () => {
  it('refuses a second arm while one take is in flight', () => {
    const beat = new FakeBeatMap();
    beat.playing = 5;
    const session = new RecordingSession(beat);
    expect(session.arm('a', 0, 8)).toBe(true);
    expect(session.arm('b', 0, 8)).toBe(false);
    expect(session.armedTrack).toBe('a');
  });

  it('refuses to arm a zero-length track and resets cleanly', () => {
    const beat = new FakeBeatMap();
    const session = new RecordingSession(beat);
    expect(session.arm('a', 0, 0)).toBe(false);
    expect(session.isArmed).toBe(false);
    // Still usable afterward.
    expect(session.arm('a', 0, 4)).toBe(true);
  });

  it('a cancel or confirm while idle is a harmless no-op', () => {
    const session = new RecordingSession(new FakeBeatMap());
    expect(() => {
      session.cancel();
      const r = session.confirm();
      expect(r.commit).toBeNull();
      expect(r.dropped).toBe(0);
    }).not.toThrow();
  });
});

describe('RecordingSession loop passes', () => {
  it('tracks the current pass from the playhead without clearing the draft', () => {
    const { beat, session } = makeSession(4);
    expect(session.snapshot.pass).toBe(0);
    beat.playing = 4;
    session.updatePlayhead(4);
    expect(session.snapshot.pass).toBe(1);
    beat.playing = 9;
    session.updatePlayhead(9);
    expect(session.snapshot.pass).toBe(2);
    // A note recorded into cell 1 across passes stays; the later take wins.
    session.noteOn(0, 60, 100, 9 * STEP); // global 9 % 4 = 1
    session.noteOff(0, 60, 9 * STEP + 40);
    expect(cellOf(session, 1)).not.toBeNull();
  });
});

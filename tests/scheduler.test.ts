import { describe, expect, it } from 'vitest';
import { ManualClock } from '../src/lib/sequencer/clock';
import { RecordingOutputAdapter } from '../src/lib/sequencer/output';
import { Scheduler } from '../src/lib/sequencer/scheduler';
import { createPattern, createTrack, type Pattern, type Step } from '../src/lib/sequencer/types';

const BPM = 120;
const STEP_MS = 125; // 60000 / (120 * 4)

interface Rig {
  clock: ManualClock;
  out: RecordingOutputAdapter;
  scheduler: Scheduler;
  pattern: Pattern;
  steps: number[];
}

function makeRig(options: {
  tracks?: { length: number; enabled: number[]; pitch?: number; gate?: number; channel?: number }[];
  tempo?: number;
  lookaheadMs?: number;
}): Rig {
  const tempo = options.tempo ?? BPM;
  const pattern: Pattern = { tracks: [] };
  for (const t of options.tracks ?? [{ length: 4, enabled: [0] }]) {
    const track = createTrack(t.length);
    track.channel = t.channel ?? 0;
    for (const i of t.enabled) {
      const step: Step | undefined = track.steps[i];
      if (step) {
        step.enabled = true;
        step.pitch = t.pitch ?? 60;
        step.velocity = 100;
        step.gate = t.gate ?? 0.5;
      }
    }
    pattern.tracks.push(track);
  }

  const clock = new ManualClock();
  const out = new RecordingOutputAdapter('out-1', 'Test Output');
  const steps: number[] = [];
  const scheduler = new Scheduler({
    clock,
    getPattern: () => pattern,
    getTempo: () => tempo,
    lookaheadMs: options.lookaheadMs,
    onStep: (s) => steps.push(s)
  });
  scheduler.setOutput(out);
  return { clock, out, scheduler, pattern, steps };
}

function noteOns(out: RecordingOutputAdapter) {
  return out.sent.filter((m) => (m.message[0]! & 0xf0) === 0x90);
}

function noteOffs(out: RecordingOutputAdapter) {
  return out.sent.filter((m) => (m.message[0]! & 0xf0) === 0x80);
}

describe('Scheduler lookahead', () => {
  it('queues events ahead of time instead of relying on per-step timers', () => {
    const { scheduler, out } = makeRig({ tracks: [{ length: 4, enabled: [0] }] });
    scheduler.play();
    // Immediately after play(), step 0 (due at t=1) is already queued…
    expect(scheduler.queuedEvents.length).toBeGreaterThan(0);
    // …but nothing has been sent yet, because nothing is due.
    expect(out.sent.length).toBe(0);
  });

  it('dispatches note-on and note-off with clock-timeline timestamps', () => {
    const { clock, scheduler, out } = makeRig({ tracks: [{ length: 4, enabled: [0], gate: 0.5 }] });
    scheduler.play();
    clock.advance(200);
    const on = noteOns(out);
    const off = noteOffs(out);
    expect(on.length).toBe(1);
    expect(on[0]!.message).toEqual([0x90, 60, 100]);
    expect(on[0]!.timeMs).toBe(1);
    expect(off.length).toBe(1);
    expect(off[0]!.timeMs).toBe(1 + STEP_MS * 0.5);
  });

  it('keeps exactly one timer armed while playing', () => {
    const { clock, scheduler } = makeRig({ tracks: [{ length: 4, enabled: [0] }] });
    scheduler.play();
    for (let i = 0; i < 10; i++) clock.advance(25);
    expect(clock.pendingTimers).toBe(1);
  });

  it('loops tracks with different lengths independently', () => {
    const { clock, scheduler, out } = makeRig({
      tracks: [
        { length: 2, enabled: [0], pitch: 60 },
        { length: 4, enabled: [3], pitch: 64 }
      ]
    });
    scheduler.play();
    clock.advance(1200);
    const pitches = noteOns(out).map((m) => m.message[1]);
    // Global steps 0..8: A on even steps, B on step 3 and 7.
    expect(pitches).toEqual([60, 60, 64, 60, 60, 64, 60]);
  });

  it('respects per-step gate length', () => {
    const { clock, scheduler, out } = makeRig({ tracks: [{ length: 4, enabled: [0], gate: 0.25 }] });
    scheduler.play();
    clock.advance(200);
    expect(noteOffs(out)[0]!.timeMs).toBeCloseTo(1 + STEP_MS * 0.25, 5);
  });

  it('applies score edits only to steps not yet scheduled', () => {
    const rig = makeRig({ tracks: [{ length: 4, enabled: [] }] });
    rig.scheduler.play();
    rig.clock.advance(100);
    // Enable step 2 while playing; it is beyond the current lookahead window.
    rig.pattern.tracks[0]!.steps[2]!.enabled = true;
    rig.pattern.tracks[0]!.steps[2]!.pitch = 67;
    rig.clock.advance(400);
    const on = noteOns(rig.out);
    expect(on.length).toBe(1);
    expect(on[0]!.message[1]).toBe(67);
    expect(on[0]!.timeMs).toBe(1 + 2 * STEP_MS);
  });
});

describe('Scheduler tempo changes', () => {
  it('re-plans unsent steps at the new tempo, keeps sent notes untouched', () => {
    const rig = makeRig({ tracks: [{ length: 8, enabled: [0, 1, 2, 3], gate: 1.0 }] });
    // Distinct pitches so the retrigger guard does not rewrite step 0's note-off.
    rig.pattern.tracks[0]!.steps.forEach((s, i) => {
      s.pitch = i === 0 ? 60 : 64;
    });
    let tempo = BPM;
    const scheduler = new Scheduler({
      clock: rig.clock,
      getPattern: () => rig.pattern,
      getTempo: () => tempo
    });
    scheduler.setOutput(rig.out);
    scheduler.play();
    rig.clock.advance(110); // step 0 sounding (gate 1.0, note-off due at 126)

    tempo = 240; // step length halves to 62.5ms
    scheduler.tempoChanged();
    rig.clock.advance(400);

    const offs = noteOffs(rig.out);
    // The sounding note keeps its original note-off time (126ms grid).
    expect(offs.some((m) => m.timeMs === 1 + STEP_MS)).toBe(true);
    const ons = noteOns(rig.out);
    // Step 1 was re-planned on the new grid: last boundary (1) + 62.5,
    // clamped to "now" (110) — not the old 126ms grid.
    expect(ons[1]!.timeMs).toBe(110);
    expect(ons[2]!.timeMs).toBe(172.5);
    // No step fired twice.
    expect(ons.length).toBe(new Set(ons.map((m) => m.timeMs)).size);
  });

  it('does not disturb already-dispatched history', () => {
    const rig = makeRig({ tracks: [{ length: 8, enabled: [0, 1, 2, 3] }] });
    let tempo = BPM;
    const scheduler = new Scheduler({
      clock: rig.clock,
      getPattern: () => rig.pattern,
      getTempo: () => tempo
    });
    scheduler.setOutput(rig.out);
    scheduler.play();
    rig.clock.advance(140); // step 0 fully sent (gate 0.5)
    const before = rig.out.sent.map((m) => [...m.message, m.timeMs]);
    tempo = 90;
    scheduler.tempoChanged();
    rig.clock.advance(400);
    const after = rig.out.sent.map((m) => [...m.message, m.timeMs]);
    expect(after.slice(0, before.length)).toEqual(before);
  });
});

describe('Scheduler stop / pause', () => {
  it('stop cancels queued messages, silences sounding notes and disarms the timer', () => {
    const { clock, scheduler, out } = makeRig({ tracks: [{ length: 4, enabled: [0, 1], gate: 1.0 }] });
    scheduler.play();
    clock.advance(100); // step 0 sounding, step 1 queued
    scheduler.stop();

    // The sounding note was closed immediately…
    const offs = noteOffs(out);
    expect(offs.length).toBe(1);
    expect(offs[0]!.message[1]).toBe(60);
    // …the queue is empty and the timer is gone…
    expect(scheduler.queuedEvents.length).toBe(0);
    expect(scheduler.soundingNotes).toBe(0);
    expect(clock.pendingTimers).toBe(0);
    // …and nothing more is ever sent.
    const count = out.sent.length;
    clock.advance(2000);
    expect(out.sent.length).toBe(count);
    expect(noteOns(out).length).toBe(1); // queued step 1 never fired
    expect(scheduler.transportState).toBe('stopped');
  });

  it('stop boundary: notes due but not yet dispatched are cancelled, not fired', () => {
    const { clock, scheduler, out } = makeRig({ tracks: [{ length: 4, enabled: [0, 1, 2] }] });
    scheduler.play();
    // Stall the main thread past several step times, then stop before any
    // tick had a chance to dispatch them.
    clock.jump(300);
    scheduler.stop();
    expect(noteOns(out).length).toBe(0);
    clock.advance(1000);
    expect(noteOns(out).length).toBe(0);
    expect(clock.pendingTimers).toBe(0);
  });

  it('pause closes sounding notes; resume continues without re-firing', () => {
    const { clock, scheduler, out } = makeRig({ tracks: [{ length: 4, enabled: [0, 1], gate: 1.0 }] });
    scheduler.play();
    clock.advance(100); // step 0 sounding
    scheduler.pause();
    expect(scheduler.transportState).toBe('paused');
    expect(noteOffs(out).length).toBe(1); // no stuck note while paused
    const sentAtPause = out.sent.length;
    clock.advance(500);
    expect(out.sent.length).toBe(sentAtPause); // fully silent while paused

    scheduler.play(); // resume
    clock.advance(300);
    expect(scheduler.transportState).toBe('playing');
    // Step 0's note-on was not repeated; step 1 fired exactly once more.
    expect(noteOns(out).length).toBe(2);
  });

  it('repeated play/stop clicks never duplicate timers or notes', () => {
    const { clock, scheduler, out } = makeRig({ tracks: [{ length: 4, enabled: [0, 1, 2, 3] }] });
    scheduler.play();
    scheduler.play();
    scheduler.play();
    clock.advance(140);
    scheduler.stop();
    scheduler.stop();
    scheduler.play();
    scheduler.play();
    clock.advance(140);
    scheduler.stop();

    expect(clock.pendingTimers).toBe(0);
    const ons = noteOns(out);
    // Every note-on has a distinct scheduled time — no double-triggering.
    expect(ons.length).toBe(new Set(ons.map((m) => m.timeMs)).size);
    // Every note-on is matched by exactly one note-off — no stuck notes.
    expect(noteOffs(out).length).toBe(ons.length);
  });
});

describe('Scheduler late callbacks', () => {
  it('a stalled tick fires recently-missed notes once and skips ancient ones', () => {
    const { clock, scheduler, out } = makeRig({ tracks: [{ length: 64, enabled: Array.from({ length: 64 }, (_, i) => i) }] });
    scheduler.play();
    clock.advance(25); // step 0 dispatched
    clock.jump(5000); // main thread stalls for 5 seconds
    clock.advance(25); // the overdue tick finally runs

    const ons = noteOns(out);
    // 1 note before the stall + only the catch-up window's worth after it
    // (240ms catch-up + 120ms lookahead at 125ms/step ≈ 3), not 40+.
    expect(ons.length).toBeLessThanOrEqual(5);
    expect(ons.length).toBeGreaterThan(1);
    // No duplicates, transport still alive.
    expect(ons.length).toBe(new Set(ons.map((m) => m.timeMs)).size);
    expect(scheduler.transportState).toBe('playing');
    clock.advance(300);
    expect(noteOns(out).length).toBeGreaterThan(ons.length); // keeps playing
  });
});

describe('Scheduler output handling', () => {
  it('refuses to play without an output instead of pretending', () => {
    const clock = new ManualClock();
    const pattern = createPattern(1, 4);
    const scheduler = new Scheduler({ clock, getPattern: () => pattern, getTempo: () => BPM });
    expect(scheduler.play()).toBe(false);
    expect(scheduler.transportState).toBe('stopped');
    clock.advance(1000);
    expect(clock.pendingTimers).toBe(0);
  });

  it('switching outputs silences the old device and continues on the new one', () => {
    const { clock, scheduler, out } = makeRig({ tracks: [{ length: 4, enabled: [0, 1, 2], gate: 1.0 }] });
    const outB = new RecordingOutputAdapter('out-2', 'Second');
    scheduler.play();
    clock.advance(100); // note sounding on out
    scheduler.setOutput(outB);

    // Old device got exactly: note-on, then note-off (no stuck note there).
    expect(noteOns(out).length).toBe(1);
    expect(noteOffs(out).length).toBe(1);
    const oldCount = out.sent.length;
    clock.advance(400);
    // Nothing more went to the old device; the new one carries on.
    expect(out.sent.length).toBe(oldCount);
    expect(noteOns(outB).length).toBeGreaterThan(0);
  });

  it('losing the output mid-play closes notes on the departed device', () => {
    const { clock, scheduler, out } = makeRig({ tracks: [{ length: 4, enabled: [0], gate: 1.0 }] });
    scheduler.play();
    clock.advance(100); // sounding
    scheduler.setOutput(null); // device unplugged
    expect(noteOffs(out).length).toBe(1);
    const count = out.sent.length;
    clock.advance(500);
    expect(out.sent.length).toBe(count); // nothing further, no errors
  });

  it('retriggering the same note closes the previous one first', () => {
    const { clock, scheduler, out } = makeRig({ tracks: [{ length: 2, enabled: [0, 1], gate: 1.0 }] });
    scheduler.play();
    clock.advance(500);
    scheduler.stop(); // closes the final, still-open note
    const ons = noteOns(out);
    const offs = noteOffs(out);
    expect(ons.length).toBeGreaterThan(1);
    expect(offs.length).toBe(ons.length); // every retrigger closed its predecessor
    // At each retrigger the previous note-off is scheduled no later than
    // the next note-on.
    for (let i = 1; i < ons.length; i++) {
      expect(offs[i - 1]!.timeMs!).toBeLessThanOrEqual(ons[i]!.timeMs!);
    }
  });
});

describe('Scheduler live score editing', () => {
  it('disabling a queued step cancels its note before it can fire', () => {
    const rig = makeRig({ tracks: [{ length: 4, enabled: [1] }] });
    rig.scheduler.play();
    rig.clock.advance(25); // step 1 (due 126) is now queued in the lookahead
    expect(
      rig.scheduler.queuedEvents.some((e) => e.kind === 'noteOn' && e.step === 1)
    ).toBe(true);
    rig.pattern.tracks[0]!.steps[1]!.enabled = false;
    rig.scheduler.stepEdited(rig.pattern.tracks[0]!.id, 1);
    expect(
      rig.scheduler.queuedEvents.some((e) => e.kind === 'noteOn' && e.step === 1)
    ).toBe(false);
    rig.clock.advance(500);
    expect(noteOns(rig.out).length).toBe(0); // the stale queued note never fired
  });

  it('enabling a step inside the lookahead window still fires it on time', () => {
    const rig = makeRig({ tracks: [{ length: 4, enabled: [] }] });
    rig.scheduler.play();
    rig.clock.advance(25);
    rig.pattern.tracks[0]!.steps[1]!.enabled = true;
    rig.pattern.tracks[0]!.steps[1]!.pitch = 55;
    rig.scheduler.stepEdited(rig.pattern.tracks[0]!.id, 1);
    rig.clock.advance(200);
    const ons = noteOns(rig.out);
    expect(ons.length).toBe(1);
    expect(ons[0]!.message[1]).toBe(55);
    expect(ons[0]!.timeMs).toBe(1 + STEP_MS); // original boundary, not edit time
  });

  it('disabling a sounding step releases its note immediately and only once', () => {
    const rig = makeRig({ tracks: [{ length: 4, enabled: [0], gate: 1.0 }] });
    rig.scheduler.play();
    rig.clock.advance(100); // step 0 sounding; its off was due at 126
    rig.pattern.tracks[0]!.steps[0]!.enabled = false;
    rig.scheduler.stepEdited(rig.pattern.tracks[0]!.id, 0);
    const offs = noteOffs(rig.out);
    expect(offs.length).toBe(1); // released at edit time (100), not at the old 126
    expect(offs[0]!.timeMs).toBe(100);
    rig.clock.advance(10); // past where the stale off would have fired
    expect(noteOffs(rig.out).length).toBe(1); // never closed twice
    expect(noteOns(rig.out).length).toBe(1); // not retriggered by the loop
  });

  it('changing pitch releases the old sounding note without a stray new-pitch off', () => {
    const rig = makeRig({ tracks: [{ length: 4, enabled: [0], gate: 1.0 }] });
    rig.scheduler.play();
    rig.clock.advance(100);
    rig.pattern.tracks[0]!.steps[0]!.pitch = 72;
    rig.scheduler.stepEdited(rig.pattern.tracks[0]!.id, 0);
    expect(noteOffs(rig.out).map((m) => m.message[1])).toEqual([60]);
    rig.clock.advance(450);
    // Only the old pitch ever gets an off; the new pitch plays next loop.
    expect(noteOffs(rig.out).map((m) => m.message[1])).toEqual([60]);
    expect(noteOns(rig.out).map((m) => m.message[1])).toContain(72);
  });

  it('updates pitch and velocity of a queued-but-unsent note in place', () => {
    const rig = makeRig({ tracks: [{ length: 4, enabled: [1], gate: 0.5 }] });
    rig.scheduler.play();
    rig.clock.advance(25); // step 1 queued
    rig.pattern.tracks[0]!.steps[1]!.pitch = 80;
    rig.pattern.tracks[0]!.steps[1]!.velocity = 42;
    rig.scheduler.stepEdited(rig.pattern.tracks[0]!.id, 1);
    rig.clock.advance(200);
    const ons = noteOns(rig.out);
    expect(ons.length).toBe(1);
    expect(ons[0]!.message).toEqual([0x90, 80, 42]);
    expect(ons[0]!.timeMs).toBe(1 + STEP_MS); // still on the same boundary
  });

  it('shortening the gate of a sounding note releases it earlier', () => {
    const rig = makeRig({ tracks: [{ length: 4, enabled: [0], gate: 1.0 }] });
    rig.scheduler.play();
    rig.clock.advance(100); // off originally due at 126
    rig.pattern.tracks[0]!.steps[0]!.gate = 0.2; // new off time 26, already past
    rig.scheduler.stepEdited(rig.pattern.tracks[0]!.id, 0);
    const offs = noteOffs(rig.out);
    expect(offs.length).toBe(1); // released at edit time, not at the old 126
    expect(offs[0]!.timeMs).toBe(100);
    rig.clock.advance(20); // the stale queued off (126) must not fire again
    expect(noteOffs(rig.out).length).toBe(1);
    expect(noteOns(rig.out).length).toBe(1);
  });

  it('lengthening the gate postpones the note-off without overlapping or sticking', () => {
    const rig = makeRig({ tracks: [{ length: 1, enabled: [0], gate: 0.25 }] });
    rig.scheduler.play();
    rig.clock.advance(100);
    rig.pattern.tracks[0]!.steps[0]!.gate = 1;
    rig.scheduler.stepEdited(rig.pattern.tracks[0]!.id, 0);
    rig.clock.advance(300);
    rig.scheduler.stop();
    const ons = noteOns(rig.out);
    // No duplicate ons, and every on is matched by exactly one off.
    expect(ons.length).toBe(new Set(ons.map((m) => m.timeMs)).size);
    expect(noteOffs(rig.out).length).toBe(ons.length);
  });

  it('shortening a track cancels voices from cells it no longer owns', () => {
    const rig = makeRig({
      tracks: [{ length: 8, enabled: [0, 3], gate: 1.0 }],
      lookaheadMs: 500
    });
    rig.scheduler.play();
    rig.clock.advance(100); // cell 0 sounding; cell 3 (due 376) queued
    expect(
      rig.scheduler.queuedEvents.some(
        (e) => e.kind === 'noteOn' && e.trackId === rig.pattern.tracks[0]!.id && e.step === 3
      )
    ).toBe(true);
    rig.pattern.tracks[0]!.steps.length = 2; // cells 2..7 are gone
    rig.scheduler.trackEdited(rig.pattern.tracks[0]!.id);
    // The cell-0 sounding note survives (step 8 % 2 === 0 still owns it);
    // the queued cell-3 note is dropped and never fires.
    expect(noteOffs(rig.out).length).toBe(0);
    rig.clock.advance(500);
    expect(
      noteOns(rig.out).some((m) => m.timeMs === 1 + 3 * STEP_MS)
    ).toBe(false);
  });

  it('muting a track silences its notes and queue without moving other tracks', () => {
    const rig = makeRig({
      tracks: [
        { length: 4, enabled: [0, 2], gate: 1.0, pitch: 60, channel: 0 },
        { length: 4, enabled: [1], gate: 1.0, pitch: 64, channel: 1 }
      ]
    });
    rig.scheduler.play();
    rig.clock.advance(100); // track 0 cell 0 sounding; tracks' future cells queued
    rig.pattern.tracks[0]!.muted = true;
    rig.scheduler.trackEdited(rig.pattern.tracks[0]!.id);
    expect(noteOffs(rig.out).map((m) => m.message)).toEqual([[0x80, 60, 0]]);
    rig.clock.advance(400);
    // Muted track stays silent (its initial on is the only one)…
    expect(noteOns(rig.out).map((m) => m.message[1])).toEqual([60, 64]);
    // …and the other track fired exactly on its original boundary.
    expect(noteOns(rig.out)[1]!.timeMs).toBe(1 + STEP_MS);
  });

  it('editing one track never moves the other track off the global grid', () => {
    const rig = makeRig({
      tracks: [
        { length: 4, enabled: [0], pitch: 60, channel: 0 },
        { length: 4, enabled: [0, 1, 2, 3], pitch: 64, channel: 1, gate: 0.2 }
      ]
    });
    rig.scheduler.play();
    rig.clock.advance(50);
    // A burst of edits on track 0 must not rewind or shift the timeline.
    rig.pattern.tracks[0]!.steps[0]!.pitch = 70;
    rig.scheduler.stepEdited(rig.pattern.tracks[0]!.id, 0);
    rig.pattern.tracks[0]!.muted = true;
    rig.scheduler.trackEdited(rig.pattern.tracks[0]!.id);
    rig.pattern.tracks[0]!.steps.length = 2;
    rig.scheduler.trackEdited(rig.pattern.tracks[0]!.id);
    rig.clock.advance(450);
    const track1Ons = noteOns(rig.out).filter((m) => (m.message[0]! & 0x0f) === 1);
    expect(track1Ons.map((m) => m.timeMs)).toEqual([
      1,
      1 + STEP_MS,
      1 + 2 * STEP_MS,
      1 + 3 * STEP_MS
    ]);
  });
});

describe('Scheduler beat mapping (recorder timeline)', () => {
  it('maps a clock time onto the global step whose boundary is at or before it', () => {
    const { clock, scheduler } = makeRig({ tracks: [{ length: 8, enabled: [] }] });
    scheduler.play();
    clock.advance(100); // step 0 sounding (boundary t=1)
    expect(scheduler.locateBeat(100).step).toBe(0);
    expect(scheduler.locateBeat(126).step).toBe(1); // step 1 boundary
    expect(scheduler.locateBeat(250).step).toBe(1);
    expect(scheduler.locateBeat(251).step).toBe(2);
  });

  it('exposes the step duration in force', () => {
    const { scheduler } = makeRig({ tracks: [{ length: 8, enabled: [] }] });
    scheduler.play();
    expect(scheduler.locateBeat(0).stepDur).toBeCloseTo(STEP_MS, 5);
  });

  it('beat mapping follows a tempo change using the replanned grid', () => {
    const rig = makeRig({ tracks: [{ length: 64, enabled: [] }] });
    let tempo = BPM;
    const scheduler = new Scheduler({
      clock: rig.clock,
      getPattern: () => rig.pattern,
      getTempo: () => tempo
    });
    scheduler.setOutput(rig.out);
    scheduler.play();
    rig.clock.advance(110); // step 0 sounding
    tempo = 240; // 62.5ms per step
    scheduler.tempoChanged();
    // Replanned next step is clamped to now (110). A note just after a
    // replanned boundary maps onto the new 62.5ms grid.
    rig.clock.advance(1); // t=111, step 1 boundary in force
    const mapped = scheduler.locateBeat(rig.clock.now());
    expect(mapped.step).toBe(1);
    expect(mapped.stepDur).toBeCloseTo(62.5, 4);
    rig.clock.advance(63); // one more new-grid step
    expect(scheduler.locateBeat(rig.clock.now()).step).toBe(2);
  });

  it('returns the conventional origin when stopped', () => {
    const { scheduler } = makeRig({ tracks: [{ length: 8, enabled: [] }] });
    expect(scheduler.locateBeat(500).step).toBe(0);
    expect(scheduler.playingStep).toBe(-1);
  });
});

describe('Scheduler shared channel and pitch', () => {
  it('releasing one overlapping voice never sends note-off while another holds the key', () => {
    // Both tracks share channel 0 / pitch 60, starting together at t=1:
    // track 1's short note ends at 63.5, track 0's long one runs to 126.
    // Long tracks (length 16) keep this inside a single loop.
    const rig = makeRig({
      tracks: [
        { length: 16, enabled: [0], gate: 1.0, pitch: 60, channel: 0 },
        { length: 16, enabled: [0], gate: 0.5, pitch: 60, channel: 0 }
      ]
    });
    rig.scheduler.play();
    rig.clock.advance(100); // both note-ons out; track 1 already released internally
    expect(noteOns(rig.out).length).toBe(2);
    expect(noteOffs(rig.out).length).toBe(0); // key still held by track 0
    rig.clock.advance(55); // next tick past 126 dispatches track 0's own off
    expect(noteOffs(rig.out).length).toBe(1); // exactly one wire note-off
    rig.scheduler.stop();
    expect(noteOffs(rig.out).length).toBe(1); // nothing stuck, nothing doubled
  });

  it('muting one track of a shared key never ends the other track early', () => {
    const rig = makeRig({
      tracks: [
        { length: 16, enabled: [0], gate: 1.0, pitch: 60, channel: 0 },
        { length: 16, enabled: [0], gate: 1.0, pitch: 60, channel: 0 }
      ]
    });
    rig.scheduler.play();
    rig.clock.advance(100); // both voices sounding on the same wire key
    rig.pattern.tracks[0]!.muted = true;
    rig.scheduler.trackEdited(rig.pattern.tracks[0]!.id);
    expect(noteOffs(rig.out).length).toBe(0); // track 1 still needs the note
    rig.clock.advance(20); // well before track 1's natural off at 126
    expect(noteOffs(rig.out).length).toBe(0); // still held by the sibling
    rig.clock.advance(35); // next tick past 126: track 1's off is the first
    expect(noteOffs(rig.out).length).toBe(1);
    rig.scheduler.stop();
    expect(noteOffs(rig.out).length).toBe(1); // nothing stuck, nothing doubled
  });

  it('a retrigger / tempo replan in one track never clamps a sibling note-off', () => {
    const rig = makeRig({
      tracks: [
        { length: 8, enabled: [0, 1, 2, 3], gate: 1.0, pitch: 60, channel: 0 },
        { length: 8, enabled: [0], gate: 1.0, pitch: 60, channel: 0 }
      ]
    });
    let tempo = BPM;
    const scheduler = new Scheduler({
      clock: rig.clock,
      getPattern: () => rig.pattern,
      getTempo: () => tempo
    });
    scheduler.setOutput(rig.out);
    scheduler.play();
    rig.clock.advance(100); // both step-0 notes sounding; offs due at 126
    tempo = 240;
    scheduler.tempoChanged(); // re-plans track 0's steps 1+ on a new grid
    rig.clock.advance(400);
    // Track 1's note-off (126) must not be dragged onto track 0's replanned
    // trigger (110): the first wire note-off cannot arrive before 126.
    const offs = noteOffs(rig.out);
    expect(offs.length).toBeGreaterThan(0);
    expect(offs[0]!.timeMs).toBeGreaterThanOrEqual(1 + STEP_MS);
  });
});

import { describe, expect, it } from 'vitest';
import { ManualClock } from '../src/lib/sequencer/clock';
import { RecordingOutputAdapter } from '../src/lib/sequencer/output';
import { Scheduler } from '../src/lib/sequencer/scheduler';
import { createTrack, resizeTrack, type Pattern } from '../src/lib/sequencer/types';

function isOn(m: number[]): boolean {
  return (m[0]! & 0xf0) === 0x90;
}
function isOff(m: number[]): boolean {
  return (m[0]! & 0xf0) === 0x80;
}

describe('live-edit stress invariants', () => {
  it('random edits with shared channels never leave stuck or stray notes', () => {
    // Seeded pseudo-random so the run is reproducible.
    let seed = 1234567;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const pickIndex = (n: number) => Math.min(n - 1, Math.floor(rand() * n));

    const pattern: Pattern = { tracks: [] };
    for (let i = 0; i < 6; i++) {
      const t = createTrack(8);
      t.channel = i % 2; // only 2 channels -> guaranteed key sharing
      for (let s = 0; s < 8; s++) {
        t.steps[s]!.enabled = rand() < 0.5;
        t.steps[s]!.pitch = 60 + Math.floor(rand() * 3); // 60..62 -> heavy sharing
        t.steps[s]!.gate = 0.25 + rand() * 0.75;
      }
      pattern.tracks.push(t);
    }
    const clock = new ManualClock();
    const out = new RecordingOutputAdapter('o', 'O');
    const scheduler = new Scheduler({
      clock,
      getPattern: () => pattern,
      getTempo: () => 120
    });
    scheduler.setOutput(out);
    scheduler.play();

    // A note-off may only ever leave for a currently held key. Overlapping
    // same-key voices send several note-ons before the single final off
    // (MIDI retrigger), so the invariant is binary wire state, not a 1:1
    // on/off count.
    const held = new Set<string>();
    const assertNoStrayOff = (tick: number): void => {
      // Recompute from scratch each tick (messages are few) and assert no
      // prefix ever produced an off for an unheld key.
      const live = new Set<string>();
      for (const m of out.sent) {
        const key = `${m.message[0]! & 0x0f}:${m.message[1]}`;
        if (isOn(m.message)) {
          live.add(key);
        } else if (isOff(m.message)) {
          expect(live.has(key), `note-off for unheld ${key} at tick ${tick}`).toBe(true);
          live.delete(key);
        }
      }
    };

    for (let tick = 0; tick < 400; tick++) {
      clock.advance(25);
      const t = pattern.tracks[pickIndex(pattern.tracks.length)]!;
      const choice = rand();
      if (choice < 0.3 && t.steps.length > 0) {
        const i = pickIndex(t.steps.length);
        t.steps[i]!.enabled = !t.steps[i]!.enabled;
        scheduler.stepEdited(t.id, i);
      } else if (choice < 0.5 && t.steps.length > 0) {
        const i = pickIndex(t.steps.length);
        t.steps[i]!.pitch = 60 + Math.floor(rand() * 3);
        t.steps[i]!.gate = 0.1 + rand() * 0.9;
        scheduler.stepEdited(t.id, i);
      } else if (choice < 0.65) {
        t.muted = !t.muted;
        scheduler.trackEdited(t.id);
      } else if (choice < 0.8) {
        resizeTrack(t, 1 + Math.floor(rand() * 8));
        scheduler.trackEdited(t.id);
      } else if (choice < 0.9) {
        t.channel = Math.floor(rand() * 2);
        scheduler.trackEdited(t.id);
      } else if (choice < 0.95) {
        for (const st of t.steps) {
          st.enabled = rand() < 0.5;
          st.pitch = 60 + Math.floor(rand() * 3);
        }
        scheduler.trackEdited(t.id);
      }
      assertNoStrayOff(tick);
    }

    scheduler.stop();
    expect(scheduler.soundingNotes).toBe(0);
    // The wire ends silent: every key that ever sounded has a final off.
    held.clear();
    for (const m of out.sent) {
      const key = `${m.message[0]! & 0x0f}:${m.message[1]}`;
      if (isOn(m.message)) held.add(key);
      else if (isOff(m.message)) held.delete(key);
    }
    expect([...held]).toEqual([]);
  });

  it('editing one track never moves another track off the global grid', () => {
    const pattern: Pattern = { tracks: [] };
    const t0 = createTrack(4);
    t0.channel = 0;
    const t1 = createTrack(4);
    t1.channel = 3;
    for (const s of t1.steps) {
      s.enabled = true;
      s.gate = 0.2;
    }
    pattern.tracks.push(t0, t1);

    const clock = new ManualClock();
    const out = new RecordingOutputAdapter('o', 'O');
    const scheduler = new Scheduler({
      clock,
      getPattern: () => pattern,
      getTempo: () => 120
    });
    scheduler.setOutput(out);
    scheduler.play();
    clock.advance(25);

    // Aggressive edits on track 0 only.
    for (let i = 0; i < 20; i++) {
      const cell = i % 4;
      t0.steps[cell]!.enabled = !t0.steps[cell]!.enabled;
      t0.steps[cell]!.pitch = 60 + i;
      scheduler.stepEdited(t0.id, cell);
      t0.muted = i % 2 === 0;
      scheduler.trackEdited(t0.id);
    }
    clock.advance(600);

    const onsCh3 = out.sent.filter(
      (m) => (m.message[0]! & 0x0f) === 3 && isOn(m.message)
    );
    expect(onsCh3.map((m) => m.timeMs)).toEqual([1, 126, 251, 376, 501]);
  });
});

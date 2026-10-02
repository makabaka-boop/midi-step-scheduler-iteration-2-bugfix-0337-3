/**
 * End-to-end recording tests: the real Scheduler + ManualClock timeline,
 * the MidiDeviceManager with a fake Web MIDI environment, and a
 * simulated MIDI keyboard whose messages carry clock-aligned timestamps.
 *
 * Time is driven like a real session: advance the clock to a playback
 * position, arm there, play notes at the current clock time while
 * advancing, then confirm/cancel. This covers beat mapping under tempo
 * changes, same-pitch retrigger, the loop tail, same-cell competition,
 * zero-velocity note-on, draft isolation from the playing score/queue,
 * and commit-time output message ordering — plus cancel / stop / device
 * disconnect discarding the draft and hanging notes.
 */
import { get } from 'svelte/store';
import { describe, expect, it } from 'vitest';
import { SequencerController } from '../src/lib/controller';
import { ManualClock } from '../src/lib/sequencer/clock';
import { MidiDeviceManager, type MidiAccessLike } from '../src/lib/sequencer/devices';
import { createPattern } from '../src/lib/sequencer/types';
import { FakeMidiAccess, FakeMidiInput, FakeMidiOutput } from './fakeMidi';

interface Rig {
  clock: ManualClock;
  access: FakeMidiAccess;
  input: FakeMidiInput;
  output: FakeMidiOutput;
  controller: SequencerController;
  trackId: string;
  channel: number;
}

async function makeRig(trackLength = 8, enabled: number[] = [0]): Promise<Rig> {
  const access = new FakeMidiAccess();
  access.plugOutput('out', 'Out');
  const input = access.plugInput('kbd', 'Keyboard');
  const clock = new ManualClock();
  const manager = new MidiDeviceManager(() =>
    Promise.resolve(access as unknown as MidiAccessLike)
  );
  const pattern = createPattern(1, trackLength);
  pattern.tracks[0]!.steps.forEach((s) => (s.enabled = false));
  for (const i of enabled) {
    const s = pattern.tracks[0]!.steps[i];
    if (s) {
      s.enabled = true;
      s.pitch = 48;
      s.velocity = 100;
      s.gate = 0.5;
    }
  }
  const controller = new SequencerController({ clock, deviceManager: manager, pattern });
  await controller.init();
  return {
    clock,
    access,
    input,
    output: access.outputs.get('out')!,
    controller,
    trackId: pattern.tracks[0]!.id,
    channel: pattern.tracks[0]!.channel
  };
}

const ons = (port: FakeMidiOutput) => port.sent.filter((m) => (m[0]! & 0xf0) === 0x90);

/** Play one note at the current clock position: on now, off after gateMs. */
function play(rig: Rig, pitch: number, velocity: number, gateMs: number): void {
  const onAt = rig.clock.now();
  rig.input.emit([0x90 | rig.channel, pitch, velocity], onAt);
  rig.clock.advance(gateMs);
  // A held key gets its note-off at the current (advanced) clock time.
  rig.input.emit([0x80 | rig.channel, pitch, 0], rig.clock.now());
}

/** Inject an input message at the current clock time. */
function emitNow(rig: Rig, bytes: number[]): void {
  rig.input.emit(bytes, rig.clock.now());
}

/**
 * Advance so a note injected "now" quantizes onto global step `target`:
 * advance to a small epsilon after step `target`'s boundary, and verify
 * via the scheduler's own beat map that `target` is the sounding step.
 */
function ontoStep(rig: Rig, target: number): void {
  const stepDur = 60000 / (get(rig.controller.tempo) * 4);
  // Step N's boundary is at 1 + N*stepDur; a moment later the playhead
  // (last reached boundary) reads N.
  const boundary = 1 + target * stepDur;
  const delta = boundary - rig.clock.now() + 1;
  if (delta > 0) rig.clock.advance(delta);
  expect(rig.controller.scheduler.locateBeat(rig.clock.now()).step).toBe(target);
}

describe('record-while-playing integration', () => {
  it('captures played notes against the beat grid without touching the playing score', async () => {
    const rig = await makeRig(8, [0]); // original score: only cell 0 (pitch 48)
    const { clock, controller, trackId } = rig;
    controller.play();
    clock.advance(100); // step 0 of the existing pattern sounded
    expect(ons(rig.output).map((m) => m[1])).toEqual([48]);

    // Arm while playing, then wait for cell 2's boundary and perform.
    controller.armRecording(trackId);
    ontoStep(rig, 2);
    play(rig, 72, 80, 62); // half-step gate

    // The draft holds the performance…
    const rec = get(controller.recording);
    expect(rec.armed).toBe(true);
    expect(rec.cells.find((c) => c.cell === 2)).toMatchObject({ pitch: 72, velocity: 80 });
    // …but the score and the queued output are untouched: keyboard input
    // produced no extra wire messages.
    expect(ons(rig.output).map((m) => m[1])).toEqual([48]);

    controller.confirmRecording();
    const cell = get(controller.pattern).tracks[0]!.steps[2]!;
    expect(cell.enabled).toBe(true);
    expect(cell.pitch).toBe(72);
    expect(cell.velocity).toBe(80);
    expect(cell.gate).toBeCloseTo(0.5, 1);
    expect(get(controller.recording).armed).toBe(false);
  });

  it('committed cells play on the next pass and unrecorded cells keep the old score', async () => {
    const rig = await makeRig(8, [0]);
    const { clock, controller, trackId } = rig;
    controller.play();
    clock.advance(100);
    controller.armRecording(trackId);
    // Advance to cell 4 and overdub one note there.
    ontoStep(rig, 4);
    play(rig, 72, 110, 60);
    controller.confirmRecording();

    const steps = get(controller.pattern).tracks[0]!.steps;
    expect(steps[0]!.enabled).toBe(true); // untouched original
    expect(steps[4]!.pitch).toBe(72); // committed overdub
    expect(steps[1]!.enabled).toBe(false); // never played -> untouched

    clock.advance(1200); // subsequent passes: both notes recur
    const pitches = ons(rig.output).map((m) => m[1]);
    expect(pitches.filter((p) => p === 72).length).toBeGreaterThan(0);
    expect(pitches.filter((p) => p === 48).length).toBeGreaterThan(1);
    controller.stop();
  });

  it('retrigger adjudication: the earlier note closes at the new trigger', async () => {
    const rig = await makeRig(16, []);
    const { clock, controller, trackId } = rig;
    controller.play();
    clock.advance(100); // on cell 0
    controller.armRecording(trackId);
    // Start a note on cell 0, keep holding, replay same pitch on cell 1.
    emitNow(rig, [0x90, 60, 100]);
    ontoStep(rig, 1);
    emitNow(rig, [0x90, 60, 70]); // retrigger, no intervening off
    clock.advance(60);
    emitNow(rig, [0x80, 60, 0]);

    const rec = get(controller.recording);
    expect(rec.verdicts.some((v) => v.kind === 'retrigger')).toBe(true);
    controller.confirmRecording();
    const cells = get(controller.pattern).tracks[0]!.steps;
    // The retriggered note wins cell 1 with the new velocity…
    expect(cells[1]!.enabled).toBe(true);
    expect(cells[1]!.velocity).toBe(70);
    // …and the closed predecessor stays on cell 0 (its gate was measured
    // to the trigger and clamped, so both cells are complete and stable).
    expect(cells[0]!.enabled).toBe(true);
    expect(cells[0]!.pitch).toBe(60);
  });

  it('same-cell competition: later onset wins and the verdict is visible', async () => {
    const rig = await makeRig(16, []);
    const { clock, controller, trackId } = rig;
    controller.play();
    clock.advance(100); // on cell 0
    controller.armRecording(trackId);
    // Two short notes, both still inside cell 0's window; the later onset
    // (pitch 80) wins the cell.
    emitNow(rig, [0x90, 60, 100]);
    clock.advance(10);
    emitNow(rig, [0x80, 60, 0]);
    emitNow(rig, [0x90, 80, 100]);
    clock.advance(10);
    emitNow(rig, [0x80, 80, 0]);
    const rec = get(controller.recording);
    expect(rec.verdicts.some((v) => v.kind === 'cell-overwrite')).toBe(true);
    controller.confirmRecording();
    expect(get(controller.pattern).tracks[0]!.steps[0]!.pitch).toBe(80);
  });

  it('zero-velocity note-on is treated as note-off', async () => {
    const rig = await makeRig(16, []);
    const { clock, controller, trackId } = rig;
    controller.play();
    clock.advance(100); // on cell 0
    controller.armRecording(trackId);
    emitNow(rig, [0x90, 60, 100]);
    clock.advance(40);
    emitNow(rig, [0x90, 60, 0]); // velocity-0 note-on closes the note
    const rec = get(controller.recording);
    expect(rec.verdicts.some((v) => v.kind === 'zero-velocity-off')).toBe(true);
    expect(rec.cells[0]?.open).toBe(false);
    controller.confirmRecording();
    expect(get(controller.pattern).tracks[0]!.steps[0]!.enabled).toBe(true);
  });

  it('cross-loop tail is clamped and does not smear into the next loop', async () => {
    const rig = await makeRig(4, []);
    const { clock, controller, trackId } = rig;
    controller.play();
    clock.advance(100); // on cell 0
    controller.armRecording(trackId);
    ontoStep(rig, 3); // just inside cell 3
    // Hold across the end of this 4-cell loop and well into the next.
    emitNow(rig, [0x90, 60, 100]);
    clock.advance(300); // across the tail, into the next loop
    emitNow(rig, [0x80, 60, 0]);
    const rec = get(controller.recording);
    expect(rec.verdicts.some((v) => v.kind === 'cross-loop-gate')).toBe(true);
    expect(rec.cells.find((c) => c.cell === 3)?.gate).toBe(1);
    controller.confirmRecording();
    const cells = get(controller.pattern).tracks[0]!.steps;
    expect(cells[3]!.enabled).toBe(true);
    expect(cells[1]!.enabled).toBe(false); // no spill into the next pass
  });
});

describe('recording under tempo changes', () => {
  it('quantizes on the new tempo grid after a change mid-take', async () => {
    const rig = await makeRig(16, []);
    const { clock, controller, trackId } = rig;
    controller.play();
    clock.advance(100); // cell 0 on the 125ms grid
    controller.armRecording(trackId);
    // Record one note on cell 1 at the original tempo.
    ontoStep(rig, 1);
    play(rig, 60, 100, 30);

    // Double the tempo mid-take; subsequent steps are 62.5ms. Record a
    // note on whatever global step the playhead reaches next on the new
    // grid — it must map through locateBeat, not the old 125ms grid.
    controller.setTempo(240);
    clock.advance(63); // crosses at least one replanned 62.5ms boundary
    const stepNow = controller.scheduler.locateBeat(clock.now()).step;
    expect(stepNow).toBeGreaterThan(1);
    emitNow(rig, [0x90, 70, 100]);
    clock.advance(30);
    emitNow(rig, [0x80, 70, 0]);
    const targetCell = ((stepNow % 16) + 16) % 16;
    const draft = get(controller.recording).cells.map((c) => c.cell);
    expect(draft).toContain(1);
    expect(draft).toContain(targetCell);
    controller.confirmRecording();
    const cells = get(controller.pattern).tracks[0]!.steps;
    expect(cells[1]!.pitch).toBe(60);
    expect(cells[targetCell]!.pitch).toBe(70);
  });
});

describe('late messages across tempo changes and take boundaries', () => {
  it('a note delivered late across a tempo change lands in its true cell with its true gate', async () => {
    const rig = await makeRig(16, []);
    const { clock, controller, trackId } = rig;
    controller.play();
    clock.advance(40); // t=40, cell 0 on the 125ms grid
    controller.armRecording(trackId);
    // The key is physically pressed at t=50 and released at t=110 (60% of
    // a 125ms step), but the messages are only delivered at t=320 — after
    // a tempo change at t=252 replanned the grid to 250ms steps.
    clock.advance(212); // t=252, cell 2
    controller.setTempo(60);
    clock.advance(68); // t=320
    rig.input.emit([0x90 | rig.channel, 67, 90], 50);
    rig.input.emit([0x80 | rig.channel, 67, 0], 110);
    const draft = get(controller.recording);
    const cell = draft.cells.find((c) => c.pitch === 67);
    expect(cell?.cell).toBe(0); // pressed during cell 0 on the 125ms grid
    expect(cell?.gate).toBeCloseTo(0.48, 2); // 60ms of the 125ms step
    controller.confirmRecording();
    const steps = get(controller.pattern).tracks[0]!.steps;
    expect(steps[0]!.pitch).toBe(67);
    expect(steps[0]!.gate).toBeCloseTo(0.48, 2);
    expect(steps[1]!.enabled).toBe(false); // not smeared onto a neighbour
    controller.stop();
  });

  it('a cancelled round’s late messages cannot enter the next take', async () => {
    const rig = await makeRig(8, []);
    const { clock, controller, trackId } = rig;
    controller.play();
    clock.advance(100); // t=100, cell 0
    controller.armRecording(trackId);
    // First take: a note is played at t=130..190, but its messages are
    // still in flight when the take is cancelled at t=200.
    clock.advance(100); // t=200
    controller.cancelRecording();
    // A new take starts immediately; only now do the old messages arrive.
    controller.armRecording(trackId);
    rig.input.emit([0x90 | rig.channel, 61, 100], 130);
    rig.input.emit([0x80 | rig.channel, 61, 0], 190);
    const rec = get(controller.recording);
    expect(rec.cells.length).toBe(0); // the old round is kept out
    expect(rec.verdicts.some((v) => v.kind === 'stale-message')).toBe(true);
    // The new take records its own performance and commits only that.
    clock.advance(60); // t=260, cell 2 (boundary 251)
    rig.input.emit([0x90 | rig.channel, 65, 100], clock.now());
    clock.advance(50);
    rig.input.emit([0x80 | rig.channel, 65, 0], clock.now());
    controller.confirmRecording();
    const steps = get(controller.pattern).tracks[0]!.steps;
    expect(steps[2]!.pitch).toBe(65);
    expect(steps.some((s) => s.pitch === 61)).toBe(false); // no leftover committed
    controller.stop();
  });

  it('same-cell competition follows onset time, not delivery order', async () => {
    const rig = await makeRig(16, []);
    const { clock, controller, trackId } = rig;
    controller.play();
    clock.advance(100); // t=100, cell 0
    controller.armRecording(trackId);
    // The newer onset (t=115) is delivered first; the older one (t=105)
    // arrives late and must not overwrite the newer performance.
    rig.input.emit([0x90 | rig.channel, 80, 100], 115);
    rig.input.emit([0x80 | rig.channel, 80, 0], 155);
    rig.input.emit([0x90 | rig.channel, 60, 100], 105);
    rig.input.emit([0x80 | rig.channel, 60, 0], 145);
    const rec = get(controller.recording);
    expect(rec.cells.find((c) => c.cell === 0)?.pitch).toBe(80);
    expect(rec.verdicts.some((v) => v.kind === 'stale-message')).toBe(true);
    controller.confirmRecording();
    expect(get(controller.pattern).tracks[0]!.steps[0]!.pitch).toBe(80);
    controller.stop();
  });
});

describe('recording commit output ordering', () => {
  it('applies the batch with deterministic, timestamp-ordered messages', async () => {
    const rig = await makeRig(8, []);
    const { clock, controller, trackId, output } = rig;
    controller.play();
    clock.advance(100);
    controller.armRecording(trackId);
    // Perform cell 3 first, then cell 5, so the commit batch is applied
    // in a different order than the cells will subsequently fire.
    ontoStep(rig, 3);
    play(rig, 76, 100, 40);
    ontoStep(rig, 5);
    play(rig, 60, 100, 40);
    const before = output.logged.length;
    controller.confirmRecording();
    clock.advance(1200); // later passes let both committed cells fire

    // Every wire message emitted after the commit is timestamp-ordered,
    // and the committed cells fire on their own boundaries (3 before 5).
    const after = output.logged.slice(before);
    for (let i = 1; i < after.length; i++) {
      expect(after[i - 1]!.timeMs ?? 0).toBeLessThanOrEqual(after[i]!.timeMs ?? 0);
    }
    const newPitches = after
      .filter((e) => (e.message[0]! & 0xf0) === 0x90)
      .map((e) => e.message[1]);
    const p76 = newPitches.indexOf(76);
    expect(p76).toBeGreaterThanOrEqual(0);
    expect(newPitches.indexOf(60)).toBeGreaterThan(p76);
    controller.stop();
  });

  it('overdubbing a different pitch into a queued cell reconciles the old voice cleanly', async () => {
    const rig = await makeRig(8, [2]); // existing cell 2, pitch 48
    const { clock, controller, trackId, output } = rig;
    controller.play();
    clock.advance(100); // cell 2 (due 251) is queued
    controller.armRecording(trackId);
    clock.advance(2 * 125); // onto cell 2 (just after its boundary)
    play(rig, 80, 100, 40); // overwrite cell 2 with pitch 80
    const atConfirm = clock.now();
    controller.confirmRecording();
    // Advance to cell 2 of the next loop (step 10 boundary 1 + 10*125).
    clock.advance(1 + 10 * 125 - atConfirm + 50);
    // Cell 2 now plays the committed pitch 80; the wire never carries a
    // note-off for a key that is not held (no stray off).
    expect(ons(output).some((m) => m[1] === 80)).toBe(true);
    controller.stop();
  });
});

describe('discarding an unconfirmed take', () => {
  it('cancel keeps the original score and output exactly as they were', async () => {
    const rig = await makeRig(8, [0]);
    const { clock, controller, trackId, output } = rig;
    controller.play();
    clock.advance(100);
    const wireBefore = output.sent.length;
    controller.armRecording(trackId);
    clock.advance(2 * 125);
    play(rig, 80, 100, 40);
    controller.cancelRecording();
    expect(get(controller.recording).armed).toBe(false);
    expect(get(controller.pattern).tracks[0]!.steps[2]!.enabled).toBe(false);
    // Keyboard input never produced wire messages; cancel adds none.
    expect(output.sent.length).toBe(wireBefore);
  });

  it('stop while armed discards the draft and the hanging note', async () => {
    const rig = await makeRig(8, []);
    const { clock, controller, trackId } = rig;
    controller.play();
    clock.advance(100);
    controller.armRecording(trackId);
    emitNow(rig, [0x90, 60, 100]); // held, never released
    expect(get(controller.recording).cells.length).toBe(1);
    controller.stop();
    expect(get(controller.recording).armed).toBe(false);
    expect(get(controller.recording).cells.length).toBe(0);
  });

  it('pause while armed discards the draft as well', async () => {
    const rig = await makeRig(8, []);
    const { clock, controller, trackId } = rig;
    controller.play();
    clock.advance(100);
    controller.armRecording(trackId);
    emitNow(rig, [0x90, 60, 100]);
    clock.advance(40);
    emitNow(rig, [0x80, 60, 0]);
    controller.pause();
    expect(get(controller.recording).armed).toBe(false);
    controller.play();
    clock.advance(300);
    expect(ons(rig.output).length).toBe(0);
    controller.stop();
  });

  it('input device disconnect mid-take discards the draft; playback continues', async () => {
    const rig = await makeRig(8, [0]);
    const { clock, controller, trackId, access } = rig;
    controller.play();
    clock.advance(100);
    controller.armRecording(trackId);
    emitNow(rig, [0x90, 60, 100]);
    expect(get(controller.recording).armed).toBe(true);

    access.unplug('kbd');
    expect(get(controller.recording).armed).toBe(false);
    expect(get(controller.selectedInputId)).toBeNull();
    expect(get(controller.notice)).toMatch(/输入设备已断开/);
    // Playback itself is unaffected: the pattern keeps playing.
    expect(get(controller.transport)).toBe('playing');
    clock.advance(1200);
    expect(ons(rig.output).length).toBeGreaterThan(1);
    controller.stop();
  });

  it('a hot-plugged replacement input can arm the next take', async () => {
    const rig = await makeRig(8, []);
    const { clock, controller, trackId, access } = rig;
    access.unplug('kbd');
    expect(get(controller.selectedInputId)).toBeNull();
    access.plugInput('kbd2', 'Other Keyboard');
    expect(get(controller.selectedInputId)).toBe('kbd2');

    controller.play();
    clock.advance(100);
    controller.armRecording(trackId);
    expect(get(controller.recording).armed).toBe(true);
    access.inputs.get('kbd2')!.emit([0x90, 60, 100], clock.now());
    clock.advance(50);
    access.inputs.get('kbd2')!.emit([0x80, 60, 0], clock.now());
    controller.confirmRecording();
    expect(get(controller.pattern).tracks[0]!.steps[0]!.pitch).toBe(60);
  });
});

describe('recording does not affect other tracks', () => {
  it('arming and committing one track leaves a second track and shared output intact', async () => {
    const rig = await makeRig(16, [0]);
    const { clock, controller } = rig;
    controller.addTrack();
    const p = get(controller.pattern);
    const t1 = p.tracks[1]!;
    t1.channel = 0; // share channel with track 0
    t1.steps[1]!.enabled = true;
    t1.steps[1]!.pitch = 55;
    t1.steps[1]!.gate = 0.5;
    const track0 = p.tracks[0]!.id;

    controller.play();
    clock.advance(100);
    controller.armRecording(track0);
    clock.advance(2 * 125); // onto cell 2
    play(rig, 90, 100, 40); // record into track 0 cell 2
    controller.confirmRecording();
    clock.advance(600);

    // Track 1 kept playing its own pattern on the shared channel.
    expect(ons(rig.output).some((m) => m[1] === 55)).toBe(true);
    const t1after = get(controller.pattern).tracks.find((t) => t.id === t1.id)!;
    expect(t1after.steps[2]!.enabled).toBe(false);
    expect(t1after.steps[1]!.pitch).toBe(55);
    controller.stop();
  });
});

describe('recording without an input device', () => {
  it('still edits and plays the score normally; arming is refused', async () => {
    const access = new FakeMidiAccess();
    access.plugOutput('out', 'Out'); // output but NO input
    const clock = new ManualClock();
    const manager = new MidiDeviceManager(() =>
      Promise.resolve(access as unknown as MidiAccessLike)
    );
    const pattern = createPattern(1, 4);
    const controller = new SequencerController({ clock, deviceManager: manager, pattern });
    await controller.init();
    expect(get(controller.selectedInputId)).toBeNull();

    controller.play();
    clock.advance(100);
    controller.armRecording(pattern.tracks[0]!.id);
    expect(get(controller.recording).armed).toBe(false);
    expect(get(controller.notice)).toMatch(/输入设备/);

    // Editing and playback still work.
    controller.toggleStep(pattern.tracks[0]!.id, 2);
    expect(get(controller.pattern).tracks[0]!.steps[2]!.enabled).toBe(true);
    controller.stop();
  });

  it('refuses to arm while stopped even with a keyboard present', async () => {
    const rig = await makeRig(8, []);
    const { controller, trackId } = rig;
    expect(get(controller.transport)).toBe('stopped');
    controller.armRecording(trackId);
    expect(get(controller.recording).armed).toBe(false);
    expect(get(controller.notice)).toMatch(/请先播放/);
  });

  it('does not switch the input device while a take is armed', async () => {
    const rig = await makeRig(8, []);
    const { clock, controller, trackId, access } = rig;
    access.plugInput('kbd2', 'Other Keyboard');
    controller.play();
    clock.advance(100);
    controller.armRecording(trackId);
    // Attempting to swap inputs mid-take is ignored.
    controller.selectInput('kbd2');
    expect(get(controller.selectedInputId)).toBe('kbd');
    controller.cancelRecording();
    controller.stop();
  });
});

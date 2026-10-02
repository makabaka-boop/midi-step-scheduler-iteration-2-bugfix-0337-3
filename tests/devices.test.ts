import { get } from 'svelte/store';
import { describe, expect, it } from 'vitest';
import { SequencerController } from '../src/lib/controller';
import { ManualClock } from '../src/lib/sequencer/clock';
import { MidiDeviceManager, type MidiAccessLike } from '../src/lib/sequencer/devices';
import { createPattern } from '../src/lib/sequencer/types';
import { FakeMidiAccess, FakeMidiOutput } from './fakeMidi';

function makeController(access: FakeMidiAccess | null) {
  const clock = new ManualClock();
  const manager = new MidiDeviceManager(
    access ? () => Promise.resolve(access as unknown as MidiAccessLike) : null
  );
  const pattern = createPattern(1, 4);
  for (const step of pattern.tracks[0]!.steps) {
    step.enabled = true;
    step.pitch = 60;
  }
  const controller = new SequencerController({ clock, deviceManager: manager, pattern });
  return { clock, manager, controller };
}

const noteOns = (port: FakeMidiOutput) => port.sent.filter((m) => (m[0]! & 0xf0) === 0x90);
const noteOffs = (port: FakeMidiOutput) => port.sent.filter((m) => (m[0]! & 0xf0) === 0x80);

describe('MidiDeviceManager', () => {
  it('reports unsupported when Web MIDI is absent', async () => {
    const manager = new MidiDeviceManager(null);
    expect(await manager.request()).toBe('unsupported');
  });

  it('reports denied when access is refused', async () => {
    const manager = new MidiDeviceManager(() => Promise.reject(new Error('denied')));
    expect(await manager.request()).toBe('denied');
  });

  it('lists outputs and tracks hot-plug events', async () => {
    const access = new FakeMidiAccess();
    access.plug('a', 'Synth A');
    const manager = new MidiDeviceManager(() =>
      Promise.resolve(access as unknown as MidiAccessLike)
    );
    const seen: string[][] = [];
    manager.setEvents({ onDevicesChanged: (outs) => seen.push(outs.map((o) => o.id)) });
    await manager.request();
    expect(manager.outputs.map((o) => o.id)).toEqual(['a']);

    access.plug('b', 'Synth B'); // hot-plug
    expect(manager.outputs.map((o) => o.id)).toEqual(['a', 'b']);

    access.unplug('a'); // hot-unplug
    const a = manager.outputs.find((o) => o.id === 'a');
    expect(a?.connected).toBe(false);
    expect(seen.length).toBeGreaterThanOrEqual(3);
  });

  it('adapter for a disconnected port drops sends silently', async () => {
    const access = new FakeMidiAccess();
    access.plug('a', 'Synth A');
    const manager = new MidiDeviceManager(() =>
      Promise.resolve(access as unknown as MidiAccessLike)
    );
    await manager.request();
    const adapter = manager.adapterFor('a')!;
    expect(adapter).not.toBeNull();
    access.unplug('a');
    expect(adapter.connected).toBe(false);
    expect(() => adapter.send([0x90, 60, 100])).not.toThrow();
    expect(manager.adapterFor('a')).toBeNull();
  });
});

describe('MidiDeviceManager inputs', () => {
  it('lists inputs and tracks hot-plug / disconnect separately from outputs', async () => {
    const access = new FakeMidiAccess();
    access.plugOutput('oa', 'Out A');
    access.plugInput('ia', 'Keys A');
    const manager = new MidiDeviceManager(() =>
      Promise.resolve(access as unknown as MidiAccessLike)
    );
    const inputChanges: string[][] = [];
    let disconnectedId: string | null = null;
    manager.setEvents({
      onInputsChanged: (inputs) => inputChanges.push(inputs.map((i) => i.id)),
      onInputDisconnected: (id) => {
        disconnectedId = id;
      }
    });
    await manager.request();
    expect(manager.inputs.map((i) => i.id)).toEqual(['ia']);
    expect(manager.outputs.map((o) => o.id)).toEqual(['oa']);

    access.plugInput('ib', 'Keys B');
    expect(manager.inputs.map((i) => i.id)).toEqual(['ia', 'ib']);
    access.unplug('ia');
    expect(disconnectedId).toBe('ia');
    expect(manager.inputs.find((i) => i.id === 'ia')?.connected).toBe(false);
    expect(inputChanges.length).toBeGreaterThanOrEqual(2);
  });

  it('delivers injected messages through an input adapter', async () => {
    const access = new FakeMidiAccess();
    const port = access.plugInput('ia', 'Keys A');
    const manager = new MidiDeviceManager(() =>
      Promise.resolve(access as unknown as MidiAccessLike)
    );
    await manager.request();
    const adapter = manager.inputAdapterFor('ia')!;
    expect(adapter).not.toBeNull();
    const received: { data: number[]; time: number }[] = [];
    adapter.onMessage((data, time) => received.push({ data, time: Number(time) }));
    port.emit([0x90, 60, 100], 123);
    expect(received).toEqual([{ data: [0x90, 60, 100], time: 123 }]);
    access.unplug('ia');
    expect(adapter.connected).toBe(false);
    expect(manager.inputAdapterFor('ia')).toBeNull();
  });
});

describe('Controller + devices integration', () => {
  it('auto-selects the first connected output and plays through it', async () => {
    const access = new FakeMidiAccess();
    const { clock, controller } = makeController(access);
    await controller.init();
    expect(get(controller.midiStatus)).toBe('ready');

    access.plug('a', 'Synth A'); // hot-plugged after init
    expect(get(controller.selectedOutputId)).toBe('a');

    controller.play();
    clock.advance(100);
    const port = access.outputs.get('a')!;
    expect(noteOns(port).length).toBe(1);
    controller.stop();
  });

  it('stops playback and cleans up when the selected device disconnects', async () => {
    const access = new FakeMidiAccess();
    access.plug('a', 'Synth A');
    const { clock, controller } = makeController(access);
    await controller.init();

    controller.play();
    clock.advance(100); // one note sounding (gate 0.8 default)
    expect(get(controller.transport)).toBe('playing');

    access.unplug('a');
    expect(get(controller.transport)).toBe('stopped');
    expect(get(controller.selectedOutputId)).toBeNull();
    expect(get(controller.notice)).toMatch(/断开/);

    // No further timers, no further messages, no exceptions.
    const sentCount = access.outputs.get('a')!.sent.length;
    clock.advance(1000);
    expect(access.outputs.get('a')!.sent.length).toBe(sentCount);
  });

  it('keeps playing across an output switch, closing notes on the old device', async () => {
    const access = new FakeMidiAccess();
    access.plug('a', 'Synth A');
    access.plug('b', 'Synth B');
    const { clock, controller } = makeController(access);
    await controller.init();
    expect(get(controller.selectedOutputId)).toBe('a');

    controller.play();
    clock.advance(100);
    controller.selectOutput('b');
    clock.advance(300);

    const a = access.outputs.get('a')!;
    const b = access.outputs.get('b')!;
    expect(noteOns(a).length).toBe(1);
    expect(noteOffs(a).length).toBeGreaterThanOrEqual(1); // nothing left hanging on A
    expect(noteOns(b).length).toBeGreaterThan(0); // music continues on B
    expect(get(controller.transport)).toBe('playing');
    controller.stop();
  });

  it('a replacement device can be selected and used after a disconnect', async () => {
    const access = new FakeMidiAccess();
    access.plug('a', 'Synth A');
    const { clock, controller } = makeController(access);
    await controller.init();
    controller.play();
    clock.advance(50);
    access.unplug('a');
    expect(get(controller.transport)).toBe('stopped');

    access.plug('b', 'Synth B'); // user plugs in a replacement
    expect(get(controller.selectedOutputId)).toBe('b');
    controller.play();
    clock.advance(100);
    expect(noteOns(access.outputs.get('b')!).length).toBe(1);
    controller.stop();
  });

  it('without MIDI it allows editing but refuses to play', async () => {
    const { clock, controller } = makeController(null);
    await controller.init();
    expect(get(controller.midiStatus)).toBe('unsupported');

    // Editing works fine.
    const trackId = controllerPatternTrackId(controller);
    const before = get(controller.pattern).tracks[0]!.steps[1]!.enabled;
    controller.toggleStep(trackId, 1);
    expect(get(controller.pattern).tracks[0]!.steps[1]!.enabled).toBe(!before);

    // Playback is refused, not faked.
    controller.play();
    expect(get(controller.transport)).toBe('stopped');
    clock.advance(500);
    expect(clock.pendingTimers).toBe(0);
  });
});

function controllerPatternTrackId(controller: SequencerController): string {
  return get(controller.pattern).tracks[0]!.id;
}

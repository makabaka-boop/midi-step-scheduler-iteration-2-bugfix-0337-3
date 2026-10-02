/**
 * Web MIDI device management: access request, input/output listing and
 * hot-plug / disconnect tracking.
 *
 * The manager talks to a `MidiAccessLike` structural interface rather
 * than the global `navigator`, so tests can inject a fake MIDI access
 * object and simulate devices coming and going.
 */

import { WebMidiInputAdapter, type MidiInputAdapter, type MidiInputPortLike } from './input';
import { WebMidiOutputAdapter, type MidiOutputAdapter } from './output';

export type MidiStatus =
  | 'unknown'
  | 'unsupported' // no Web MIDI in this browser
  | 'requesting'
  | 'denied' // user/agent refused access
  | 'ready'
  | 'error';

export interface MidiDeviceInfo {
  id: string;
  name: string;
  connected: boolean;
}

/** Structural subset of the Web MIDI MIDIAccess we rely on. */
export interface MidiAccessLike {
  outputs: ReadonlyMap<string, MidiInputPortLike | MIDIOutput>;
  inputs: ReadonlyMap<string, MidiInputPortLike>;
  onstatechange: ((event: { port?: { id?: string; state?: string } }) => void) | null;
}

export interface MidiDeviceManagerEvents {
  /** Fired whenever the output list or connection states change. */
  onDevicesChanged?: (outputs: MidiDeviceInfo[]) => void;
  /** Fired whenever the input list or connection states change. */
  onInputsChanged?: (inputs: MidiDeviceInfo[]) => void;
  /** Fired when a previously connected output disappears. */
  onOutputDisconnected?: (id: string) => void;
  /** Fired when a previously connected input disappears. */
  onInputDisconnected?: (id: string) => void;
}

export class MidiDeviceManager {
  private access: MidiAccessLike | null = null;
  private knownConnectedOutputs = new Set<string>();
  private knownConnectedInputs = new Set<string>();
  private events: MidiDeviceManagerEvents;
  status: MidiStatus = 'unknown';
  outputs: MidiDeviceInfo[] = [];
  inputs: MidiDeviceInfo[] = [];

  constructor(
    private readonly requestAccess: (() => Promise<MidiAccessLike>) | null,
    events: MidiDeviceManagerEvents = {}
  ) {
    this.events = events;
  }

  /** Rebind event callbacks (used when the manager is injected pre-built). */
  setEvents(events: MidiDeviceManagerEvents): void {
    this.events = events;
  }

  /** Ask for MIDI access once; safe to call again after a failure. */
  async request(): Promise<MidiStatus> {
    if (!this.requestAccess) {
      this.status = 'unsupported';
      return this.status;
    }
    this.status = 'requesting';
    try {
      this.access = await this.requestAccess();
      this.access.onstatechange = () => this.refresh();
      this.status = 'ready';
      this.refresh();
    } catch {
      this.status = 'denied';
    }
    return this.status;
  }

  /** Re-read the port lists from the access object (hot-plug entry point). */
  refresh(): void {
    if (!this.access) return;
    this.refreshKind(
      this.access.outputs,
      this.knownConnectedOutputs,
      (next) => {
        this.outputs = next;
        this.events.onDevicesChanged?.(next);
      },
      (id) => this.events.onOutputDisconnected?.(id)
    );
    this.refreshKind(
      this.access.inputs,
      this.knownConnectedInputs,
      (next) => {
        this.inputs = next;
        this.events.onInputsChanged?.(next);
      },
      (id) => this.events.onInputDisconnected?.(id)
    );
  }

  private refreshKind(
    ports: ReadonlyMap<string, MidiInputPortLike | MIDIOutput>,
    known: Set<string>,
    publish: (next: MidiDeviceInfo[]) => void,
    onGone: (id: string) => void
  ): void {
    const next: MidiDeviceInfo[] = [];
    const nowConnected = new Set<string>();
    for (const port of ports.values()) {
      const connected = port.state === 'connected';
      next.push({
        id: port.id,
        name: port.name ?? port.id,
        connected
      });
      if (connected) nowConnected.add(port.id);
    }
    // Diff against what we knew to report disconnections.
    for (const id of known) {
      if (!nowConnected.has(id)) onGone(id);
    }
    known.clear();
    for (const id of nowConnected) known.add(id);
    publish(next);
  }

  /** Build an adapter for a currently connected output, or null. */
  adapterFor(id: string, now?: () => number): MidiOutputAdapter | null {
    if (!this.access) return null;
    const port = this.access.outputs.get(id);
    if (!port || port.state !== 'connected') return null;
    return new WebMidiOutputAdapter(port as MIDIOutput, now);
  }

  /** Build an adapter for a currently connected input, or null. */
  inputAdapterFor(id: string): MidiInputAdapter | null {
    if (!this.access) return null;
    const port = this.access.inputs.get(id);
    if (!port || port.state !== 'connected') return null;
    return new WebMidiInputAdapter(port);
  }
}

/** Production factory: reads `navigator.requestMIDIAccess` if present. */
export function createBrowserDeviceManager(
  events: MidiDeviceManagerEvents = {}
): MidiDeviceManager {
  const request =
    typeof navigator !== 'undefined' && typeof navigator.requestMIDIAccess === 'function'
      ? () => navigator.requestMIDIAccess({ sysex: false }) as Promise<MidiAccessLike>
      : null;
  return new MidiDeviceManager(request, events);
}

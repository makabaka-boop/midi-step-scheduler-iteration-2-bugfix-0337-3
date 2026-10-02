/**
 * MIDI input adapter abstraction.
 *
 * Symmetric to `output.ts`: the recording pipeline subscribes to a
 * MidiInputAdapter and never touches Web MIDI directly, so a real MIDI
 * keyboard and a deterministic simulated device share one code path.
 *
 * Adapters only deliver raw byte arrays plus a timestamp; message
 * interpretation lives in `midi.ts` (parseNoteMessage) and sequencing
 * policy in `recorder.ts`.
 */

export type InputTimestamp = DOMHighResTimeStamp | number;

export interface MidiInputAdapter {
  readonly id: string;
  readonly name: string;
  /** False once the underlying device has gone away. */
  readonly connected: boolean;
  /**
   * Subscribe to MIDI messages from this input. Returns an unsubscribe
   * function; only one subscriber is needed per adapter.
   */
  onMessage(handler: (data: number[], timeMs: InputTimestamp) => void): () => void;
  /** Drop the subscription (e.g. after a disconnect). Must not throw. */
  close(): void;
}

/** Structural subset of the Web MIDI MIDIInput port we rely on. */
export interface MidiInputPortLike {
  readonly id: string;
  readonly name: string | null;
  readonly state: 'connected' | 'disconnected';
  onmidimessage: ((event: { data: ArrayLike<number>; timeStamp?: number }) => void) | null;
}

/** Wraps a real Web MIDI MIDIInput port. */
export class WebMidiInputAdapter implements MidiInputAdapter {
  private handler: ((data: number[], timeMs: InputTimestamp) => void) | null = null;

  constructor(private readonly port: MidiInputPortLike) {
    this.port.onmidimessage = (event) => {
      if (!this.handler) return;
      // Web MIDI timestamps share performance.now()'s time origin, the
      // same clock BrowserClock reads.
      const data = Array.from(event.data);
      this.handler(data, event.timeStamp ?? performance.now());
    };
  }

  get id(): string {
    return this.port.id ?? this.port.name ?? 'unknown-input';
  }

  get name(): string {
    return this.port.name ?? this.port.id ?? 'MIDI Input';
  }

  get connected(): boolean {
    return this.port.state === 'connected';
  }

  onMessage(handler: (data: number[], timeMs: InputTimestamp) => void): () => void {
    this.handler = handler;
    return () => {
      if (this.handler === handler) this.handler = null;
    };
  }

  close(): void {
    this.handler = null;
    try {
      this.port.onmidimessage = null;
    } catch {
      // A port can vanish between the state check and the assignment.
    }
  }
}

/**
 * Deterministic input device for tests: messages are injected with an
 * explicit timestamp, so a "key performance" can be played against a
 * ManualClock-driven beat without any real timers or hardware.
 */
export class SimulatedMidiInput implements MidiInputAdapter {
  private handler: ((data: number[], timeMs: InputTimestamp) => void) | null = null;

  constructor(
    readonly id: string,
    readonly name: string,
    public connected = true
  ) {}

  onMessage(handler: (data: number[], timeMs: InputTimestamp) => void): () => void {
    this.handler = handler;
    return () => {
      if (this.handler === handler) this.handler = null;
    };
  }

  /** Inject one raw message as if the keyboard had sent it at timeMs. */
  emit(data: number[], timeMs: InputTimestamp): void {
    if (!this.connected) return;
    this.handler?.([...data], timeMs);
  }

  /** Convenience: a full note-on/note-off pair at explicit times. */
  emitNote(channel: number, pitch: number, velocity: number, onMs: number, offMs: number): void {
    this.emit([0x90 | (channel & 0x0f), pitch, velocity], onMs);
    this.emit([0x80 | (channel & 0x0f), pitch, 0], offMs);
  }

  close(): void {
    this.handler = null;
  }
}

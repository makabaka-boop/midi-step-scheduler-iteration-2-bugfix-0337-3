/**
 * Output adapter abstraction.
 *
 * The scheduler talks to a MidiOutputAdapter, never to Web MIDI directly.
 * Adapters are replaceable: a real Web MIDI port in the browser, a
 * recording fake in tests, or nothing at all when MIDI is unavailable
 * (in which case playback is refused rather than faked).
 */

import type { MidiMessage } from './midi';

export interface MidiOutputAdapter {
  readonly id: string;
  readonly name: string;
  /** False once the underlying device has gone away. */
  readonly connected: boolean;
  /**
   * Send a message immediately. `timeMs` is the intended time on the
   * scheduler's clock; adapters that support timestamped output may use
   * it, others send immediately (the scheduler dispatches at due time).
   */
  send(message: MidiMessage, timeMs?: number): void;
}

/** Wraps a Web MIDI MIDIOutput port. */
export class WebMidiOutputAdapter implements MidiOutputAdapter {
  /**
   * Source for the "now" floor applied to outbound timestamps. In the
   * browser this is performance.now() (the same clock as Web MIDI);
   * deterministic tests inject the scheduler clock so the recorded
   * timestamps are the scheduler's, not the host wall clock's.
   */
  private readonly now: () => number;

  constructor(port: MIDIOutput, now: () => number = () => performance.now()) {
    this.port = port;
    this.now = now;
  }

  private readonly port: MIDIOutput;

  get id(): string {
    return this.port.id ?? this.port.name ?? 'unknown';
  }

  get name(): string {
    return this.port.name ?? this.port.id ?? 'MIDI Output';
  }

  get connected(): boolean {
    return this.port.state === 'connected';
  }

  send(message: MidiMessage, timeMs?: number): void {
    if (!this.connected) return; // device vanished: drop silently, never throw
    try {
      // The scheduler dispatches at due time, so the intended time is
      // never in the future; clamp defensively because some
      // implementations reject past timestamps instead of sending
      // immediately as the spec intends.
      const ts = timeMs !== undefined ? Math.max(timeMs, this.now()) : undefined;
      this.port.send(message, ts);
    } catch {
      // A port can disconnect between the state check and send(); ignore.
    }
  }
}

/** Records every message with its timestamp. Used by unit and page tests. */
export class RecordingOutputAdapter implements MidiOutputAdapter {
  readonly sent: { message: MidiMessage; timeMs: number | undefined }[] = [];

  constructor(
    readonly id: string,
    readonly name: string,
    public connected = true
  ) {}

  send(message: MidiMessage, timeMs?: number): void {
    if (!this.connected) return;
    this.sent.push({ message: [...message], timeMs });
  }

  clear(): void {
    this.sent.length = 0;
  }
}

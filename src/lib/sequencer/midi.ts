/**
 * MIDI message builders. All messages are plain byte arrays so the
 * scheduler stays independent of any particular output implementation.
 */

export type MidiMessage = number[];

const clampByte = (v: number) => Math.max(0, Math.min(127, Math.round(v)));

export function noteOn(channel: number, pitch: number, velocity: number): MidiMessage {
  return [0x90 | (channel & 0x0f), clampByte(pitch), clampByte(velocity)];
}

export function noteOff(channel: number, pitch: number): MidiMessage {
  return [0x80 | (channel & 0x0f), clampByte(pitch), 0];
}

/** CC 123 — All Notes Off for one channel. */
export function allNotesOff(channel: number): MidiMessage {
  return [0xb0 | (channel & 0x0f), 123, 0];
}

/** CC 120 — All Sound Off for one channel (immediate, ignores release). */
export function allSoundOff(channel: number): MidiMessage {
  return [0xb0 | (channel & 0x0f), 120, 0];
}

export interface ParsedNoteMessage {
  kind: 'on' | 'off';
  channel: number;
  pitch: number;
  velocity: number;
  /** True when the off was encoded as a zero-velocity note-on (running-status convention). */
  zeroVelocity: boolean;
}

/**
 * Parse a channel note-on / note-off message.
 *
 * A note-on with velocity 0 is interpreted as a note-off, per the MIDI
 * convention — callers must not treat it as a sounding note. Anything
 * that is not a channel voice note message (CC, SYSEX, active sensing…)
 * returns null.
 */
export function parseNoteMessage(data: ArrayLike<number>): ParsedNoteMessage | null {
  const status = data[0];
  const pitch = data[1];
  const velocity = data[2];
  if (status === undefined || pitch === undefined || velocity === undefined) return null;
  if ((status & 0x80) === 0) return null; // running status / not a status byte
  const op = status & 0xf0;
  if (op !== 0x90 && op !== 0x80) return null;
  const p = clampByte(pitch);
  const v = clampByte(velocity);
  if (op === 0x90 && v > 0) {
    return { kind: 'on', channel: status & 0x0f, pitch: p, velocity: v, zeroVelocity: false };
  }
  return {
    kind: 'off',
    channel: status & 0x0f,
    pitch: p,
    velocity: v,
    zeroVelocity: op === 0x90
  };
}

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** MIDI note number -> name, e.g. 60 -> "C4". */
export function noteName(pitch: number): string {
  const p = Math.max(0, Math.min(127, Math.round(pitch)));
  return `${NAMES[p % 12]}${Math.floor(p / 12) - 1}`;
}

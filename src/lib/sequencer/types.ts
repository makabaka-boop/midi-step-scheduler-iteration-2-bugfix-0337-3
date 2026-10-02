/**
 * Core domain types for the step sequencer.
 *
 * A Pattern holds 1..8 tracks. Each track owns 1..64 steps.
 * Every step carries pitch, velocity and gate length.
 */

export const MIN_TRACKS = 1;
export const MAX_TRACKS = 8;
export const MIN_STEPS = 1;
export const MAX_STEPS = 64;
export const STEPS_PER_BEAT = 4; // 16th-note grid

export interface Step {
  /** Whether the step fires when the playhead passes it. */
  enabled: boolean;
  /** MIDI note number 0..127. */
  pitch: number;
  /** MIDI velocity 1..127. */
  velocity: number;
  /**
   * Gate length as a fraction of one step duration, in (0, 1].
   * 1 = note sustains until the next step boundary.
   */
  gate: number;
}

export interface Track {
  id: string;
  name: string;
  /** MIDI channel 0..15. */
  channel: number;
  muted: boolean;
  steps: Step[];
}

export interface Pattern {
  tracks: Track[];
}

export function createStep(enabled = false): Step {
  return { enabled, pitch: 60, velocity: 100, gate: 0.8 };
}

let trackCounter = 0;

export function createTrack(stepCount = 16, channel?: number): Track {
  const id = `track-${++trackCounter}`;
  return {
    id,
    name: `Track ${trackCounter}`,
    channel: channel ?? (trackCounter - 1) % 16,
    muted: false,
    steps: Array.from({ length: stepCount }, () => createStep())
  };
}

export function createPattern(trackCount = 4, stepCount = 16): Pattern {
  trackCounter = 0;
  const tracks: Track[] = [];
  for (let i = 0; i < Math.max(MIN_TRACKS, Math.min(MAX_TRACKS, trackCount)); i++) {
    tracks.push(createTrack(stepCount));
  }
  return { tracks };
}

/** Clamp a track's step list to a new length, preserving existing steps. */
export function resizeTrack(track: Track, length: number): void {
  const len = Math.max(MIN_STEPS, Math.min(MAX_STEPS, Math.round(length)));
  if (len < track.steps.length) {
    track.steps.length = len;
  } else {
    while (track.steps.length < len) {
      track.steps.push(createStep());
    }
  }
}

export function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

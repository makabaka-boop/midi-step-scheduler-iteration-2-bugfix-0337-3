/**
 * Single-track "record, then confirm" session.
 *
 * While armed, note-on/note-off from the input device are interpreted
 * against the *scheduler's own beat timeline* (a `BeatMap`) and turned
 * into complete note pairs quantized onto one track's step cells. The
 * session keeps a private draft: it never writes the playing pattern and
 * never touches an output adapter, so playback of the existing score and
 * every other track proceed untouched. Confirmation hands one batch of
 * finished cells to the caller (the controller commits it once and asks
 * the scheduler to reconcile); cancellation, stop, input loss or revoked
 * authorization simply discard the draft and all hanging notes.
 *
 * Every ambiguous situation has a deterministic outcome that is also
 * surfaced as a verdict:
 *
 * - same-pitch retrigger while the previous note is still held: the old
 *   note closes at the new trigger time (gate clamped, never negative);
 * - notes longer than a cell are clamped to gate 1.0; a note that hangs
 *   across the loop tail is clamped without smearing into the next loop;
 * - two onsets competing for one cell: the later *onset* wins — decided
 *   by the messages' own timestamps, never by delivery order — and the
 *   losing record is displaced with a visible verdict;
 * - zero-velocity note-on is a note-off (MIDI convention);
 * - a note-off without a note-on is ignored;
 * - a note still held at confirm time is an incomplete pair: dropped,
 *   never committed half-open.
 *
 * The take has a hard boundary on the scheduler clock: anything
 * timestamped before the take was armed — a previous take's leftover
 * delivered late, or idle playing before record was enabled — is not
 * part of this performance. It writes no cell and no verdict, so a
 * cancelled take can never leak into the next take's draft.
 *
 * The session is framework-free; the controller republishes its
 * snapshots through a Svelte store so the input adapter, beat mapping,
 * controller and UI share exactly one recording result.
 */

import type { Step } from './types';

export const MIN_GATE = 0.05;
export const MAX_GATE = 1;
/** Verdicts beyond this are trimmed (oldest first) to bound memory. */
const MAX_VERDICTS = 64;

export type RecordVerdictKind =
  | 'retrigger' // same pitch replayed before its previous note closed
  | 'cross-loop-gate' // held across the loop tail: gate clamped, no spill
  | 'gate-capped' // longer than one cell: gate clamped to 100%
  | 'cell-overwrite' // later onset took a cell already occupied
  | 'zero-velocity-off' // velocity-0 note-on interpreted as note-off
  | 'orphan-off' // note-off without a matching note-on: ignored
  | 'incomplete'; // still held when the take ended: dropped

export interface RecordVerdict {
  kind: RecordVerdictKind;
  /** Cell index on the armed track, or -1 when no cell is involved. */
  cell: number;
  pitch: number;
  /** Clock time of the event that produced the verdict. */
  timeMs: number;
}

export interface DraftStep {
  cell: number;
  pitch: number;
  velocity: number;
  gate: number;
  /** True while the keyboard key is still held (provisional entry). */
  open: boolean;
}

export interface RecordingSnapshot {
  armed: boolean;
  trackId: string | null;
  /** MIDI channel the arm is listening on, and the loop length in cells. */
  channel: number;
  length: number;
  /** Loop passes fully traversed since arming (the current take is pass N). */
  pass: number;
  /** Current draft, one winning entry per cell, sorted by cell. */
  cells: readonly DraftStep[];
  /** Adjudication log, oldest first. */
  verdicts: readonly RecordVerdict[];
}

export interface CommittedCell {
  cell: number;
  step: Pick<Step, 'enabled' | 'pitch' | 'velocity' | 'gate'>;
}

export interface RecordingCommit {
  trackId: string;
  cells: CommittedCell[];
}

/** Result of finishing a take: the commit (null if nothing complete) and
 *  the number of incomplete pairs that had to be dropped. */
export interface RecordingCommitResult {
  commit: RecordingCommit | null;
  dropped: number;
}

/** The slice of the scheduler the session depends on. */
export interface BeatMap {
  locateBeat(timeMs: number): { step: number; time: number; stepDur: number };
  /** Global step the playhead is currently on (>= 0 while playing). */
  playingStep: number;
  /** Current scheduler-clock time; stamps the take boundary at arming. */
  nowMs(): number;
}

interface OpenVoice {
  id: number;
  pitch: number;
  /** Quantized global step and track cell of the note-on. */
  onStep: number;
  cell: number;
  /** First global step of the loop pass after the onset cell's pass. */
  loopEndStep: number;
  onTime: number;
  velocity: number;
  /** Step duration in force when the note-on arrived (history is frozen). */
  stepDur: number;
}

const IDLE_SNAPSHOT: RecordingSnapshot = {
  armed: false,
  trackId: null,
  channel: 0,
  length: 0,
  pass: 0,
  cells: [],
  verdicts: []
};

const clampGate = (gate: number): number => Math.min(MAX_GATE, Math.max(MIN_GATE, gate));
const mod = (n: number, m: number): number => ((n % m) + m) % m;

export class RecordingSession {
  private beat: BeatMap | null = null;
  private armedTrackId: string | null = null;
  private channel = 0;
  private length = 0;
  /** Global step the take was anchored on (start of pass 0). */
  private anchorStep = 0;
  private pass = 0;
  /**
   * Scheduler-clock time this take was armed. Messages timestamped before
   * it belong to an earlier take (or to no take) and are ignored outright.
   */
  private armedAtMs = 0;

  /** Currently held keyboard keys, keyed by pitch (single channel). */
  private open = new Map<number, OpenVoice>();
  /** One winning draft entry per cell; values carry the owning voice id
   *  and the winning onset time (cell races are judged by timestamps). */
  private cells = new Map<number, DraftStep & { voiceId: number; onTime: number }>();
  private verdicts: RecordVerdict[] = [];
  private voiceSeq = 0;
  private listener: ((snapshot: RecordingSnapshot) => void) | null = null;

  constructor(beat: BeatMap) {
    this.beat = beat;
  }

  /** Svelte-store compatible subscription over the shared snapshot. */
  subscribe(listener: (snapshot: RecordingSnapshot) => void): () => void {
    this.listener = listener;
    listener(this.snapshot);
    return () => {
      if (this.listener === listener) this.listener = null;
    };
  }

  get snapshot(): RecordingSnapshot {
    if (!this.armedTrackId) return IDLE_SNAPSHOT;
    return {
      armed: true,
      trackId: this.armedTrackId,
      channel: this.channel,
      length: this.length,
      pass: this.pass,
      cells: [...this.cells.values()]
        .map(({ cell, pitch, velocity, gate, open }) => ({ cell, pitch, velocity, gate, open }))
        .sort((a, b) => a.cell - b.cell),
      verdicts: [...this.verdicts]
    };
  }

  get isArmed(): boolean {
    return this.armedTrackId !== null;
  }

  get armedTrack(): string | null {
    return this.armedTrackId;
  }

  /** Begin a take on one track/channel at the current playhead. */
  arm(trackId: string, channel: number, length: number): boolean {
    if (this.armedTrackId || !this.beat || length <= 0) return false;
    this.armedTrackId = trackId;
    this.channel = channel;
    this.length = length;
    // The take boundary on the scheduler clock: only messages timestamped
    // from this moment on belong to this take.
    this.armedAtMs = this.beat.nowMs();
    // Anchor the take on the step the playhead is currently crossing;
    // notes arriving before the next boundary belong to that cell.
    this.anchorStep = Math.max(0, this.beat.playingStep);
    this.pass = 0;
    this.emit();
    return true;
  }

  /** Discard an unconfirmed take and every hanging note. */
  cancel(): void {
    if (!this.armedTrackId) return;
    this.reset();
    this.emit();
  }

  /**
   * Finish the take: drop incomplete (still-held) notes and return the
   * complete cells of this take in ascending cell order for a single
   * commit. The commit is null when nothing valid was recorded, but the
   * dropped count is always reported. The draft is cleared either way.
   */
  confirm(): RecordingCommitResult {
    const trackId = this.armedTrackId;

    // Any voice still held is an incomplete pair. Drop its provisional
    // cell (when it still owns one) and make the disposal visible.
    let dropped = 0;
    if (trackId) {
      for (const voice of this.open.values()) {
        const entry = this.cells.get(voice.cell);
        if (entry && entry.voiceId === voice.id) {
          this.pushVerdict('incomplete', voice.cell, voice.pitch, voice.onTime);
          this.cells.delete(voice.cell);
          dropped += 1;
        }
      }
    }

    const cells: CommittedCell[] = [];
    if (trackId) {
      for (const [cell, entry] of [...this.cells.entries()].sort((a, b) => a[0] - b[0])) {
        if (cell >= this.length || entry.open) continue; // defensive: never commit open
        cells.push({
          cell,
          step: {
            enabled: true,
            pitch: entry.pitch,
            velocity: entry.velocity,
            gate: entry.gate
          }
        });
      }
    }

    const commit: RecordingCommit | null =
      trackId && cells.length > 0 ? { trackId, cells } : null;
    this.reset();
    this.emit();
    return { commit, dropped };
  }

  /** Track the playhead so the current loop pass stays visible live. */
  updatePlayhead(globalStep: number): void {
    if (!this.armedTrackId) return;
    const pass = Math.max(0, Math.floor((globalStep - this.anchorStep) / this.length));
    if (pass !== this.pass) {
      this.pass = pass;
      this.emit();
    }
  }

  // --- input events ------------------------------------------------------

  noteOn(channel: number, pitch: number, velocity: number, timeMs: number): void {
    if (!this.armedTrackId || channel !== this.channel || velocity <= 0) return;
    if (!this.beat) return;
    // Older than the take itself: a leftover from a previous take (or an
    // idle keyboard) delivered late. It is not part of this performance —
    // it must not write a cell, a verdict or any other trace here.
    if (timeMs < this.armedAtMs) return;

    // Same-pitch retrigger: close the previous instance at exactly the
    // new trigger time, so the two never overlap and its gate is real.
    const previous = this.open.get(pitch);
    let retriggeredCell = -1;
    if (previous) {
      retriggeredCell = previous.cell;
      this.finalizeVoice(previous, timeMs, timeMs, true);
      this.open.delete(pitch);
    }

    const located = this.beat.locateBeat(timeMs);
    const voice: OpenVoice = {
      id: ++this.voiceSeq,
      pitch,
      onStep: located.step,
      cell: mod(located.step, this.length),
      // The loop tail ends at the first boundary of the next pass.
      loopEndStep: located.step - mod(located.step, this.length) + this.length,
      onTime: timeMs,
      velocity,
      stepDur: located.stepDur
    };
    this.open.set(pitch, voice);

    // One cell carries at most one note, and the later *onset* wins — by
    // the messages' own timestamps, not by arrival order. A note that is
    // delivered late but was played before the cell's current owner has
    // already lost: its voice stays open only so its note-off can pair,
    // and the loss is reported rather than silently dropped.
    const occupant = this.cells.get(voice.cell);
    if (occupant && occupant.voiceId !== voice.id && occupant.cell !== retriggeredCell) {
      if (occupant.onTime > timeMs) {
        this.pushVerdict('cell-overwrite', voice.cell, pitch, timeMs);
        this.emit();
        return;
      }
      this.pushVerdict('cell-overwrite', voice.cell, occupant.pitch, timeMs);
    }
    this.cells.set(voice.cell, {
      cell: voice.cell,
      pitch,
      velocity,
      gate: MAX_GATE,
      open: true,
      voiceId: voice.id,
      onTime: timeMs
    });
    this.emit();
  }

  noteOff(channel: number, pitch: number, timeMs: number, zeroVelocity = false): void {
    if (!this.armedTrackId || channel !== this.channel) return;
    // Same take boundary as noteOn: a leftover from before this take was
    // armed leaves no trace — not even an orphan verdict.
    if (timeMs < this.armedAtMs) return;
    const voice = this.open.get(pitch);
    if (!voice) {
      // A close without an open note cannot form a pair — ignore it, but
      // keep the decision visible (includes stray zero-velocity ons).
      const cell = this.beat ? mod(this.beat.locateBeat(timeMs).step, this.length) : -1;
      this.pushVerdict('orphan-off', cell, pitch, timeMs);
      this.emit();
      return;
    }
    this.open.delete(pitch);
    this.finalizeVoice(voice, timeMs, timeMs, false, zeroVelocity);
    this.emit();
  }

  // --- internals ---------------------------------------------------------

  /**
   * Close a held voice: compute the gate from the real time span, clamp
   * it and — only while the voice still owns its cell — write the
   * finished draft entry. A voice displaced from its cell leaves no
   * trace there; the earlier cell-overwrite verdict already explained it.
   */
  private finalizeVoice(
    voice: OpenVoice,
    offTime: number,
    verdictTime: number,
    retrigger: boolean,
    zeroVelocity = false
  ): void {
    const rawGate = Math.max(0, (offTime - voice.onTime) / voice.stepDur);
    const gate = clampGate(rawGate);
    // "Loop tail" = the release reached the first boundary of the next
    // loop pass. Such a note is clamped to one cell and must not smear
    // into the next pass.
    const offStep = this.beat ? this.beat.locateBeat(offTime).step : voice.onStep;
    const crossedLoop = offStep >= voice.loopEndStep;

    const entry = this.cells.get(voice.cell);
    const ownsCell = !!entry && entry.voiceId === voice.id;
    if (ownsCell) {
      this.cells.set(voice.cell, {
        cell: voice.cell,
        pitch: voice.pitch,
        velocity: voice.velocity,
        gate,
        open: false,
        voiceId: voice.id,
        onTime: voice.onTime
      });
    }

    if (zeroVelocity) {
      this.pushVerdict('zero-velocity-off', voice.cell, voice.pitch, verdictTime);
    }
    if (crossedLoop) {
      // The note rang into (or past) the loop tail: clamp and do not let
      // it smear into the same cell of the next pass.
      this.pushVerdict('cross-loop-gate', voice.cell, voice.pitch, verdictTime);
    } else if (rawGate > MAX_GATE) {
      this.pushVerdict('gate-capped', voice.cell, voice.pitch, verdictTime);
    }
    if (retrigger) {
      this.pushVerdict('retrigger', voice.cell, voice.pitch, verdictTime);
    }
  }

  private pushVerdict(
    kind: RecordVerdictKind,
    cell: number,
    pitch: number,
    timeMs: number
  ): void {
    this.verdicts.push({ kind, cell, pitch, timeMs });
    if (this.verdicts.length > MAX_VERDICTS) {
      this.verdicts.splice(0, this.verdicts.length - MAX_VERDICTS);
    }
  }

  private reset(): void {
    this.armedTrackId = null;
    this.channel = 0;
    this.length = 0;
    this.anchorStep = 0;
    this.armedAtMs = 0;
    this.pass = 0;
    this.open.clear();
    this.cells.clear();
    this.verdicts = [];
  }

  private emit(): void {
    this.listener?.(this.snapshot);
  }
}

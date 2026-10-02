/**
 * Lookahead transport scheduler.
 *
 * A short-period tick (every `tickMs`) runs two phases:
 *   1. schedule — materialize note-on/note-off events for every step whose
 *      start time falls inside the lookahead horizon (`now + lookaheadMs`);
 *   2. dispatch — send every queued event whose time has come due.
 *
 * The beat is therefore kept by the clock timeline, never by a chain of
 * per-step timers: a late tick simply schedules and dispatches whatever it
 * missed (bounded by `catchUpMs`, so a stalled tab cannot unleash a storm
 * of overdue notes).
 *
 * Because events only enter the queue one lookahead window ahead of time,
 * tempo changes and score edits naturally affect only steps that have not
 * been sent yet. `tempoChanged` additionally re-plans the not-yet-dispatched
 * part of the queue at the new tempo while leaving already-sounding notes
 * (and their note-offs) untouched.
 *
 * Live score edits (`stepEdited` / `trackEdited`) never rewind the clock:
 * they reconcile only the queued and sounding voices produced by the edited
 * cell or track. Turning a step off, muting or shortening a track cancels
 * its queued note-ons and releases its sounding notes immediately; pitch /
 * channel changes release the old note (the new one sounds next pass);
 * velocity and gate edits update the pending pair (a shortened gate on a
 * sounding note releases it early, a lengthened one postpones the off).
 * Because reconciliation is scoped by track and global step, editing one
 * track cannot move another track's beat.
 *
 * Voices are tracked independently even when two tracks share a MIDI
 * channel and pitch: the wire key state is a set of voice ids, so a wire
 * note-off is sent only when the *last* overlapping voice closes. Closing
 * one track's note can therefore never end another track's sound early.
 *
 * Pause, stop, output switch and output loss all run the same cleanup:
 * cancel every queued (unsent) message and immediately note-off every
 * wire key this scheduler started, so nothing can stick or fire twice.
 *
 * `locateBeat` exposes the current tempo grid for live-input recording:
 * a keyboard event's clock time maps to the global step boundary at or
 * before it, with the step duration in force (frozen per recorded note).
 * `stepsCommitted` reconciles one recorded take's cells as a single
 * ascending-order batch, so a confirmation applies like deterministic
 * manual edits without rewinding the clock or moving other tracks.
 */

import type { Clock, TimerHandle } from './clock';
import { noteOff, noteOn } from './midi';
import type { MidiOutputAdapter } from './output';
import { STEPS_PER_BEAT, type Pattern } from './types';

export type TransportState = 'stopped' | 'playing' | 'paused';

export interface ScheduledEvent {
  id: number;
  kind: 'noteOn' | 'noteOff';
  /** Due time on the scheduler clock, ms. */
  time: number;
  channel: number;
  pitch: number;
  velocity: number;
  /** Links a note-off to the note-on it belongs to. */
  pairId: number;
  /** Track and global step this event was materialized from (live-edit scope). */
  trackId: string;
  step: number;
}

interface ActiveNote {
  channel: number;
  pitch: number;
  /** True once the note-on was actually dispatched (audibly sounding). */
  sounding: boolean;
  /** Identity of the score cell that produced this voice. */
  trackId: string;
  step: number;
  /** Note-on time and the step duration in force when it was scheduled. */
  onTime: number;
  stepDur: number;
}

export interface SchedulerOptions {
  clock: Clock;
  /** Live pattern source; read at schedule time so edits apply to future steps. */
  getPattern: () => Pattern;
  /** Live tempo source (BPM); read at schedule time. */
  getTempo: () => number;
  lookaheadMs?: number;
  tickMs?: number;
  /** Steps older than this are skipped rather than fired late. */
  catchUpMs?: number;
  /** Playhead callback, fired when a step boundary is reached. */
  onStep?: (stepIndex: number, timeMs: number) => void;
  onStateChange?: (state: TransportState) => void;
}

const DEFAULT_LOOKAHEAD_MS = 120;
const DEFAULT_TICK_MS = 25;
const DEFAULT_CATCH_UP_MS = 240;

export class Scheduler {
  private readonly clock: Clock;
  private readonly getPattern: () => Pattern;
  private readonly getTempo: () => number;
  private readonly lookaheadMs: number;
  private readonly tickMs: number;
  private readonly catchUpMs: number;
  private readonly onStep?: (stepIndex: number, timeMs: number) => void;
  private readonly onStateChange?: (state: TransportState) => void;

  private output: MidiOutputAdapter | null = null;
  private state: TransportState = 'stopped';
  private timer: TimerHandle | null = null;

  /** Next step to schedule, and when it is due. */
  private stepIndex = 0;
  private nextStepTime = 0;
  /** Last step boundary that came due (drives tempo-change re-planning). */
  private lastBoundary: { step: number; time: number } = { step: -1, time: 0 };
  /**
   * Origin of the *current* tempo grid: the step/time anchor from which
   * boundaries run at `stepDuration()` right now. A tempo change moves it
   * to the boundary in force at the change, so live input is beat-mapped
   * onto exactly the grid playback is using (independent of when ticks
   * happen to dispatch).
   */
  private gridAnchor: { step: number; time: number } = { step: 0, time: 0 };

  /** Queued, not yet dispatched events — the "已排队消息". */
  private pending: ScheduledEvent[] = [];
  /** Steps scheduled but not yet reached (for the playhead callback). */
  private stepTimes: { step: number; time: number }[] = [];
  /** Notes this scheduler started and has not yet closed, keyed by note-on event id. */
  private activeNotes = new Map<number, ActiveNote>();
  /**
   * Voices currently holding each wire key, keyed by (channel, pitch).
   *
   * On a MIDI cable a note number is either held or not: a second note-on
   * while the key is held restarts the voice rather than adding a second
   * held key, and the note-off only becomes valid once the *last* voice
   * stops. Tracking the voice ids per key lets two tracks share a channel
   * and pitch — releasing one voice can never end the other's sound early,
   * while MIDI pairing (one on / one off) is still preserved.
   */
  private heldKeys = new Map<number, Set<number>>();
  private eventSeq = 0;

  constructor(options: SchedulerOptions) {
    this.clock = options.clock;
    this.getPattern = options.getPattern;
    this.getTempo = options.getTempo;
    this.lookaheadMs = options.lookaheadMs ?? DEFAULT_LOOKAHEAD_MS;
    this.tickMs = options.tickMs ?? DEFAULT_TICK_MS;
    this.catchUpMs = options.catchUpMs ?? DEFAULT_CATCH_UP_MS;
    this.onStep = options.onStep;
    this.onStateChange = options.onStateChange;
  }

  get transportState(): TransportState {
    return this.state;
  }

  get position(): number {
    return this.stepIndex;
  }

  /**
   * Global step the playhead is currently on while playing — the last
   * reached boundary's step (the step sounding now). -1 before the first
   * boundary. The recorder anchors a take's first loop on this.
   */
  get playingStep(): number {
    if (this.state !== 'playing') return -1;
    return this.lastBoundary.step;
  }

  get queuedEvents(): readonly ScheduledEvent[] {
    return this.pending;
  }

  get soundingNotes(): number {
    let n = 0;
    for (const note of this.activeNotes.values()) if (note.sounding) n++;
    return n;
  }

  /** Attach or replace the output. Null = no output (playback refused). */
  setOutput(output: MidiOutputAdapter | null): void {
    const old = this.output;
    if (old === output) return;
    this.output = output;
    if (old) {
      // Notes still sounding on the old device must be closed *there*,
      // or they would ring forever on hardware we no longer talk to.
      this.silence(old);
    }
    this.dropQueue();
    // Re-plan the current lookahead window onto the new output so a
    // mid-play switch does not swallow beats.
    if (this.state === 'playing') {
      this.rewindToLastBoundary();
    }
  }

  /**
   * Start or resume playback. Returns false (and changes nothing) when
   * there is no output — without a destination we refuse to pretend
   * to play. Repeated calls while playing are a no-op.
   */
  play(): boolean {
    if (this.state === 'playing') return true;
    if (!this.output) return false;
    if (this.state === 'stopped') {
      this.stepIndex = 0;
    }
    this.setState('playing');
    // Start the (possibly resumed) step almost immediately, but on the
    // clock timeline so the grid stays exact.
    this.nextStepTime = this.clock.now() + 1;
    this.lastBoundary = {
      step: this.stepIndex - 1,
      time: this.nextStepTime - this.stepDuration()
    };
    // The current-tempo grid starts at the first step of this run.
    this.gridAnchor = { step: this.stepIndex, time: this.nextStepTime };
    this.tick();
    return true;
  }

  /** Halt and keep position. Sounding notes are closed immediately. */
  pause(): void {
    if (this.state !== 'playing') return;
    this.setState('paused');
    this.cancelTimer();
    this.silence(this.output);
    this.dropQueue();
    // Resume from the first step that never made it out the door.
    this.stepIndex = this.lastBoundary.step + 1;
  }

  /** Halt and rewind to step 0. Sounding notes are closed immediately. */
  stop(): void {
    if (this.state === 'stopped') return;
    this.setState('stopped');
    this.cancelTimer();
    this.silence(this.output);
    this.dropQueue();
    this.stepIndex = 0;
    this.nextStepTime = 0;
    this.lastBoundary = { step: -1, time: 0 };
    this.gridAnchor = { step: 0, time: 0 };
  }

  /**
   * Tempo changes only re-plan steps that have not been sent yet:
   * queued note-ons are dropped and re-scheduled at the new tempo from
   * the last reached boundary, while already-sounding notes keep their
   * original note-off times.
   */
  tempoChanged(): void {
    if (this.state !== 'playing') return;
    this.dropUndispatched();
    this.rewindToLastBoundary();
    // From the change on, the grid runs at the new tempo from the next
    // step boundary the replan anchored on.
    this.gridAnchor = { step: this.stepIndex, time: this.nextStepTime };
  }

  /**
   * Reconcile one step cell after a live edit (enable toggle, pitch /
   * velocity / gate change). Only voices produced by that cell are
   * touched, so other tracks — and the global timeline — never move:
   *
   * - queued note-ons are dropped when the cell no longer fires, or
   *   updated to the new pitch / velocity / gate;
   * - a note that is already sounding is closed at once when disabled,
   *   and when its pitch or channel changes the old pitch is released;
   * - a shortened gate releases the sounding note earlier; a lengthened
   *   gate postpones the note-off (never past the step boundary — the
   *   same-track retrigger guard clamps it at the next trigger).
   */
  stepEdited(trackId: string, index: number): void {
    if (this.state !== 'playing') return;
    this.reconcileTrack(trackId, { cellIndex: index });
  }

  /**
   * Reconcile one track after a live structural edit (mute toggle, length
   * change, channel change, removal). Voices the track no longer owns are
   * cancelled or released immediately; voices that merely moved channel
   * are released on the old channel. Other tracks' queued events, voices
   * and step boundaries are left exactly where they were.
   */
  trackEdited(trackId: string, removed = false): void {
    if (this.state !== 'playing') return;
    this.reconcileTrack(trackId, { removed });
  }

  /** Duration of one step in ms at the current tempo. */
  stepDuration(): number {
    return 60000 / (this.getTempo() * STEPS_PER_BEAT);
  }

  /**
   * Beat-map a clock timestamp onto the scheduler's global step grid.
   *
   * Used by the recorder to interpret live keyboard input against the
   * *same* timeline the playback follows: the anchor is the last reached
   * step boundary and the current step duration, so a tempo change only
   * moves mapping for notes that arrive after it — already-played notes
   * keep the duration captured when their note-on arrived, just as
   * already-dispatched playback history is never rewritten.
   *
   * Returns the global step whose boundary is at or immediately before
   * `timeMs`, the boundary's clock time and the step duration in force.
   */
  locateBeat(timeMs: number): { step: number; time: number; stepDur: number } {
    const stepDur = Math.max(1, this.stepDuration());
    if (this.lastBoundary.step < 0) {
      // Never started (or fully stopped): expose the conventional origin.
      return { step: 0, time: 0, stepDur };
    }
    // Map against the current-tempo grid anchor (the boundary in force at
    // the last play() / tempo change), which is exactly where playback's
    // boundaries objectively fall — independent of tick dispatch timing.
    const { step: anchorStep, time: anchorTime } = this.gridAnchor;
    const k = Math.floor((timeMs - anchorTime) / stepDur);
    return { step: anchorStep + k, time: anchorTime + k * stepDur, stepDur };
  }

  /**
   * Reconcile a batch of cells on one track after a recorded take is
   * committed. The pattern already carries the recorded values; this
   * applies them to queued/sounding voices exactly like the equivalent
   * manual edits, with cells processed in ascending order so the order
   * of the resulting wire messages is deterministic (a turned-off cell
   * releases before a newly enabled cell can sound on a shared key).
   */
  stepsCommitted(trackId: string, cells: readonly number[]): void {
    if (this.state !== 'playing') return;
    for (const index of [...cells].sort((a, b) => a - b)) {
      this.reconcileTrack(trackId, { cellIndex: index });
    }
  }

  // -------------------------------------------------------------------

  private setState(state: TransportState): void {
    if (this.state === state) return;
    this.state = state;
    this.onStateChange?.(state);
  }

  private tick = (): void => {
    this.timer = null;
    if (this.state !== 'playing') return;
    const now = this.clock.now();
    this.scheduleAhead(now + this.lookaheadMs, now);
    this.dispatchDue(now);
    if (this.state === 'playing') {
      this.timer = this.clock.setTimeout(this.tick, this.tickMs);
    }
  };

  private cancelTimer(): void {
    if (this.timer !== null) {
      this.clock.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleAhead(horizon: number, now: number): void {
    // Guard against pathological tempos producing zero-length steps.
    const stepDur = Math.max(1, this.stepDuration());
    while (this.nextStepTime < horizon) {
      const time = this.nextStepTime;
      const step = this.stepIndex;
      // A step so far in the past that firing it now would be a
      // catch-up storm (e.g. after a stalled tab) is skipped, but the
      // playhead still advances over it.
      if (time >= now - this.catchUpMs) {
        this.scheduleStep(step, time, stepDur);
      }
      this.stepTimes.push({ step, time });
      this.nextStepTime += stepDur;
      this.stepIndex += 1;
    }
  }

  private scheduleStep(step: number, time: number, stepDur: number): void {
    const pattern = this.getPattern();
    for (const track of pattern.tracks) {
      this.scheduleTrackStep(track, step, time, stepDur);
    }
  }

  private scheduleTrackStep(
    track: Pattern['tracks'][number],
    step: number,
    time: number,
    stepDur: number
  ): void {
    if (track.muted || track.steps.length === 0) return;
    const cell = track.steps[step % track.steps.length];
    if (!cell || !cell.enabled) return;

    // Retrigger guard: any still-open instance of the same note *on the
    // same track* (whether already sounding or merely queued) is closed
    // exactly when the new one starts, so the two never overlap or stick.
    // The match is scoped by track: another track sharing this channel
    // and pitch is a separate voice and must keep ringing.
    for (const e of this.pending) {
      if (
        e.kind === 'noteOff' &&
        e.trackId === track.id &&
        e.channel === track.channel &&
        e.pitch === cell.pitch &&
        e.time > time
      ) {
        e.time = time;
      }
    }

    const onId = ++this.eventSeq;
    const offId = ++this.eventSeq;
    this.pending.push({
      id: onId,
      kind: 'noteOn',
      time,
      channel: track.channel,
      pitch: cell.pitch,
      velocity: cell.velocity,
      pairId: offId,
      trackId: track.id,
      step
    });
    this.pending.push({
      id: offId,
      kind: 'noteOff',
      time: time + stepDur * cell.gate,
      channel: track.channel,
      pitch: cell.pitch,
      velocity: 0,
      pairId: onId,
      trackId: track.id,
      step
    });
    this.activeNotes.set(onId, {
      channel: track.channel,
      pitch: cell.pitch,
      sounding: false,
      trackId: track.id,
      step,
      onTime: time,
      stepDur
    });
  }

  private dispatchDue(now: number): void {
    if (this.pending.length > 0) {
      const due = this.pending
        .filter((e) => e.time <= now)
        .sort((a, b) => a.time - b.time || a.id - b.id);
      this.pending = this.pending.filter((e) => e.time > now);
      for (const event of due) {
        if (event.kind === 'noteOn') {
          if (this.output) {
            this.output.send(
              noteOn(event.channel, event.pitch, event.velocity),
              event.time
            );
          }
          this.acquireKey(event.channel, event.pitch, event.id);
          const active = this.activeNotes.get(event.id);
          if (active) active.sounding = true;
        } else {
          this.releaseKey(
            event.channel,
            event.pitch,
            event.pairId,
            this.output,
            event.time
          );
          this.activeNotes.delete(event.pairId);
        }
      }
    }
    if (this.stepTimes.length > 0) {
      const reached = this.stepTimes.filter((s) => s.time <= now);
      this.stepTimes = this.stepTimes.filter((s) => s.time > now);
      for (const s of reached) {
        this.lastBoundary = { step: s.step, time: s.time };
        this.onStep?.(s.step, s.time);
      }
    }
  }

  /**
   * Send note-offs for every sounding voice to the given output. Each
   * distinct held (channel, pitch) is closed exactly once: when several
   * tracks overlap on the same key the wire still carries a single
   * note-off, and no earlier release can have closed a sibling voice.
   */
  private silence(output: MidiOutputAdapter | null): void {
    if (!output) {
      this.heldKeys.clear();
      return;
    }
    for (const key of this.heldKeys.keys()) {
      output.send(noteOff((key >> 8) & 0x0f, key & 0xff));
    }
    this.heldKeys.clear();
  }

  /** Drop every queued-but-unsent message and forget all open notes. */
  private dropQueue(): void {
    this.pending = [];
    this.stepTimes = [];
    this.activeNotes.clear();
    this.heldKeys.clear();
  }

  /**
   * Drop queued note-ons together with their paired note-offs, but keep
   * note-offs belonging to notes already dispatched (still sounding).
   */
  private dropUndispatched(): void {
    const unsentOnIds = new Set(
      this.pending.filter((e) => e.kind === 'noteOn').map((e) => e.id)
    );
    this.pending = this.pending.filter(
      (e) => e.kind === 'noteOff' && !unsentOnIds.has(e.pairId)
    );
    for (const id of unsentOnIds) this.activeNotes.delete(id);
    this.stepTimes = [];
  }

  // --- live score editing ------------------------------------------------
  //
  // Edits never rewind the clock or touch other tracks: they reconcile
  // only the queued/sounding voices produced by the edited cell, reading
  // the fresh pattern at edit time. Voices are identified by (trackId,
  // global step), which stays valid across track resizing: a cell the
  // shortened track no longer owns is recognized as stale and dropped.

  private reconcileTrack(
    trackId: string,
    scope: { cellIndex?: number; removed?: boolean }
  ): void {
    const now = this.clock.now();
    const track = this.getPattern().tracks.find((t) => t.id === trackId) ?? null;
    const removed = scope.removed ?? false;
    const muted = removed || (track?.muted ?? true);
    const length = track?.steps.length ?? 0;

    // A voice belongs to this reconciliation when it came from this track
    // and (for a cell edit) the edited cell is the one that produced it.
    // Identity is global-step based: after a resize the global step of an
    // old voice is looked up in the *current* array, so voices the
    // shortened track no longer owns are recognized as stale.
    const inScope = (originStep: number): boolean =>
      scope.cellIndex === undefined ||
      (!muted && length > 0 && originStep % length === scope.cellIndex);

    // --- queued, not-yet-dispatched events ---
    for (const e of [...this.pending]) {
      if (e.trackId !== trackId || !inScope(e.step)) continue;

      if (muted || removed || length === 0) {
        // Whole track silenced / removed: drop every queued event.
        this.pending.splice(this.pending.indexOf(e), 1);
        if (e.kind === 'noteOn') this.activeNotes.delete(e.id);
        continue;
      }
      const cell = track!.steps[e.step % length]!;
      if (!cell.enabled || e.channel !== track!.channel || e.pitch !== cell.pitch) {
        // Cell turned off, or moved channel/pitch: the pair is stale.
        this.pending.splice(this.pending.indexOf(e), 1);
        if (e.kind === 'noteOn') this.activeNotes.delete(e.id);
        continue;
      }
      if (e.kind === 'noteOn') {
        e.velocity = cell.velocity;
      } else {
        // Keep the original on-time and planned step duration; only the
        // gate fraction changed.
        const source = this.activeNotes.get(e.pairId);
        if (source) e.time = source.onTime + source.stepDur * cell.gate;
      }
    }

    // --- sounding notes (and queued note-ons whose pair was dropped) ---
    for (const [id, note] of [...this.activeNotes]) {
      if (note.trackId !== trackId || !inScope(note.step)) continue;

      const cell =
        !muted && !removed && length > 0 ? track!.steps[note.step % length] : undefined;
      const sameDestination =
        !!cell &&
        cell.enabled &&
        note.channel === track!.channel &&
        note.pitch === cell.pitch;

      if (!sameDestination) {
        // Silenced, moved to another pitch/channel, or the cell went away:
        // release the sounding wire note immediately (refcount-shared keys
        // keep sibling voices alive). Never-sent voices are just forgotten.
        this.cancelVoice(id, note, now);
        continue;
      }
      if (!note.sounding) {
        // Keep the record when its queued pair survived (e.g. a velocity
        // or gate edit); only drop it for re-materialization below when
        // the note-on itself was discarded.
        const onStillQueued = this.pending.some(
          (e) => e.kind === 'noteOn' && e.id === id
        );
        if (!onStillQueued) this.activeNotes.delete(id);
        continue;
      }
      // Same pitch, still sounding: only a changed gate is audible.
      const newOff = note.onTime + note.stepDur * cell.gate;
      const off = this.pending.find((e) => e.kind === 'noteOff' && e.pairId === id);
      if (newOff <= now) {
        // Gate shortened into the past: drop the stale queued off and
        // close the sounding note at once.
        if (off) this.pending.splice(this.pending.indexOf(off), 1);
        this.cancelVoice(id, note, now);
      } else if (off) {
        off.time = newOff; // the retrigger guard clamps it at the next trigger
      }
    }

    // --- re-materialize planned steps the edit made valid again ---
    // Steps already inside the lookahead window are only visited by ticks
    // on the *next* loop; without this, a quick enable / channel change /
    // unmute would skip a due note. Other tracks and the timeline are
    // untouched — we only plan this track's voices on existing boundaries.
    if (!muted && !removed && track) {
      const stepDur = Math.max(1, this.stepDuration());
      for (const s of this.stepTimes) {
        // Same horizon as a tick: overdue within the catch-up window
        // (a late timer is still allowed to fire), up to the lookahead edge.
        if (s.time > now - this.catchUpMs && s.time <= now + this.lookaheadMs) {
          const cellIndex = s.step % track.steps.length;
          if (scope.cellIndex === undefined || cellIndex === scope.cellIndex) {
            const hasVoice =
              this.pending.some(
                (e) =>
                  e.kind === 'noteOn' && e.trackId === trackId && e.step === s.step
              ) ||
              [...this.activeNotes.values()].some(
                (n) => n.trackId === trackId && n.step === s.step
              );
            if (!hasVoice) this.scheduleTrackStep(track, s.step, s.time, stepDur);
          }
        }
      }
    }
  }

  /**
   * Tear down one voice: remove its queued events, release the wire note
   * if it was sounding, and forget it. Sibling voices on the same
   * (channel, pitch) — possibly from another track — are untouched.
   */
  private cancelVoice(onId: number, note: ActiveNote, now?: number): void {
    this.pending = this.pending.filter((e) => e.pairId !== onId && e.id !== onId);
    if (note.sounding) {
      this.releaseKey(note.channel, note.pitch, onId, this.output, now);
    }
    this.activeNotes.delete(onId);
  }

  private keyOf(channel: number, pitch: number): number {
    return (channel << 8) | pitch;
  }

  /**
   * Record that a sounding voice holds a wire key. A second overlapping
   * note-on is still sent (MIDI restarts the voice), but its id joins the
   * set so the note-off is withheld until every overlapping voice ends.
   */
  private acquireKey(channel: number, pitch: number, voiceId: number): void {
    const key = this.keyOf(channel, pitch);
    let voices = this.heldKeys.get(key);
    if (!voices) {
      voices = new Set<number>();
      this.heldKeys.set(key, voices);
    }
    voices.add(voiceId);
  }

  /**
   * Release one voice on a wire key; the wire note-off goes out only when
   * the last remaining voice releases. Without an output (e.g. the device
   * already gone) the bookkeeping is still kept correct.
   */
  private releaseKey(
    channel: number,
    pitch: number,
    voiceId: number,
    output: MidiOutputAdapter | null,
    timeMs?: number
  ): void {
    const key = this.keyOf(channel, pitch);
    const voices = this.heldKeys.get(key);
    if (!voices) return;
    voices.delete(voiceId);
    if (voices.size === 0) {
      if (output) output.send(noteOff(channel, pitch), timeMs);
      this.heldKeys.delete(key);
    }
  }

  /** Re-schedule the lookahead window starting at the last reached boundary. */
  private rewindToLastBoundary(): void {
    this.stepIndex = this.lastBoundary.step + 1;
    this.nextStepTime = Math.max(
      this.clock.now(),
      this.lastBoundary.time + this.stepDuration()
    );
  }
}

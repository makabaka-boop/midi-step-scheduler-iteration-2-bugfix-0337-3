/**
 * Application controller: owns the Svelte stores and wires them to the
 * scheduler, the MIDI device manager and the single-track recording
 * session.
 *
 * The controller is framework-thin on purpose — all timing/queueing
 * policy lives in the Scheduler, all MIDI policy in MidiDeviceManager,
 * all record/quantize adjudication in RecordingSession — so it can be
 * driven from a Svelte page, a unit test, or jsdom without real MIDI
 * hardware.
 *
 * The recording session is the single source of truth shared by the
 * input adapter, beat mapping (the scheduler) and the Svelte stores:
 * while armed it keeps a private draft and never touches the playing
 * pattern; confirm commits one batch, and cancel / stop / input loss /
 * revoked authorization discards the draft and its hanging notes.
 */

import { derived, get, writable, type Readable } from 'svelte/store';
import { BrowserClock, type Clock } from './sequencer/clock';
import {
  MidiDeviceManager,
  createBrowserDeviceManager,
  type MidiDeviceInfo,
  type MidiStatus
} from './sequencer/devices';
import type { MidiInputAdapter } from './sequencer/input';
import { parseNoteMessage } from './sequencer/midi';
import { RecordingSession, type RecordingSnapshot } from './sequencer/recorder';
import { Scheduler, type TransportState } from './sequencer/scheduler';
import {
  MAX_TRACKS,
  MIN_TRACKS,
  clampInt,
  createPattern,
  createTrack,
  resizeTrack,
  type Pattern,
  type Step
} from './sequencer/types';

export const MIN_BPM = 20;
export const MAX_BPM = 300;

const IDLE_RECORDING: RecordingSnapshot = {
  armed: false,
  trackId: null,
  channel: 0,
  length: 0,
  pass: 0,
  cells: [],
  verdicts: []
};

export interface StepSelection {
  trackId: string;
  index: number;
}

export interface ControllerOptions {
  clock?: Clock;
  deviceManager?: MidiDeviceManager;
  pattern?: Pattern;
}

export class SequencerController {
  // --- stores (view state) ---
  readonly pattern = writable<Pattern>();
  readonly tempo = writable<number>(120);
  readonly transport = writable<TransportState>('stopped');
  readonly midiStatus = writable<MidiStatus>('unknown');
  readonly outputs = writable<MidiDeviceInfo[]>([]);
  readonly inputs = writable<MidiDeviceInfo[]>([]);
  readonly selectedOutputId = writable<string | null>(null);
  readonly selectedInputId = writable<string | null>(null);
  readonly currentStep = writable<number>(-1);
  readonly notice = writable<string | null>(null);
  readonly selection = writable<StepSelection | null>(null);
  /** Live recording draft / verdict snapshot (idle snapshot when not armed). */
  readonly recording = writable<RecordingSnapshot>(IDLE_RECORDING);

  readonly scheduler: Scheduler;
  readonly devices: MidiDeviceManager;
  readonly session: RecordingSession;

  private clock: Clock;
  private input: MidiInputAdapter | null = null;
  private unsubscribeInput: (() => void) | null = null;

  constructor(options: ControllerOptions = {}) {
    this.pattern.set(options.pattern ?? createPattern(4, 16));

    this.clock = options.clock ?? new BrowserClock();
    this.devices = options.deviceManager ?? createBrowserDeviceManager();
    this.devices.setEvents({
      onDevicesChanged: (outputs) => this.onDevicesChanged(outputs),
      onOutputDisconnected: (id) => this.onOutputDisconnected(id),
      onInputsChanged: (inputs) => this.onInputsChanged(inputs),
      onInputDisconnected: (id) => this.onInputDisconnected(id)
    });

    this.scheduler = new Scheduler({
      clock: this.clock,
      getPattern: () => get(this.pattern),
      getTempo: () => get(this.tempo),
      onStep: (step) => {
        this.currentStep.set(step);
        this.session.updatePlayhead(step);
      },
      onStateChange: (state) => {
        this.transport.set(state);
        if (state === 'stopped') this.currentStep.set(-1);
        // Leaving playback (stop/pause) invalidates a take that was being
        // played along to: discard the unconfirmed draft and every hanging
        // note rather than pretending it still lines up with the timeline.
        if (state !== 'playing' && this.session.isArmed) {
          this.discardRecording('已停止播放，未确认的录音草稿已丢弃。');
        }
      }
    });

    // The session reads the scheduler's beat timeline; both only interact
    // once a take is armed (callbacks above run after construction).
    this.session = new RecordingSession(this.scheduler);
    this.session.subscribe((snapshot) => this.recording.set(snapshot));
  }

  /** Request MIDI access. Safe to call from onMount; never throws. */
  async init(): Promise<void> {
    const status = await this.devices.request();
    this.midiStatus.set(status);
    if (status === 'ready') {
      this.outputs.set(this.devices.outputs);
      this.inputs.set(this.devices.inputs);
      this.autoSelectOutput();
      this.autoSelectInput();
    } else if (status === 'unsupported') {
      this.notice.set('此浏览器不支持 Web MIDI——可以编辑乐谱，但无法播放。');
    } else if (status === 'denied') {
      this.notice.set('Web MIDI 授权被拒绝——可以编辑乐谱，但无法播放。');
    }
  }

  // --- transport ---

  play(): void {
    if (!this.scheduler.play()) {
      this.notice.set('没有可用的 MIDI 输出设备——可以编辑乐谱，但无法播放。');
    }
  }

  pause(): void {
    this.scheduler.pause();
  }

  stop(): void {
    this.scheduler.stop();
  }

  setTempo(bpm: number): void {
    const clamped = clampInt(bpm, MIN_BPM, MAX_BPM);
    this.tempo.set(clamped);
    this.scheduler.tempoChanged();
  }

  // --- output selection ---

  selectOutput(id: string | null): void {
    if (id === null) {
      // Dropping the output mid-play must not silently "play" nowhere.
      this.scheduler.setOutput(null);
      this.scheduler.stop();
      this.selectedOutputId.set(null);
      return;
    }
    const adapter = this.devices.adapterFor(id, () => this.clock.now());
    if (!adapter) {
      this.notice.set('所选输出设备不可用。');
      return;
    }
    this.scheduler.setOutput(adapter);
    this.selectedOutputId.set(id);
    this.notice.set(null);
  }

  // --- input selection ---

  selectInput(id: string | null): void {
    // A take in flight keeps its device: swapping underneath it would
    // orphan its open notes and split one performance across adapters.
    if (this.session.isArmed) return;
    if (id === null) {
      this.releaseInput();
      this.selectedInputId.set(null);
      return;
    }
    const adapter = this.devices.inputAdapterFor(id);
    if (!adapter) {
      this.notice.set('所选输入设备不可用。');
      return;
    }
    this.attachInput(adapter);
    this.selectedInputId.set(id);
  }

  // --- record: arm / confirm / cancel ---

  /**
   * Arm a pending-confirmation take on one track. Recording is only
   * meaningful while playing along the beat, with an input device; the
   * track's own channel is the one the session listens on.
   */
  armRecording(trackId: string): void {
    if (this.session.isArmed) return;
    if (get(this.transport) !== 'playing') {
      this.notice.set('请先播放，再启用录制——录音按当前节拍轴量化。');
      return;
    }
    const track = get(this.pattern).tracks.find((t) => t.id === trackId);
    if (!track) return;
    if (!this.input) {
      this.notice.set('没有可用的 MIDI 输入设备——无法录制，但编辑和播放不受影响。');
      return;
    }
    this.session.arm(trackId, track.channel, track.steps.length);
    this.notice.set(null);
  }

  /** Commit this take's complete cells once, then let the scheduler reconcile. */
  confirmRecording(): void {
    if (!this.session.isArmed) return;
    const { commit, dropped } = this.session.confirm();
    if (!commit) {
      this.notice.set(
        dropped > 0
          ? `${dropped} 个仍在悬挂的音符不完整，没有可提交的步格——草稿已丢弃。`
          : '没有可提交的完整音符——草稿已丢弃。'
      );
      return;
    }
    this.pattern.update((p) => {
      const track = p.tracks.find((t) => t.id === commit.trackId);
      if (track) {
        for (const c of commit.cells) {
          const step = track.steps[c.cell];
          if (step) {
            step.enabled = c.step.enabled;
            step.pitch = clampInt(c.step.pitch, 0, 127);
            step.velocity = clampInt(c.step.velocity, 1, 127);
            step.gate = c.step.gate;
          }
        }
      }
      return p;
    });
    // One reconciliation batch for the whole take; the scheduler applies
    // it deterministically (ascending cells) without moving the timeline.
    this.scheduler.stepsCommitted(
      commit.trackId,
      commit.cells.map((c) => c.cell)
    );
    this.notice.set(
      dropped > 0
        ? `已提交 ${commit.cells.length} 个步格；${dropped} 个仍在悬挂的音符未提交。`
        : `已提交 ${commit.cells.length} 个步格。`
    );
  }

  /** Explicitly discard the take. */
  cancelRecording(): void {
    if (!this.session.isArmed) return;
    this.discardRecording('已取消录制，未确认的草稿已丢弃。');
  }

  // --- score editing (always available, MIDI or not) ---

  toggleStep(trackId: string, index: number): void {
    this.pattern.update((p) => {
      const track = p.tracks.find((t) => t.id === trackId);
      const step = track?.steps[index];
      if (track && step) {
        step.enabled = !step.enabled;
        this.selection.set({ trackId, index });
      }
      return p;
    });
    // A toggle must take effect immediately: cancel a note already queued
    // for a turned-off step, or make a turned-on step fire if it is due
    // inside the current lookahead window.
    this.scheduler.stepEdited(trackId, index);
  }

  updateStep(trackId: string, index: number, patch: Partial<Omit<Step, 'enabled'>>): void {
    this.pattern.update((p) => {
      const step = p.tracks.find((t) => t.id === trackId)?.steps[index];
      if (step) {
        if (patch.pitch !== undefined) step.pitch = clampInt(patch.pitch, 0, 127);
        if (patch.velocity !== undefined) step.velocity = clampInt(patch.velocity, 1, 127);
        if (patch.gate !== undefined) {
          step.gate = Math.max(0.05, Math.min(1, patch.gate));
        }
      }
      return p;
    });
    // Apply pitch / velocity / gate changes to queued and sounding notes,
    // not only to steps scheduled after the edit.
    this.scheduler.stepEdited(trackId, index);
  }

  selectStep(trackId: string, index: number): void {
    this.selection.set({ trackId, index });
  }

  addTrack(): void {
    let added: string | null = null;
    this.pattern.update((p) => {
      if (p.tracks.length >= MAX_TRACKS) return p;
      const length = p.tracks[0]?.steps.length ?? 16;
      const track = createTrack(length);
      added = track.id;
      p.tracks.push(track);
      return p;
    });
    // Let the new track join the pattern immediately if it owns a due cell.
    if (added) this.scheduler.trackEdited(added);
  }

  removeTrack(trackId: string): void {
    // Removing the track a take is aimed at makes the draft meaningless.
    if (this.session.armedTrack === trackId) {
      this.discardRecording('录制目标音轨已删除，未确认的草稿已丢弃。');
    }
    this.pattern.update((p) => {
      if (p.tracks.length <= MIN_TRACKS) return p;
      p.tracks = p.tracks.filter((t) => t.id !== trackId);
      const sel = get(this.selection);
      if (sel && sel.trackId === trackId) this.selection.set(null);
      return p;
    });
    // Cancel everything the removed track had queued or sounding.
    this.scheduler.trackEdited(trackId, true);
  }

  setTrackLength(trackId: string, length: number): void {
    this.pattern.update((p) => {
      const track = p.tracks.find((t) => t.id === trackId);
      if (track) resizeTrack(track, length);
      return p;
    });
    // Voices from cells the shortened track no longer owns must be
    // cancelled at once; surviving cells keep their scheduled voices.
    this.scheduler.trackEdited(trackId);
  }

  setTrackChannel(trackId: string, channel: number): void {
    this.pattern.update((p) => {
      const track = p.tracks.find((t) => t.id === trackId);
      if (track) track.channel = clampInt(channel, 0, 15);
      return p;
    });
    // Release notes on the old channel; due steps go out on the new one.
    this.scheduler.trackEdited(trackId);
  }

  toggleMute(trackId: string): void {
    this.pattern.update((p) => {
      const track = p.tracks.find((t) => t.id === trackId);
      if (track) track.muted = !track.muted;
      return p;
    });
    // Muting drops that track's queue and silences its notes; unmuting
    // lets due steps rejoin without restarting or moving the timeline.
    this.scheduler.trackEdited(trackId);
  }

  // --- device events ---

  private onDevicesChanged(outputs: MidiDeviceInfo[]): void {
    this.outputs.set(outputs);
    this.autoSelectOutput();
  }

  private onInputsChanged(inputs: MidiDeviceInfo[]): void {
    this.inputs.set(inputs);
    this.autoSelectInput();
  }

  private onOutputDisconnected(id: string): void {
    if (get(this.selectedOutputId) !== id) return;
    // The device we are playing through vanished: cut every note we
    // started, drop the queue and stop — never leave notes hanging.
    this.scheduler.setOutput(null);
    this.scheduler.stop();
    this.selectedOutputId.set(null);
    this.notice.set('MIDI 输出设备已断开，播放已停止。');
  }

  private onInputDisconnected(id: string): void {
    if (get(this.selectedInputId) !== id) return;
    // The recording device vanished mid-take: discard the draft and clean
    // up every hanging note; playback itself is unaffected (output stays).
    if (this.session.isArmed) {
      this.discardRecording('MIDI 输入设备已断开，未确认的录音草稿已丢弃。');
    }
    this.releaseInput();
    this.selectedInputId.set(null);
    // A replacement keyboard, if present, becomes the default for next time.
    this.autoSelectInput();
  }

  private autoSelectOutput(): void {
    const current = get(this.selectedOutputId);
    const outputs = get(this.outputs);
    const stillThere = outputs.some((o) => o.id === current && o.connected);
    if (stillThere) return;
    const first = outputs.find((o) => o.connected);
    if (first) {
      const adapter = this.devices.adapterFor(first.id, () => this.clock.now());
      if (adapter) {
        this.scheduler.setOutput(adapter);
        this.selectedOutputId.set(first.id);
      }
    } else if (current !== null) {
      this.scheduler.setOutput(null);
      this.selectedOutputId.set(null);
    }
  }

  private autoSelectInput(): void {
    // Never re-bind under a live take; its adapter must stay stable.
    if (this.session.isArmed) return;
    const current = get(this.selectedInputId);
    const inputs = get(this.inputs);
    const stillThere = inputs.some((i) => i.id === current && i.connected);
    if (stillThere) return;
    const first = inputs.find((i) => i.connected);
    if (first) {
      const adapter = this.devices.inputAdapterFor(first.id);
      if (adapter) {
        this.attachInput(adapter);
        this.selectedInputId.set(first.id);
      }
    } else if (current !== null) {
      this.releaseInput();
      this.selectedInputId.set(null);
    }
  }

  // --- input plumbing ---

  private attachInput(adapter: MidiInputAdapter): void {
    this.releaseInput();
    this.input = adapter;
    this.unsubscribeInput = adapter.onMessage((data, timeMs) => {
      this.handleInputMessage(data, timeMs);
    });
  }

  private releaseInput(): void {
    this.unsubscribeInput?.();
    this.unsubscribeInput = null;
    this.input?.close();
    this.input = null;
  }

  private handleInputMessage(data: number[], timeMs: number | undefined): void {
    const parsed = parseNoteMessage(data);
    if (!parsed) return;
    // Outside playback a take cannot be armed; silently ignore so a
    // keyboard can sit plugged in while editing the score.
    if (get(this.transport) !== 'playing' || !this.session.isArmed) return;
    const time = typeof timeMs === 'number' ? timeMs : this.clock.now();
    if (parsed.kind === 'on') {
      this.session.noteOn(parsed.channel, parsed.pitch, parsed.velocity, time);
    } else {
      this.session.noteOff(parsed.channel, parsed.pitch, time, parsed.zeroVelocity);
    }
  }

  private discardRecording(message: string): void {
    this.session.cancel();
    this.notice.set(message);
  }
}

export function selectedStep(
  pattern: Readable<Pattern>,
  selection: Readable<StepSelection | null>
): Readable<{ trackId: string; index: number; step: Step } | null> {
  return derived([pattern, selection], ([p, s]) => {
    if (!s) return null;
    const track = p.tracks.find((t) => t.id === s.trackId);
    const step = track?.steps[s.index];
    return step ? { trackId: s.trackId, index: s.index, step } : null;
  });
}

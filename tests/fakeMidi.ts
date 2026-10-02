/**
 * Fake Web MIDI environment for tests: no real hardware involved.
 * Devices can be plugged and unplugged at will, and input messages can
 * be injected with an explicit timestamp against a ManualClock beat.
 */
export class FakeMidiOutput {
  readonly sent: number[][] = [];
  /** Every send, in wire order, with the adapter-provided timestamp. */
  readonly logged: { message: number[]; timeMs?: number }[] = [];
  readonly type = 'output';
  connection = 'open';

  constructor(
    readonly id: string,
    readonly name: string,
    public state: 'connected' | 'disconnected' = 'connected'
  ) {}

  send(data: number[], timeMs?: number): void {
    if (this.state !== 'connected') {
      throw new Error('send on disconnected port');
    }
    this.sent.push([...data]);
    this.logged.push({ message: [...data], timeMs });
  }
}

export class FakeMidiInput {
  readonly type = 'input';
  connection = 'open';
  onmidimessage: ((event: { data: number[]; timeStamp: number }) => void) | null = null;

  constructor(
    readonly id: string,
    readonly name: string,
    public state: 'connected' | 'disconnected' = 'connected'
  ) {}

  /** Inject one raw MIDI message as if the keyboard had sent it. */
  emit(data: number[], timeStamp: number): void {
    this.onmidimessage?.({ data: [...data], timeStamp });
  }
}

export class FakeMidiAccess {
  readonly outputs = new Map<string, FakeMidiOutput>();
  readonly inputs = new Map<string, FakeMidiInput>();
  onstatechange: ((event: { port: FakeMidiOutput | FakeMidiInput }) => void) | null = null;

  plugOutput(id: string, name: string): FakeMidiOutput {
    const existing = this.outputs.get(id);
    if (existing) {
      existing.state = 'connected';
      this.onstatechange?.({ port: existing });
      return existing;
    }
    const port = new FakeMidiOutput(id, name);
    this.outputs.set(id, port);
    this.onstatechange?.({ port });
    return port;
  }

  plugInput(id: string, name: string): FakeMidiInput {
    const existing = this.inputs.get(id);
    if (existing) {
      existing.state = 'connected';
      this.onstatechange?.({ port: existing });
      return existing;
    }
    const port = new FakeMidiInput(id, name);
    this.inputs.set(id, port);
    this.onstatechange?.({ port });
    return port;
  }

  /** Back-compat alias for output-only test setups. */
  plug(id: string, name: string): FakeMidiOutput {
    return this.plugOutput(id, name);
  }

  unplug(id: string): void {
    const out = this.outputs.get(id);
    if (out) {
      out.state = 'disconnected';
      this.onstatechange?.({ port: out });
    }
    const input = this.inputs.get(id);
    if (input) {
      input.state = 'disconnected';
      this.onstatechange?.({ port: input });
    }
  }
}

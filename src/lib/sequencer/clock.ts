/**
 * Replaceable clock abstraction.
 *
 * The scheduler never touches `performance.now()` or `setTimeout` directly,
 * so tests can drive time manually and simulate late callbacks, clock jumps
 * and stop boundaries deterministically.
 */

export type TimerHandle = unknown;

export interface Clock {
  /** Monotonic time in milliseconds. */
  now(): number;
  /** Schedule a one-shot callback; returns an opaque handle. */
  setTimeout(cb: () => void, delayMs: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

/** Production clock backed by performance.now() and window timers. */
export class BrowserClock implements Clock {
  now(): number {
    return performance.now();
  }
  setTimeout(cb: () => void, delayMs: number): TimerHandle {
    return setTimeout(cb, delayMs);
  }
  clearTimeout(handle: TimerHandle): void {
    clearTimeout(handle as number);
  }
}

/**
 * Deterministic test clock. Time only moves when the test says so;
 * timers fire (in due-time order) as time advances.
 */
export class ManualClock implements Clock {
  private current = 0;
  private seq = 0;
  private timers: { id: number; at: number; cb: () => void; cancelled: boolean }[] = [];

  now(): number {
    return this.current;
  }

  setTimeout(cb: () => void, delayMs: number): TimerHandle {
    const id = ++this.seq;
    this.timers.push({ id, at: this.current + Math.max(0, delayMs), cb, cancelled: false });
    return id;
  }

  clearTimeout(handle: TimerHandle): void {
    const t = this.timers.find((t) => t.id === handle);
    if (t) t.cancelled = true;
  }

  /** Advance time, firing any timers that come due along the way. */
  advance(ms: number): void {
    const target = this.current + ms;
    for (;;) {
      const due = this.timers
        .filter((t) => !t.cancelled && t.at <= target)
        .sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      // A timer that comes due while the clock has already jumped ahead
      // fires *late*: the callback observes the real current time, just
      // like a stalled setTimeout in a browser.
      this.current = Math.max(due.at, this.current);
      due.cancelled = true;
      due.cb();
    }
    this.current = target;
  }

  /** Jump time forward without firing timers (simulates a stalled main thread). */
  jump(ms: number): void {
    this.current += ms;
  }

  get pendingTimers(): number {
    return this.timers.filter((t) => !t.cancelled).length;
  }
}

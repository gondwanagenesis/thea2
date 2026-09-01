// M01 kernel — injected clocks. All time in the system flows through Clock;
// nothing outside src/kernel may call Date.now/new Date (ESLint-enforced).

export interface Clock {
  epochMs(): number;
  now(): Date;
  /** Resolves when wall-clock (or simulated) time reaches `t`. Rejects with code 'aborted' if signaled first. */
  waitUntil(t: number, signal?: AbortSignal): Promise<void>;
}

export class SystemClock implements Clock {
  epochMs(): number {
    return Date.now();
  }
  now(): Date {
    return new Date();
  }
  waitUntil(t: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return rejectAbort(reject);
      const arm = (): void => {
        const delay = Math.min(Math.max(t - Date.now(), 0), 2 ** 31 - 1);
        const timer = setTimeout(done, delay);
        signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            rejectAbort(reject);
          },
          { once: true },
        );
      };
      const done = (): void => {
        if (Date.now() < t) arm();
        else resolve();
      };
      arm();
    });
  }
}

const rejectAbort = (reject: (e: unknown) => void): void =>
  reject(Object.assign(new Error('aborted'), { code: 'aborted' }));

interface Waiter {
  due: number;
  seq: number; // registration order — tie-breaker for equal due times
  resolve: () => void;
  reject: (e: unknown) => void;
  signal?: AbortSignal;
}

/**
 * Simulated clock for hermetic tests. Time only moves via advance(), which fires
 * pending waiters in exact due order; equal due times fire in registration order,
 * and each resolution's microtasks drain before the next waiter fires, so scheduled
 * work runs as it would in real time. A waiter aborted while queued rejects with
 * code 'aborted' — never left dangling.
 */
export class TestClock implements Clock {
  private t: number;
  private waiters: Waiter[] = [];
  private seqCounter = 0;

  constructor(startMs = 0) {
    this.t = startMs;
  }

  epochMs(): number {
    return this.t;
  }

  now(): Date {
    return new Date(this.t);
  }

  async advance(ms: number): Promise<void> {
    if (ms < 0) throw new Error('TestClock.advance: negative ms');
    const target = this.t + ms;
    for (;;) {
      // Reject waiters whose signals aborted while queued.
      const aborted = this.waiters.filter((w) => w.signal?.aborted);
      for (const w of aborted) rejectAbort(w.reject);
      this.waiters = this.waiters.filter((w) => !w.signal?.aborted);

      const due = this.waiters.filter((w) => w.due <= target);
      if (due.length === 0) break;
      due.sort((a, b) => a.due - b.due || a.seq - b.seq);
      const next = due[0]!;
      this.waiters = this.waiters.filter((w) => w !== next);
      this.t = next.due;
      next.resolve();
      // Drain microtasks so .then handlers of the resolved waiter run before
      // the next simulated timer fires.
      await Promise.resolve();
      await Promise.resolve();
    }
    this.t = target;
  }

  waitUntil(t: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(Object.assign(new Error('aborted'), { code: 'aborted' }));
    if (t <= this.t) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        due: t,
        seq: this.seqCounter++,
        resolve,
        reject,
        ...(signal !== undefined ? { signal } : {}),
      };
      signal?.addEventListener(
        'abort',
        () => {
          this.waiters = this.waiters.filter((w) => w !== waiter);
          rejectAbort(reject);
        },
        { once: true },
      );
      this.waiters.push(waiter);
    });
  }
}

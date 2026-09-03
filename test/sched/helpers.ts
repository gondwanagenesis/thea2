// M16 sched — test helpers. Everything hermetic: TestClock + seeded rng + a real
// EventLog over a tmp dir (fs is fine; network and wall clock are not).

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TestClock } from '../../src/kernel/clock.js';
import { makeRng } from '../../src/kernel/rng.js';
import { openEventLog, type EventEnvelope, type EventLog } from '../../src/events/index.js';
import { startScheduler, type Job, type SchedulerHandle } from '../../src/sched/index.js';

export const MIN = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;
export const WEEK = 7 * DAY;

export const tmpDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'thea2-sched-'));

/** Tue 2026-09-01T00:00:00Z — the simulated-week anchor. */
export const T0 = Date.UTC(2026, 8, 1, 0, 0, 0);

export interface Fired {
  /** Exact fire instant — payload `due + lateMs`, stamped synchronously at dispatch. */
  at: number;
  job: string;
  due: number;
  lateMs: number;
  catchUp: boolean;
}

interface FirePayload {
  job: string;
  due: number;
  lateMs: number;
  catchUp?: boolean;
}

/** Real event log over tmp; flush() guarantees every queued sched.* emit is durable before assertions. */
export class SchedHarness {
  readonly dir: string;
  readonly clock: TestClock;
  readonly events: EventLog;
  private readonly rngSeed: string;

  constructor(startMs: number = T0, rngSeed = 'sched-test') {
    this.dir = tmpDir();
    this.clock = new TestClock(startMs);
    this.rngSeed = rngSeed;
    this.events = openEventLog(path.join(this.dir, 'events'), { clock: this.clock });
  }

  statePath(): string {
    return path.join(this.dir, 'sched-state.json');
  }

  start(jobs: Job[], opts?: { interactiveMutex?: () => boolean; statePath?: string }): SchedulerHandle {
    return startScheduler(jobs, {
      clock: this.clock,
      rng: makeRng(this.rngSeed),
      events: this.events,
      statePath: opts?.statePath ?? this.statePath(),
      ...(opts?.interactiveMutex !== undefined ? { interactiveMutex: opts.interactiveMutex } : {}),
    });
  }

  /** Drains the log's emit chain, then returns envelopes of the given kinds in append order. */
  async of(...kinds: string[]): Promise<EventEnvelope[]> {
    await this.events.emit('test.flush', {});
    const out: EventEnvelope[] = [];
    for await (const ev of this.events.replay({ kinds })) out.push(ev);
    return out;
  }

  /**
   * Fires in dispatch order. Uses payload times, not envelope ts: the event log
   * stamps envelopes when the queued emit executes (after real-fs lag), while
   * `due`/`lateMs` are stamped synchronously at the dispatch instant.
   */
  async fires(): Promise<Fired[]> {
    const rows = await this.of('sched.fire');
    return rows.map((ev) => {
      const p = ev.payload as FirePayload;
      return { at: p.due + p.lateMs, job: p.job, due: p.due, lateMs: p.lateMs, catchUp: p.catchUp === true };
    });
  }

  /** Fire instants of one job, in order. */
  async timesOf(job: string): Promise<number[]> {
    return (await this.fires()).filter((f) => f.job === job).map((f) => f.at);
  }

  /**
   * Drains the log's emit chain (a sentinel emit joined after everything
   * already queued), then removes the tmp dir — otherwise fire-and-forget
   * sched.* emits land in a deleted directory and cry to stderr.
   */
  async cleanup(): Promise<void> {
    try {
      await this.events.emit('test.flush', {});
    } catch {
      /* the log is already unusable; removal proceeds regardless */
    }
    fs.rmSync(this.dir, { recursive: true, force: true });
  }
}

/** A real-event-loop settle (test-only; src is Clock-gated): lets an fs append
 * chain that raced an assertion land before the log is read. */
export const realSettle = (ms = 25): Promise<void> => new Promise((r) => setTimeout(r, ms));


// --- job factories ---------------------------------------------------------

type JobOverrides = Partial<Pick<Job, 'name' | 'cadence' | 'lane' | 'catchUp' | 'timeoutMs' | 'run'>>;

export const makeJob = (over: JobOverrides = {}): Job => ({
  name: 'job',
  cadence: { kind: 'every', ms: 10 * MIN },
  lane: 'maintenance',
  catchUp: 'skip',
  timeoutMs: 5 * MIN,
  run: async () => undefined,
  ...over,
});

/**
 * The simulated-week job set: all three cadence kinds, both lanes, both catch-up
 * policies, one jittered job. The golden-week fixture and the week tests all run
 * exactly this table so the committed sequence pins real behavior.
 */
export const weekJobs = (): Job[] => [
  makeJob({
    name: 'heartbeat',
    cadence: { kind: 'every', ms: 30 * MIN, jitterPct: 10 },
    lane: 'interactive',
    catchUp: 'skip',
    timeoutMs: 5 * MIN,
  }),
  makeJob({ name: 'affect-snapshot', cadence: { kind: 'every', ms: 6 * HOUR }, lane: 'maintenance' }),
  makeJob({ name: 'reflect', cadence: { kind: 'daily', utcMinute: 180 }, lane: 'maintenance', catchUp: 'once' }),
  makeJob({ name: 'ledger-report', cadence: { kind: 'daily', utcMinute: 270 }, lane: 'maintenance', catchUp: 'once' }),
  makeJob({ name: 'derive-check', cadence: { kind: 'weekly', dow: 5, utcMinute: 240 }, lane: 'maintenance', catchUp: 'once' }),
];

/** Boots the week table on a harness, advances one simulated week, stops, returns the fire sequence. */
export const runWeek = async (h: SchedHarness): Promise<Fired[]> => {
  const handle = h.start(weekJobs());
  await handle.ready();
  await h.clock.advance(WEEK);
  await handle.stop();
  return h.fires();
};

/** A job body that blocks until the test releases it — for lane/concurrency/wedge tests. */
export interface Gate {
  release(): void;
  released: boolean;
}

export const gatedJob = (name: string, over: JobOverrides = {}): { job: Job; gates: Gate[] } => {
  const gates: Gate[] = [];
  const job = makeJob({
    name,
    run: async () => {
      await new Promise<void>((resolve) => {
        const gate: Gate = {
          release: () => {
            gate.released = true;
            resolve();
          },
          released: false,
        };
        gates.push(gate);
      });
    },
    ...over,
  });
  return { job, gates };
};

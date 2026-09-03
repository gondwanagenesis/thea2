// The isolation gate: one job's failure — throw, timeout or wedge — must never
// block, delay or kill another job, and every failure must be observable as an
// event with a typed error path. Also the lane/concurrency laws and the
// interactive-mutex skip.

import { describe, expect, it, afterEach } from 'vitest';
import * as fs from 'node:fs';
import type { Job, JobCtx } from '../../src/sched/index.js';
import { realSettle,  HOUR, MIN, SchedHarness, T0, makeJob } from './helpers.js';

let harness: SchedHarness | undefined;
afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
});

interface FailPayload {
  job: string;
  consecutiveFailures: number;
  wedged?: boolean;
  error: { code?: string; message: string };
}
interface WedgedPayload {
  job: string;
  timeoutMs: number;
  due: number;
}
interface SkippedPayload {
  job: string;
  due: number;
  reason: string;
}

const readState = async (h: SchedHarness): Promise<Record<string, { lastCompleted?: number; lastAttempt?: number; consecutiveFailures: number }>> => {
  const raw = JSON.parse(await fs.promises.readFile(h.statePath(), 'utf8')) as {
    jobs: Record<string, { lastCompleted?: number; lastAttempt?: number; consecutiveFailures: number }>;
  };
  return raw.jobs;
};

describe('throwing-job isolation', () => {
  it('a chronically throwing job fails alone: its sibling keeps the exact schedule, failures back off x2 then x4, and the alarm raises on the third consecutive failure', async () => {
    harness = new SchedHarness();
    // Different lanes so the two never contend: any sibling delay here would be
    // a scheduling bug, not a lane artifact.
    const thrower = makeJob({
      name: 'thrower',
      cadence: { kind: 'every', ms: 10 * MIN },
      lane: 'maintenance',
      run: async () => {
        throw new Error('boom');
      },
    });
    const healthy = makeJob({ name: 'healthy', cadence: { kind: 'every', ms: 10 * MIN }, lane: 'interactive' });
    const handle = harness.start([thrower, healthy]);
    await handle.ready();
    await harness.clock.advance(2 * HOUR);
    await handle.stop(); // resolves — the scheduler survives its worst job

    // The sibling never noticed: exact grid, never late.
    expect(await harness.timesOf('healthy')).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((n) => T0 + n * 10 * MIN));

    // The thrower's ladder: 10min, x2 -> 30min, x4 -> 70min, 110min.
    expect(await harness.timesOf('thrower')).toEqual([10, 30, 70, 110].map((n) => T0 + n * MIN));

    const fails = (await harness.of('sched.fail')).map((ev) => ev.payload as FailPayload);
    expect(fails.map((f) => f.job)).toEqual(['thrower', 'thrower', 'thrower', 'thrower']);
    expect(fails.map((f) => f.consecutiveFailures)).toEqual([1, 2, 3, 4]);
    expect(fails[0]!.error.message).toBe('boom');
    expect(fails.some((f) => f.wedged)).toBe(false);

    // Alarm exactly from the third consecutive failure onward.
    const alarms = (await harness.of('sched.alarm')).map((ev) => ev.payload as FailPayload);
    expect(alarms.map((a) => a.consecutiveFailures)).toEqual([3, 4]);

    // Both trajectories are readable from the persisted state.
    const state = await readState(harness);
    expect(state['thrower']?.consecutiveFailures).toBe(4);
    expect(state['thrower']?.lastCompleted).toBeUndefined();
    expect(state['healthy']?.consecutiveFailures).toBe(0);
  });

  it('a synchronous throw is isolated exactly like a rejected async body', async () => {
    harness = new SchedHarness();
    const syncThrow = (): never => {
      throw new Error('sync boom');
    };
    const job = makeJob({
      name: 'sync',
      cadence: { kind: 'every', ms: 10 * MIN },
      // Deliberately not async: the scheduler must turn a throw thrown the instant
      // run() is invoked into the same failure path as a rejected promise.
      run: syncThrow as unknown as Job['run'],
    });
    const handle = harness.start([job]);
    await handle.ready();
    await harness.clock.advance(10 * MIN);
    await handle.stop();

    const fails = (await harness.of('sched.fail')).map((ev) => ev.payload as FailPayload);
    expect(fails).toHaveLength(1);
    expect(fails[0]!.error.message).toBe('sync boom');
    expect(fails[0]!.consecutiveFailures).toBe(1);
  });
});

describe('timeout isolation', () => {
  it('a job that honors the cooperative cancel is a timeout failure, never a wedge, and may run again', async () => {
    harness = new SchedHarness();
    let calls = 0;
    const slow = makeJob({
      name: 'slow',
      cadence: { kind: 'every', ms: 10 * MIN },
      timeoutMs: 1_000, // 1 simulated second — the pin makes short spans exact
      run: async (ctx: JobCtx) => {
        calls += 1;
        if (calls === 1) {
          try {
            await ctx.clock.waitUntil(T0 + 10 * HOUR, ctx.signal); // far past the deadline
          } catch {
            /* cancelled cooperatively — the documented way out */
          }
        }
        // Second run: healthy again.
      },
    });
    const handle = harness.start([slow]);
    await handle.ready();
    await harness.clock.advance(10 * MIN + 1_000); // through deadline + cancel
    await harness.clock.advance(20 * MIN); // to the backed-off next slot

    const fails = (await harness.of('sched.fail')).map((ev) => ev.payload as FailPayload);
    expect(fails).toHaveLength(1);
    expect(fails[0]!.error.code).toBe('sched/timeout');
    expect(fails[0]!.wedged).toBeUndefined();
    expect(await harness.of('sched.wedged')).toEqual([]);

    // x2 backoff, then a clean success resets the failure count.
    expect(await harness.timesOf('slow')).toEqual([T0 + 10 * MIN, T0 + 30 * MIN]);
    const completes = (await harness.of('sched.complete')).map((ev) => ev.payload as { job: string });
    expect(completes.map((c) => c.job)).toEqual(['slow']);
    await handle.stop(); // drains the persist chain before the state is read
    const state = await readState(harness);
    expect(state['slow']?.consecutiveFailures).toBe(0);
    expect(state['slow']?.lastCompleted).toBe(T0 + 30 * MIN);
  });

  it('a job that ignores the abort is wedged: abandoned, flagged, and locked out until restart', async () => {
    harness = new SchedHarness();
    const stuck = makeJob({
      name: 'stuck',
      cadence: { kind: 'every', ms: 10 * MIN },
      timeoutMs: 1_000,
      run: (ctx: JobCtx) =>
        // Never settles and never reacts to the signal — the wedge case.
        new Promise<void>(() => {
          ctx.signal.addEventListener('abort', () => undefined);
        }),
    });
    const first = harness.start([stuck]);
    await first.ready();
    await harness.clock.advance(10 * MIN + 2_000); // deadline + full grace window
    // The wedged emit's fs append races this assertion under load: let the
    // real-event-loop chain (advance's microtasks -> emit -> log append) land
    // before reading the log. Same device as test/app/helpers settle().
    await realSettle(25);

    const wedged = (await harness.of('sched.wedged')).map((ev) => ev.payload as WedgedPayload);
    expect(wedged).toEqual([{ job: 'stuck', timeoutMs: 1_000, due: T0 + 10 * MIN }]);
    const fails = (await harness.of('sched.fail')).map((ev) => ev.payload as FailPayload);
    expect(fails[0]!.wedged).toBe(true);
    expect(first.runningJobs()).toEqual([]); // abandoned, not blocking the process

    // The singleton lock: no re-entry for the life of this scheduler.
    await harness.clock.advance(3 * HOUR);
    expect(await harness.timesOf('stuck')).toEqual([T0 + 10 * MIN]);
    await first.stop();

    // The wedge is in-memory only: the state records an attempt, not a lock, so
    // a restart (the recovery path) runs the job again.
    const state = await readState(harness);
    expect(state['stuck']?.lastAttempt).toBe(T0 + 10 * MIN);
    expect(state['stuck']?.lastCompleted).toBeUndefined();

    const second = harness.start([stuck]);
    await second.ready();
    await harness.clock.advance(2 * HOUR); // past the restarted backoff plan
    const fired = await harness.timesOf('stuck');
    expect(fired.length).toBe(2); // the pre-restart fire, plus one fresh re-entry
    expect(fired[1]).toBeGreaterThan(T0 + 10 * MIN);
    await second.stop();
  });
});

describe('lanes and the global cap', () => {
  it('maintenance never overlaps itself, interactive overlaps maintenance, and no more than two jobs ever run', async () => {
    harness = new SchedHarness();
    const laneLive = { maintenance: 0, interactive: 0 };
    const maxLane = { maintenance: 0, interactive: 0 };
    let maxTotal = 0;
    const track = (lane: Job['lane'], body: Job['run']): Job['run'] => async (ctx: JobCtx) => {
      laneLive[lane] += 1;
      maxLane[lane] = Math.max(maxLane[lane], laneLive[lane]);
      maxTotal = Math.max(maxTotal, laneLive.maintenance + laneLive.interactive);
      try {
        await body(ctx);
      } finally {
        laneLive[lane] -= 1;
      }
    };

    // Dues staggered 1ms apart so the whole gated span is milliseconds of
    // simulated time (the 1ms pin makes that exact without wall timers). Each
    // body holds only its FIRST run — later runs settle instantly, so the
    // 20-minute slots stay exact.
    const gates: Array<() => void> = [];
    const holdFirstRun = (): Job['run'] => {
      let runs = 0;
      return async () => {
        runs += 1;
        if (runs === 1) await new Promise<void>((resolve) => gates.push(resolve));
      };
    };
    const job = (name: string, lane: Job['lane'], ms: number): Job => ({
      ...makeJob({ name, lane, cadence: { kind: 'every', ms } }),
      // A hold must outlive the job's timeout or the scheduler will (correctly)
      // time the run out mid-gate — so the timeout is far beyond any hold here.
      timeoutMs: 30 * MIN,
      run: track(lane, holdFirstRun()),
    });
    const jobs = [job('mA', 'maintenance', 600_000), job('iB', 'interactive', 600_001), job('mC', 'maintenance', 600_002)];

    const handle = harness.start(jobs);
    await handle.ready();
    await harness.clock.advance(10 * MIN + 5); // all three dues pass; mA and iB hold their gates
    expect(handle.runningJobs().sort()).toEqual(['iB', 'mA']); // interactive ran *through* maintenance
    expect((await harness.of('sched.fire')).length).toBe(2); // mC never fired: its lane is busy

    // Releasing a gate settles the body in pure microtasks; drain those directly
    // (an advance is a unreliable pump here — when the only candidate is
    // lane-deferred the scheduler arms no waiter, so advance has nothing to drain).
    const drain = async (): Promise<void> => {
      for (let i = 0; i < 20; i += 1) await Promise.resolve();
    };

    gates[0]?.(); // release mA
    await drain();
    expect(handle.runningJobs().sort()).toEqual(['iB', 'mC']); // mC took the freed maintenance lane

    gates[1]?.(); // release iB
    gates[2]?.(); // release mC
    await drain();
    expect(handle.runningJobs()).toEqual([]);

    // mC was deferred, not skipped: it fired only after the lane freed, and its
    // chain stayed slot-anchored (next slot at due + period, no burst, no drift).
    const cFires = await harness.timesOf('mC');
    expect(cFires[0]).toBeGreaterThan(T0 + 10 * MIN + 2);
    await harness.clock.advance(10 * MIN + 60_002); // to the 20-minute slots
    expect(await harness.timesOf('mA')).toEqual([T0 + 10 * MIN, T0 + 20 * MIN]);
    expect(await harness.timesOf('iB')).toEqual([T0 + 600_001, T0 + 600_001 + 600_001]); // slot-anchored chain
    expect(await harness.timesOf('mC')).toEqual([cFires[0]!, T0 + 600_002 + 600_002]); // slot2 = slot1 + period

    expect(maxLane.maintenance).toBe(1); // serial within the lane
    expect(maxLane.interactive).toBe(1);
    expect(maxTotal).toBe(2); // the two serial lanes ARE the global cap
    await handle.stop();
  });
});

describe('interactive mutex', () => {
  it('a held mutex skips the occurrence loudly, owes nothing, writes no state, and resumes on the grid', async () => {
    harness = new SchedHarness();
    let locked = true;
    const mood = makeJob({ name: 'mood', cadence: { kind: 'every', ms: 10 * MIN }, lane: 'interactive' });
    const handle = harness.start([mood], { interactiveMutex: () => locked });
    await handle.ready();
    await harness.clock.advance(35 * MIN);

    expect(await harness.timesOf('mood')).toEqual([]); // not one fire while the user is busy
    const skips = (await harness.of('sched.skipped')).map((ev) => ev.payload as SkippedPayload);
    expect(skips).toEqual(
      [10, 20, 30].map((n) => ({ job: 'mood', due: T0 + n * MIN, reason: 'interactive-mutex' })),
    );
    expect(fs.existsSync(harness.statePath())).toBe(false); // a mood is not an obligation: nothing attempted

    locked = false;
    await harness.clock.advance(45 * MIN);
    // Resumes on the grid at 40min — never a burst of the skipped occurrences.
    expect(await harness.timesOf('mood')).toEqual([40, 50, 60, 70, 80].map((n) => T0 + n * MIN));
    await handle.stop();
  });
});

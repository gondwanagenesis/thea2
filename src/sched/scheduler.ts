// M16 sched — the one in-process scheduler (ADR-002). Multiplexes every periodic
// behavior onto the injected Clock: TestClock turns a simulated week into
// milliseconds and this module must never arm a real timer. Job bodies share no
// await chain with the scheduling loop — a throwing, timing-out or wedged job is
// isolated behind a promise race and can only ever delay itself.

import { KernelErrorImpl, asError } from '../kernel/index.js';
import { type Rng } from '../kernel/index.js';
import type { Job, JobCtx, JobState, SchedulerDeps, SchedulerHandle } from './types.js';
import { afterFailure, scanSlots, startupPlan, validateJob } from './slots.js';
import { readSchedState, writeSchedState } from './state.js';

/** Consecutive failures before `sched.alarm` fires (then on every further failure while still failing). */
const ALARM_AFTER = 3;
/** Serial within a lane; the two lanes together are the global cap. */
const MAX_CONCURRENCY = 2;
/**
 * Simulated-time pin. TestClock.advance would otherwise run past a fire instant
 * before the run's settle microtasks land, and the next fire would bunch at the
 * end of the advance instead of its exact due. While any job is running we keep
 * a 1ms waiter armed so time only creeps until settles catch up.
 */
const PIN_MS = 1;

/**
 * Microtask rounds a stop/timeout race yields before declaring a body abandoned.
 * The waiter drain is shorter than the fire→settle chain, so the race can announce
 * `stopping`/`timeout` while the body's outcome is still queued. A few microtask
 * turns pass no clock time (simulated or wall) and cover that chain several times
 * over; a genuinely still-running body never sets its flag, so the bound holds.
 */
const SETTLE_DRAIN_ROUNDS = 8;

type BodyOutcome = { kind: 'settled' } | { kind: 'threw'; error: unknown };

type SchedEventKind =
  | 'sched.fire'
  | 'sched.complete'
  | 'sched.fail'
  | 'sched.alarm'
  | 'sched.wedged'
  | 'sched.skipped'
  | 'sched.catchup';

interface Runtime {
  readonly job: Job;
  readonly order: number;
  /** Next scheduled slot (absolute ms). The slot chain — not the completion time — is the anchor. */
  due: number;
  running: boolean;
  /** Singleton lock, process-lifetime: a wedged job refuses re-entry until restart (never persisted). */
  wedged: boolean;
  catchupPending: boolean;
  lastCompleted?: number | undefined;
  lastAttempt?: number | undefined;
  consecutiveFailures: number;
  startedAt?: number | undefined;
  cancel?: AbortController | undefined;
}

interface ErrorSummary {
  code?: string;
  message: string;
}

const errorSummary = (e: unknown): ErrorSummary => {
  const code =
    typeof e === 'object' && e !== null && 'code' in e && typeof (e as { code: unknown }).code === 'string'
      ? (e as { code: string }).code
      : undefined;
  return { ...(code !== undefined ? { code } : {}), message: e instanceof Error ? e.message : String(e) };
};

const timeoutError = (name: string, timeoutMs: number): KernelErrorImpl =>
  new KernelErrorImpl('sched/timeout', `job '${name}' exceeded timeoutMs (${timeoutMs}) and was cancelled cooperatively`);

export const startScheduler = (jobs: Job[], deps: SchedulerDeps): SchedulerHandle => {
  const clock = deps.clock;
  const events = deps.events;
  const mutex = deps.interactiveMutex ?? (() => false);

  // A malformed job table is a composition bug — loud at boot, not a surprise on
  // the job's first fire at 3am.
  const seen = new Set<string>();
  for (const job of jobs) {
    validateJob(job);
    if (seen.has(job.name)) failDup(job.name);
    seen.add(job.name);
  }

  const runtimes: Runtime[] = jobs.map((job, order) => ({
    job,
    order,
    due: Number.MAX_SAFE_INTEGER,
    running: false,
    wedged: false,
    catchupPending: false,
    consecutiveFailures: 0,
  }));
  const bodyRng = new Map<string, Rng>(runtimes.map((rt) => [rt.job.name, deps.rng.fork(`sched:${rt.job.name}`)]));

  let stopping = false;
  let bootDone = false;
  let startupError: KernelErrorImpl | undefined;
  let pinAbort: AbortController | undefined;
  const inflight = new Set<Promise<void>>();
  let persistChain: Promise<void> = Promise.resolve();
  const stopController = new AbortController();

  const emit = (kind: SchedEventKind, payload: unknown): void => {
    // Fire-and-forget: job isolation must not depend on log health. EventLog
    // already cries to stderr if an emit fails twice.
    void events.emit(kind, payload).catch(() => undefined);
  };

  const laneBusy = (lane: Job['lane']): boolean => runtimes.some((rt) => rt.running && rt.job.lane === lane);
  const runningCount = (): number => runtimes.reduce((n, rt) => n + (rt.running ? 1 : 0), 0);

  // --- persistence ---------------------------------------------------------

  const snapshot = (): { version: 1; jobs: Record<string, JobState> } => {
    const jobsState: Record<string, JobState> = {};
    for (const rt of runtimes) {
      if (rt.lastAttempt === undefined && rt.lastCompleted === undefined && rt.consecutiveFailures === 0) continue;
      jobsState[rt.job.name] = {
        ...(rt.lastCompleted !== undefined ? { lastCompleted: rt.lastCompleted } : {}),
        ...(rt.lastAttempt !== undefined ? { lastAttempt: rt.lastAttempt } : {}),
        consecutiveFailures: rt.consecutiveFailures,
      };
    }
    return { version: 1, jobs: jobsState };
  };

  const persist = (): void => {
    // FIFO chain of whole snapshots; the snapshot is taken inside the chain so
    // concurrent settles persist in settle order, never a torn mix.
    persistChain = persistChain.then(async () => {
      try {
        await writeSchedState(deps.statePath, snapshot());
      } catch (e) {
        // Loud but not loop-fatal: the next settle rewrites, and stop() awaits
        // the chain so a persistently failing disk surfaces at shutdown too.
        emit('sched.alarm', { job: '(state)', scope: 'state-write', error: errorSummary(asError(e)) });
      }
    });
  };

  // --- run lifecycle -------------------------------------------------------

  const startRun = (rt: Runtime, now: number): void => {
    rt.running = true;
    rt.lastAttempt = now;
    rt.startedAt = now;
    const isCatchup = rt.catchupPending;
    rt.catchupPending = false;
    persist(); // attempts write lastAttempt — crash-mid-run recovery reads it
    emit('sched.fire', {
      job: rt.job.name,
      lane: rt.job.lane,
      due: rt.due,
      lateMs: now - rt.due,
      ...(isCatchup ? { catchUp: true } : {}),
    });

    const cancel = new AbortController();
    rt.cancel = cancel;
    const ctx: JobCtx = {
      clock,
      rng: bodyRng.get(rt.job.name)!,
      signal: cancel.signal,
      events,
    };
    const dueSlot = rt.due;
    const deadline = now + rt.job.timeoutMs;

    let bodySettled = false;
    const body = Promise.resolve()
      .then(() => rt.job.run(ctx)) // sync throws become rejections like any other failure
      .then(
        (): BodyOutcome => {
          bodySettled = true;
          return { kind: 'settled' };
        },
        (e: unknown): BodyOutcome => {
          bodySettled = true;
          return { kind: 'threw', error: e };
        },
      );
    const timeoutP = clock
      .waitUntil(deadline, stopController.signal)
      .then(
        () => ({ kind: 'timeout' } as const),
        () => ({ kind: 'stopping' } as const),
      );
    const drainSettle = async (): Promise<void> => {
      for (let i = 0; i < SETTLE_DRAIN_ROUNDS && !bodySettled; i += 1) await Promise.resolve();
    };

    const done = (async (): Promise<void> => {
      const first = await Promise.race([body, timeoutP]);
      if (first.kind === 'stopping' || first.kind === 'timeout') await drainSettle();
      if (bodySettled) {
        // The race announced stop/timeout while the body's settle microtasks were
        // still queued, so a finished body would be miscounted as `stopped`. An
        // outcome that has happened is real: record it, even during shutdown.
        const real = await body; // already resolved once bodySettled
        return real.kind === 'settled'
          ? finishSuccess(rt, clock.epochMs(), dueSlot)
          : finishFailure(rt, real.error, false);
      }
      if (stopping || first.kind === 'stopping') return finishStopped(rt);
      if (first.kind === 'timeout') {
        // Deadline missed. Cooperative cancel first: a well-behaved job gets one
        // further timeout period to settle before we declare it wedged.
        cancel.abort();
        const graceP = clock
          .waitUntil(deadline + rt.job.timeoutMs, stopController.signal)
          .then(
            () => ({ kind: 'expired' } as const),
            () => ({ kind: 'stopping' } as const),
          );
        const second = await Promise.race([body, graceP]);
        await drainSettle();
        if (bodySettled) {
          // Settled (or thrown) inside the grace window — cooperatively
          // cancelled: still a missed deadline, but the job may run again on
          // its next slot.
          await body;
          return finishFailure(rt, timeoutError(rt.job.name, rt.job.timeoutMs), false);
        }
        if (stopping || second.kind === 'stopping') return finishStopped(rt);
        // The body ignored the abort through the whole grace window: abandon
        // it, flag it, refuse re-entry.
        rt.wedged = true;
        emit('sched.wedged', { job: rt.job.name, timeoutMs: rt.job.timeoutMs, due: dueSlot });
        return finishFailure(rt, timeoutError(rt.job.name, rt.job.timeoutMs), true);
      }
      if (first.kind === 'threw') return finishFailure(rt, first.error, false);
      return finishSuccess(rt, clock.epochMs(), dueSlot);
    })();
    inflight.add(done);
    void done.then(
      () => undefined,
      () => undefined,
    ).then(() => {
      inflight.delete(done);
      rt.cancel = undefined;
    });
  };

  const finishSuccess = (rt: Runtime, completedAt: number, dueSlot: number): void => {
    rt.running = false;
    // Persistence records WHICH occurrence completed — its scheduled slot, not
    // the settle instant. The slot chain is jittered and anchored on the previous
    // slot, so a restart anchoring on settle-time (slot + ε) would draw different
    // jitter seeds and never reproduce the identical sequence.
    rt.lastCompleted = dueSlot;
    rt.consecutiveFailures = 0;
    persist();
    emit('sched.complete', { job: rt.job.name, durationMs: completedAt - (rt.startedAt ?? completedAt) });
    // Anchor on the scheduled slot, not the completion: a late or deferred run
    // consumes its slot and the chain resumes in the future — never a burst.
    rt.due = scanSlots(rt.job.name, rt.job.cadence, dueSlot, completedAt).next;
    schedule();
  };

  const finishFailure = (rt: Runtime, error: unknown, wedged: boolean): void => {
    rt.running = false;
    rt.consecutiveFailures += 1;
    const summary = errorSummary(error);
    persist();
    emit('sched.fail', {
      job: rt.job.name,
      consecutiveFailures: rt.consecutiveFailures,
      ...(wedged ? { wedged: true } : {}),
      error: summary,
    });
    if (rt.consecutiveFailures >= ALARM_AFTER) {
      emit('sched.alarm', { job: rt.job.name, consecutiveFailures: rt.consecutiveFailures, error: summary });
    }
    if (!rt.wedged) {
      rt.due = afterFailure(rt.job.cadence, rt.due, clock.epochMs(), rt.consecutiveFailures);
    }
    schedule();
  };

  const finishStopped = (rt: Runtime): void => {
    // Shutdown is not a job failure: no fail event, no backoff, no alarm. The
    // attempt is already persisted from fire time.
    rt.running = false;
  };

  // --- scheduling core -----------------------------------------------------

  const dispatch = (): void => {
    const now = clock.epochMs();
    const candidates = runtimes
      .filter((rt) => !rt.wedged && !rt.running && rt.due <= now)
      .sort((a, b) => a.due - b.due || a.order - b.order); // exact-fire order: due time, then registration
    for (const rt of candidates) {
      if (rt.wedged || rt.running) continue; // settled mid-pass
      if (laneBusy(rt.job.lane) || runningCount() >= MAX_CONCURRENCY) continue; // deferred — a settle reschedules
      if (rt.job.lane === 'interactive' && mutex()) {
        // A mood, not an obligation: consume the slot, run nothing, record no
        // completion — nothing is owed, and no missed-catch-up debt accrues.
        emit('sched.skipped', { job: rt.job.name, due: rt.due, reason: 'interactive-mutex' });
        rt.due = scanSlots(rt.job.name, rt.job.cadence, rt.due, now).next;
        continue;
      }
      startRun(rt, now);
    }
  };

  const schedule = (): void => {
    if (stopping || !bootDone) return;
    dispatch();
    const now = clock.epochMs();
    let sleepAt: number | undefined;
    let running = false;
    for (const rt of runtimes) {
      if (rt.running) {
        running = true;
        continue;
      }
      if (rt.wedged) continue;
      if (rt.due <= now) return; // deferred behind a lane-mate — its settle reschedules us
      sleepAt = sleepAt === undefined ? rt.due : Math.min(sleepAt, rt.due);
    }
    if (running) {
      const pin = now + PIN_MS;
      sleepAt = sleepAt === undefined ? pin : Math.min(sleepAt, pin);
    }
    if (sleepAt !== undefined) armSleep(sleepAt);
  };

  const armSleep = (until: number): void => {
    // At most one live sleep waiter: supersede (abort) rather than accumulate.
    pinAbort?.abort();
    const ac = new AbortController();
    pinAbort = ac;
    void clock
      .waitUntil(until, ac.signal)
      .then(
        () => {
          if (!stopping) schedule();
        },
        () => undefined, // superseded or stopping — never a dangling rejection
      );
  };

  // --- boot ----------------------------------------------------------------

  let readyResolve: (() => void) | undefined;
  const readyPromise = new Promise<void>((resolve) => {
    readyResolve = resolve;
  });

  const boot = (async (): Promise<void> => {
    try {
      const state = await readSchedState(deps.statePath);
      const now = clock.epochMs();
      for (const rt of runtimes) {
        const st = state.jobs[rt.job.name];
        rt.lastCompleted = st?.lastCompleted;
        rt.lastAttempt = st?.lastAttempt;
        rt.consecutiveFailures = st?.consecutiveFailures ?? 0;
        const plan = startupPlan(rt.job, st, now);
        rt.due = plan.due;
        rt.catchupPending = plan.catchUpFire;
        if (plan.missed > 0) {
          emit('sched.catchup', {
            job: rt.job.name,
            missed: plan.missed,
            policy: rt.job.catchUp,
            action: plan.catchUpFire ? 'catchup-once' : 'skip',
          });
        }
      }
      bootDone = true;
      schedule();
    } catch (e) {
      startupError =
        e instanceof KernelErrorImpl
          ? e
          : new KernelErrorImpl('sched/state-corrupt', `scheduler startup failed for ${deps.statePath}`, e);
      console.error(`[sched] startup failed: ${startupError.message}`);
    } finally {
      readyResolve?.(); // readiness even on failure — stop() rethrows startupError
    }
  })();

  const stop = async (): Promise<void> => {
    stopping = true;
    stopController.abort(); // wakes/rejects sleep + timeout waiters
    pinAbort?.abort();
    await boot;
    for (const rt of runtimes) rt.cancel?.abort(); // cooperative cancel of in-flight runs
    // Each in-flight race settles at its deadline even for a wedged body, so
    // this drain is bounded by timeoutMs (advance the TestClock in tests).
    await Promise.allSettled([...inflight]);
    await persistChain; // no dangling writes
    if (startupError !== undefined) throw startupError;
  };

  return {
    ready: (): Promise<void> => readyPromise,
    stop,
    runningJobs: (): string[] => runtimes.filter((rt) => rt.running).map((rt) => rt.job.name),
  };
};

const failDup = (name: string): never => {
  throw new KernelErrorImpl('sched/duplicate-job', `job name '${name}' registered twice`);
};

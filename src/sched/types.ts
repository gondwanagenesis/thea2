// M16 sched — public contract. M17/M18 build job bodies against these types and
// M20 wires startScheduler; field names here are load-bearing across modules.

import type { Clock } from '../kernel/index.js';
import type { Rng } from '../kernel/index.js';
import type { EventLog } from '../events/index.js';

/**
 * When a job fires.
 * - `every`    — fixed period anchored on the previous scheduled slot; `jitterPct`
 *                spreads each slot ± that percentage of the period (0–100), drawn
 *                deterministically from hash(jobName, slot) so replays reproduce.
 * - `daily`    — once per UTC day at `utcMinute` (DST-agnostic by construction).
 * - `weekly`   — once per ISO week on `dow` (0 = Sunday, matches getUTCDay) at `utcMinute`.
 */
export type Cadence =
  | { kind: 'every'; ms: number; jitterPct?: number | undefined }
  | { kind: 'daily'; utcMinute: number }
  | { kind: 'weekly'; dow: number; utcMinute: number };

export type Lane = 'interactive' | 'maintenance';

/**
 * Per-run context handed to a job body. `signal` aborts when the run exceeds
 * `timeoutMs` (cooperative cancel) or when the process is shutting down.
 * `rng` is a per-job fork of the scheduler's stream — a body's draws continue
 * across runs and never perturb another job's stream or the jitter draws.
 */
export interface JobCtx {
  clock: Clock;
  rng: Rng;
  signal: AbortSignal;
  events: EventLog;
}

export interface Job {
  name: string;
  cadence: Cadence;
  lane: Lane;
  /**
   * Downtime policy. `skip` — missed occurrences are dropped (heartbeat and
   * ponder are moods, not obligations: 16 missed heartbeats must never become
   * 16 texts). `once` — one catch-up pass regardless of how many were missed
   * (reflect/consolidate/ledger-report/derive-check are obligations).
   */
  catchUp: 'skip' | 'once';
  timeoutMs: number;
  run(ctx: JobCtx): Promise<void>;
}

export interface SchedulerDeps {
  clock: Clock;
  rng: Rng;
  events: EventLog;
  /** Persisted `{lastCompleted, lastAttempt, consecutiveFailures}` per job (kernel atomic writes). */
  statePath: string;
  /**
   * True = SKIP this interactive firing (inbound < 10 min ago or a turn in
   * flight). Injected by M20, which owns the mutex's state; the scheduler only
   * consults the predicate so the semantics stay testable here and true in prod.
   */
  interactiveMutex?: (() => boolean) | undefined;
}

export interface SchedulerHandle {
  /**
   * Resolves once the state file is read, catch-up is planned and the loop is
   * armed. M20's boot order and every hermetic test need this to be awaitable —
   * advancing an injected clock before planning completes would mis-time first fires.
   */
  ready(): Promise<void>;
  /** Aborts the loop, cooperatively cancels in-flight runs, drains state writes. */
  stop(): Promise<void>;
  /** Names of jobs whose bodies are executing right now. */
  runningJobs(): string[];
}

/** Persisted per-job record — "what actually ran", read by recovery and M18's Ledger. */
export interface JobState {
  lastCompleted?: number | undefined;
  lastAttempt?: number | undefined;
  consecutiveFailures: number;
}

/** `var/sched/state.json` on-disk shape. */
export interface SchedState {
  version: 1;
  jobs: Record<string, JobState>;
}

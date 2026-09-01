// M16 sched — pure slot arithmetic. Every "when does this fire next" decision in
// the module resolves through these functions, so the catch-up, jitter and
// backoff laws are unit-testable without a clock, a filesystem, or a scheduler.

import { fail, makeRng } from '../kernel/index.js';
import type { Cadence, Job } from './types.js';

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
const MINUTE_MS = 60_000;

/**
 * Bail-out for pathological downtime (a 1-minute job after a year offline).
 * Beyond this many missed slots the scan jumps straight to "first slot after
 * now"; the count saturates rather than lying low.
 */
export const MAX_SLOT_SCAN = 1_000_000;

/** The cadence's natural period — also the unit backoff multiplies ("interval ×2 up to ×4"). */
export const periodMs = (cadence: Cadence): number =>
  cadence.kind === 'every' ? cadence.ms : cadence.kind === 'daily' ? DAY_MS : WEEK_MS;

/**
 * Job-table validation. A malformed job is a composition bug (M20 wiring), so it
 * is a typed startup failure naming every problem — never a surprise on the job's
 * first fire, and never silently dropped (absence is expressed by not registering).
 */
export const validateJob = (job: Job): void => {
  const problems: string[] = [];
  if (typeof job.name !== 'string' || job.name.length === 0) problems.push('name must be a non-empty string');
  const c = job.cadence;
  if (c.kind === 'every') {
    if (!Number.isFinite(c.ms) || c.ms <= 0) problems.push('every.ms must be a finite number > 0');
    if (c.jitterPct !== undefined && (!Number.isFinite(c.jitterPct) || c.jitterPct < 0 || c.jitterPct > 100)) {
      problems.push('every.jitterPct must be a percentage within [0, 100]');
    }
  } else if (c.kind === 'daily') {
    if (!Number.isInteger(c.utcMinute) || c.utcMinute < 0 || c.utcMinute > 1439) {
      problems.push('daily.utcMinute must be an integer minute of the UTC day [0, 1439]');
    }
  } else {
    if (!Number.isInteger(c.dow) || c.dow < 0 || c.dow > 6) {
      problems.push('weekly.dow must be an integer [0, 6] (0 = Sunday)');
    }
    if (!Number.isInteger(c.utcMinute) || c.utcMinute < 0 || c.utcMinute > 1439) {
      problems.push('weekly.utcMinute must be an integer minute of the UTC day [0, 1439]');
    }
  }
  if (job.lane !== 'interactive' && job.lane !== 'maintenance') problems.push('lane must be "interactive" or "maintenance"');
  if (job.catchUp !== 'skip' && job.catchUp !== 'once') problems.push('catchUp must be "skip" or "once"');
  if (!Number.isFinite(job.timeoutMs) || job.timeoutMs <= 0) problems.push('timeoutMs must be a finite number > 0');
  if (typeof job.run !== 'function') problems.push('run must be a function');
  if (problems.length > 0) fail('sched/bad-job', `invalid job '${String(job.name)}': ${problems.join('; ')}`);
};

/**
 * Day-of-week of a UTC day index without constructing a Date (determinism law):
 * day 0 = 1970-01-01 = a Thursday, so (index + 4) mod 7 lands on getUTCDay's
 * 0 = Sunday convention.
 */
const dowOfDayIndex = (dayIndex: number): number => (((dayIndex + 4) % 7) + 7) % 7;

const daySlotMs = (dayIndex: number, utcMinute: number): number => dayIndex * DAY_MS + utcMinute * MINUTE_MS;

/** Deterministic jitter: hash(jobName, slot) seeds the draw, so a replay of the same chain reproduces the same offsets. */
export const jitterOffsetMs = (jobName: string, slotSeedMs: number, periodMs_: number, jitterPct: number): number => {
  const draw = makeRng(`sched/jitter/${jobName}/${slotSeedMs}`).float() * 2 - 1; // [-1, 1)
  return Math.round(draw * (jitterPct / 100) * periodMs_);
};

/** First slot strictly after `afterMs`. For `every`, the slot chain is anchored on the previous scheduled slot. */
export const nextSlot = (jobName: string, cadence: Cadence, afterMs: number): number => {
  switch (cadence.kind) {
    case 'every': {
      const seed = afterMs + cadence.ms;
      return seed + jitterOffsetMs(jobName, seed, cadence.ms, cadence.jitterPct ?? 0);
    }
    case 'daily': {
      const day = Math.floor(afterMs / DAY_MS);
      const today = daySlotMs(day, cadence.utcMinute);
      return today > afterMs ? today : daySlotMs(day + 1, cadence.utcMinute);
    }
    case 'weekly': {
      let day = Math.floor(afterMs / DAY_MS);
      for (;;) {
        const slot = daySlotMs(day, cadence.utcMinute);
        if (slot > afterMs && dowOfDayIndex(day) === cadence.dow) return slot;
        day++;
      }
    }
  }
};

export interface SlotScan {
  /** Slots at or before `until` — the missed occurrences a catch-up policy rules on. */
  missed: number;
  /** First slot strictly after `until`. */
  next: number;
}

/**
 * Walk the slot chain from `from`, counting everything at or before `until`.
 * Missed slots are skipped forward over, never accumulated — this one walk is
 * both the startup catch-up census and the "a late run must not burst" guard.
 */
export const scanSlots = (jobName: string, cadence: Cadence, from: number, until: number): SlotScan => {
  let missed = 0;
  let slot = nextSlot(jobName, cadence, from);
  while (slot <= until) {
    missed++;
    slot = nextSlot(jobName, cadence, slot);
    if (missed >= MAX_SLOT_SCAN) return { missed, next: nextSlot(jobName, cadence, until) };
  }
  return { missed, next: slot };
};

/** interval ×2^failures, capped at ×4 — the spec's whole backoff ladder. */
export const backoffMultiplier = (consecutiveFailures: number): number =>
  consecutiveFailures <= 0 ? 1 : Math.min(2 ** consecutiveFailures, 4);

/**
 * Next attempt after a failure: the failed slot plus backoff periods, stepping
 * over any that elapsed meanwhile (a chronically failing job under downtime
 * resumes in the future, not in a burst of retries).
 */
export const afterFailure = (cadence: Cadence, failedSlot: number, until: number, consecutiveFailures: number): number => {
  const step = periodMs(cadence) * backoffMultiplier(consecutiveFailures);
  let slot = failedSlot + step;
  while (slot <= until) slot += step;
  return slot;
};

export interface StartupPlan {
  due: number;
  /** True when this first fire is the single catch-up pass of a `once` job. */
  catchUpFire: boolean;
  missed: number;
}

/**
 * Startup planning — the catch-up rule in one place.
 * - `once` with missed slots: fire exactly one catch-up pass now (an obligation).
 * - otherwise, backoff pending from a failure is honored across restarts.
 * - otherwise resume the chain after everything missed (`skip`: moods are not
 *   owed — 16 missed heartbeats must never become 16 texts).
 * - fresh job: first slot strictly after now, so a boot never fires at boot.
 */
export const startupPlan = (job: Job, st: { lastCompleted?: number | undefined; lastAttempt?: number | undefined; consecutiveFailures?: number | undefined } | undefined, now: number): StartupPlan => {
  const anchor = st?.lastCompleted ?? st?.lastAttempt;
  const missed = anchor !== undefined ? scanSlots(job.name, job.cadence, anchor, now).missed : 0;
  if (missed > 0 && job.catchUp === 'once') return { due: now, catchUpFire: true, missed };
  const failures = st?.consecutiveFailures ?? 0;
  if (failures > 0 && st?.lastAttempt !== undefined) {
    return { due: afterFailure(job.cadence, st.lastAttempt, now, failures), catchUpFire: false, missed };
  }
  if (anchor !== undefined) return { due: scanSlots(job.name, job.cadence, anchor, now).next, catchUpFire: false, missed };
  return { due: nextSlot(job.name, job.cadence, now), catchUpFire: false, missed };
};

// Unit tests for the pure slot arithmetic: nextDue math table (every/daily/weekly),
// deterministic jitter, the backoff ladder, missed-slot scans and startup plans.

import { describe, expect, it } from 'vitest';
import {
  afterFailure,
  backoffMultiplier,
  jitterOffsetMs,
  nextSlot,
  periodMs,
  scanSlots,
  startupPlan,
  validateJob,
} from '../../src/sched/index.js';
import { KernelErrorImpl } from '../../src/kernel/index.js';
import { DAY, HOUR, MIN, makeJob } from './helpers.js';

// Hand-derived anchors (no implementation sharing): 2026-09-01 is a Tuesday.
const T0 = Date.UTC(2026, 8, 1, 0, 0, 0);
const at = (dayOffset: number, h: number, m: number): number => T0 + dayOffset * DAY + h * HOUR + m * MIN;

describe('nextSlot — every', () => {
  it('first slot is exactly one period after the anchor', () => {
    expect(nextSlot('hb', { kind: 'every', ms: 30 * MIN }, T0)).toBe(T0 + 30 * MIN);
  });

  it('chains from the previous slot, not from now', () => {
    const s1 = nextSlot('hb', { kind: 'every', ms: 30 * MIN }, T0);
    expect(nextSlot('hb', { kind: 'every', ms: 30 * MIN }, s1)).toBe(s1 + 30 * MIN);
  });

  it('applies deterministic ± jitterPct within bounds, identical on recompute', () => {
    const cadence = { kind: 'every' as const, ms: 30 * MIN, jitterPct: 10 };
    const s1 = nextSlot('hb', cadence, T0);
    expect(s1).toBeGreaterThanOrEqual(T0 + 27 * MIN);
    expect(s1).toBeLessThanOrEqual(T0 + 33 * MIN);
    expect(nextSlot('hb', cadence, T0)).toBe(s1); // pure — same inputs, same slot
    // A different job name draws a different offset in general (hash-seeded).
    const draws = new Set<number>();
    for (let i = 0; i < 12; i++) draws.add(nextSlot(`job-${i}`, cadence, T0));
    expect(draws.size).toBeGreaterThan(1);
  });

  it('jitter is seeded by the slot position: the same slot index reproduces across jobs of equal shape', () => {
    const a = jitterOffsetMs('heartbeat', T0 + 30 * MIN, 30 * MIN, 10);
    expect(jitterOffsetMs('heartbeat', T0 + 30 * MIN, 30 * MIN, 10)).toBe(a);
    expect(Math.abs(a)).toBeLessThanOrEqual(3 * MIN);
  });
});

describe('nextSlot — daily and weekly (UTC grid, DST-agnostic by construction)', () => {
  it('daily fires at utcMinute each UTC day, strictly after the anchor', () => {
    const cadence = { kind: 'daily' as const, utcMinute: 3 * 60 };
    expect(nextSlot('reflect', cadence, T0)).toBe(at(0, 3, 0));
    expect(nextSlot('reflect', cadence, at(0, 3, 0))).toBe(at(1, 3, 0)); // exactly on the slot → next day
    expect(nextSlot('reflect', cadence, at(0, 3, 1))).toBe(at(1, 3, 0));
    expect(nextSlot('reflect', cadence, at(0, 23, 59))).toBe(at(1, 3, 0));
  });

  it('weekly lands on the requested dow across a week boundary', () => {
    const friday = { kind: 'weekly' as const, dow: 5, utcMinute: 4 * 60 };
    // 2026-09-01 is a Tuesday; the next Friday 04:00 is 2026-09-04.
    expect(nextSlot('derive-check', friday, T0)).toBe(at(3, 4, 0));
    // After that fire, the next is a full week later.
    expect(nextSlot('derive-check', friday, at(3, 4, 0))).toBe(at(10, 4, 0));
    // Late in the week it still lands on NEXT week's Friday, never this week's past slot.
    expect(nextSlot('derive-check', friday, at(4, 0, 0))).toBe(at(10, 4, 0));
  });

  it('covers all seven dow positions within seven days of any anchor', () => {
    for (let dow = 0; dow < 7; dow++) {
      const slot = nextSlot('w', { kind: 'weekly', dow, utcMinute: 0 }, T0);
      expect(slot).toBeGreaterThan(T0);
      expect(slot - T0).toBeLessThanOrEqual(7 * DAY);
      // dow of the slot's day index must equal the request.
      const idx = Math.floor(slot / DAY);
      expect(((idx + 4) % 7 + 7) % 7).toBe(dow);
    }
  });

  it('periodMs gives the backoff unit per cadence kind', () => {
    expect(periodMs({ kind: 'every', ms: 5 * MIN })).toBe(5 * MIN);
    expect(periodMs({ kind: 'daily', utcMinute: 0 })).toBe(DAY);
    expect(periodMs({ kind: 'weekly', dow: 0, utcMinute: 0 })).toBe(7 * DAY);
  });
});

describe('backoff ladder — interval ×2 up to ×4', () => {
  it('multipliers follow 1, 2, 4, 4, ...', () => {
    expect([0, 1, 2, 3, 4, 9].map(backoffMultiplier)).toEqual([1, 2, 4, 4, 4, 4]);
  });

  it('a failing every-job backs off ×2 then ×4 from the failed slot, skipping elapsed steps', () => {
    const cadence = { kind: 'every' as const, ms: 10 * MIN };
    expect(afterFailure(cadence, at(0, 0, 10), at(0, 0, 10), 1)).toBe(at(0, 0, 30)); // +2 periods
    expect(afterFailure(cadence, at(0, 0, 30), at(0, 0, 30), 2)).toBe(at(0, 1, 10)); // +4 periods
    expect(afterFailure(cadence, at(0, 1, 10), at(0, 1, 10), 3)).toBe(at(0, 1, 50)); // ×4 capped
  });

  it('backoff keeps daily jobs on the grid minute and skips past downtime', () => {
    const cadence = { kind: 'daily' as const, utcMinute: 180 };
    expect(afterFailure(cadence, at(0, 3, 0), at(0, 3, 0), 1)).toBe(at(2, 3, 0)); // 2 days out
    // Downtime past the backed-off slot resumes in the future, no retry burst.
    expect(afterFailure(cadence, at(0, 3, 0), at(5, 3, 0), 1)).toBe(at(6, 3, 0));
  });
});

describe('scanSlots / startupPlan — the catch-up census', () => {
  it('counts missed slots and resumes strictly after now', () => {
    const cadence = { kind: 'every' as const, ms: 30 * MIN };
    const scan = scanSlots('heartbeat', cadence, T0, T0 + 8 * HOUR); // 16 slots missed
    expect(scan.missed).toBe(16);
    expect(scan.next).toBe(T0 + 8 * HOUR + 30 * MIN);
  });

  it('counts missed daily slots including the day of the anchor slot', () => {
    const cadence = { kind: 'daily' as const, utcMinute: 180 };
    expect(scanSlots('reflect', cadence, at(0, 3, 0), at(3, 9, 0)).missed).toBe(3); // days 1, 2, 3
    expect(scanSlots('reflect', cadence, at(0, 3, 0), at(3, 3, 0)).missed).toBe(3); // boundary inclusive
  });

  it('startupPlan: fresh job fires one cadence step from boot, never at boot', () => {
    const plan = startupPlan(makeJob({ name: 'hb', cadence: { kind: 'every', ms: 30 * MIN } }), undefined, T0);
    expect(plan).toEqual({ due: T0 + 30 * MIN, catchUpFire: false, missed: 0 });
    const daily = startupPlan(makeJob({ name: 'r', cadence: { kind: 'daily', utcMinute: 180 } }), undefined, T0);
    expect(daily.due).toBe(at(0, 3, 0));
  });

  it('startupPlan: skip policy drops every missed occurrence and owes nothing', () => {
    const st = { lastCompleted: T0, consecutiveFailures: 0 };
    const plan = startupPlan(makeJob({ name: 'hb', cadence: { kind: 'every', ms: 30 * MIN } }), st, T0 + 8 * HOUR);
    expect(plan.missed).toBe(16);
    expect(plan.catchUpFire).toBe(false);
    expect(plan.due).toBe(T0 + 8 * HOUR + 30 * MIN);
  });

  it('startupPlan: once policy fires exactly one catch-up pass at boot regardless of N missed', () => {
    const st = { lastCompleted: T0, consecutiveFailures: 0 };
    const job = makeJob({ name: 'reflect', cadence: { kind: 'every', ms: 30 * MIN }, catchUp: 'once' });
    for (const hours of [1, 8, 72, 24 * 30]) {
      const plan = startupPlan(job, st, T0 + hours * HOUR);
      expect(plan.catchUpFire).toBe(true);
      expect(plan.due).toBe(T0 + hours * HOUR); // fires now, once
      expect(plan.missed).toBeGreaterThan(0);
    }
  });

  it('startupPlan: pending failure backoff survives a restart', () => {
    const st = { lastAttempt: T0 + 10 * MIN, consecutiveFailures: 2 };
    // ×4 ⇒ first backed-off slot after the failed one: lastAttempt + 4 periods.
    const plan = startupPlan(makeJob({ name: 'f', cadence: { kind: 'every', ms: 10 * MIN } }), st, T0 + 45 * MIN);
    expect(plan.due).toBe(T0 + 50 * MIN);
    expect(plan.catchUpFire).toBe(false);
  });

  it('startupPlan: a once job that is not behind fires on its regular next slot', () => {
    const st = { lastCompleted: T0, consecutiveFailures: 0 };
    const plan = startupPlan(makeJob({ name: 'r', cadence: { kind: 'daily', utcMinute: 180 }, catchUp: 'once' }), st, T0 + HOUR);
    expect(plan).toEqual({ due: at(0, 3, 0), catchUpFire: false, missed: 0 });
  });
});

describe('validateJob', () => {
  it('accepts a well-formed job silently', () => {
    expect(() => validateJob(makeJob())).not.toThrow();
  });

  it('rejects malformed jobs with one typed code naming every problem', () => {
    const bad = (over: Parameters<typeof makeJob>[0]): unknown => {
      try {
        validateJob(makeJob(over));
        return undefined;
      } catch (e) {
        return e;
      }
    };
    expect(bad({ name: '' })).toBeInstanceOf(KernelErrorImpl);
    expect(bad({ cadence: { kind: 'every', ms: 0 } })).toBeInstanceOf(KernelErrorImpl);
    expect(bad({ cadence: { kind: 'every', ms: 1000, jitterPct: 140 } })).toBeInstanceOf(KernelErrorImpl);
    expect(bad({ cadence: { kind: 'daily', utcMinute: 1440 } })).toBeInstanceOf(KernelErrorImpl);
    expect(bad({ cadence: { kind: 'weekly', dow: 7, utcMinute: 0 } })).toBeInstanceOf(KernelErrorImpl);
    expect(bad({ lane: 'chore' as never })).toBeInstanceOf(KernelErrorImpl);
    expect(bad({ catchUp: 'retry' as never })).toBeInstanceOf(KernelErrorImpl);
    expect(bad({ timeoutMs: -1 })).toBeInstanceOf(KernelErrorImpl);
    const err = bad({ cadence: { kind: 'daily', utcMinute: 1440 } }) as KernelErrorImpl;
    expect((err as { code: string }).code).toBe('sched/bad-job');
    expect(err.message).toContain('utcMinute');
  });
});

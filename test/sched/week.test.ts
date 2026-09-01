// The simulated-week gate: mixed cadences over seven TestClock days, every firing
// at its exact due time, in order — plus jitter determinism across fresh instances
// and restart-recovery from the persisted state file.

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { DAY, HOUR, MIN, SchedHarness, T0, WEEK, makeJob, runWeek, weekJobs } from './helpers.js';

// The committed expectation — hand-checkable structure, machine-exact sequence.
interface GoldenFixture {
  startMs: number;
  weekMs: number;
  fires: Array<{ at: number; job: string; lateMs: number; catchUp: boolean }>;
}
const golden = JSON.parse(
  fs.readFileSync(path.join(import.meta.dirname, 'golden-week.json'), 'utf8'),
) as GoldenFixture;

const at = (dayOffset: number, h: number, m: number): number => T0 + dayOffset * DAY + h * HOUR + m * MIN;

describe('simulated week — the exact-fire-sequence test', () => {
  it('fires every job at its exact due time, in order, across seven days', async () => {
    const h = new SchedHarness();
    try {
      const fires = await runWeek(h);

      // Exactness: a TestClock fire never lands late.
      expect(fires.length).toBeGreaterThan(0);
      for (const f of fires) expect(f.lateMs, `${f.job} at ${f.at}`).toBe(0);

      // Ordering: one global non-decreasing sequence.
      for (let i = 1; i < fires.length; i++) {
        expect(fires[i]!.at, `fire ${i} (${fires[i]!.job}) after ${fires[i - 1]!.job}`).toBeGreaterThanOrEqual(
          fires[i - 1]!.at,
        );
      }

      // Nothing fires at boot, and boot does not pull the schedule forward.
      expect(fires[0]!.at).toBeGreaterThan(T0);

      // Daily cadence: exactly at utcMinute, every UTC day, DST-agnostic by UTC.
      expect(await h.timesOf('reflect')).toEqual([0, 1, 2, 3, 4, 5, 6].map((d) => at(d, 3, 0)));
      expect(await h.timesOf('ledger-report')).toEqual([0, 1, 2, 3, 4, 5, 6].map((d) => at(d, 4, 30)));

      // Weekly cadence: once, on Friday 04:00 (2026-09-04), not a week-boundary guess.
      expect(await h.timesOf('derive-check')).toEqual([at(3, 4, 0)]);

      // Every-cadence without jitter: locked to the period grid from boot.
      const snapshots = Array.from({ length: 28 }, (_, i) => T0 + (i + 1) * 6 * HOUR);
      expect(await h.timesOf('affect-snapshot')).toEqual(snapshots);

      // Every-cadence with jitter: cadence holds within ±jitterPct, no drift.
      const hb = await h.timesOf('heartbeat');
      expect(hb.length).toBeGreaterThanOrEqual(330);
      expect(hb.length).toBeLessThanOrEqual(342);
      expect(hb[0]! - T0).toBeGreaterThanOrEqual(27 * MIN);
      for (let i = 1; i < hb.length; i++) {
        const gap = hb[i]! - hb[i - 1]!;
        expect(gap, `heartbeat gap ${i}`).toBeGreaterThanOrEqual(27 * MIN);
        expect(gap, `heartbeat gap ${i}`).toBeLessThanOrEqual(33 * MIN);
      }
    } finally {
      await h.cleanup();
    }
  }, 240_000);

  it('reproduces the committed golden sequence byte-for-byte', async () => {
    const h = new SchedHarness();
    try {
      const fires = await runWeek(h);
      expect(golden.startMs).toBe(T0);
      expect(golden.weekMs).toBe(WEEK);
      expect(fires.map((f) => ({ at: f.at, job: f.job, lateMs: f.lateMs, catchUp: f.catchUp }))).toEqual(golden.fires);
    } finally {
      await h.cleanup();
    }
  }, 240_000);

  it('two fresh scheduler instances (seeded rng) produce identical fire timestamps', async () => {
    const a = new SchedHarness(T0, 'determinism-a');
    const b = new SchedHarness(T0, 'determinism-a'); // same seed, fresh state
    try {
      const runA = await runWeek(a);
      const runB = await runWeek(b);
      expect(runB.map((f) => ({ at: f.at, job: f.job }))).toEqual(runA.map((f) => ({ at: f.at, job: f.job })));
    } finally {
      await a.cleanup();
      await b.cleanup();
    }
  }, 240_000);
});

describe('restart recovery — state.json is the schedule, not process birth', () => {
  it('stopping and restarting mid-week continues the identical sequence', async () => {
    const uninterrupted = new SchedHarness();
    try {
      const expected = (await runWeek(uninterrupted)).map((f) => ({ at: f.at, job: f.job }));

      const restarted = new SchedHarness();
      try {
        const first = await restarted.start(weekJobs());
        await first.ready();
        await restarted.clock.advance(3 * DAY + 7 * HOUR); // mid-Thursday, between fires
        await first.stop();

        const second = restarted.start(weekJobs());
        await second.ready();
        await restarted.clock.advance(WEEK - (3 * DAY + 7 * HOUR));
        await second.stop();

        // The log is append-only across the restart, so one replay is the whole
        // week — replays are never concatenated or mid-run fires double-count.
        const whole = (await restarted.fires()).map((f) => ({ at: f.at, job: f.job }));
        expect(whole).toEqual(expected); // same instants, same jobs, jitter chain unbroken
      } finally {
        await restarted.cleanup();
      }
    } finally {
      await uninterrupted.cleanup();
    }
  }, 300_000);

  it('a hand-written mid-week state file is honored over process birth', async () => {
    const h = new SchedHarness(T0 + 2 * HOUR + 30 * MIN); // boots 2.5h into the week
    try {
      await fsp.mkdir(path.dirname(h.statePath()), { recursive: true });
      await fsp.writeFile(
        h.statePath(),
        JSON.stringify({
          version: 1,
          jobs: { 'affect-snapshot': { lastCompleted: T0 + 2 * HOUR, lastAttempt: T0 + 2 * HOUR, consecutiveFailures: 0 } },
        }),
        'utf8',
      );
      const handle = h.start([makeJob({ name: 'affect-snapshot', cadence: { kind: 'every', ms: 6 * HOUR } })]);
      await handle.ready();
      await h.clock.advance(6 * HOUR);
      await handle.stop();
      // From persistence: last slot 02:00 was consumed, next is 08:00 — not boot(02:30)+6h.
      expect(await h.timesOf('affect-snapshot')).toEqual([T0 + 8 * HOUR]);
    } finally {
      await h.cleanup();
    }
  });

  it('writes the documented state shape: lastCompleted, lastAttempt, consecutiveFailures', async () => {
    const h = new SchedHarness();
    try {
      const handle = h.start([makeJob({ name: 'job', cadence: { kind: 'every', ms: 10 * MIN } })]);
      await handle.ready();
      await h.clock.advance(10 * MIN);
      await handle.stop();
      const raw = JSON.parse(await fsp.readFile(h.statePath(), 'utf8')) as {
        version: number;
        jobs: Record<string, { lastCompleted?: number; lastAttempt?: number; consecutiveFailures: number }>;
      };
      expect(raw.version).toBe(1);
      const st = raw.jobs['job']!;
      expect(st.consecutiveFailures).toBe(0);
      expect(st.lastCompleted).toBe(T0 + 10 * MIN);
      expect(st.lastAttempt).toBe(T0 + 10 * MIN);
    } finally {
      await h.cleanup();
    }
  });
});

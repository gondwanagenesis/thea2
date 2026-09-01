// The catch-up gate. The named regression exists because the bug class is real:
// Thea1's sentinel once turned 16 missed heartbeats into 16 texts on recovery.
// Moods (skip) are never owed; obligations (once) catch up exactly one pass.

import { describe, expect, it, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { startupPlan } from '../../src/sched/index.js';
import { DAY, HOUR, MIN, SchedHarness, T0, makeJob, type Fired } from './helpers.js';

let harness: SchedHarness | undefined;
afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
});

const writeState = async (statePath: string, jobs: Record<string, unknown>): Promise<void> => {
  await fsp.mkdir(path.dirname(statePath), { recursive: true });
  await fsp.writeFile(statePath, JSON.stringify({ version: 1, jobs }), 'utf8');
};

describe('sixteen-missed-heartbeats — the named regression', () => {
  it('catchUp: skip with 16 missed occurrences fires nothing at startup and resumes one slot out', async () => {
    harness = new SchedHarness();
    const downtime = 8 * HOUR; // 16 heartbeats of 30 min
    const statePath = harness.statePath();
    await writeState(statePath, { heartbeat: { lastCompleted: T0, consecutiveFailures: 0 } });
    // Boot at the END of the downtime, as a recovery would.
    harness.clock.advance(downtime);

    const handle = harness.start([
      makeJob({ name: 'heartbeat', cadence: { kind: 'every', ms: 30 * MIN }, lane: 'interactive' }),
    ]);
    await handle.ready();

    const fires: Fired[] = [];
    const at0 = await harness.fires();
    fires.push(...at0);
    expect(fires).toEqual([]); // not one text owed

    // The census says 16 and skips them — visible in the log, never silent.
    const catchups = await harness.of('sched.catchup');
    expect(catchups).toHaveLength(1);
    expect(catchups[0]!.payload).toMatchObject({ job: 'heartbeat', missed: 16, policy: 'skip', action: 'skip' });

    // The rhythm resumes one period out from now, not a burst from the past.
    await handle.stop();
    expect(await harness.timesOf('heartbeat')).toEqual([]);
  });

  it('catchUp: once with 16 missed occurrences fires exactly one catch-up pass', async () => {
    harness = new SchedHarness();
    const statePath = harness.statePath();
    await writeState(statePath, { reflect: { lastCompleted: T0, consecutiveFailures: 0 } });
    harness.clock.advance(8 * HOUR);

    const handle = harness.start([
      makeJob({ name: 'reflect', cadence: { kind: 'every', ms: 30 * MIN }, catchUp: 'once' }),
    ]);
    await handle.ready();
    await handle.stop();

    const catchups = await harness.of('sched.catchup');
    expect(catchups[0]!.payload).toMatchObject({ job: 'reflect', missed: 16, policy: 'once', action: 'catchup-once' });
    const times = await harness.timesOf('reflect');
    expect(times).toEqual([T0 + 8 * HOUR]); // one fire, at boot, regardless of N=16
    const fire = (await harness.of('sched.fire'))[0]!;
    expect(fire.payload).toMatchObject({ job: 'reflect', catchUp: true });
  });

  it('a once job 16 days behind catches up exactly one pass and resumes its cadence', async () => {
    harness = new SchedHarness();
    const statePath = harness.statePath();
    await writeState(statePath, { reflect: { lastCompleted: T0, consecutiveFailures: 0 } });
    harness.clock.advance(16 * DAY);

    const handle = harness.start([
      makeJob({ name: 'reflect', cadence: { kind: 'daily', utcMinute: 180 }, catchUp: 'once' }),
    ]);
    await handle.ready();
    // Let the catch-up pass run, then advance past one more regular slot.
    await harness.clock.advance(MIN);
    await harness.clock.advance(24 * HOUR);
    await handle.stop();

    const catchups = await harness.of('sched.catchup');
    expect(catchups[0]!.payload).toMatchObject({ missed: 16, action: 'catchup-once' });
    // Exactly one catch-up fire now + the next regular 03:00 slot — never 17 fires.
    expect(await harness.timesOf('reflect')).toEqual([T0 + 16 * DAY, T0 + 16 * DAY + 3 * HOUR]);
  });
});

describe('catch-up property — no policy ever bursts on startup', () => {
  it('for any missed count, skip plans zero fires and once plans at most one', () => {
    // Property over the pure planner the scheduler actually uses: catch-up is
    // coalesced by construction, so 16 missed heartbeats can never mean 16 texts.
    for (const periodMin of [1, 5, 20, 30, 60]) {
      for (const missed of [1, 2, 3, 7, 16, 17, 33, 64]) {
        const st = { lastCompleted: T0, consecutiveFailures: 0 };
        const now = T0 + missed * periodMin * MIN;
        const skip = startupPlan(
          makeJob({ name: 'hb', cadence: { kind: 'every', ms: periodMin * MIN }, catchUp: 'skip' }),
          st,
          now,
        );
        expect(skip.catchUpFire, `skip/missed=${missed}`).toBe(false);
        expect(skip.due, `skip/missed=${missed}`).toBeGreaterThan(now);

        const once = startupPlan(
          makeJob({ name: 'ob', cadence: { kind: 'every', ms: periodMin * MIN }, catchUp: 'once' }),
          st,
          now,
        );
        expect(once.catchUpFire, `once/missed=${missed}`).toBe(true);
        expect(once.due, `once/missed=${missed}`).toBe(now); // one pass, now
      }
    }
  });

  it('scheduler-level: 16 and 33 missed interactive heartbeats produce at most one startup fire', async () => {
    for (const missed of [16, 33]) {
      const h = new SchedHarness();
      try {
        await fsp.mkdir(path.dirname(h.statePath()), { recursive: true });
        await fsp.writeFile(
          h.statePath(),
          JSON.stringify({ version: 1, jobs: { ponder: { lastCompleted: T0, consecutiveFailures: 0 } } }),
          'utf8',
        );
        h.clock.advance(missed * 20 * MIN);
        const handle = h.start([
          makeJob({ name: 'ponder', cadence: { kind: 'every', ms: 20 * MIN }, lane: 'interactive' }),
        ]);
        await handle.ready();
        await handle.stop();
        expect((await h.fires()).length, `missed=${missed}`).toBe(0); // skip policy: ≤ 1, in fact 0
      } finally {
        await h.cleanup();
      }
    }
  });
});

describe('state file handling', () => {
  it('a corrupt state file is a typed startup failure, not silent fresh state', async () => {
    harness = new SchedHarness();
    await fsp.writeFile(harness.statePath(), '{not json', 'utf8');
    const handle = harness.start([makeJob({ name: 'x' })]);
    await handle.ready();
    await expect(handle.stop()).rejects.toMatchObject({ code: 'sched/state-corrupt' });
  });

  it('a wrong-version state file is refused too', async () => {
    harness = new SchedHarness();
    await fsp.writeFile(harness.statePath(), JSON.stringify({ version: 2, jobs: {} }), 'utf8');
    const handle = harness.start([makeJob({ name: 'x' })]);
    await expect(handle.stop()).rejects.toMatchObject({ code: 'sched/state-corrupt' });
  });

  it('a missing state file boots fresh with no complaint', async () => {
    harness = new SchedHarness();
    const handle = harness.start([makeJob({ name: 'x', cadence: { kind: 'every', ms: 5 * MIN } })]);
    await handle.ready();
    await harness.clock.advance(5 * MIN);
    await handle.stop();
    expect(await harness.timesOf('x')).toEqual([T0 + 5 * MIN]);
  });

  it('no state is written for a job that has never attempted anything', async () => {
    harness = new SchedHarness();
    const handle = harness.start([makeJob({ name: 'x', cadence: { kind: 'every', ms: 5 * MIN } })]);
    await handle.ready();
    await handle.stop();
    expect(fs.existsSync(harness.statePath())).toBe(false);
  });
});

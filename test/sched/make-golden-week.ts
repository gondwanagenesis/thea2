// One-shot generator for golden-week.json (the committed fire sequence for the
// simulated week). Run manually when the week fixture's SEMANTICS change —
// deliberately never from tests, so the fixture is an expectation, not a snapshot:
//
//   npx tsx test/sched/make-golden-week.ts

import * as fs from 'node:fs';
import * as path from 'node:path';
import { SchedHarness, T0, WEEK, runWeek } from './helpers.js';

const main = async (): Promise<void> => {
  const h = new SchedHarness(T0, 'sched-test');
  try {
    const fires = await runWeek(h);
    const fixture = {
      comment: 'Committed sched.fire sequence for one simulated week (TestClock) over weekJobs(). Expectation, not snapshot — regenerate only when the week semantics change.',
      startMs: T0,
      weekMs: WEEK,
      fires: fires.map((f) => ({ at: f.at, job: f.job, lateMs: f.lateMs, catchUp: f.catchUp })),
    };
    const out = path.join(import.meta.dirname, 'golden-week.json');
    fs.writeFileSync(out, JSON.stringify(fixture, null, 2) + '\n', 'utf8');
    console.log(`wrote ${out} with ${fires.length} fires`);
  } finally {
    await h.cleanup();
  }
};

void main();

// M18 gate — the Ledger. The report is assembled from a REPLAYED event fixture
// (the runner replays L0 through its real path), the numbers are machine-rendered,
// and the page is pinned byte-for-byte: the spec calls this the report snapshot.
// The guardrail's two halves are both pinned here — refusals are LOGGED
// (`sibling.routing_refused`) and never written; accepted proposals ARE written
// to routing.json, which is itself the deploy-marker bump Nightingale watches.
// Absorbable failures (unreadable sched state, unreadable routing.json, a voice
// pass that will not render) are incidents; a report that cannot be written at
// all is a loud rejection.

import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { makeRng } from '../../src/kernel/rng.js';
import { canonicalJson } from '../../src/kernel/index.js';
import { renderLedgerBody, renderLedgerReport, runLedgerReport, ledgerJob } from '../../src/siblings/ledger.js';
import { aggregateWindow } from '../../src/siblings/aggregate.js';
import { LEDGER_JOB_NAME, LEDGER_TIMEOUT_MS, LEDGER_UTC_MINUTE, LEDGER_WINDOW_MS } from '../../src/siblings/types.js';
import type { LedgerReportData, LedgerTruths } from '../../src/siblings/ledger.js';
import type { Job, JobCtx } from '../../src/sched/index.js';
import {
  GOLDEN,
  HOT_DAY_EVIDENCE,
  T0,
  callEvent,
  eventsOf,
  goldenDay,
  harness,
  hotDay,
  rmDir,
  schedStateJson,
  writeText,
  type Harness,
  type HarnessOver,
} from './helpers.js';

// Temp roots, cleaned after each test (the repo's mkdtemp convention).
const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) rmDir(roots.pop()!);
});
const setup = (label: string, over: HarnessOver = {}): Harness => {
  const h = harness(label, over);
  roots.push(h.dirs.root);
  return h;
};

const VOICE = 'quiet day. the machines hum.';
/** The voice pass is scripted once per harness: one cheap summarize, one fixed opening. */
const voiced = (h: Harness): void => {
  h.model.onTask('summarize', () => ({ content: VOICE }));
};

const TURN_DAY_EVIDENCE = '24 calls, $6.00 (50.0% of window spend), p95 2000 ms, 0.0% parse failures';
const TURN_REFUSAL_REASON =
  `turn is pinned to the main tier in code (ADR-008) — the evidence was real (${TURN_DAY_EVIDENCE}), the answer is still no`;
const SUMMARIZE_PROPOSAL_REASON =
  `${HOT_DAY_EVIDENCE} — downgrade is cheap-tier-safe and Nightingale gates the change`;

/** The golden day's exact machine-rendered body — written out in full, since the
 * numbers ARE the contract. */
const GOLDEN_BODY = [
  '## model calls (trailing 24h)',
  '',
  '| task class | calls | in tok | out tok | cost | p50 ms | p95 ms | parse fails |',
  '|---|---:|---:|---:|---:|---:|---:|---:|',
  `| ${GOLDEN.aggs[0]!.taskClass} | 3 | 3300 | 630 | $0.75 | 14000 | 16000 | 2 |`,
  `| ${GOLDEN.aggs[1]!.taskClass} | 2 | 4100 | 610 | $1.00 | 1000 | 9000 | 0 |`,
  `| ${GOLDEN.aggs[2]!.taskClass} | 3 | 2650 | 330 | $0.50 | 600 | 700 | 1 |`,
  `| ${GOLDEN.aggs[3]!.taskClass} | 5 | 1500 | 350 | $2.25 | 3000 | 5000 | 1 |`,
  `| ${GOLDEN.aggs[4]!.taskClass} | 3 | 15300 | 2850 | $2.75 | 8000 | 9000 | 0 |`,
  '',
  'totals: 16 calls, 26850 tok in / 4770 tok out, $7.25, 23 attempts across 16 calls (retries included), 1 failed calls',
  'parse failures: 4 attributed + 2 unattributed; 3 malformed L0 rows skipped',
  '',
  '## operational truths',
  '',
  '- lost replies: 2 (oldest 90 min)',
  '- gate rejections: 2 loops, 4 re-entries — rules: low-arousal ×3, quiet-hours ×1',
  '- sched alarms: 2 — ledger-report ×1, ponder-seed ×1',
  '- gravity alarms: tilt ×1, unmoored ×2',
  '- consolidate alarms: 1',
  '- router guardrail warnings (model.routing_ignored): 1',
  '- incidents: incident.probe_timeout ×1',
  '- scheduler: ledger-report: last completed 30 min ago; probe-on-deploy: FAILING ×2, last completed never ago',
  '',
  '## routing',
  '',
  '- nothing hot enough to propose, nothing refused',
  '',
].join('\n');

const GOLDEN_REPORT = `# Ledger — 2023-11-14\n\n${VOICE}\n\n${GOLDEN_BODY}`;
const reportOf = (h: Harness, file: string): string => fs.readFileSync(file, 'utf8');

describe('the Ledger report from a replayed event fixture', () => {
  it('assembles the day exactly: every number, every operational truth, one page', async () => {
    const h = setup('ledger-golden', { l0: goldenDay(), schedState: schedStateJson(T0) });
    voiced(h);

    const run = await runLedgerReport(h.deps);

    // The run result carries the fold and the routing outcome...
    expect(run.file).toBe(path.join(h.dirs.reportsDir, 'ledger-2023-11-14.md'));
    expect(run.window).toEqual({ start: T0 - LEDGER_WINDOW_MS, end: T0 });
    expect(run.aggs).toEqual(GOLDEN.aggs);
    expect(run.stats).toEqual({ aggs: GOLDEN.aggs, ...GOLDEN.totals });
    expect(run.truths).toEqual({
      ...GOLDEN.truths,
      schedJobs: [
        { job: 'ledger-report', consecutiveFailures: 0, lastCompletedAgeMs: 30 * 60_000 },
        { job: 'probe-on-deploy', consecutiveFailures: 2, lastCompletedAgeMs: null },
      ],
      schedStateRead: true,
    });
    expect(run.routing).toEqual({ applied: [], refused: [], changed: false, unreadable: false });
    expect(run.voiced).toBe(true);

    // ...and the file is the exact page: the voice's opening on the machine body.
    expect(reportOf(h, run.file)).toBe(GOLDEN_REPORT);
    // A quiet day proposes nothing, refuses nothing, and writes no routing.json.
    expect(fs.existsSync(h.dirs.routingPath)).toBe(false);
    expect(eventsOf(h.log, 'sibling.routing_refused')).toEqual([]);
  });

  it('the voice pass is ONE cheap-tier summarize call, seeded by the injected persona', async () => {
    const h = setup('ledger-voice', { l0: goldenDay(), schedState: schedStateJson(T0) });
    voiced(h);

    await runLedgerReport(h.deps);

    expect(h.model.calls).toHaveLength(1);
    const req = h.model.calls[0]!;
    expect(req.taskClass).toBe('summarize');
    expect(req.tier).toBe('cheap');
    expect(req.maxTokens).toBe(400);
    expect(req.temperature).toBe(0.8);
    expect(req.messages[0]?.role).toBe('system');
    expect(req.messages[0]?.content).toBe('fixture ledger seed');
    expect(req.messages[1]?.role).toBe('user');
    expect(req.messages[1]?.content).toContain(GOLDEN_BODY); // the model sees the body it opens
  });

  it('tells L0 what happened: sibling.ledger_report with the day\'s headline numbers', async () => {
    const h = setup('ledger-event', { l0: goldenDay(), schedState: schedStateJson(T0) });
    voiced(h);

    await runLedgerReport(h.deps);

    const reports = eventsOf(h.log, 'sibling.ledger_report');
    expect(reports).toHaveLength(1);
    expect(reports[0]).toEqual({
      file: path.join(h.dirs.reportsDir, 'ledger-2023-11-14.md'),
      window: { start: T0 - LEDGER_WINDOW_MS, end: T0 },
      calls: 16,
      attempts: 23,
      costUsd: 7.25,
      parseFailures: 6, // 4 attributed + 2 unattributed
      lostReplies: 2,
      gateLoops: 2,
      schedAlarms: 2,
      gravityAlarms: 3,
      incidents: 1,
      routing: { applied: [], refused: [], changed: false },
    });
  });

  it('the window is the trailing UTC day, boundary inclusive', async () => {
    const h = setup('ledger-window', {
      l0: [
        callEvent({ ts: T0 - LEDGER_WINDOW_MS - 1, taskClass: 'derive', inputTokens: 1, outputTokens: 1, latencyMs: 1, attempts: 1 }), // before start
        callEvent({ ts: T0 - LEDGER_WINDOW_MS, taskClass: 'derive', inputTokens: 2, outputTokens: 1, latencyMs: 1, attempts: 1 }), // exactly at start
        callEvent({ ts: T0 - 60_000, taskClass: 'judge', inputTokens: 4, outputTokens: 1, latencyMs: 1, attempts: 1 }),
      ],
      schedState: schedStateJson(T0),
    });
    voiced(h);

    const run = await runLedgerReport(h.deps);

    expect(run.stats.calls).toBe(2);
    expect(run.stats.inputTokens).toBe(6); // the day-older call never entered the fold
  });

  it('is deterministic: the same replayed day, the same clock instant, byte-identical reports', async () => {
    const a = setup('ledger-det-a', { l0: goldenDay(), schedState: schedStateJson(T0) });
    const b = setup('ledger-det-b', { l0: goldenDay(), schedState: schedStateJson(T0) });
    voiced(a);
    voiced(b);

    const ra = await runLedgerReport(a.deps);
    const rb = await runLedgerReport(b.deps);

    expect(reportOf(a, ra.file)).toBe(GOLDEN_REPORT);
    expect(reportOf(b, rb.file)).toBe(reportOf(a, ra.file));
  });
});

describe('absorbable failures are incidents, and the report still carries every number', () => {
  it('an unreadable sched state file is an incident, not a dead report', async () => {
    const h = setup('ledger-sched-rot', { l0: goldenDay(), schedState: '{oops' });
    voiced(h);

    const run = await runLedgerReport(h.deps);

    expect(run.truths.schedStateRead).toBe(false);
    expect(run.truths.schedJobs).toEqual([]);
    const page = reportOf(h, run.file);
    expect(page).toContain('- scheduler: state file unreadable (see incidents)');
    expect(page).toContain('totals: 16 calls'); // the numbers survived
    const incidents = eventsOf(h.log, 'sibling.incident');
    expect(incidents).toHaveLength(1);
    // The message carries the parser's own prose; the source names the valve.
    expect(incidents[0]).toMatchObject({ source: 'sched-state' });
    expect(incidents[0]).toHaveProperty('message');
  });

  it('an unreadable routing.json blocks proposing AND writing: a human hand edit is never clobbered', async () => {
    const h = setup('ledger-routing-rot', { l0: hotDay(), schedState: schedStateJson(T0) });
    voiced(h);
    writeText(h.dirs.routingPath, '{ a human was here');
    const before = fs.readFileSync(h.dirs.routingPath, 'utf8');

    const run = await runLedgerReport(h.deps);

    expect(run.routing).toEqual({ applied: [], refused: [], changed: false, unreadable: true });
    expect(fs.readFileSync(h.dirs.routingPath, 'utf8')).toBe(before);
    const page = reportOf(h, run.file);
    expect(page).toContain('- routing.json: UNREADABLE — nothing proposed, nothing written (see incidents)');
    expect(page).not.toContain('- nothing hot enough to propose'); // the UNREADABLE line replaces the routing section
    expect(eventsOf(h.log, 'sibling.incident')).toEqual([
      { source: 'routing', message: expect.stringContaining('not valid JSON') },
    ]);
    expect(eventsOf(h.log, 'sibling.routing_refused')).toEqual([]); // never propose against an unseen table
  });

  it('a voice pass that will not render is an incident; the page keeps its numbers and drops the opening', async () => {
    const h = setup('ledger-voice-dead', { l0: goldenDay(), schedState: schedStateJson(T0) });
    h.model.onTask('summarize', () => ({ error: { code: 'model/transport', message: 'endpoint down' } }));

    const run = await runLedgerReport(h.deps);

    expect(run.voiced).toBe(false);
    expect(eventsOf(h.log, 'sibling.incident')).toEqual([
      { source: 'ledger-voice', code: 'model/transport', message: 'endpoint down' },
    ]);
    // No opening: the report is head + body, unvoiced but complete.
    expect(reportOf(h, run.file)).toBe(`# Ledger — 2023-11-14\n\n${GOLDEN_BODY}`);
  });

  it('a report that cannot be written kills the run loudly — M16 counts it, nothing pretends success', async () => {
    const h = setup('ledger-disk', { l0: goldenDay(), schedState: schedStateJson(T0) });
    voiced(h);
    // A directory path whose parent is a FILE: every write fails, like a full disk.
    const blocker = path.join(h.dirs.root, 'blocker');
    fs.writeFileSync(blocker, 'not a directory', 'utf8');
    h.deps.reportsDir = path.join(blocker, 'reports');

    await expect(runLedgerReport(h.deps)).rejects.toThrow();
    expect(eventsOf(h.log, 'sibling.ledger_report')).toEqual([]);
  });
});

describe('the guardrail on the writing end', () => {
  it('a hot summarize is proposed to cheap; hot turn is refused and logged, never written', async () => {
    const h = setup('ledger-hot', { l0: hotDay(), schedState: schedStateJson(T0) });
    voiced(h);

    const run = await runLedgerReport(h.deps);

    expect(run.routing.applied).toEqual([
      { taskClass: 'summarize', from: 'main', to: 'cheap', reason: SUMMARIZE_PROPOSAL_REASON },
    ]);
    expect(run.routing.refused).toEqual([
      { taskClass: 'turn', proposedTier: 'cheap', reason: TURN_REFUSAL_REASON },
    ]);
    expect(run.routing.changed).toBe(true);

    // The refusal is LOGGED on L0 — the guardrail's loud half.
    expect(eventsOf(h.log, 'sibling.routing_refused')).toEqual([
      { taskClass: 'turn', proposedTier: 'cheap', reason: TURN_REFUSAL_REASON },
    ]);

    // The proposal is WRITTEN — routing.json carries the override with its evidence,
    // in canonical bytes (key-sorted, so a re-read reparses to the same table).
    expect(fs.readFileSync(h.dirs.routingPath, 'utf8')).toBe(
      canonicalJson([{ taskClass: 'summarize', tier: 'cheap', reason: SUMMARIZE_PROPOSAL_REASON }]),
    );

    const page = reportOf(h, run.file);
    expect(page).toContain(`- proposed: summarize → cheap — ${SUMMARIZE_PROPOSAL_REASON}`);
    expect(page).toContain(`- refused: turn → cheap — ${TURN_REFUSAL_REASON}`);
    expect(page).toContain(
      '- routing.json updated: 1 override(s) now in force — that was a deploy, Nightingale runs within a minute',
    );
  });

  it('a second run re-refuses turn but never rewrites the table: the file bytes are stable', async () => {
    const h = setup('ledger-idempotent', { l0: hotDay(), schedState: schedStateJson(T0) });
    voiced(h);
    await runLedgerReport(h.deps);
    const afterFirst = fs.readFileSync(h.dirs.routingPath, 'utf8');
    const refusalsAfterFirst = eventsOf(h.log, 'sibling.routing_refused').length;

    const second = await runLedgerReport(h.deps);

    // summarize now rides cheap, so it is silence; turn is refused again — a
    // daily report never stops saying no.
    expect(second.routing.applied).toEqual([]);
    expect(second.routing.refused.map((r) => r.taskClass)).toEqual(['turn']);
    expect(second.routing.changed).toBe(false);
    expect(fs.readFileSync(h.dirs.routingPath, 'utf8')).toBe(afterFirst);
    expect(eventsOf(h.log, 'sibling.routing_refused')).toHaveLength(refusalsAfterFirst + 1);
    expect(reportOf(h, second.file)).toContain('- routing.json unchanged: 1 override(s) in force');
  });
});

describe('the pure renderers', () => {
  const EMPTY_TRUTHS: LedgerTruths = {
    lostReplies: 0,
    lostReplyMaxAgeMs: 0,
    gateLoops: 0,
    gateLoopReentries: 0,
    gateRules: [],
    schedAlarms: 0,
    schedAlarmJobs: [],
    gravityAlarms: [],
    consolidateAlarms: 0,
    routingIgnored: 0,
    incidents: [],
    schedJobs: [],
    schedStateRead: true,
  };

  const dataOf = (over: Partial<LedgerReportData> = {}): LedgerReportData => ({
    date: '2023-11-14',
    window: { start: T0 - LEDGER_WINDOW_MS, end: T0 },
    stats: aggregateWindow([]),
    truths: EMPTY_TRUTHS,
    proposed: [],
    refused: [],
    routingChanged: false,
    routingOverrides: 0,
    routingUnreadable: false,
    ...over,
  });

  it('a quiet window says so: no calls, every truth at zero, nothing proposed', () => {
    expect(renderLedgerBody(dataOf())).toBe(
      [
        '## model calls (trailing 24h)',
        '',
        'no model calls in the window',
        '',
        '## operational truths',
        '',
        '- lost replies: 0',
        '- gate rejections: 0 loops',
        '- sched alarms: 0',
        '- gravity alarms: none',
        '- consolidate alarms: 0',
        '- router guardrail warnings (model.routing_ignored): 0',
        '- incidents: none',
        '- scheduler: no jobs have run yet',
        '',
        '## routing',
        '',
        '- nothing hot enough to propose, nothing refused',
        '',
      ].join('\n'),
    );
  });

  it('the head is the date line; a blank voice is dropped, not rendered as an empty paragraph', () => {
    expect(renderLedgerReport('2023-11-14', '  opening  ', 'BODY')).toBe('# Ledger — 2023-11-14\n\nopening\n\nBODY');
    expect(renderLedgerReport('2023-11-14', '', 'BODY')).toBe('# Ledger — 2023-11-14\n\nBODY');
    expect(renderLedgerReport('2023-11-14', '   \n', 'BODY')).toBe('# Ledger — 2023-11-14\n\nBODY');
  });
});

describe('the daily job row (M16\'s table, M18\'s body)', () => {
  it('ledger-report: daily at minute 270 (04:30 UTC, the golden-week pin), maintenance, catch-up once, 5 min budget', () => {
    const job: Job = ledgerJob(setup('ledger-job').deps);
    expect(job.name).toBe(LEDGER_JOB_NAME);
    expect(job.name).toBe('ledger-report');
    expect(job.cadence).toEqual({ kind: 'daily', utcMinute: 270 });
    expect(LEDGER_UTC_MINUTE).toBe(270);
    expect(job.lane).toBe('maintenance');
    expect(job.catchUp).toBe('once'); // an obligation, not a mood
    expect(job.timeoutMs).toBe(LEDGER_TIMEOUT_MS);
    expect(job.timeoutMs).toBe(5 * 60_000);
  });

  it('the job body runs the report against M16\'s JobCtx (which satisfies SiblingRunCtx)', async () => {
    const h = setup('ledger-job-run', { l0: goldenDay(), schedState: schedStateJson(T0) });
    voiced(h);
    const ctx: JobCtx = {
      clock: h.clock,
      rng: makeRng('ledger-job'),
      signal: new AbortController().signal,
      events: h.log,
    };

    await ledgerJob(h.deps).run(ctx);

    expect(fs.existsSync(path.join(h.dirs.reportsDir, 'ledger-2023-11-14.md'))).toBe(true);
    expect(eventsOf(h.log, 'sibling.ledger_report')).toHaveLength(1);
  });

  it('with no ctx the deps\' own clock/rng/events are the run context (the CLI verb path)', async () => {
    const h = setup('ledger-no-ctx', { l0: goldenDay(), schedState: schedStateJson(T0) });
    voiced(h);

    const run = await runLedgerReport(h.deps);

    expect(run.window.end).toBe(T0);
    expect(eventsOf(h.log, 'sibling.ledger_report')).toHaveLength(1); // the deps' log heard it
  });
});

// M18 gate — Nightingale, the behavioral immune system. The trigger is the
// deploy marker (a change is checked once; a persona seed edit is not a deploy),
// the verdict comes from M19's own gate arithmetic through the runner seam, and
// the truth table is loud: green recommits the baseline, red leaves it
// byte-for-byte and names the regressing probes, yellow watches. Failure is loud
// too: a gateless runner is never graded green, a throwing runner propagates,
// and a failed run advances nothing — the next tick retries it.

import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { canonicalJson } from '../../src/kernel/index.js';
import { gateSuite } from '../../src/probes/baseline.js';
import type { ProbeBaseline } from '../../schemas/probe.js';
import { renderNightingaleBody, renderNightingaleReport, runNightingale, nightingaleJob } from '../../src/siblings/nightingale.js';
import type { NightingaleReportData } from '../../src/siblings/nightingale.js';
import { computeMarkerInputs, markerHash, readMarker } from '../../src/siblings/marker.js';
import { NIGHTINGALE_JOB_NAME, NIGHTINGALE_TIMEOUT_MS, PROBE_K, WATCHER_PERIOD_MS } from '../../src/siblings/types.js';
import { runLedgerReport } from '../../src/siblings/ledger.js';
import {
  eventsOf,
  gatelessRunner,
  harness,
  hotDay,
  probeResult,
  rmDir,
  scriptedRunner,
  writeText,
  type Harness,
  type HarnessOver,
} from './helpers.js';

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) rmDir(roots.pop()!);
});
const setup = (label: string, over: HarnessOver = {}): Harness => {
  const h = harness(label, over);
  roots.push(h.dirs.root);
  return h;
};

const VOICE = 'tonight the defenses held.';
const voiced = (h: Harness): void => {
  h.model.onTask('summarize', () => ({ content: VOICE }));
};

/** The marker inputs the harness's deps resolve to (recomputed independently). */
const inputsOf = (h: Harness) =>
  computeMarkerInputs({
    routingPath: h.dirs.routingPath,
    codeVersion: 'test-1',
    inhibitionsPath: h.dirs.inhibitionsPath,
    couplingPath: h.dirs.couplingPath,
    corpusDir: h.dirs.corpusDir,
  });

/** A stored normal for one probe, as the schema wants it. */
const baselineJson = (over: { judgeMedian?: number | null; drift?: Record<string, number>; version?: number } = {}): string =>
  JSON.stringify({
    version: over.version ?? 1,
    committedAtStage: 'fixture',
    probes: {
      'voice-cold-open': {
        judgeMedian: over.judgeMedian ?? 4.5,
        drift: over.drift ?? { voice: 0.95 },
        deterministicPass: true,
        judgeVariance: 0,
      },
    },
  });

const BASELINE_OBJ: ProbeBaseline = JSON.parse(baselineJson()) as ProbeBaseline;

describe('the watcher tick: trigger before spend', () => {
  it('the very first observation runs the suite — no stored marker must never mean silence', async () => {
    const h = setup('night-first');
    voiced(h);

    const run = await runNightingale(h.deps);

    expect(run.ran).toBe(true);
    expect(run.trigger).toBe('first-observation');
    expect(run.verdict).toBe('green');
    expect(run.markerDiff).toEqual([]);
    expect(run.reportFile).toBe(path.join(h.dirs.reportsDir, 'nightingale-20231114T221320000Z.md'));
    // The marker is stored, so the next tick knows what "unchanged" means.
    expect(await readMarker(h.deps.deployMarkerPath)).toEqual({
      version: 1,
      hash: markerHash(await inputsOf(h)),
      inputs: await inputsOf(h),
    });
  });

  it('an unchanged marker spends nothing: the tick is a no-op', async () => {
    const h = setup('night-quiet');
    voiced(h);
    await runNightingale(h.deps);

    const again = await runNightingale(h.deps);

    expect(again).toEqual({ ran: false });
    expect(h.runner.calls).toHaveLength(1); // one change, one live suite — not every minute
  });

  it('a marker change runs it again, and names what moved', async () => {
    const h = setup('night-change');
    voiced(h);
    await runNightingale(h.deps);
    writeText(h.dirs.routingPath, canonicalJson([{ taskClass: 'summarize', tier: 'cheap' }]));

    const run = await runNightingale(h.deps);

    expect(run.ran).toBe(true);
    expect(run.trigger).toBe('marker-change');
    expect(run.markerDiff).toEqual(['var/routing.json']);
  });

  it('force runs the suite even when nothing changed: the CLI verb', async () => {
    const h = setup('night-manual');
    voiced(h);
    await runNightingale(h.deps);

    const run = await runNightingale(h.deps, undefined, { force: true });

    expect(run.ran).toBe(true);
    expect(run.trigger).toBe('manual');
    expect(run.markerDiff).toEqual([]);
  });

  it('a persona seed edit is not a deploy: Nightingale sleeps', async () => {
    const h = setup('night-persona');
    voiced(h);
    await runNightingale(h.deps);
    writeText(path.join(h.dirs.personaDir, 'ledger.md'), 'seed v2 — a whole new voice\n');

    const run = await runNightingale(h.deps);

    expect(run).toEqual({ ran: false }); // voice for reports, never behavior
  });
});

describe('the verdict truth table (gated through M19\'s own arithmetic)', () => {
  it('green recommits the baseline and announces the new normal', async () => {
    const h = setup('night-green');
    voiced(h);

    const run = await runNightingale(h.deps);

    expect(run.verdict).toBe('green');
    expect(run.baselineRecommitted).toBe(true);
    expect(JSON.parse(fs.readFileSync(h.deps.baselinePath, 'utf8'))).toEqual({
      version: 1,
      committedAtStage: 'nightingale',
      probes: {
        'voice-cold-open': { judgeMedian: 4.5, drift: { voice: 0.95 }, deterministicPass: true, judgeVariance: 0 },
      },
    });
    expect(eventsOf(h.log, 'sibling.baseline_recommitted')).toEqual([
      { file: h.deps.baselinePath, version: 1, probes: 1 },
    ]);
    expect(eventsOf(h.log, 'sibling.nightingale_red')).toEqual([]);
    expect(eventsOf(h.log, 'sibling.nightingale_yellow')).toEqual([]);
  });

  it('red leaves the baseline byte-for-byte, names the regressor, and does not re-fire', async () => {
    const h = setup('night-red', {
      baseline: baselineJson({ judgeMedian: 4.5 }),
      runner: scriptedRunner([probeResult({ judgeMedian: 3 })]), // a drop of 1.5, red's line is 0.8
    });
    voiced(h);
    const baselineBefore = fs.readFileSync(h.deps.baselinePath, 'utf8');

    const run = await runNightingale(h.deps);

    expect(run.verdict).toBe('red');
    expect(run.regressing).toEqual(['voice-cold-open']);
    expect(run.baselineRecommitted).toBe(false);
    expect(fs.readFileSync(h.deps.baselinePath, 'utf8')).toBe(baselineBefore); // preserved, not rolled forward
    expect(eventsOf(h.log, 'sibling.nightingale_red')).toEqual([
      { verdict: 'red', regressing: ['voice-cold-open'], markerDiff: [] },
    ]);
    // One change = one probe run: the report and the alarm are the loudness, not
    // a re-fire every minute.
    expect(await runNightingale(h.deps)).toEqual({ ran: false });
  });

  it('a drift-only drop is yellow: watch, preserve, keep going', async () => {
    const h = setup('night-yellow', {
      baseline: baselineJson({ drift: { voice: 0.95 } }),
      runner: scriptedRunner([probeResult({ judgeMedian: 4.5, drift: { voice: 0.85 } })]), // drop 0.1 > 0.05
    });
    voiced(h);
    const baselineBefore = fs.readFileSync(h.deps.baselinePath, 'utf8');

    const run = await runNightingale(h.deps);

    expect(run.verdict).toBe('yellow');
    expect(run.regressing).toEqual([]); // yellow warns; only red names regressors
    expect(fs.readFileSync(h.deps.baselinePath, 'utf8')).toBe(baselineBefore);
    expect(eventsOf(h.log, 'sibling.nightingale_yellow')).toEqual([
      { verdict: 'yellow', regressing: [], markerDiff: [] },
    ]);
    expect(eventsOf(h.log, 'sibling.nightingale_red')).toEqual([]);
  });

  it('a deterministic failure is red whatever the scores say — shape is non-negotiable', async () => {
    const h = setup('night-shape', {
      baseline: baselineJson({ judgeMedian: 4.5 }),
      runner: scriptedRunner([probeResult({ judgeMedian: 4.5, deterministicPass: false })]),
    });
    voiced(h);

    const run = await runNightingale(h.deps);

    expect(run.verdict).toBe('red');
    expect(run.regressing).toEqual(['voice-cold-open']);
    expect(eventsOf(h.log, 'sibling.nightingale_red')).toHaveLength(1);
  });
});

describe('failure is loud, and silence is never graded green', () => {
  it('a runner that is not the M19 seam (no gate report) is a typed error, not a green', async () => {
    const h = setup('night-gateless');
    h.deps.probes = gatelessRunner([probeResult({ judgeMedian: 4.5 })]);

    await expect(runNightingale(h.deps)).rejects.toMatchObject({ code: 'siblings/no-gate' });

    expect(eventsOf(h.log, 'sibling.baseline_recommitted')).toEqual([]);
    expect(fs.existsSync(h.deps.deployMarkerPath)).toBe(false); // a failed run advances nothing
    // The next tick retries — the marker never moved, so it is still the first
    // observation.
    h.deps.probes = scriptedRunner([probeResult({ judgeMedian: 4.5, drift: { voice: 0.95 } })]);
    const retry = await runNightingale(h.deps);
    expect(retry.ran).toBe(true);
    expect(retry.trigger).toBe('first-observation');
  });

  it('a throwing runner propagates (M16 counts it; the alarm is at three) and advances nothing', async () => {
    const runner = scriptedRunner([probeResult({})]);
    const h = setup('night-dead', { runner });
    runner.failNextWith(new Error('runner exploded'));

    await expect(runNightingale(h.deps)).rejects.toThrow('runner exploded');

    expect(fs.existsSync(h.deps.deployMarkerPath)).toBe(false);
    expect(eventsOf(h.log, 'sibling.baseline_recommitted')).toEqual([]);
    // The failure was consumed; the next tick runs the suite for real.
    const retry = await runNightingale(h.deps);
    expect(retry.ran).toBe(true);
    expect(retry.verdict).toBe('green');
  });
});

describe('the runner seam contract (k, dry, baseline)', () => {
  it('probes run k=3, live, gated against the baseline that was read', async () => {
    expect(PROBE_K).toBe(3);
    const h = setup('night-seam', { baseline: baselineJson({ judgeMedian: 4.5 }) });
    voiced(h);

    await runNightingale(h.deps);

    expect(h.runner.calls).toEqual([
      {
        k: 3,
        dry: false,
        baseline: JSON.parse(baselineJson({ judgeMedian: 4.5 })),
      },
    ]);
  });

  it('with no baseline yet, the runner is asked to gate against nothing', async () => {
    const h = setup('night-seam-null');
    voiced(h);

    await runNightingale(h.deps);

    expect(h.runner.calls).toEqual([{ k: 3, dry: false, baseline: null }]);
  });
});

describe('the report', () => {
  const results = () => [probeResult({ probeId: 'voice-cold-open', judgeMedian: 4.5, drift: { voice: 0.95 } })];

  const dataOf = (over: Partial<NightingaleReportData> = {}): NightingaleReportData => {
    const rs = over.suite?.results ?? results();
    return {
      stamp: '20231114T221320000Z',
      verdict: 'green',
      trigger: 'first observation',
      markerDiff: [],
      markerHash: 'a'.repeat(64),
      previousMarkerHash: null,
      baselineAction: 'recommitted',
      baselineVersion: 1,
      suite: over.suite ?? { results: rs, gate: gateSuite(rs, null), modelCalls: 6, dry: false },
      ...over,
    };
  };

  it('the body is machine-rendered: verdict, trigger, marker, gate table, findings, spend', () => {
    expect(renderNightingaleBody(dataOf())).toBe(
      [
        'verdict: green',
        'trigger: first observation',
        `marker: ${'a'.repeat(19)}… (no stored marker)`,
        'baseline: recommitted (version 1)',
        '',
        '## gate (k=3, live)',
        '',
        '| probe | verdict | deterministic | judge median | drift |',
        '|---|---|---|---|---|',
        '| voice-cold-open | green | pass | 4.5 (no baseline) | voice —→0.95 |',
        '',
        'regressing: none',
        'rules: deterministic failure ⇒ red · judge median drop > 0.8 ⇒ red · drift cosine drop > 0.05 ⇒ yellow',
        '',
        '## findings',
        '',
        '- nothing to flag',
        '',
        '## spend',
        '',
        '6 judge call(s) — k=3 × 1 rubric-bearing probe(s), dry: no',
        '',
      ].join('\n'),
    );
  });

  it('a red page names what changed, what regressed, and why', () => {
    const rs = [probeResult({ probeId: 'voice-cold-open', judgeMedian: 3 })];
    const data = dataOf({
      verdict: 'red',
      trigger: 'marker change',
      markerDiff: ['var/routing.json'],
      previousMarkerHash: 'b'.repeat(64),
      baselineAction: 'preserved',
      baselineVersion: 1,
      suite: { results: rs, gate: gateSuite(rs, BASELINE_OBJ), modelCalls: 6, dry: false },
    });
    const body = renderNightingaleBody(data);

    expect(body.split('\n').slice(0, 4)).toEqual([
      'verdict: red',
      'trigger: marker change (var/routing.json)',
      `marker: ${'a'.repeat(19)}… (was ${'b'.repeat(19)}…)`,
      'baseline: preserved (version 1)',
    ]);
    expect(body).toContain('| voice-cold-open | red | pass | 4.5 → 3 | voice 0.95→— |');
    expect(body).toContain('regressing: voice-cold-open');
    expect(body).toContain('- voice-cold-open: judge median 4.5 → 3 (drop 1.5 > 0.8)');
  });

  it('a gateless suite is rendered as ungated: no table, no findings, no verdicts', () => {
    const body = renderNightingaleBody(dataOf({ suite: { results: results(), modelCalls: 0, dry: false } }));
    expect(body).toContain('no gate report — the runner returned results without gating');
    expect(body).not.toContain('regressing'); // nothing was graded
    // Spend reads the results, not the (missing) gate: the rubric was still borne.
    expect(body).toContain('0 judge call(s) — k=3 × 1 rubric-bearing probe(s), dry: no');
  });

  it('the head is fixed; a blank voice is dropped, not rendered as an empty paragraph', () => {
    expect(renderNightingaleReport('  opening  ', 'BODY')).toBe('# Nightingale\n\nopening\n\nBODY');
    expect(renderNightingaleReport('', 'BODY')).toBe('# Nightingale\n\nBODY');
  });

  it('the report lands at var/reports/nightingale-<UTC stamp>.md with the voice opening', async () => {
    const h = setup('night-file');
    voiced(h);

    const run = await runNightingale(h.deps);

    expect(fs.existsSync(run.reportFile!)).toBe(true);
    const page = fs.readFileSync(run.reportFile!, 'utf8');
    expect(page.startsWith(`# Nightingale\n\n${VOICE}\n\nverdict: green\ntrigger: first observation\n`)).toBe(true);
    expect(page).toContain('## spend');
  });

  it('a voice pass that will not render is an incident; the report and the marker still land', async () => {
    const h = setup('night-voice-dead');
    h.model.onTask('summarize', () => ({ error: { code: 'model/transport', message: 'endpoint down' } }));

    const run = await runNightingale(h.deps);

    expect(run.ran).toBe(true); // the immune system ran; only its voice failed
    expect(eventsOf(h.log, 'sibling.incident')).toEqual([
      { source: 'nightingale-voice', code: 'model/transport', message: 'endpoint down' },
    ]);
    expect(fs.existsSync(run.reportFile!)).toBe(true);
    expect(fs.readFileSync(run.reportFile!, 'utf8').startsWith('# Nightingale\n\nverdict: green')).toBe(true);
    expect(await readMarker(h.deps.deployMarkerPath)).not.toBeNull(); // the run was handled
  });
});

describe('the handoff: an applied routing change is a deploy Nightingale sees', () => {
  it('ledger run writes routing.json; the very next watcher tick fires with that diff', async () => {
    const h = setup('night-handoff', { l0: hotDay() });
    voiced(h);

    const first = await runNightingale(h.deps); // establishes the stored marker
    expect(first.ran).toBe(true);
    expect(await runNightingale(h.deps)).toEqual({ ran: false }); // quiet until something changes

    const ledger = await runLedgerReport(h.deps); // proposes summarize → cheap, writes routing.json
    expect(ledger.routing.changed).toBe(true);

    const tick = await runNightingale(h.deps); // within one minute in production
    expect(tick).toMatchObject({ ran: true, trigger: 'marker-change', markerDiff: ['var/routing.json'] });
  });
});

describe("the watcher job row (M16's table, M18's body)", () => {
  it('probe-on-deploy: every minute, maintenance lane, catch-up skip, 15 min budget', () => {
    const job = nightingaleJob(setup('night-job').deps);
    expect(job.name).toBe(NIGHTINGALE_JOB_NAME);
    expect(job.name).toBe('probe-on-deploy');
    expect(job.cadence).toEqual({ kind: 'every', ms: 60_000 });
    expect(WATCHER_PERIOD_MS).toBe(60_000);
    expect(job.lane).toBe('maintenance');
    expect(job.catchUp).toBe('skip'); // a change is checked once; 60 missed checks are not 60 probe runs
    expect(job.timeoutMs).toBe(NIGHTINGALE_TIMEOUT_MS);
    expect(job.timeoutMs).toBe(15 * 60_000);
  });
});

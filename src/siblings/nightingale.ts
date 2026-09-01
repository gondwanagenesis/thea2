// M18 siblings — Nightingale: the behavioral immune system.
//
// Trigger is the deploy marker: a content hash over {code version, routing.json,
// inhibitions.yaml, coupling.yaml, corpus hash}, watched every minute
// (catchUp 'skip' — one change is checked once) or fired manually by the CLI.
// On trigger: run the live probe suite through M19's runner (k=3, median),
// gate against probes/baseline.json with M19's own arithmetic, write
// var/reports/nightingale-<ts>.md, and be LOUD about the verdict:
//   red    ⇒ `sibling.nightingale_red`, baseline preserved byte-for-byte
//   yellow ⇒ `sibling.nightingale_yellow` (watch), baseline preserved
//   green  ⇒ `sibling.baseline_recommitted` — the new normal
// A red also names the marker diff in the report: what changed to cause this.
//
// Failure is loud by construction: a throwing runner propagates, M16 counts it,
// and the third consecutive failure is `sched.alarm` — a dead immune system is
// worse than none.

import * as path from 'node:path';
import { ProbeError } from '../probes/index.js';
import {
  DRIFT_DROP_YELLOW,
  JUDGE_DROP_RED,
  loadBaseline,
  writeBaseline,
  type GateVerdict,
  type ProbeResult,
  type ProbeSuiteResult,
} from '../probes/index.js';
import { atomicWriteText } from '../kernel/index.js';
import type { Job, JobCtx } from '../sched/index.js';
import type { SiblingDeps, SiblingRunCtx } from './types.js';
import { NIGHTINGALE_JOB_NAME, NIGHTINGALE_TIMEOUT_MS, PROBE_K, WATCHER_PERIOD_MS, runCtx } from './types.js';
import { computeMarkerInputs, diffMarker, markerHash, readMarker, writeMarker } from './marker.js';
import { loadPersonaSeed } from './persona.js';
import { emitSiblingIncident } from './util.js';

// ---------------------------------------------------------------------------
// Report rendering (pure, machine-rendered body)
// ---------------------------------------------------------------------------

export interface NightingaleReportData {
  stamp: string;
  verdict: GateVerdict;
  trigger: 'marker change' | 'first observation' | 'manual';
  markerDiff: string[];
  markerHash: string;
  previousMarkerHash: string | null;
  baselineAction: 'recommitted' | 'preserved';
  baselineVersion: number | null;
  suite: ProbeSuiteResult;
}

export const renderNightingaleBody = (data: NightingaleReportData): string => {
  const L: string[] = [];
  const gate = data.suite.gate;

  L.push(
    `verdict: ${data.verdict}`,
    `trigger: ${data.trigger}${data.markerDiff.length > 0 ? ` (${data.markerDiff.join(', ')})` : ''}`,
    `marker: ${short(data.markerHash)}${data.previousMarkerHash === null ? ' (no stored marker)' : ` (was ${short(data.previousMarkerHash)})`}`,
    `baseline: ${data.baselineAction}${data.baselineVersion !== null ? ` (version ${data.baselineVersion})` : ''}`,
    '',
  );

  L.push(`## gate (k=${PROBE_K}, ${data.suite.dry ? 'dry' : 'live'})`, '');
  if (gate === undefined) {
    L.push('no gate report — the runner returned results without gating', '');
  } else {
    L.push('| probe | verdict | deterministic | judge median | drift |');
    L.push('|---|---|---|---|---|');
    for (const p of gate.probes) {
      const r = data.suite.results.find((x) => x.probeId === p.probeId);
      L.push(
        `| ${p.probeId} | ${p.verdict} | ${r?.deterministic.pass === true ? 'pass' : 'FAIL'} ` +
          `| ${judgeCell(p.baseline?.judgeMedian ?? null, r?.judgeMedian ?? null)} ` +
          `| ${driftCell(p.baseline?.drift ?? null, r?.drift ?? null)} |`,
      );
    }
    L.push('');
    L.push(
      gate.regressing.length > 0
        ? `regressing: ${gate.regressing.join(', ')}`
        : 'regressing: none',
    );
    L.push(
      `rules: deterministic failure ⇒ red · judge median drop > ${JUDGE_DROP_RED} ⇒ red · ` +
        `drift cosine drop > ${DRIFT_DROP_YELLOW} ⇒ yellow`,
    );
    L.push('');
    const findings = gate.probes.flatMap((p) => p.reasons.map((reason) => `- ${p.probeId}: ${reason}`));
    L.push('## findings', '');
    L.push(findings.length > 0 ? findings.join('\n') : '- nothing to flag');
    L.push('');
  }

  L.push('## spend', '');
  L.push(
    `${data.suite.modelCalls} judge call(s) — k=${PROBE_K} × ${data.suite.results.filter((r) => r.judgeMedian !== null).length} rubric-bearing probe(s), dry: ${data.suite.dry ? 'yes' : 'no'}`,
  );
  L.push('');
  return L.join('\n');
};

const short = (hash: string): string => (hash.length > 19 ? `${hash.slice(0, 19)}…` : hash);

const judgeCell = (baseline: number | null, now: number | null): string =>
  baseline === null ? (now === null ? '—' : `${now} (no baseline)`) : `${baseline} → ${now ?? '—'}`;

const driftCell = (baseline: Record<string, number> | null, now: Record<string, number> | null): string => {
  const dims = new Set([...Object.keys(baseline ?? {}), ...Object.keys(now ?? {})]);
  if (dims.size === 0) return '—';
  return [...dims]
    .sort()
    .map((d) => {
      const b = baseline?.[d];
      const n = now?.[d];
      return `${d} ${b === undefined ? '—' : b}→${n === undefined ? '—' : n}`;
    })
    .join(', ');
};

export const renderNightingaleReport = (voice: string, body: string): string => {
  const opening = voice.trim();
  const head = '# Nightingale\n\n';
  return opening.length > 0 ? `${head}${opening}\n\n${body}` : `${head}${body}`;
};

// ---------------------------------------------------------------------------
// The voice pass — one cheap-tier call, persona-seeded
// ---------------------------------------------------------------------------

const voicePrompt = (verdict: GateVerdict, body: string): string =>
  [
    "here is tonight's machine-rendered probe report. write the opening.",
    `the verdict is ${verdict}. the table below stays in the file verbatim. two or three sentences.`,
    '',
    '---',
    body,
  ].join('\n');

const voicePass = async (deps: SiblingDeps, c: SiblingRunCtx, verdict: GateVerdict, body: string): Promise<string> => {
  const seed = loadPersonaSeed('nightingale', deps.personaDir);
  const reply = await deps.model.chat(
    {
      taskClass: 'summarize',
      tier: 'cheap',
      messages: [
        { role: 'system', content: seed },
        { role: 'user', content: voicePrompt(verdict, body) },
      ],
      maxTokens: 400,
      temperature: 0.8,
    },
    { ...(c.signal !== undefined ? { signal: c.signal } : {}) },
  );
  return reply.content;
};

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export type NightingaleTrigger = 'marker-change' | 'first-observation' | 'manual';

export interface NightingaleRunResult {
  /** False = the marker had not changed and nothing ran. */
  ran: boolean;
  trigger?: NightingaleTrigger | undefined;
  verdict?: GateVerdict | undefined;
  regressing?: string[] | undefined;
  markerDiff?: string[] | undefined;
  reportFile?: string | undefined;
  baselineRecommitted?: boolean | undefined;
}

/**
 * One watcher tick. Reads the marker inputs, compares to the stored marker, and
 * only then spends a live suite. The stored marker advances AFTER a handled run
 * (green, yellow or red): one change = one probe run, and a red stays loud
 * through its alarm event + report rather than re-firing every minute. A failed
 * run advances nothing, so the next tick retries it (with M16's backoff, and the
 * alarm at three).
 */
export const runNightingale = async (
  deps: SiblingDeps,
  ctx?: Partial<SiblingRunCtx> | undefined,
  opts?: { force?: boolean | undefined },
): Promise<NightingaleRunResult> => {
  const c = runCtx(deps, ctx);

  const inputs = await computeMarkerInputs({
    routingPath: deps.routingPath,
    ...(deps.marker?.codeVersion !== undefined ? { codeVersion: deps.marker.codeVersion } : {}),
    ...(deps.marker?.inhibitionsPath !== undefined ? { inhibitionsPath: deps.marker.inhibitionsPath } : {}),
    ...(deps.marker?.couplingPath !== undefined ? { couplingPath: deps.marker.couplingPath } : {}),
    ...(deps.marker?.corpusDir !== undefined ? { corpusDir: deps.marker.corpusDir } : {}),
  });
  const hash = markerHash(inputs);
  const previous = await readMarker(deps.deployMarkerPath);

  const trigger: NightingaleTrigger | null =
    previous === null
      ? 'first-observation'
      : previous.hash !== hash
        ? 'marker-change'
        : opts?.force === true
          ? 'manual'
          : null;
  if (trigger === null) return { ran: false };

  const markerDiff = previous === null ? [] : diffMarker(previous.inputs, inputs);

  const baseline = loadBaseline(deps.baselinePath);
  const suite = await deps.probes.runAll({ k: PROBE_K, dry: false, baseline: baseline ?? null });
  const gate = suite.gate;
  if (gate === undefined) {
    // M19's runner gates whenever a baseline is supplied; a gateless result means
    // the injected runner is not the M19 seam — never grade silence as green.
    throw new ProbeError('siblings/no-gate', 'probe runner returned a suite with no gate report');
  }

  let baselineRecommitted = false;
  let baselineVersion: number | null = baseline?.version ?? null;
  if (gate.verdict === 'green') {
    const recommitted = await writeBaseline(deps.baselinePath, suite.results, { stage: 'nightingale' });
    baselineRecommitted = true;
    baselineVersion = recommitted.version;
    await c.events.emit('sibling.baseline_recommitted', {
      file: deps.baselinePath,
      version: recommitted.version,
      probes: suite.results.length,
    });
  } else if (gate.verdict === 'red') {
    await c.events.emit('sibling.nightingale_red', {
      verdict: 'red',
      regressing: gate.regressing,
      markerDiff,
    });
  } else {
    await c.events.emit('sibling.nightingale_yellow', {
      verdict: 'yellow',
      regressing: gate.regressing,
      markerDiff,
    });
  }

  const data: NightingaleReportData = {
    stamp: c.clock.now().toISOString().replace(/[-:.]/g, ''),
    verdict: gate.verdict,
    trigger: trigger === 'marker-change' ? 'marker change' : trigger === 'first-observation' ? 'first observation' : 'manual',
    markerDiff,
    markerHash: hash,
    previousMarkerHash: previous?.hash ?? null,
    baselineAction: baselineRecommitted ? 'recommitted' : 'preserved',
    baselineVersion,
    suite,
  };
  const body = renderNightingaleBody(data);

  let voice = '';
  try {
    voice = await voicePass(deps, c, gate.verdict, body);
  } catch (e) {
    await emitSiblingIncident(c.events, 'nightingale-voice', e);
  }

  const reportFile = path.join(deps.reportsDir, `nightingale-${data.stamp}.md`);
  await atomicWriteText(reportFile, renderNightingaleReport(voice, body));

  await writeMarker(deps.deployMarkerPath, inputs);

  return {
    ran: true,
    trigger,
    verdict: gate.verdict,
    regressing: gate.regressing,
    markerDiff,
    reportFile,
    baselineRecommitted,
  };
};

/** The watcher — M16's `probe-on-deploy` row: 1 min, maintenance lane, no catch-up. */
export const nightingaleJob = (deps: SiblingDeps): Job => ({
  name: NIGHTINGALE_JOB_NAME,
  cadence: { kind: 'every', ms: WATCHER_PERIOD_MS },
  lane: 'maintenance',
  catchUp: 'skip',
  timeoutMs: NIGHTINGALE_TIMEOUT_MS,
  run: async (ctx: JobCtx) => {
    await runNightingale(deps, ctx);
  },
});

// Re-exported for the tests that pin the truth table through this seam.
export type { ProbeResult };

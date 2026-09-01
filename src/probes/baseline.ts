// M19 probes — the baseline + gate machinery.
//
// probes/baseline.json is the recorded normal: per-probe scores + drift, recommit
// after each ACCEPTED change. The gate is deliberately boring arithmetic — red /
// yellow / green by three exact rules — because the interesting question ("is
// she still herself?") must never be decided by fuzzy comparison. M18 consumes
// the verdict; M19 computes it.

import * as fs from 'node:fs';
import { atomicWriteJson } from '../kernel/index.js';
import { ProbeBaseline, type BaselineEntry } from '../../schemas/probe.js';
import { DRIFT_DROP_YELLOW, JUDGE_DROP_RED, type GateVerdict, type ProbeGateReport, type ProbeResult, type SuiteGateReport } from './types.js';
import { ProbeError, zodIssuesText } from './errors.js';

export type { BaselineEntry };

/** Reads + validates probes/baseline.json. A missing file is a null baseline (first ever run). */
export const loadBaseline = (filePath: string): ProbeBaseline | null => {
  if (!fs.existsSync(filePath)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    throw new ProbeError('probes/baseline', `baseline ${filePath} is not valid JSON: ${String(e)}`, { file: filePath, cause: e });
  }
  const parsed = ProbeBaseline.safeParse(raw);
  if (!parsed.success) {
    throw new ProbeError('probes/baseline', `baseline ${filePath} violates the schema: ${zodIssuesText(parsed.error)}`, {
      file: filePath,
    });
  }
  return parsed.data;
};

/** The result → baseline-row projection (what a green run recommits). */
export const baselineEntryFor = (result: ProbeResult): BaselineEntry => ({
  judgeMedian: result.judgeMedian,
  drift: { ...result.drift },
  deterministicPass: result.deterministic.pass,
  judgeVariance: result.judgeVariance,
});

/**
 * Writes a fresh baseline from results. `version` increments the existing file's
 * when omitted; `stage` is documentation (committedAtStage), never enforcement.
 */
export const writeBaseline = async (
  filePath: string,
  results: readonly ProbeResult[],
  opts: { stage: string; version?: number },
): Promise<ProbeBaseline> => {
  const prior = loadBaseline(filePath);
  const baseline: ProbeBaseline = {
    version: opts.version ?? (prior?.version ?? 0) + 1,
    committedAtStage: opts.stage,
    probes: Object.fromEntries(results.map((r) => [r.probeId, baselineEntryFor(r)])),
  };
  await atomicWriteJson(filePath, baseline);
  return baseline;
};

/** Compares one probe result against its baseline row (null = no row yet ⇒ nothing to drop from). */
export const gateProbe = (result: ProbeResult, baseline: BaselineEntry | null): ProbeGateReport => {
  const reasons: string[] = [];

  // Rule 1 — shape is non-negotiable: any deterministic failure is red.
  if (!result.deterministic.pass) {
    const failed = result.deterministic.results.filter((r) => !r.pass);
    reasons.push(`deterministic: ${failed.length} check(s) failed (${failed.map((r) => r.check.type).join(', ')})`);
  }

  // Rule 2 — judge median drop > 0.8 is red. Either side null (dry run / no rubric
  // / no baseline row) means "not measured", which never invents a drop.
  if (baseline !== null && baseline.judgeMedian !== null && result.judgeMedian !== null) {
    const drop = baseline.judgeMedian - result.judgeMedian;
    if (drop > JUDGE_DROP_RED) reasons.push(`judge median ${baseline.judgeMedian} → ${result.judgeMedian} (drop ${drop} > ${JUDGE_DROP_RED})`);
  }

  // Rule 3 — drift cosine drop > 0.05 on any dimension is yellow (a warning, not a stop).
  if (baseline !== null) {
    for (const [dim, baseCosine] of Object.entries(baseline.drift)) {
      const now = result.drift[dim];
      if (now === undefined) continue; // the probe stopped reporting this dimension
      const drop = baseCosine - now;
      if (drop > DRIFT_DROP_YELLOW) reasons.push(`drift[${dim}] ${baseCosine} → ${now} (drop ${drop} > ${DRIFT_DROP_YELLOW})`);
    }
  }

  // Red outranks yellow: shape failures and judge regressions stop the line;
  // a drift drop alone only flags.
  const judgeRed = reasons.some((r) => r.startsWith('judge median'));
  const verdict: GateVerdict = reasons.length === 0 ? 'green' : judgeRed || !result.deterministic.pass ? 'red' : 'yellow';
  return { probeId: result.probeId, verdict, reasons, baseline };
};

/** Gates a whole suite; the suite verdict is the worst probe verdict, id-sorted. */
export const gateSuite = (results: readonly ProbeResult[], baseline: ProbeBaseline | null): SuiteGateReport => {
  const probes = [...results]
    .sort((a, b) => (a.probeId < b.probeId ? -1 : a.probeId > b.probeId ? 1 : 0))
    .map((r) => gateProbe(r, baseline?.probes[r.probeId] ?? null));
  const rank: Record<GateVerdict, number> = { green: 0, yellow: 1, red: 2 };
  const verdict = probes.reduce<GateVerdict>((worst, p) => (rank[p.verdict] > rank[worst] ? p.verdict : worst), 'green');
  return {
    verdict,
    probes,
    regressing: probes.filter((p) => p.verdict === 'red').map((p) => p.probeId),
    thresholds: { judgeDropRed: JUDGE_DROP_RED, driftDropYellow: DRIFT_DROP_YELLOW },
  };
};

/** Convenience: gate results straight from a baseline file path. */
export const gateAgainstBaselineFile = (results: readonly ProbeResult[], filePath: string): SuiteGateReport =>
  gateSuite(results, loadBaseline(filePath));

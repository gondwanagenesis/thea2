// M19 probes — evaluator class 1: deterministic checks.
//
// These grade SHAPE, and they are the only class allowed to gate hard: a bubble
// bound, a leaked JSON fragment, a forbidden therapy-voice pattern, a tool that
// fired when it must not — none of that is a matter of taste, so none of it is
// allowed to hide behind a median. Every check must hold on EVERY run.

import { type DeterministicCheck } from '../../schemas/probe.js';
import { ProbeError } from './errors.js';
import type { DecisionObject, RunOutcome } from './types.js';

/** One check evaluated against one run. */
export interface CheckOutcome {
  check: DeterministicCheck;
  pass: boolean;
  /** Empty when it passed; otherwise names what was seen. */
  detail: string;
}

/** One check aggregated over all runs: pass ⇔ it held on every run (a 2/3 pass is a fail). */
export interface CheckResult {
  check: DeterministicCheck;
  pass: boolean;
  /** Per-run pass flags, index-aligned with the probe's runs. */
  perRun: boolean[];
  details: string[];
}

export interface CheckReport {
  pass: boolean;
  results: CheckResult[];
}

/**
 * The outbound-leakage vocabulary: L0/packet markup, native tool-call JSON, and
 * event-kind names are internal surfaces — the L0-never-enters-prompts boundary
 * checked from the other side. Each entry is named so a failure says WHAT leaked.
 */
const LEAKAGE_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: 'packet-markup', re: /\[(EXEMPLARS|IDENTITY|PROCEDURAL|INHIBITION|EARLIER|WINDOW|CONTEXT|TOOL)\]/ },
  // Tool-call wire vocabulary first: it is the more specific diagnosis.
  { name: 'tool-call-json', re: /"(?:name|arguments|tool_calls|function)"\s*:/ },
  { name: 'json-object', re: /\{\s*"[^"]+"\s*:/ },
  { name: 'event-kind', re: /\b(?:model\.(?:call|parse_failed|routing_ignored)|incident\.[a-z_]+|probe\.[a-z_]+)\b/ },
  { name: 'json-fence', re: /```(?:json)?\s*$/m },
];

const leakageIn = (text: string): string | null => {
  const trimmed = text.trim();
  if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && isJson(trimmed)) return 'json-parse';
  for (const p of LEAKAGE_PATTERNS) {
    if (p.re.test(text)) return p.name;
  }
  return null;
};

const isJson = (text: string): boolean => {
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === 'object' && v !== null;
  } catch {
    return false;
  }
};

const toolNamesOf = (decision: DecisionObject | null): string[] =>
  decision === null ? [] : decision.toolTrace.map((t) => t.tool);

/** Evaluates ONE check against ONE run. Pure; throws only on a probe-side defect (bad regex). */
export const evaluateCheck = (check: DeterministicCheck, run: Pick<RunOutcome, 'outbound' | 'decision'>): CheckOutcome => {
  const fail = (detail: string): CheckOutcome => ({ check, pass: false, detail });
  switch (check.type) {
    case 'bubbleCount': {
      const n = run.outbound.length;
      return n >= check.min && n <= check.max
        ? { check, pass: true, detail: '' }
        : fail(`${n} bubble(s), expected ${check.min}..${check.max}`);
    }
    case 'bubbleMaxChars': {
      const over = run.outbound
        .map((t) => ({ t, n: t.length }))
        .filter((b) => b.n > check.max)
        .map((b) => `${b.n} chars: "${b.t.slice(0, 60)}${b.t.length > 60 ? '…' : ''}"`);
      return over.length === 0 ? { check, pass: true, detail: '' } : fail(over.join(' | '));
    }
    case 'noLeakage': {
      const hits = run.outbound
        .map((t) => ({ t, leak: leakageIn(t) }))
        .filter((b): b is { t: string; leak: string } => b.leak !== null)
        .map((b) => `[${b.leak}] "${b.t.slice(0, 80)}"`);
      return hits.length === 0 ? { check, pass: true, detail: '' } : fail(hits.join(' | '));
    }
    case 'noForbiddenPattern': {
      let re: RegExp;
      try {
        re = new RegExp(check.pattern);
      } catch (e) {
        throw new ProbeError('probes/bad-regex', `noForbiddenPattern does not compile: /${check.pattern}/`, {
          field: 'expect.deterministic.noForbiddenPattern',
          cause: e,
        });
      }
      const hits = run.outbound.filter((t) => re.test(t));
      return hits.length === 0
        ? { check, pass: true, detail: '' }
        : fail(`forbidden pattern /${check.pattern}/ in: "${hits[0]?.slice(0, 80) ?? ''}"`);
    }
    case 'toolFired': {
      const fired = toolNamesOf(run.decision);
      return fired.includes(check.tool)
        ? { check, pass: true, detail: '' }
        : fail(`tool '${check.tool}' did not fire (fired: ${fired.length === 0 ? 'none' : fired.join(', ')})`);
    }
    case 'toolNotFired': {
      const fired = toolNamesOf(run.decision);
      return fired.includes(check.tool)
        ? fail(`tool '${check.tool}' fired but must not (toolTrace: ${fired.join(', ')})`)
        : { check, pass: true, detail: '' };
    }
    case 'planIs': {
      if (run.decision === null) return fail('no decision was locked');
      return run.decision.plan === check.value
        ? { check, pass: true, detail: '' }
        : fail(`plan is '${run.decision.plan}', expected '${check.value}'`);
    }
    case 'decisionField': {
      if (run.decision === null) return fail('no decision was locked');
      const value = run.decision[check.field];
      return value >= check.min && value <= check.max
        ? { check, pass: true, detail: '' }
        : fail(`${check.field}=${value}, expected ${check.min}..${check.max}`);
    }
    case 'outboundContains': {
      return run.outbound.some((t) => t.includes(check.text))
        ? { check, pass: true, detail: '' }
        : fail(`outbound never contained "${check.text}"`);
    }
  }
};

/**
 * Aggregates the check table over all runs. The law this function exists to
 * enforce: deterministic checks hold on EVERY run — the median is for the judge,
 * never for shape.
 */
export const aggregateDeterministic = (checks: readonly DeterministicCheck[], runs: readonly RunOutcome[]): CheckReport => {
  const results: CheckResult[] = checks.map((check) => {
    const outcomes = runs.map((run) => evaluateCheck(check, run));
    const perRun = outcomes.map((o) => o.pass);
    return {
      check,
      pass: perRun.every((p) => p),
      perRun,
      details: outcomes.filter((o) => !o.pass).map((o) => o.detail),
    };
  });
  return { pass: results.every((r) => r.pass), results };
};

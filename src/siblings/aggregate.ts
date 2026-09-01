// M18 siblings — the Ledger's pure aggregation core.
//
// `aggregateModelCalls` is the spec'd golden-testable fold: a replayed mixed
// model.call day becomes per-taskClass cost/latency/token aggregates. The wider
// `aggregateWindow` is what the job body actually consumes — it keeps the counts
// the pure fold's shape has nowhere to put (retry totals, unattributable parse
// failures, malformed L0 rows) so the report loses nothing the window contained.
//
// Attribution law: M03 emits `model.call` and `model.parse_failed` with the SAME
// turnId for one logical chat, and the parse event can land BEFORE its call (the
// repair ladder throws before the call event is emitted). So attribution is a
// two-pass fold: build turnId → taskClass from every call in the window, then
// attribute each parse failure to the most recent call sharing its turnId. A
// parse failure with no such call is counted, never dropped — it surfaces as
// `parseFailuresUnattributed` and in the report.

import { z } from 'zod';
import type { EventEnvelope } from '../events/index.js';
import { TASK_CLASSES, type TaskClass } from '../model/index.js';
import type { LedgerAggregate } from './types.js';

// ---------------------------------------------------------------------------
// L0 payload shapes (M03 owns these; parsed here, never trusted)
// ---------------------------------------------------------------------------

const usageShape = z.object({
  inputTokens: z.number().finite().nonnegative(),
  outputTokens: z.number().finite().nonnegative(),
  costUsd: z.number().finite().nonnegative().optional(),
  latencyMs: z.number().finite().nonnegative(),
  attempts: z.number().finite().int().nonnegative(),
});

const modelCallShape = z.object({
  taskClass: z.string(),
  tier: z.string(),
  model: z.string(),
  usage: usageShape,
  outcome: z.string(),
});

const isTaskClass = (s: string): s is TaskClass => (TASK_CLASSES as readonly string[]).includes(s);

const parseFailedShape = z.object({
  schema: z.string(),
  rung: z.string(),
  error: z.string(),
});

// ---------------------------------------------------------------------------
// The fold
// ---------------------------------------------------------------------------

interface CallRecord {
  taskClass: TaskClass;
  turnId?: string | undefined;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
  attempts: number;
  failed: boolean;
}

export interface WindowStats {
  /** Per-taskClass aggregates, taskClass-sorted. Classes with zero calls are absent. */
  aggs: LedgerAggregate[];
  /** Logical chats — one `model.call` each. Retries do NOT inflate this. */
  calls: number;
  /** Σ usage.attempts — the retry total M03 folded into each event. */
  attempts: number;
  /** Calls whose outcome was not 'ok'. */
  failedCalls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  /** Parse failures no model.call in the window could attribute (counted, never dropped). */
  parseFailuresUnattributed: number;
  /** `model.call` / `model.parse_failed` rows that failed their payload shape. */
  malformed: number;
}

export const aggregateWindow = (evs: readonly EventEnvelope[]): WindowStats => {
  const calls: CallRecord[] = [];
  const parseFailTurnIds: Array<string | undefined> = [];
  let malformed = 0;

  for (const ev of evs) {
    if (ev.kind === 'model.call') {
      const parsed = modelCallShape.safeParse(ev.payload);
      const tc: string | undefined = parsed.success ? parsed.data.taskClass : undefined;
      if (!parsed.success || tc === undefined || !isTaskClass(tc)) {
        malformed += 1;
        continue;
      }
      const p = parsed.data;
      calls.push({
        taskClass: tc,
        inputTokens: p.usage.inputTokens,
        outputTokens: p.usage.outputTokens,
        costUsd: p.usage.costUsd ?? 0,
        latencyMs: p.usage.latencyMs,
        attempts: p.usage.attempts,
        failed: p.outcome !== 'ok',
        ...(ev.turnId !== undefined ? { turnId: ev.turnId } : {}),
      });
    } else if (ev.kind === 'model.parse_failed') {
      const parsed = parseFailedShape.safeParse(ev.payload);
      if (!parsed.success) {
        malformed += 1;
        continue;
      }
      parseFailTurnIds.push(ev.turnId);
    }
  }

  // Pass two: attribute parse failures. The most recent call per turnId wins —
  // several calls can share a turn, and the failing structured call is the one
  // whose ladder gave up.
  const classByTurn = new Map<string, TaskClass>();
  for (const c of calls) if (c.turnId !== undefined) classByTurn.set(c.turnId, c.taskClass);

  const parseFailuresByClass = new Map<TaskClass, number>();
  let parseFailuresUnattributed = 0;
  for (const turnId of parseFailTurnIds) {
    const cls = turnId !== undefined ? classByTurn.get(turnId) : undefined;
    if (cls === undefined) parseFailuresUnattributed += 1;
    else parseFailuresByClass.set(cls, (parseFailuresByClass.get(cls) ?? 0) + 1);
  }

  const groups = new Map<TaskClass, CallRecord[]>();
  for (const c of calls) {
    const rows = groups.get(c.taskClass);
    if (rows !== undefined) rows.push(c);
    else groups.set(c.taskClass, [c]);
  }

  const aggs: LedgerAggregate[] = [...groups.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([taskClass, rows]) => ({
      taskClass,
      calls: rows.length,
      inputTokens: sum(rows.map((r) => r.inputTokens)),
      outputTokens: sum(rows.map((r) => r.outputTokens)),
      costUsd: sum(rows.map((r) => r.costUsd)),
      latencyP50Ms: percentile(rows.map((r) => r.latencyMs), 0.5),
      latencyP95Ms: percentile(rows.map((r) => r.latencyMs), 0.95),
      parseFailures: parseFailuresByClass.get(taskClass) ?? 0,
    }));

  return {
    aggs,
    calls: calls.length,
    attempts: sum(calls.map((c) => c.attempts)),
    failedCalls: calls.filter((c) => c.failed).length,
    inputTokens: sum(calls.map((c) => c.inputTokens)),
    outputTokens: sum(calls.map((c) => c.outputTokens)),
    costUsd: sum(calls.map((c) => c.costUsd)),
    parseFailuresUnattributed,
    malformed,
  };
};

/** The spec'd pure surface — exactly the aggregates, nothing else. */
export const aggregateModelCalls = (evs: readonly EventEnvelope[]): LedgerAggregate[] => aggregateWindow(evs).aggs;

// ---------------------------------------------------------------------------
// Math
// ---------------------------------------------------------------------------

export const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);

/**
 * Nearest-rank percentile over ascending-sorted values: p = xs[⌈q·n⌉ − 1].
 * Empty input is 0 (a class with calls always has latencies, so this only
 * guards the degenerate call sites).
 */
export const percentile = (xs: readonly number[], q: number): number => {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil(q * sorted.length)));
  return sorted[rank - 1]!;
};

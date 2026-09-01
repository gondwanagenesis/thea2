// M18 siblings — guardrailed routing proposals (ADR-008, §5.6).
//
// The evidence rule is mechanical and boring ON PURPOSE: a non-user-facing task
// class that is hot, parses clean, and is expensive or slow becomes a downgrade
// proposal to the cheap tier, with the numbers in the reason string. Everything
// the guardrail forbids is either refused loudly (a user-facing target — turn is
// pinned to main in code) or simply not a proposal (a class already at or below
// the target tier has nothing cheaper to move to).
//
// M03's router enforces the same pin at resolve time; the Ledger refuses to
// PROPOSE it. Both halves are load-bearing.

import { z } from 'zod';
import * as fsp from 'node:fs/promises';
import { atomicWriteJson, canonicalJson } from '../kernel/index.js';
import type { EventLog } from '../events/index.js';
import {
  TASK_CLASSES,
  TIER_RANK,
  USER_FACING_TASK_CLASSES,
  type RoutingOverride,
  type RoutingTable,
  type TaskClass,
  type Tier,
} from '../model/index.js';
import type { LedgerAggregate, ProposalSet, RoutingProposal, RoutingRefusal } from './types.js';
import { pct, usd } from './util.js';

// ---------------------------------------------------------------------------
// Evidence thresholds (load-bearing constants — propose, don't silently tune)
// ---------------------------------------------------------------------------

/** Enough observations that the numbers are a pattern, not a morning. */
export const PROPOSAL_MIN_CALLS = 20;
/** A class already fumbling its structured output does not get a weaker model. */
export const PROPOSAL_MAX_PARSE_FAIL_RATE = 0.05;
/** …or the class carries at least this share of the window's spend. */
export const PROPOSAL_COST_SHARE = 0.15;
/** …or its p95 latency crosses this (a slow class is a felt class). */
export const PROPOSAL_P95_MS = 8_000;
/** The only tier the Ledger ever proposes. */
export const PROPOSAL_TARGET_TIER: Tier = 'cheap';

/**
 * The tier each class rides absent a routing.json override — the tiers its
 * callers actually request today (M03 has no per-class default table, so the
 * Ledger keeps this one; a caller that changes its request invalidates the
 * `from` in new proposals, which is what the next day's report shows).
 */
export const DEFAULT_CLASS_TIERS: Record<TaskClass, Tier> = {
  turn: 'main',
  appraisal: 'cheap',
  'heartbeat-thought': 'main',
  'ponder-seed': 'main',
  consolidate: 'cheap',
  derive: 'main',
  judge: 'reasoning',
  'probe-judge': 'reasoning',
  summarize: 'main',
};

// ---------------------------------------------------------------------------
// Pure proposal pass
// ---------------------------------------------------------------------------

/** Last entry wins — the same rule M03's router applies when resolving. */
export const routingOverrideFor = (routing: RoutingTable, taskClass: TaskClass): RoutingOverride | undefined => {
  let found: RoutingOverride | undefined;
  for (const entry of routing) if (entry.taskClass === taskClass) found = entry;
  return found;
};

/** The tier a class actually rides: its override, else its callers' default. */
export const effectiveTier = (taskClass: TaskClass, current: RoutingTable): Tier =>
  routingOverrideFor(current, taskClass)?.tier ?? DEFAULT_CLASS_TIERS[taskClass];

const evidenceText = (agg: LedgerAggregate, totalCost: number): string =>
  `${agg.calls} calls, ${usd(agg.costUsd)} (${pct(agg.costUsd, totalCost)} of window spend), ` +
  `p95 ${agg.latencyP95Ms} ms, ${pct(agg.parseFailures, agg.calls)} parse failures`;

export const proposeRouting = (aggs: readonly LedgerAggregate[], current: RoutingTable): ProposalSet => {
  const totalCost = aggs.reduce((acc, a) => acc + a.costUsd, 0);
  const proposals: RoutingProposal[] = [];
  const refused: RoutingRefusal[] = [];

  for (const agg of [...aggs].sort((a, b) => (a.taskClass < b.taskClass ? -1 : a.taskClass > b.taskClass ? 1 : 0))) {
    const hot = agg.calls >= PROPOSAL_MIN_CALLS;
    const clean = agg.calls > 0 && agg.parseFailures / agg.calls <= PROPOSAL_MAX_PARSE_FAIL_RATE;
    const heavy = totalCost > 0 && agg.costUsd > 0 && agg.costUsd / totalCost >= PROPOSAL_COST_SHARE;
    const slow = agg.latencyP95Ms >= PROPOSAL_P95_MS;
    if (!hot || !clean || (!heavy && !slow)) continue;

    const from = effectiveTier(agg.taskClass, current);
    const to = PROPOSAL_TARGET_TIER;

    // Guardrail, refusal half: a user-facing class never moves. Logged, never written.
    if (USER_FACING_TASK_CLASSES.includes(agg.taskClass)) {
      refused.push({
        taskClass: agg.taskClass,
        proposedTier: to,
        reason:
          `${agg.taskClass} is pinned to the ${from} tier in code (ADR-008) — the evidence was real ` +
          `(${evidenceText(agg, totalCost)}), the answer is still no`,
      });
      continue;
    }

    // Already at or below the target: nothing cheaper exists, so this is not a
    // refusal (nothing was asked for) and not a proposal — it is silence.
    if (TIER_RANK[to] >= TIER_RANK[from]) continue;

    proposals.push({
      taskClass: agg.taskClass,
      from,
      to,
      reason: `${evidenceText(agg, totalCost)} — downgrade is cheap-tier-safe and Nightingale gates the change`,
    });
  }

  return { proposals, refused };
};

// ---------------------------------------------------------------------------
// The routing.json file (Ledger-proposal-written or human-edited, never ad hoc)
// ---------------------------------------------------------------------------

const routingEntryShape = z.object({
  taskClass: z.string(),
  tier: z.enum(['main', 'cheap', 'reasoning']),
  reason: z.string().optional(),
});
const routingFileShape = z.array(routingEntryShape);

const isTaskClass = (s: string): s is TaskClass => (TASK_CLASSES as readonly string[]).includes(s);

/**
 * Reads var/routing.json. Missing file = no overrides (the normal first week).
 * A file that PARSES but violates the shape is a typed throw — silently ignoring
 * a human's hand edit would make the Ledger propose against a table it cannot see.
 */
export const readRoutingTable = async (routingPath: string): Promise<RoutingTable> => {
  let text: string;
  try {
    text = await fsp.readFile(routingPath, 'utf8');
  } catch {
    return []; // absent is a valid empty table
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (e) {
    throw new Error(`routing.json is not valid JSON: ${String(e)}`);
  }
  const parsed = routingFileShape.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.map(String).join('.') || '<root>'}: ${i.message}`).join('; ');
    throw new Error(`routing.json violates the routing table shape: ${detail}`);
  }
  const table: RoutingOverride[] = [];
  for (const entry of parsed.data) {
    if (!isTaskClass(entry.taskClass)) {
      throw new Error(`routing.json names unknown task class '${entry.taskClass}'`);
    }
    table.push({
      taskClass: entry.taskClass,
      tier: entry.tier,
      ...(entry.reason !== undefined ? { reason: entry.reason } : {}),
    });
  }
  return table;
};

export interface RoutingApplyResult {
  /** True when the file's content changed (which is what bumps the deploy marker). */
  changed: boolean;
  /** The table now in force; null when the file was unreadable. */
  table: RoutingTable | null;
  /** Proposals actually written (empty when nothing changed or the file was unreadable). */
  written: RoutingProposal[];
  unreadable: boolean;
}

/**
 * Writes accepted proposals into routing.json, merging over the existing table
 * (existing entries for a proposed class are superseded, last-wins per M03).
 * `current` is the table the caller already read — null marks an unreadable file,
 * which is NEVER overwritten (a human's hand edit survives; the incident was
 * already emitted by the reader). An already-identical table is never rewritten,
 * so an unchanged routing.json cannot bump the deploy marker.
 */
export const applyRouting = async (
  routingPath: string,
  current: RoutingTable | null,
  proposals: readonly RoutingProposal[],
  // Reserved for the routing-change emission M18's tests will pin; refusals
  // (`sibling.routing_refused`) are the guardrail's job and live in ledger.ts.
  _events: EventLog,
): Promise<RoutingApplyResult> => {
  if (current === null) {
    return { changed: false, table: null, written: [], unreadable: true };
  }
  const existing: RoutingTable = current;
  if (proposals.length === 0) {
    return { changed: false, table: existing, written: [], unreadable: false };
  }

  const proposed = new Set(proposals.map((p) => p.taskClass));
  const merged: RoutingOverride[] = [
    ...existing.filter((e) => !proposed.has(e.taskClass)),
    ...proposals.map((p): RoutingOverride => ({ taskClass: p.taskClass, tier: p.to, reason: p.reason })),
  ];

  if (canonicalJson(merged) === canonicalJson(existing)) {
    return { changed: false, table: existing, written: [], unreadable: false };
  }
  await atomicWriteJson(routingPath, merged);
  return { changed: true, table: merged, written: [...proposals], unreadable: false };
};

// M13 loop — the DecisionObject schema. This is the migration target of
// schemas/decision.ts (kept field-for-field identical; the mirror's sync rule
// applies from S4 on). The locked object is validated against it before it
// leaves the loop, so a structurally impossible decision can never reach the
// realizer — M14 and M19 mirror this shape structurally.

import { z } from 'zod';
import type { Verdict } from '../inhibit/index.js';

const unit = z.number().min(0).max(1);

/** Inhibition gate result (M12 owns the type; mirrored here because DecisionObject embeds it). */
export const VerdictSchema = z.union([
  z.object({ allow: z.literal(true) }),
  z.object({
    allow: z.literal(false),
    code: z.string().min(1),
    ruleId: z.string().min(1),
    hint: z.string(),
  }),
]);

/** One tool call attempted inside the deliberation loop. */
export const ToolStepSchema = z.object({
  tool: z.string().min(1),
  args: z.unknown(),
  verdict: VerdictSchema,
  result: z.unknown().optional(),
  ms: z.number().nonnegative(),
});

/** A spawned subprocess. */
export const SpawnRecordSchema = z.object({
  kind: z.enum(['fork', 'task', 'committee']),
  id: z.string().min(1),
  brief: z.string(),
  channels: z.object({ character: z.boolean(), procedural: z.boolean() }),
  outcome: z.string().optional(),
});

/** What the model authors of a decision — the loop fills the rest. */
export const ModelDecisionSchema = z.object({
  plan: z.enum(['reply', 'silent', 'defer']),
  /** The only text that can reach the channel. Empty unless plan === 'reply'. */
  bubbles: z.array(z.string()),
  confidence: unit,
  weight: unit,
  reluctance: unit,
  completeness: unit,
});

/**
 * Who decided. 'model' — her locked plan (a `decide` call, a parsed reply, or
 * a prose fold); 'gate' — the inhibition gate forced silence after the cap;
 * 'failure' — no decision could be produced (parse failure, budget exhaustion,
 * assembly error). The ledger and reconcile read this: only the first two are
 * restraint; a failure silence stays an owed reply.
 */
export const DecidedBySchema = z.enum(['model', 'gate', 'failure']);

/** The locked decision object. */
export const DecisionObjectSchema = z.object({
  turnId: z.string().min(1),
  plan: z.enum(['reply', 'silent', 'defer']),
  decidedBy: DecidedBySchema,
  bubbles: z.array(z.string()),
  confidence: unit,
  weight: unit,
  reluctance: unit,
  completeness: unit,
  toolTrace: z.array(ToolStepSchema),
  spawns: z.array(SpawnRecordSchema),
  /** Every gate verdict recorded this turn — candidate-call path and plan path both. */
  inhibitions: z.array(VerdictSchema),
});

export const decisionIssue = (e: z.ZodError): string =>
  e.issues.map((i) => `${i.path.map(String).join('.')}: ${i.message}`).join('; ');

// ---------------------------------------------------------------------------
// L0 payloads owned here
// ---------------------------------------------------------------------------

/** Mirrors schemas/events.ts `DelegationPayload` — M09's procedureFromDelegation reads exactly this. */
export const DelegationPayloadSchema = z.object({
  kind: z.enum(['fork', 'task', 'committee']),
  spawnId: z.string().min(1),
  situation: z.string(),
  call: z.string().min(1),
  argsSummary: z.string(),
  resultSummary: z.string(),
  outcome: z.enum(['good', 'mixed', 'bad']),
});

/** Mirrors schemas/events.ts `GateLoopPayload`, plus the resolution the cap took. */
export const GateLoopPayloadSchema = z.object({
  turnId: z.string().min(1),
  ruleIds: z.array(z.string()),
  reentries: z.number().int().nonnegative(),
  resolution: z.enum(['forced-silent', 'fail-open']),
});

export const verdictRuleId = (v: Verdict): string => (v.allow ? '' : v.ruleId);

// ---------------------------------------------------------------------------
// L0 kinds owned here
// ---------------------------------------------------------------------------

/** Every spawn emits one — the procedural exemplar feedstock M08 synthesizes from. */
export const DELEGATION_KIND = 'decision.delegation';
/** The locked decision, one per entry — the daily report's and the probes' hook. */
export const DECISION_LOCKED_KIND = 'decision.locked';
/** Gate rejection loop exhausted (schemas/events.ts: forced silent + incident). */
export const GATE_LOOP_INCIDENT = 'incident.gate_loop';
/** The decision survived neither the schema parse nor the one-shot repair. */
export const DECISION_PARSE_INCIDENT = 'incident.parse_failed';
/** A spawn beyond the depth/concurrency caps was refused. */
export const SPAWN_REFUSED_INCIDENT = 'incident.spawn_refused';
/** A wedged tool was cut at its timeout; the loop survived. */
export const TOOL_TIMEOUT_INCIDENT = 'incident.tool_timeout';
/** Context assembly threw — the turn locks a failure silence and says so. */
export const ASSEMBLE_FAILED_INCIDENT = 'incident.assemble_failed';
/** The model answered in prose instead of calling `decide`; the prose was folded deterministically. */
export const DECISION_PROSE_FOLDED = 'decision.prose_folded';

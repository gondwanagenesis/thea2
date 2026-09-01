// Reference schema — spec-v1. Source of truth migrates to src/loop at stage S4; keep synced.
// (Verdict is owned by src/inhibit, stage S3; mirrored here because DecisionObject embeds it.)
//
// The DecisionObject is the deliberation loop's single output (M13). Internal-
// vs-external is the typed `plan` field, never prose (ADR-003). It is locked
// once per loop entry, gated as a whole (M12 checkPlan), then handed to the
// realizer (M14), which may merge bubbles but never rewrite them. Nothing else
// in the system can reach the channel.

import { z } from 'zod';

const unit = z.number().min(0).max(1);

/** Inhibition gate result (M12). Binary + reason code; <1 ms; zero LLM; never learned. */
export const Verdict = z.union([
  z.object({ allow: z.literal(true) }),
  z.object({
    allow: z.literal(false),
    /** Stable machine code, e.g. 'SPEND_CAP', 'CHAT_LOCK', 'PATH_FENCE'. */
    code: z.string().min(1),
    /** Which inhibitions.yaml entry fired. */
    ruleId: z.string().min(1),
    /** Fed back into the loop on re-entry (max 2 re-entries, then forced plan:'silent' + incident). */
    hint: z.string(),
  }),
]);
export type Verdict = z.infer<typeof Verdict>;

/** One tool call attempted inside the deliberation loop. */
export const ToolStep = z.object({
  tool: z.string().min(1),
  /** Arguments as sent; validated upstream against the tool's own zod input schema. */
  args: z.unknown(),
  /** Gate verdict for this call (checked before execution). */
  verdict: Verdict,
  /** Observation summarized back into the loop; absent when the call was denied. */
  result: z.unknown().optional(),
  ms: z.number().nonnegative(),
});
export type ToolStep = z.infer<typeof ToolStep>;

/**
 * A spawned subprocess. fork/task/committee are ordinary registry tools invoked
 * via native function calling (ADR-009). Caps: depth <= 2, concurrency <= 3,
 * per-entry wall-clock budget; every spawn also emits a delegation episode
 * event (procedural exemplar feedstock).
 */
export const SpawnRecord = z.object({
  kind: z.enum(['fork', 'task', 'committee']),
  id: z.string().min(1),
  brief: z.string(),
  /** Channel composition (ADR-009): fork = character + procedural; task/cast = procedural only. */
  channels: z.object({
    character: z.boolean(),
    procedural: z.boolean(),
  }),
  /** Short result summary once the spawn resolves. */
  outcome: z.string().optional(),
});
export type SpawnRecord = z.infer<typeof SpawnRecord>;

export const DecisionObject = z.object({
  turnId: z.string().min(1),
  plan: z.enum(['reply', 'silent', 'defer']),
  /** The only text that can reach the channel. Empty unless plan === 'reply'. */
  bubbles: z.array(z.string()),
  confidence: unit,
  /** How much this deserves to be said; the realizer consumes it for cadence. */
  weight: unit,
  /** Drives pre-delay: 800 ms + 2500 ms * reluctance (M14). */
  reluctance: unit,
  /** How settled the deliberation was when the decision locked. */
  completeness: unit,
  toolTrace: z.array(ToolStep),
  spawns: z.array(SpawnRecord),
  /** Every gate verdict recorded this turn — candidate-call path and plan path both. */
  inhibitions: z.array(Verdict),
});
export type DecisionObject = z.infer<typeof DecisionObject>;

// Parse-failure behavior (ADR-003, M3 repair ladder): native json_schema ->
// tool-call-as-schema -> prompted JSON + zod -> one cheap-tier repair call ->
// incident.parse_failed. A decision that cannot be parsed becomes a recorded
// failure inside the ledger reconciliation invariant, never a silent drop.

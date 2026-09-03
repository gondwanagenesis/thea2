// M13 loop — configuration and the load-bearing constants. Caps and budgets are
// behavior: the spec pins some verbatim (spawn depth 2, concurrency 3), others
// carry a proposed default flagged in the module report. Everything is
// overridable per deployment through LoopConfig, never through edits here.

import type { EntryKind } from '../inhibit/index.js';
import type { TaskClass, ThinkingControl, Tier } from '../model/index.js';

export type InhibitionPlacement = 'trailing' | 'merged';

/**
 * Per-task-class extended-thinking control (ADR-004a's sibling fix for the
 * starvation family): the value rides `ChatRequest.thinking` verbatim on the
 * anthropic door (M03) and is ignored on the openai wire. Honest defaults:
 * her own turns OFF — a thinking trace drawn from the same max_tokens budget
 * is latency and starvation risk on an interactive reply, and `assessMaxTokens`
 * is sized for the answer; judge-family work ON — appraisal, consolidation,
 * derive and probe judgments are exactly where reasoning earns its tokens.
 * Absent entry ⇒ the field is omitted from the wire body (the door's default
 * stands). `budget_tokens` must stay BELOW every budget a class is called
 * with; 1024 clears the smallest raised budget (2000).
 */
export type ThinkingTable = Partial<Record<TaskClass, ThinkingControl>>;

export interface LoopConfig {
  /**
   * Where the [INHIBITION] block travels. 'trailing' is the spec layout (a
   * trailing system message — recency wins); 'merged' folds it into the head
   * system message for backends that mishandle trailing system messages
   * (verified once by the S5 live smoke).
   */
  inhibitionPlacement: InhibitionPlacement;
  /** Wall-clock budget per entry kind (ms). Suggested defaults: 90s / 120s / 300s. */
  budgetMs: Record<EntryKind, number>;
  /** One tool call's cut-off. A wedged handler is abandoned here, not waited on. */
  toolTimeoutMs: number;
  /** Maximum tool rounds for ONE entry, main deliberation and subprocesses combined. */
  maxToolHops: number;
  /** Spawn nesting cap (spec): depth ≤ 2. */
  maxSpawnDepth: number;
  /** Spawn concurrency cap (spec): ≤ 3 in flight. */
  maxSpawnConcurrency: number;
  /**
   * Response reserve (§2.7): the assess call's maxTokens. 3072, not 2048 (Phase
   * 1, 2026-09-02): the starvation family — a THINKING model draws its invisible
   * reasoning trace from this same budget, and a trace that eats 2048 before any
   * visible content starves the call into an EMPTY reply. Empty ⇒ parse failure
   * ⇒ the repair rung ⇒ often failure again ⇒ a failure silence the ledger must
   * treat as a lost reply. Sizing for the trace is sizing for the answer.
   */
  assessMaxTokens: number;
  assessTemperature: number;
  /** The one-shot repair is a transcription task — coldest sampling. */
  repairTemperature: number;
  /** Current turn + this-turn tool observations, in tokens (§2.7: ≤ 6k). */
  turnTokenBudget: number;
  /** Tier per spawn kind: fork/task are cheap clones; committee nodes think. */
  spawnTier: Record<'fork' | 'task' | 'committee', Tier>;
  /** Per-task-class `thinking` control, applied by the loop's assess path. */
  thinking?: ThinkingTable | undefined;
}

/** The thinking budget for enabled (judge-family) classes. */
export const THINKING_BUDGET_TOKENS = 1024;

const THINKING_DEFAULTS: ThinkingTable = {
  // Her own turns: the field is OMITTED — the W1.1 door smoke (2026-09-03,
  // live) proved glm-5.3-flash REJECTS thinking:{type:'disabled'} with a 500
  // (api_error 1234), so 'disabled' must never touch the wire for flash; the
  // door's default (no field) answered fine at 3.5 s / end_turn. The
  // starvation guard is the padded assessMaxTokens + model/truncated
  // detection, not a rejected field. (glm-5.3 accepts 'disabled' — the
  // asymmetry is the door's, and M03 documents it.)
  // Judge-family: reasoning is the work.
  // Committee nodes (ponder GATE/SEED/GROUND/ARTIFACT, spawn committees):
  // flash starves them to empty JSON without thinking (incident.life_failed
  // 'artifact did not return JSON: empty input', post-deploy 2026-09-03).
  committee: { type: 'enabled', budget_tokens: THINKING_BUDGET_TOKENS },
  appraisal: { type: 'enabled', budget_tokens: THINKING_BUDGET_TOKENS },
  consolidate: { type: 'enabled', budget_tokens: THINKING_BUDGET_TOKENS },
  derive: { type: 'enabled', budget_tokens: THINKING_BUDGET_TOKENS },
  judge: { type: 'enabled', budget_tokens: THINKING_BUDGET_TOKENS },
  'probe-judge': { type: 'enabled', budget_tokens: THINKING_BUDGET_TOKENS },
};

/**
 * Defaults. `maxToolHops: 6` and the tier table are PROPOSED (the spec pins no
 * number for the hop cap) — flagged in the M13 build report, not silently chosen.
 */
export const LOOP_CONFIG_DEFAULTS: LoopConfig = {
  inhibitionPlacement: 'trailing',
  budgetMs: { 'user-turn': 90_000, heartbeat: 120_000, ponder: 300_000 },
  toolTimeoutMs: 30_000,
  maxToolHops: 6,
  maxSpawnDepth: 2,
  maxSpawnConcurrency: 3,
  assessMaxTokens: 3072,
  assessTemperature: 0.7,
  repairTemperature: 0,
  turnTokenBudget: 6000,
  spawnTier: { fork: 'cheap', task: 'cheap', committee: 'main' },
  thinking: THINKING_DEFAULTS,
};

/** M20 merges a partial config over the defaults; unknown fields stay the defaults'. */
export const resolveLoopConfig = (over: Partial<LoopConfig> = {}): LoopConfig => ({
  ...LOOP_CONFIG_DEFAULTS,
  ...over,
  budgetMs: { ...LOOP_CONFIG_DEFAULTS.budgetMs, ...(over.budgetMs ?? {}) },
  spawnTier: { ...LOOP_CONFIG_DEFAULTS.spawnTier, ...(over.spawnTier ?? {}) },
  thinking: { ...THINKING_DEFAULTS, ...(over.thinking ?? {}) },
});

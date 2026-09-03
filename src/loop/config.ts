// M13 loop — configuration and the load-bearing constants. Caps and budgets are
// behavior: the spec pins some verbatim (spawn depth 2, concurrency 3), others
// carry a proposed default flagged in the module report. Everything is
// overridable per deployment through LoopConfig, never through edits here.

import type { EntryKind } from '../inhibit/index.js';
import type { TaskClass, ThinkingControl, Tier } from '../model/index.js';

export type InhibitionPlacement = 'trailing' | 'merged';

/**
 * Where the spawn primitives (fork/task/committee) are offered (FA.3, D.6-8).
 * 'auto' — the default: they ride `followup|ponder|heartbeat` entries only
 * (`followup` joins when P-CAST lands in W3); a user turn offers `decide`
 * alone (`+ cast` in W3). 'always' registers them on every entry (tests and
 * deliberate overrides); 'off' never registers them.
 */
export type SpawnsMode = 'auto' | 'always' | 'off';

/**
 * FA.2 — the voice-door transport dial for the 'turn' class, owned here as the
 * loop's source of the numbers. M20's compose passes them into the voice
 * door's zaiTransport (`timeoutMs` is the IDLE deadline per streamed call,
 * `maxRetries` 1 = at most two attempts). The constants are pinned so that one
 * idle window plus the worst backoff wait (8 s cap, M03) fits inside
 * `budgetMs['user-turn']` — the turn's own deadline signal, never a second
 * full attempt, is what bounds a user turn.
 */
export interface TurnTransportConfig {
  /** Idle ms per streamed call before the door is considered dead. */
  timeoutMs: number;
  /** Transport retries on transport errors and 5xx (so attempts ≤ maxRetries + 1). */
  maxRetries: number;
}

/**
 * Per-task-class extended-thinking control (ADR-004a's sibling fix for the
 * starvation family): the value rides `ChatRequest.thinking` verbatim on the
 * anthropic door (M03) and is ignored on the openai wire. Absent entry ⇒ the
 * field is omitted from the wire body and the MODEL layer's control stands
 * (REASONING_BY_CLASS, P-DOOR DR.2 — the class table now lives there). An
 * entry here is a direct caller override of that default.
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
  /** Wall-clock budget per entry kind (ms). FA.2: the turn fits the voice door. */
  budgetMs: Record<EntryKind, number>;
  /**
   * One tool call's cut-off. A wedged handler is abandoned here, not waited
   * on. Default 10s (P-FAST derivation — the plan pins no value): it must sit
   * WELL inside `budgetMs['user-turn']` (30s) so one wedged round cannot
   * consume the whole turn before the loop observes the timeout and still
   * decides; heartbeat and ponder keep proportionally more room. The
   * wall-clock budget remains the hard bound either way.
   */
  toolTimeoutMs: number;
  /** Maximum tool rounds for ONE entry, main deliberation and subprocesses combined. */
  maxToolHops: number;
  /** Spawn nesting cap (spec): depth ≤ 2. */
  maxSpawnDepth: number;
  /** Spawn concurrency cap (spec): ≤ 3 in flight. */
  maxSpawnConcurrency: number;
  /**
   * Response reserve (§2.7): the assess call's maxTokens. FA.2 pins 1536 —
   * the turn class reasons LOW on the doors (REASONING_BY_CLASS, worst
   * anthropic thinking budget 512), so the answer keeps ~1k of visible room.
   * (The 3072 of Phase 1 sized for a WIDER table; the class default moved to
   * the model layer in P-DOOR DR.2. If a deployment overrides `thinking` with
   * a big budget, it must raise this with it — the trace eats maxTokens.)
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
  /** FA.3 — where the spawn primitives are offered (see SpawnsMode). */
  spawns: SpawnsMode;
  /** FA.2 — the turn-class transport dial for the voice door (see TurnTransportConfig). */
  turnTransport: TurnTransportConfig;
}

/**
 * P-DOOR DR.2 moved the per-class reasoning control into the model layer
 * (REASONING_BY_CLASS in src/model/tiers.ts, applied by client.chat and mapped
 * per door by the wire builders). The loop's `thinking` table stays as a
 * direct-control escape hatch and defaults to empty: no entry ⇒ no field on
 * the request ⇒ the door-level control stands.
 */

/**
 * Defaults. `maxToolHops: 6` and the tier table are PROPOSED (the spec pins no
 * number for the hop cap) — flagged in the M13 build report, not silently chosen.
 * The FA.2 budgets (30s/60s/180s), `assessMaxTokens` 1536, `spawns:'auto'`
 * (D.6-8) and the turn transport dial are P-FAST pins — verbatim from the plan.
 */
export const LOOP_CONFIG_DEFAULTS: LoopConfig = {
  inhibitionPlacement: 'trailing',
  budgetMs: { 'user-turn': 30_000, heartbeat: 60_000, ponder: 180_000 },
  toolTimeoutMs: 10_000,
  maxToolHops: 6,
  maxSpawnDepth: 2,
  maxSpawnConcurrency: 3,
  assessMaxTokens: 1536,
  assessTemperature: 0.7,
  repairTemperature: 0,
  turnTokenBudget: 6000,
  spawnTier: { fork: 'cheap', task: 'cheap', committee: 'main' },
  thinking: {},
  spawns: 'auto',
  turnTransport: { timeoutMs: 20_000, maxRetries: 1 },
};

/** M20 merges a partial config over the defaults; unknown fields stay the defaults'. */
export const resolveLoopConfig = (over: Partial<LoopConfig> = {}): LoopConfig => ({
  ...LOOP_CONFIG_DEFAULTS,
  ...over,
  budgetMs: { ...LOOP_CONFIG_DEFAULTS.budgetMs, ...(over.budgetMs ?? {}) },
  spawnTier: { ...LOOP_CONFIG_DEFAULTS.spawnTier, ...(over.spawnTier ?? {}) },
  thinking: { ...LOOP_CONFIG_DEFAULTS.thinking, ...(over.thinking ?? {}) },
  turnTransport: { ...LOOP_CONFIG_DEFAULTS.turnTransport, ...(over.turnTransport ?? {}) },
});

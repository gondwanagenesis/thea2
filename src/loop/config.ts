// M13 loop — configuration and the load-bearing constants. Caps and budgets are
// behavior: the spec pins some verbatim (spawn depth 2, concurrency 3), others
// carry a proposed default flagged in the module report. Everything is
// overridable per deployment through LoopConfig, never through edits here.

import type { EntryKind } from '../inhibit/index.js';
import type { Tier } from '../model/index.js';

export type InhibitionPlacement = 'trailing' | 'merged';

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
  /** Response reserve (§2.7): the assess call's maxTokens. */
  assessMaxTokens: number;
  assessTemperature: number;
  /** The one-shot repair is a transcription task — coldest sampling. */
  repairTemperature: number;
  /** Current turn + this-turn tool observations, in tokens (§2.7: ≤ 6k). */
  turnTokenBudget: number;
  /** Tier per spawn kind: fork/task are cheap clones; committee nodes think. */
  spawnTier: Record<'fork' | 'task' | 'committee', Tier>;
}

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
  assessMaxTokens: 2048,
  assessTemperature: 0.7,
  repairTemperature: 0,
  turnTokenBudget: 6000,
  spawnTier: { fork: 'cheap', task: 'cheap', committee: 'main' },
};

/** M20 merges a partial config over the defaults; unknown fields stay the defaults'. */
export const resolveLoopConfig = (over: Partial<LoopConfig> = {}): LoopConfig => ({
  ...LOOP_CONFIG_DEFAULTS,
  ...over,
  budgetMs: { ...LOOP_CONFIG_DEFAULTS.budgetMs, ...(over.budgetMs ?? {}) },
  spawnTier: { ...LOOP_CONFIG_DEFAULTS.spawnTier, ...(over.spawnTier ?? {}) },
});

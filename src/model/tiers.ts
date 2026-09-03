// M03 model — the tier + reasoning registry. THE one place a class-level model
// control touches: TIER_TABLE (legacy single-door mode), TIER_DOOR (tier →
// door), REASONING_BY_CLASS (class → effort), ANTHROPIC_THINKING_BUDGETS
// (effort → budget). Door configs (endpoint/model/forcing/pricing) live in
// thea2.config.yaml `models.doors` (M20); these tables are what the code
// falls back to and what the wire mapping reads.

import type { DoorName, ReasoningEffort, TaskClass, Tier } from './types.js';

export const ZAI_MODEL = 'glm-5.3-flash';

/** Z.ai OpenAI-compatible chat completions endpoint. */
export const ZAI_ENDPOINT = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';

/** Z.ai Anthropic-compatible endpoint — the coding-plan door (the OpenAI door
 * is pay-as-you-go and 1113s without balance; this one the plan covers). */
export const ANTHROPIC_ENDPOINT = 'https://api.z.ai/api/anthropic';

/** tier → model id. Config (M20) may inject a different table; this is the default. */
export const TIER_TABLE: Record<Tier, string> = {
  main: ZAI_MODEL,
  cheap: ZAI_MODEL,
  reasoning: ZAI_MODEL,
};

/** Cost/quality rank used by the router's downgrade guardrail (higher = stronger). */
export const TIER_RANK: Record<Tier, number> = {
  cheap: 0,
  reasoning: 1,
  main: 2,
};

/**
 * Task classes a routing.json proposal may never touch (ADR-008). v1 has exactly
 * one: `turn` is pinned to the main tier in code — only a human config change can
 * move it, never a Ledger proposal.
 */
export const USER_FACING_TASK_CLASSES: readonly string[] = ['turn'];

export const PINNED_TURN_TIER: Tier = 'main';

/** Per-call transport timeout (spec default; config may override). */
export const DEFAULT_TIMEOUT_MS = 60_000;

/** Retries on transport errors and 5xx → at most 1 + maxRetries attempts. */
export const DEFAULT_MAX_RETRIES = 2;

export interface BackoffConfig {
  baseMs: number;
  capMs: number;
}

export const DEFAULT_BACKOFF: BackoffConfig = { baseMs: 500, capMs: 8_000 };

// ---------------------------------------------------------------------------
// Doors + reasoning control (P-DOOR DR.1/DR.2). The load-bearing tables of the
// door world: tier → door name, task class → reasoning effort, effort →
// anthropic thinking budget. Constants from the plan verbatim — change none
// without a STATUS BLOCKED entry first.
// ---------------------------------------------------------------------------

/**
 * The reasoning control each task class needs (DR.2), applied by client.chat
 * whenever the request carries no explicit `reasoning`. turn/heartbeat-thought/
 * summarize/ponder-seed/appraisal think LOW; the judge family
 * (consolidate/derive/judge/probe-judge) thinks HIGH.
 * Replaces the loop's old THINKING_DEFAULTS table — the control now lives with
 * the door layer that maps it onto each wire.
 */
export const REASONING_BY_CLASS: Record<TaskClass, ReasoningEffort> = {
  turn: 'low',
  'heartbeat-thought': 'low',
  summarize: 'low',
  'ponder-seed': 'low',
  appraisal: 'low',
  consolidate: 'high',
  derive: 'high',
  judge: 'high',
  'probe-judge': 'high',
};

/**
 * Anthropic-door thinking budget per effort (DR.2), used when the door carries
 * no explicit `thinkingBudget`. 'none' maps to a small enabled budget — this
 * wire NEVER emits `type:'disabled'` (glm-5.3-flash rejects it with a 500;
 * W1.1 door smoke).
 */
export const ANTHROPIC_THINKING_BUDGETS: Record<ReasoningEffort, number> = {
  none: 128,
  minimal: 256,
  low: 512,
  high: 1024,
  max: 2048,
};

/** tier → door name (DR.1). Tier names in code stay main|cheap|reasoning. */
export const TIER_DOOR: Record<Tier, DoorName> = {
  main: 'voice',
  cheap: 'mind',
  reasoning: 'judge',
};

/** Resolves a tier to its door name: main→voice, cheap→mind, reasoning→judge. */
export const tierFor = (tier: Tier): DoorName => TIER_DOOR[tier];

/**
 * Jittered exponential backoff drawn from the injected Rng: base * 2^attempt,
 * scaled by a deterministic [0.5, 1.5) jitter, capped. Same seed ⇒ same delays.
 */
export const backoffDelayMs = (attempt: number, jitter: () => number, cfg: BackoffConfig): number => {
  const raw = cfg.baseMs * 2 ** (attempt - 1);
  const scaled = raw * (0.5 + jitter());
  return Math.min(cfg.capMs, Math.max(0, Math.round(scaled)));
};

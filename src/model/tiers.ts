// M03 model — the tier registry. THE one place a model swap touches.
//
// Diego's routing decree (2026-09-01): every tier rides Z.ai's OpenAI-compatible
// endpoint on glm-5.3-flash. This deliberately overrides the spec-v1 default
// table ({main: 'glm-5.2', cheap: 'deepseek-v4-flash'}): swapping a tier back is
// a one-line change here, which is exactly why the table is a single exported
// const and nothing else in the module hard-codes a model id.

import type { Tier } from './types.js';

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

/**
 * Jittered exponential backoff drawn from the injected Rng: base * 2^attempt,
 * scaled by a deterministic [0.5, 1.5) jitter, capped. Same seed ⇒ same delays.
 */
export const backoffDelayMs = (attempt: number, jitter: () => number, cfg: BackoffConfig): number => {
  const raw = cfg.baseMs * 2 ** (attempt - 1);
  const scaled = raw * (0.5 + jitter());
  return Math.min(cfg.capMs, Math.max(0, Math.round(scaled)));
};

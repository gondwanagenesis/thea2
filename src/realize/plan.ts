// M14 realize — planDelivery, the pure decision→timeline law. Cadence is
// caused by decision fields + affect and by nothing else: every duration below
// is one of the spec's constants applied to (reluctance, arousal, valence,
// bubble lengths), and the rng is touched only for the inter-bubble gap
// jitter, forked so the caller's stream is never consumed. Text enters this
// file already shaped (shape.ts) and leaves word-for-word identical.

import type { ChannelLimits } from '../bridge/index.js';
import { DIM_INDEX, type AffectDim, type Vec12 } from '../coupling/index.js';
import { AFFECT_DIMS } from '../coupling/index.js';
import type { Rng } from '../kernel/index.js';
import { RealizeError } from './errors.js';
import { shapeBubbles } from './shape.js';
import type { DeliveryPlan, DeliveryStep, RealizableDecision } from './types.js';

// --- the spec's constants, verbatim (AGENTS.md §6: these are load-bearing) ---
export const PRE_DELAY_BASE_MS = 800;
export const PRE_DELAY_PER_RELUCTANCE_MS = 2500;
export const CPS_FLOOR = 6; // typing speed at the arousal rail a=-1
export const CPS_CEIL = 14; // typing speed at the arousal rail a=+1
export const LOW_VALENCE_CPS_FACTOR = 0.85; // −15% typing speed when a[valence] < 0
export const GAP_MIN_MS = 300;
export const GAP_MAX_MS = 1200;
export const GAP_JITTER = 0.15; // ±15% around the arousal curve — the only rng draw in the module
export const TOTAL_CAP_MS = 45_000;
export const MAX_BUBBLES = 5; // spec: merge when bubbles > 5

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));
const msOf = (x: number): number => Math.max(0, Math.round(x));

/** Reads one dim off the deviation vector, refusing a vector that is not the space. */
const deviation = (a: Vec12, dim: AffectDim): number => {
  if (a.length !== AFFECT_DIMS.length) {
    throw new RealizeError('realize/vec-length', `planDelivery needs a ${String(AFFECT_DIMS.length)}-dim Vec12, got length ${a.length}`);
  }
  const v = a[DIM_INDEX[dim]];
  if (v === undefined || !Number.isFinite(v)) {
    throw new RealizeError('realize/vec-length', `planDelivery: dim '${dim}' is ${String(v)}`);
  }
  return Math.min(1, Math.max(-1, v));
};

/** Typing speed in chars/second: the 6→14 lerp over the arousal deviation, slowed 15% under low valence. */
export const typingCps = (arousal: number, valence: number): number => {
  const t = (Math.min(1, Math.max(-1, arousal)) + 1) / 2;
  const cps = CPS_FLOOR + (CPS_CEIL - CPS_FLOOR) * t;
  return valence < 0 ? cps * LOW_VALENCE_CPS_FACTOR : cps;
};

/** Inter-bubble gap: 1200→300 ms shrinking with arousal, ±15% jitter from the forked stream, clamped to the envelope. */
export const gapMs = (arousal: number, jitter: number): number => {
  const t = (Math.min(1, Math.max(-1, arousal)) + 1) / 2;
  const base = GAP_MAX_MS + (GAP_MIN_MS - GAP_MAX_MS) * t;
  const clamped = Math.min(GAP_MAX_MS, Math.max(GAP_MIN_MS, base * (1 + jitter)));
  return msOf(clamped);
};

/**
 * The delivery timeline for one locked decision. Pure and deterministic per
 * seed: same (decision, affect, limits, rng seed) ⇒ byte-identical plan.
 * Out-of-range decision/affect inputs clamp rather than throw — an extreme
 * state may compress her delivery, but it must never explode the timeline.
 */
export const planDelivery = (
  d: RealizableDecision,
  a: Vec12,
  limits: ChannelLimits,
  rng: Rng,
): DeliveryPlan => {
  if (d.plan !== 'reply' || d.bubbles.length === 0) {
    // silent/defer produce no steps at all — defer follow-up semantics live upstream.
    return { steps: [], totalMs: 0 };
  }

  const reluctance = clamp01(d.reluctance);
  const arousal = deviation(a, 'arousal');
  const valence = deviation(a, 'valence');
  const cps = typingCps(arousal, valence);
  const bubbles = shapeBubbles(d.bubbles, limits.maxMsgChars, MAX_BUBBLES);
  const gaps = rng.fork('realize/gap'); // jitter stream — the caller's rng is untouched

  const steps: DeliveryStep[] = [
    { kind: 'pause', ms: msOf(PRE_DELAY_BASE_MS + PRE_DELAY_PER_RELUCTANCE_MS * reluctance) },
  ];
  for (let i = 0; i < bubbles.length; i++) {
    if (i > 0) steps.push({ kind: 'pause', ms: gapMs(arousal, gaps.float() * 2 - 1) });
    const typing = msOf((bubbles[i]!.length / cps) * 1000);
    if (typing > 0) steps.push({ kind: 'typing', ms: typing });
    steps.push({ kind: 'send', text: bubbles[i]! });
  }

  return { steps, ...cappedTotal(steps) };
};

/**
 * The 45 s ceiling: past it, every pause and typing duration scales down by the
 * same factor (sends are never dropped — completion outranks pace). Rounding
 * each duration down can leave the sum a hair over the cap, so the excess is
 * shaved off the longest steps; the result stays proportional to within a
 * millisecond and the reported total is always the exact step sum.
 */
const cappedTotal = (steps: DeliveryStep[]): { totalMs: number } => {
  const timed = steps.filter((s): s is Exclude<DeliveryStep, { kind: 'send' }> => s.kind !== 'send');
  let total = timed.reduce((acc, s) => acc + s.ms, 0);
  if (total > TOTAL_CAP_MS) {
    const scale = TOTAL_CAP_MS / total;
    for (const s of timed) s.ms = Math.floor(s.ms * scale);
    total = timed.reduce((acc, s) => acc + s.ms, 0);
    while (total > TOTAL_CAP_MS) {
      let longest = timed[0];
      for (const s of timed) if (longest === undefined || s.ms > longest.ms) longest = s;
      if (longest === undefined || longest.ms === 0) break; // unreachable: a positive sum has a positive step
      const shave = Math.min(longest.ms, total - TOTAL_CAP_MS);
      longest.ms -= shave;
      total -= shave;
    }
  }
  return { totalMs: total };
};

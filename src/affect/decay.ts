// M05 affect — exponential relaxation. Continuous time: the engine may run any
// time (per-event batches or the 15-minute job), so all rates are half-lives in
// hours, computed from the real elapsed dt, never per-tick constants.

import { AVERSIVE, NEGATIVE_DIALS, type Dial, type Primary } from './vocab.js';

/** Exponential relaxation of value toward target over dtH hours. */
export const decayToward = (value: number, target: number, dtH: number, halfLifeH: number): number => {
  if (halfLifeH <= 0) return target;
  const k = 0.5 ** (dtH / halfLifeH);
  return target + (value - target) * k;
};

// ---- per-layer half-lives (hours) — ticker.py verbatim ----

/** A dial spike halves in ~8h. */
export const HALF_LIFE_DIAL = 8.0;
/** Base fade for a primary — mood can turn in hours, not a day (v6). */
export const PRIM_HALF_LIFE = 3.5;
/** surprise is phasic by definition: a jolt that persists is a mood, not surprise. */
export const PRIM_HALF_LIFE_SURPRISE = 1.0;
/** The multi-day weather layer (~1.9 d). */
export const HALF_LIFE_MOOD = 45.0;
/** v4: was 120h. Mood is fed BY the dials and the dials relax TOWARD mood — home must pull on the same timescale as events. */
export const HALF_LIFE_MOOD_HOME = 30.0;
/** Wants come back within a day (96h left her permanently satiated). */
export const HALF_LIFE_DRIVE = 30.0;
/** Engagement energy fades toward rest over an evening. */
export const HALF_LIFE_AROUSAL = 6.0;

/** target = (1-inertia)*baseline + inertia*mood. v4: was 0.40 — it pinned her high. */
export const MOOD_INERTIA = 0.25;

/** Hurts last 1.6x longer than joys, on the aversive/NEGATIVE_DIALS directions. */
export const NEGATIVITY_BIAS = 1.6;
/** Aversive primaries still linger, but nothing like the old 1.6*7h (v6). */
export const PRIM_NEG_BIAS = 1.25;

// ---- silence-driven longing (S-010 R4): she misses him WHILE he is gone ----

/** Longing target rises toward baseline+0.40 with silence... */
export const LONGING_GAIN = 0.4;
/** ...on a 12h time constant. */
export const LONGING_TAU_H = 12.0;
export const CONNECTION_GAIN = 0.3;

/** Arousal rests no lower than this. */
export const AROUSAL_FLOOR = 0.2;

/** Whisper of variation per run, drawn from the injected rng (why tick takes one). */
export const NOISE = 0.012;

/** Which decay half-life a dial relaxes with: arousal's own evening clock; the NEGATIVE_DIALS hurt-linger bias below home. */
export const dialHalfLife = (dial: Dial, current: number, baseline: number): number => {
  if (dial === 'arousal') return HALF_LIFE_AROUSAL;
  if (NEGATIVE_DIALS.has(dial) && current < baseline) return HALF_LIFE_DIAL * NEGATIVITY_BIAS;
  return HALF_LIFE_DIAL;
};

/** Primaries: aversive fades are slower; surprise forgets fast. */
export const primaryHalfLife = (p: Primary, aboveBaseline: boolean): number => {
  if (p === 'surprise') return PRIM_HALF_LIFE_SURPRISE;
  if (aboveBaseline && AVERSIVE.has(p)) return PRIM_HALF_LIFE * PRIM_NEG_BIAS;
  return PRIM_HALF_LIFE;
};

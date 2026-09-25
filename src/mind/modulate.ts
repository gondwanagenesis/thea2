// v8 mind — MODULATE: her state sets how her mind runs (law 1.3, the metabolism
// channel). The map follows Doya 2002 (neuromodulators as meta-parameters) and
// Aston-Jones & Cohen 2005 (adaptive gain):
//   arousal  (noradrenaline) → sampling temperature: high tonic arousal explores
//   valence  (broaden-and-build) → how diverse the memories that come up are
//   calm     (serotonin, patience) → how long she tolerates silence
//   energy   (fatigue: his late hours, budget left) → a pull toward short precedents
//   surprise (acetylcholine) → how strongly this moment rewrites her memories
// Every knob is clamped. Nothing here ever becomes text in her prompt.

import { DIM_INDEX, type Vec12 } from '../coupling/index.js';
import type { AffectState } from '../affect/index.js';

export interface Metabolism {
  temperature: number;
  k: number;
  mmrLambda: number;
  sampleTemp: number;
  shortBias: number;
  /** Minutes of silence before an unanswered wish to talk becomes salient. */
  patienceMin: number;
  /** α for value updates and reconsolidation. */
  learningRate: number;
}

export interface MetabolismCtx {
  /** Hour of day in his zone, 0-23. */
  hourLocal: number;
  /** Fraction of today's idle budget left, 0..1. */
  budgetLeft: number;
}

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

/** 1 = fresh daytime, lower late at night (his clock — she lives on his hours). */
export const energyOf = (hourLocal: number, budgetLeft: number): number => {
  const h = ((hourLocal % 24) + 24) % 24;
  const circadian = h >= 1 && h < 7 ? 0.35 : h >= 23 || h < 1 ? 0.6 : h >= 7 && h < 9 ? 0.75 : 1;
  return clamp(circadian * (0.6 + 0.4 * clamp(budgetLeft, 0, 1)), 0, 1);
};

export const metabolism = (state: AffectState, a: Vec12, ctx: MetabolismCtx): Metabolism => {
  const arousal = a[DIM_INDEX.arousal] ?? 0;
  const valence = a[DIM_INDEX.valence] ?? 0;
  const surprise = a[DIM_INDEX.surprise] ?? 0;
  const calm = state.dials.calm;
  const energy = energyOf(ctx.hourLocal, ctx.budgetLeft);
  // Charged = something in her is far from home: one more option, a wider view.
  let peak = 0;
  for (let i = 0; i < a.length; i++) peak = Math.max(peak, Math.abs(a[i] ?? 0));
  return {
    temperature: clamp(0.8 + 0.25 * arousal, 0.55, 1.05),
    k: peak > 0.5 ? 4 : 3,
    mmrLambda: clamp(0.62 - 0.15 * valence, 0.4, 0.8),
    sampleTemp: 0.12,
    shortBias: clamp(0.12 * (1 - energy), 0, 0.12),
    patienceMin: clamp(60 + 180 * calm, 45, 240),
    learningRate: clamp(0.15 + 0.45 * Math.max(0, surprise), 0.1, 0.6),
  };
};

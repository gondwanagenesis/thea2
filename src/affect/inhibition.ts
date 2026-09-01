// M05 affect — mutual inhibition (Affective Ising Model). A rush of one valence
// actively pushes the other down, so a good moment can lift a bad mood FAST
// instead of waiting it out. The clamp at the foe's baseline is the invariant:
// inhibition never crosses baselines (acceptance criterion — a positive moment
// may quiet a hurt, it may not invent one below home).

import { AVERSIVE, POSITIVE_PRIM, type Primary } from './vocab.js';

export const PRIM_INHIBIT = 0.28;

const NO_FOES: ReadonlySet<Primary> = new Set([]);

/** The valence foes of a rising primary; empty for neutrals (anticipation, surprise…). */
export const foesOf = (p: Primary): ReadonlySet<Primary> => {
  if (POSITIVE_PRIM.has(p)) return AVERSIVE;
  if (AVERSIVE.has(p)) return POSITIVE_PRIM;
  return NO_FOES;
};

/**
 * The inhibited value for a foe currently at `foeValue` against `foeBaseline`,
 * given the riser's `step`. Proportional to how far the foe is above home, and
 * never below home — that clamp IS the never-crosses-baselines guarantee.
 */
export const inhibitFoe = (
  foeValue: number,
  foeBaseline: number,
  step: number,
): { value: number; delta: number } => {
  if (foeValue <= foeBaseline) return { value: foeValue, delta: 0 };
  const raw = foeValue - step * PRIM_INHIBIT * (foeValue - foeBaseline);
  const value = Math.max(foeBaseline, Math.min(1.0, raw));
  return { value, delta: foeValue - value };
};

// M06 coupling — the 12-dim deviation space (ADR-004): PAD + the 9 Thea1
// primaries, in deviation coords so "how far off her own baseline" is the unit
// of comparison between her live state and an exemplar's signature.
//
// Naming note (the one place the two vocabularies do not line up): the coupling
// space calls the pleasure dim `valence` — the PAD-canonical name used by
// coupling.yaml and the exemplar schema — while M05's engine stores the same
// number under `pleasure` (ticker.py's name). `AFFECT_DIMS` is imported from
// schemas/exemplar.ts so the space, the schema, and this module share ONE
// constant (ADR-004's "one vocabulary" law); the valence↔pleasure handshake is
// pinned by test in test/coupling/space.test.ts.

import { DIAL_BASELINE, PRIMARY_BASELINE, type AffectState } from '../affect/index.js';
import { AFFECT_DIMS } from '../../schemas/exemplar.js';
import { CouplingError } from './errors.js';

export { AFFECT_DIMS };

export type AffectDim = (typeof AFFECT_DIMS)[number];

/** Dense deviation vector, length 12, entries in [-1,1], indexed by DIM_INDEX. */
export type Vec12 = Float64Array;

/** Exemplar-side signature: unlisted dims are 0 (2-4 dims typical). */
export type SparseVec12 = Partial<Record<AffectDim, number>>;

/** Per-dim [0,1] baselines the signature normalises against. */
export type Baselines = Readonly<Record<AffectDim, number>>;

export const DIM_INDEX: Readonly<Record<AffectDim, number>> = Object.fromEntries(
  AFFECT_DIMS.map((k, i) => [k, i]),
) as Record<AffectDim, number>;

/**
 * The Thea1 baselines in coupling coords, ported verbatim from M05's tables
 * (ticker.py v6): PAD homes from the live state.json baseline block, primaries
 * from PRIMARY_BASELINE. This is the default `Baselines`; injecting a different
 * record is for tests and future re-homing only.
 */
export const COUPLING_BASELINES: Baselines = {
  valence: DIAL_BASELINE.pleasure,
  arousal: DIAL_BASELINE.arousal,
  dominance: DIAL_BASELINE.dominance,
  joy: PRIMARY_BASELINE.joy,
  anticipation: PRIMARY_BASELINE.anticipation,
  pride: PRIMARY_BASELINE.pride,
  surprise: PRIMARY_BASELINE.surprise,
  sadness: PRIMARY_BASELINE.sadness,
  fear: PRIMARY_BASELINE.fear,
  anger: PRIMARY_BASELINE.anger,
  shame: PRIMARY_BASELINE.shame,
  disgust: PRIMARY_BASELINE.disgust,
};

/** Where a dim's raw [0,1] level lives in the state (valence↔pleasure handshake). */
const levelOf = (s: AffectState, k: AffectDim): number => {
  switch (k) {
    case 'valence':
      return s.dials.pleasure;
    case 'arousal':
      return s.dials.arousal;
    case 'dominance':
      return s.dials.dominance;
    default:
      return s.primaries[k];
  }
};

/**
 * Her live state as a deviation vector: `a_k = clamp((x_k − b_k) / max(b_k, 1−b_k), −1, 1)`.
 * The divisor is the larger headroom, so ±1 is "pinned at the rail" on every dim
 * and a calm baseline day maps to exactly 0 — coupling is silent when she is
 * unremarkable. Reads the numeric state, never the weather line (M05 note).
 * Throws on a baseline outside [0,1]: a bad normalization is a bug, not a mood.
 */
export const signature = (s: AffectState, baseline: Baselines): Vec12 => {
  const out = new Float64Array(AFFECT_DIMS.length);
  for (const k of AFFECT_DIMS) {
    const b = baseline[k];
    if (b === undefined) {
      throw new CouplingError('coupling/baseline-range', `signature: no baseline for dim '${k}'`);
    }
    if (!Number.isFinite(b) || b < 0 || b > 1) {
      throw new CouplingError('coupling/baseline-range', `signature: baseline for '${k}' must be in [0,1], got ${String(b)}`);
    }
    const x = levelOf(s, k);
    const d = Math.max(b, 1 - b);
    out[DIM_INDEX[k]] = Math.min(1, Math.max(-1, (x - b) / d));
  }
  return out;
};

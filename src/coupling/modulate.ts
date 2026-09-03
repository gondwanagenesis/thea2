// M06 coupling — the modulation function. Pure, and capped INSIDE: the λ cap is
// not a caller convention, it is enforced here, because the whole point of λ is
// that [AFFECT] text plus mood-congruent selection must not compound into a
// spiral — a caller that "just this once" passes an uncapped score through would
// reintroduce Thea1's escalation path by accident. NaN is not sanitized: affect
// never produces it (M05 clamps every level into [0,1]), so a NaN here means an
// upstream bug and should stay loud.

import { fail } from '../kernel/index.js';
import { AFFECT_DIMS, DIM_INDEX, type SparseVec12, type Vec12 } from './space.js';
import type { CompiledCoupling } from './config.js';

/**
 * `clamp(aᵀMe + Σ ruleTerms, −λ, +λ)` for one candidate.
 * `a` is her live deviation vector, `e` the candidate's sparse signature, `tags`
 * its tag set. Matrix terms are summed over the sparse entries (equivalent to
 * the dense M, pinned by test); each form rule adds, when the tag set contains
 * its boostTag, `gain · max(0, a_dim − min)` for a `min` rule (fires ABOVE θ)
 * or `gain · max(0, max − a_dim)` for a `max` rule (fires BELOW θ — the
 * "when the dimension is LOW" shape). The cap is the config's λ.
 */
export const modulate = (a: Vec12, e: SparseVec12, tags: string[], compiled: CompiledCoupling): number => {
  if (a.length !== AFFECT_DIMS.length) {
    fail('coupling/vec-length', `modulate: expected a ${AFFECT_DIMS.length}-dim vector, got length ${a.length}`);
  }
  let total = 0;
  for (const entry of compiled.cfg.matrix) {
    const eTo = e[entry.to];
    if (eTo === undefined || eTo === 0) continue;
    // Index is in range by the length guard and DIM_INDEX construction.
    total += entry.w * a[DIM_INDEX[entry.from]]! * eTo;
  }
  for (const rule of compiled.cfg.formRules) {
    if (!tags.includes(rule.boostTag)) continue;
    const aDim = a[DIM_INDEX[rule.when.dim]]!;
    total += rule.when.max !== undefined
      ? rule.gain * Math.max(0, rule.when.max - aDim)
      : rule.gain * Math.max(0, aDim - rule.when.min!);
  }
  const lambda = compiled.cfg.lambda;
  return Math.min(lambda, Math.max(-lambda, total));
};

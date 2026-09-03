// M11 assemble — the scoring law and the deterministic orders built on it.
//
//   score = normalize(baseScore) + modulate(a, sig, tags) + γ·(creditW − 1)
//
// The base term is the candidate's PER-NOMINATOR RANK-NORMALIZED base
// (`baseScoreNorm`, in (0,1]) when the nominator supplies one, else the raw
// `baseScore`. Normalization is what makes λ = 0.25 mean what ADR-004 says —
// "0.25 of the score range": raw bases arrive on incomparable scales (a corpus
// cosine×weight×gravity vs a memory cosine×recency×importance vs a procedural
// outcome score), and against a raw base of ~0.05 the ±λ modulation did not
// bend selection, it OWNED it. Rank (not z-score) because it is defined for
// n = 1 and zero-variance pools (z-score divides by σ = 0 → NaN), is bounded,
// and is invariant to whatever monotone rescaling a nominator does upstream.
// The modulation term is ADDED, never re-scaled: M06 enforces the λ cap inside
// `modulate`, and re-scaling here would reopen Thea1's escalation path by
// another name. Credit enters ONLY through the additive γ term — it biases
// ties, it never overrides relevance. Gravity is NOT applied here: it is a
// baseScore multiplier the nominator applies (ADR-005), using the multiplier
// this module exports so the dial has exactly one definition.

import { AFFECT_DIMS, DIM_INDEX, modulate, type CompiledCoupling, type SparseVec12, type Vec12 } from '../coupling/index.js';
import { compareStrings, type CandidateTier, type SourceKind } from '../corpus/types.js';
import type { Candidate } from './types.js';
import { AssembleError } from './errors.js';

/** γ — the additive credit term's coefficient (spec §2.7 scoring law). */
export const CREDIT_GAMMA = 0.15;

/**
 * Rank normalization to (0,1] — the canonical per-nominator, per-packet base
 * transform. Each value becomes its (average, for ties) 1-based rank divided
 * by n: the pool's top candidate maps to 1, the floor of the scale is 1/n.
 * Properties pinned by test: monotone-preserving (order never flips), ties map
 * to EQUAL outputs (the id tie-break below them stays honest), a
 * single-candidate pool is 1 (never NaN), and the empty pool is empty.
 *
 * RANK, not z-score: a z-score is NaN on a zero-variance pool (a vector-free
 * index ranks everything at cos 0 — a normal launch state, not an error),
 * unbounded on outliers, and meaningless at n = 1. Rank is total, bounded, and
 * stable under pool perturbation.
 *
 * NOTE for M07/M09: `src/assemble` may import corpus and memory, but not the
 * other way round (the dependency DAG), so the nominators mirror this function
 * locally; a conformance test pins the mirrors equal to this definition.
 */
export const rankNormalize = (values: readonly number[]): number[] => {
  const n = values.length;
  if (n === 0) return [];
  const order = [...values.keys()].sort((x, y) => values[x]! - values[y]! || x - y);
  const out = new Array<number>(n);
  let i = 0;
  while (i < order.length) {
    // Ties share the average of their 1-based positions, so equal inputs stay
    // equal outputs and the sum of ranks is conserved.
    let j = i;
    while (j < order.length && values[order[j]!] === values[order[i]!]) j += 1;
    const avgRank = (i + 1 + j) / 2; // mean of positions i+1 .. j
    for (let k = i; k < j; k++) out[order[k]!] = avgRank / n;
    i = j;
  }
  return out;
};

/**
 * The scoring law's base term. Nominators that rank-normalize their pool ship
 * `baseScoreNorm` (in (0,1]) alongside the raw `baseScore` — the raw value
 * stays the credit-truth the PacketRecord reports ("as nominated, gravity
 * included"), while the normalized value is what the score actually adds to.
 * A candidate without the field (every test double, every not-yet-migrated
 * nominator) scores on its raw base exactly as before.
 */
const baseOf = (c: Candidate): number => {
  const norm = (c as { baseScoreNorm?: unknown }).baseScoreNorm;
  return norm === undefined ? c.baseScore : (norm as number);
};

/**
 * ADR-005/006 gravity, in one pure function: the dial governs the pattern and
 * episode tiers only; the disposition slot is canon-reserved and exempt, and
 * memory/procedure candidates are not corpus material at all. g = 0.5 is
 * neutral, seed default 0.7 ⇒ seedMult 1.4 / livedMult 0.6.
 */
export const gravityMultiplier = (tier: CandidateTier, source: SourceKind | 'memory', g: number): number => {
  if (tier !== 'pattern' && tier !== 'episode') return 1;
  return source === 'lived' ? 2 * (1 - g) : 2 * g;
};

/** The modulation term alone, kept separate so PacketRecord.slots can report it per slot. */
export const modulationOf = (a: Vec12, c: Candidate, coupling: CompiledCoupling): number =>
  modulate(a, c.sig, c.tags, coupling);

/** The full scoring law. The base term is `baseScoreNorm` when the nominator
 * supplied one (per-nominator rank-normalized, see `rankNormalize`), else the
 * raw `baseScore` — normalization happens BEFORE modulation and credit add. */
export const scoreOf = (a: Vec12, c: Candidate, coupling: CompiledCoupling): { score: number; modulation: number } => {
  const modulation = modulationOf(a, c, coupling);
  return { modulation, score: baseOf(c) + modulation + CREDIT_GAMMA * (c.creditW - 1) };
};

/**
 * A candidate carrying a non-finite score input would make every sort
 * comparator inconsistent — ordering then depends on sort implementation
 * details, i.e. nondeterminism with no seed. Rejected loudly instead.
 */
export const assertCandidateSane = (c: Candidate, nominator: string): void => {
  const bad = (what: string, v: number): AssembleError =>
    new AssembleError('assemble/bad-candidate', `nominator '${nominator}' produced candidate '${c.id}' with non-finite ${what}: ${String(v)}`);
  if (!Number.isFinite(c.baseScore)) throw bad('baseScore', c.baseScore);
  if (!Number.isFinite(c.creditW)) throw bad('creditW', c.creditW);
  // baseScoreNorm is optional but LOAD-BEARING when present: the whole point of
  // the field is the shared (0,1] scale λ is defined against, so an out-of-range
  // value is not a quirk, it is a broken normalization — rejected loudly.
  const norm = (c as { baseScoreNorm?: unknown }).baseScoreNorm;
  if (norm !== undefined) {
    if (typeof norm !== 'number' || !Number.isFinite(norm)) throw bad('baseScoreNorm', norm as number);
    if (norm <= 0 || norm > 1) {
      throw new AssembleError(
        'assemble/bad-candidate',
        `nominator '${nominator}' produced candidate '${c.id}' with baseScoreNorm ${String(norm)} outside (0,1] — rank normalization is broken`,
      );
    }
  }
  for (const [dim, v] of Object.entries(c.sig)) {
    if (v !== undefined && !Number.isFinite(v)) throw bad(`sig.${dim}`, v);
  }
};

/**
 * The one ordering used everywhere in this module: score descending, id
 * ascending — the repo convention (M04's index, M09's recall), applied to the
 * FINAL score. Total order, no rng draw, stable across instances.
 */
export const byScoreThenId = (x: Scored, y: Scored): number =>
  y.score - x.score || compareStrings(x.c.id, y.c.id);

export interface Scored {
  c: Candidate;
  score: number;
  modulation: number;
}

export const scored = (a: Vec12, c: Candidate, coupling: CompiledCoupling): Scored => {
  const { score, modulation } = scoreOf(a, c, coupling);
  return { c, score, modulation };
};

// ---------------------------------------------------------------------------
// Signature math for the coherence spread layer and the contrast metric
// ---------------------------------------------------------------------------

/** Sparse → dense 12-dim deviation vector (missing dims are silence, i.e. 0). */
export const denseOf = (sig: SparseVec12): Float64Array => {
  const out = new Float64Array(AFFECT_DIMS.length);
  for (const dim of AFFECT_DIMS) {
    const v = sig[dim];
    if (v !== undefined) out[DIM_INDEX[dim]] = v;
  }
  return out;
};

/** Mean dense signature over a selection — the packet's affect center of mass. */
export const meanDenseOf = (sigs: ReadonlyArray<SparseVec12>): Float64Array => {
  const out = new Float64Array(AFFECT_DIMS.length);
  if (sigs.length === 0) return out;
  for (const sig of sigs) {
    const dense = denseOf(sig);
    for (let i = 0; i < out.length; i++) out[i] = out[i]! + dense[i]!;
  }
  for (let i = 0; i < out.length; i++) out[i] = out[i]! / sigs.length;
  return out;
};

/**
 * The contrast metric: Euclidean distance in the 12-dim deviation space
 * between a candidate's signature and the packet's mean signature. Signature
 * space, not embedding space — the slot's job is to pull against the packet's
 * emotional center of mass (the anti-convergence mechanism), and every
 * candidate carries a signature while `vec` is optional.
 */
export const dissimilarityOf = (sig: SparseVec12, mean: Float64Array): number => {
  const dense = denseOf(sig);
  let sumSq = 0;
  for (let i = 0; i < dense.length; i++) {
    const d = dense[i]! - mean[i]!;
    sumSq += d * d;
  }
  return Math.sqrt(sumSq);
};

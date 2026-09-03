// The coupling property suite (ROADMAP S3 gate):
//   • neutral affect ⇒ modulate exactly 0
//   • modulation bounded ±λ = 0.25 — selection may be bent, never ruled
//   • per-entry monotonicity — each matrix entry moves its target monotonically,
//     no cross-dim sign flips
// All properties run over seeded inputs (kernel Rng), never Math.random.

import { describe, expect, it } from 'vitest';
import { makeRng } from '../../src/kernel/index.js';
import {
  AFFECT_DIMS,
  DIM_INDEX,
  modulate,
  type AffectDim,
  type CouplingConfig,
  type SparseVec12,
  type Vec12,
} from '../../src/coupling/index.js';
import { COMMITTED, POOL, compileConfig, uncapped, vecOf, zeroVec } from './helpers.js';

const SOME_TAGS = ['banter', 'quiet', 'crisis', 'precision'];

const seededState = (rng: ReturnType<typeof makeRng>): Vec12 => {
  const a: Vec12 = zeroVec();
  for (const k of AFFECT_DIMS) a[DIM_INDEX[k]] = Math.round(rng.float() * 200 - 100) / 100;
  return a;
};

const seededSig = (rng: ReturnType<typeof makeRng>): SparseVec12 => {
  const sig: SparseVec12 = {};
  for (let n = 0; n < rng.int(0, 6); n++) {
    sig[AFFECT_DIMS[rng.int(0, AFFECT_DIMS.length - 1)]!] = Math.round(rng.float() * 200 - 100) / 100;
  }
  return sig;
};

describe('property: neutral affect ⇒ exactly 0', () => {
  it('the zero vector gives exactly 0 for every candidate when no form rule can fire at neutral', () => {
    // Min-rules with θ ≥ 0 cannot fire at the zero vector (max(0, 0 − θ) = 0);
    // max-rules are dropped from the mutant entirely (their whole point is
    // firing strictly BELOW a negative θ, which neutral never is). Over the
    // whole pool, every tag combination: exactly 0.
    const thetaNonNegative: CouplingConfig = {
      ...COMMITTED.cfg,
      formRules: COMMITTED.cfg.formRules.flatMap((r) =>
        r.when.max !== undefined ? [] : [{ ...r, when: { dim: r.when.dim, min: Math.max(0, r.when.min) } }],
      ),
    };
    const compiled = compileConfig(thetaNonNegative);
    const a = zeroVec();
    for (const c of POOL) {
      for (const tags of [[], SOME_TAGS]) {
        expect(modulate(a, c.sig, tags, compiled), c.id).toBe(0);
      }
    }
  });

  it('a live state at baseline (signature all zeros) is that same zero vector', () => {
    // Covered via space.test.ts; here the commitment that matters to M11: a
    // neutral turn modulates NOTHING for untagged candidates.
    expect(modulate(zeroVec(), POOL[0]!.sig, [], COMMITTED)).toBe(0);
    expect(modulate(zeroVec(), POOL[10]!.sig, [], COMMITTED)).toBe(0);
  });

  it('RESOLVED (v2) — the committed document itself is exactly 0 at neutral, every candidate, every tag set', () => {
    // The v1 quiet rules carried min: −0.4 and boosted quiet-tagged candidates
    // +0.072 AT neutral (the pinned KNOWN DEVIATION). v2 expresses them as max
    // rules — firing strictly below θ — so ADR-004's "neutral affect means
    // modulation is exactly 0" holds for the committed document as shipped.
    for (const c of POOL) {
      for (const tags of [[], SOME_TAGS, ['quiet'], ['banter', 'crisis']]) {
        expect(modulate(zeroVec(), c.sig, tags, COMMITTED), `${c.id} [${tags.join(',')}]`).toBe(0);
      }
    }
  });

  it('the quiet max-rules fire only strictly BELOW θ = −0.4, growing as the dim falls', () => {
    const quiet = (arousal: number, valence = 0): number =>
      modulate(vecOf({ arousal, valence }), {}, ['quiet'], uncapped(COMMITTED));
    expect(quiet(-0.39)).toBe(0); // above θ: silent
    expect(quiet(-0.4)).toBe(0); // exactly at θ: max(0, 0) — silent
    expect(quiet(-0.5)).toBeCloseTo(0.10 * 0.1, 12); // 0.1 past θ on arousal
    expect(quiet(-0.9, -0.5)).toBeCloseTo(0.10 * 0.5 + 0.08 * 0.1, 12); // both sides sum
  });
});

describe('property: bounded ±λ (0.25) — bent, never ruled', () => {
  it('over 500 seeded adversarial (state, signature, tags) triples', () => {
    const rng = makeRng('coupling/bounded-v1');
    const lambda = COMMITTED.cfg.lambda;
    for (let i = 0; i < 500; i++) {
      const a = seededState(rng);
      const sig = seededSig(rng);
      const tags = SOME_TAGS.filter(() => rng.float() < 0.5);
      const m = modulate(a, sig, tags, COMMITTED);
      expect(Math.abs(m), `trial ${i}`).toBeLessThanOrEqual(lambda + 1e-12);
    }
  });

  it('the all-extremes corner (every dim pinned, every tag present) is clamped', () => {
    const a: Vec12 = zeroVec();
    for (const k of AFFECT_DIMS) a[DIM_INDEX[k]] = k === 'valence' || k === 'joy' ? 1 : -1;
    const sig: SparseVec12 = {};
    for (const k of AFFECT_DIMS) sig[k] = 1;
    const m = modulate(a, sig, SOME_TAGS, COMMITTED);
    expect(Math.abs(m)).toBeLessThanOrEqual(COMMITTED.cfg.lambda + 1e-12);
  });
});

describe('property: per-entry monotonicity, no cross-dim sign flips', () => {
  // Uncapped view so we assert the matrix's own shape, before the cap.
  const flat = uncapped(COMMITTED);

  it('every committed entry moves a unit-target candidate exactly w·Δ, in the sign of w', () => {
    for (const entry of COMMITTED.cfg.matrix) {
      const sig: SparseVec12 = { [entry.to]: 1 };
      const at = (from: number): number => modulate(vecOf({ [entry.from]: from }), sig, [], flat);
      const delta = at(0.4) - at(0.1);
      expect(delta, `${entry.from}→${entry.to} (${entry.why})`).toBeCloseTo(entry.w * 0.3, 12);
      expect(Math.sign(delta)).toBe(Math.sign(entry.w));
      // Strictly monotone across the whole range, no plateaus, no flips.
      const levels = [-0.9, -0.5, -0.1, 0, 0.1, 0.5, 0.9];
      for (let i = 1; i < levels.length; i++) {
        const lo = at(levels[i - 1]!);
        const hi = at(levels[i]!);
        if (entry.w > 0) expect(hi, `${entry.from}→${entry.to} @${levels[i]}`).toBeGreaterThan(lo);
        else expect(hi, `${entry.from}→${entry.to} @${levels[i]}`).toBeLessThan(lo);
      }
    }
  });

  it("raising one dim moves the score by exactly what the entries reading that dim contribute — no cross-dim contamination", () => {
    const rng = makeRng('coupling/monotone-v1');
    for (let trial = 0; trial < 200; trial++) {
      const entry = COMMITTED.cfg.matrix[rng.int(0, COMMITTED.cfg.matrix.length - 1)]!;
      const sig = seededSig(rng);
      const base = seededState(rng);
      const delta = 0.15;
      const raised: Vec12 = zeroVec();
      for (const k of AFFECT_DIMS) raised[DIM_INDEX[k]] = base[DIM_INDEX[k]]!;
      raised[DIM_INDEX[entry.from]] = base[DIM_INDEX[entry.from]]! + delta;

      const before = modulate(base, sig, [], flat);
      const after = modulate(raised, sig, [], flat);
      // The movement decomposes EXACTLY over the entries that read a[from] —
      // entries reading other dims are untouched, so nothing else can move.
      const expected = delta * COMMITTED.cfg.matrix
        .filter((e) => e.from === entry.from)
        .reduce((acc, e) => acc + e.w * (sig[e.to] ?? 0), 0);
      expect(after - before, `trial ${trial} ${entry.from}→${entry.to}`).toBeCloseTo(expected, 12);
      // Per-entry sign: this entry's own slice moves in sign(w · e[to]) — toward
      // congruence when the candidate leans the same way, against it otherwise.
      // Whatever sign it takes, it is decided by w and e[to] alone; no other dim
      // can flip it (the exact decomposition above is that proof).
      const targetLevel = sig[entry.to] ?? 0;
      const own = delta * entry.w * targetLevel;
      if (own !== 0) expect(Math.sign(own), `trial ${trial} ${entry.from}→${entry.to}`).toBe(Math.sign(entry.w * targetLevel));
    }
  });

  it('stays monotone under the committed λ for within-cap deltas', () => {
    for (const entry of COMMITTED.cfg.matrix) {
      const sig: SparseVec12 = { [entry.to]: 0.5 };
      const at = (from: number): number => modulate(vecOf({ [entry.from]: from }), sig, [], COMMITTED);
      for (const x of [-0.4, -0.2, 0, 0.2, 0.4]) {
        const lo = at(x);
        const hi = at(x + 0.1);
        // |w · 0.1 · 0.5| ≤ 0.05 ≪ λ — inside the cap, so monotonicity is visible.
        if (entry.w > 0) expect(hi).toBeGreaterThan(lo);
        else expect(hi).toBeLessThan(lo);
      }
    }
  });

  it('the matrix reads exactly the dims it declares entries for — sparsity is honest', () => {
    // A dim no entry reads (from) cannot move ANY score; with the committed file
    // that is dominance alone: the matrix never reads her dominance, it only
    // rewards it in candidates (anger→dominance, fear→dominance) — the correctives
    // reach for grounded material without asking how dominant she feels.
    const read = new Set<AffectDim>(COMMITTED.cfg.matrix.map((e) => e.from));
    for (const k of AFFECT_DIMS) {
      const m = modulate(vecOf({ [k]: 1 }), { [k]: 1 }, [], uncapped(COMMITTED));
      if (read.has(k)) expect(Math.abs(m), k).toBeGreaterThan(0);
      else expect(m, `${k} is not read by any entry`).toBe(0);
    }
    expect([...read].sort()).toEqual(AFFECT_DIMS.filter((k) => k !== 'dominance').sort());
  });
});

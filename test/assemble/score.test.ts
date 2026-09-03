// M11 scoring law — the rank-normalized base. Acceptance criteria (Package D):
//   • normalization is monotone-preserving (and ties stay equal);
//   • no NaN on single-candidate nominators (a normal vector-free launch pool);
//   • `coupling modulation no longer saturates episode slots` — the honest
//     equivalent: over the committed coupling document, a neutral packet's
//     max |modulation| is exactly 0, and a deviated packet's is bounded by λ
//     while normalized bases put a full rank-gap beyond modulation's reach.
// All over seeded inputs (kernel Rng) or hand-computed values — hermetic.

import { describe, expect, it } from 'vitest';
import { assertCandidateSane, CREDIT_GAMMA, modulationOf, rankNormalize, scoreOf } from '../../src/assemble/score.js';
import { AssembleError } from '../../src/assemble/errors.js';
import { cand, flat12, sig12 } from './helpers.js';
import { COMMITTED } from '../coupling/helpers.js';
import { makeRng } from '../../src/kernel/index.js';
import type { Candidate } from '../../src/assemble/index.js';
import { AFFECT_DIMS, DIM_INDEX } from '../../src/coupling/index.js';

const FLAT = flat12();

/**
 * Attach the normalized base the way a nominator does — structurally (the
 * field rides on the mirror types, M11's Candidate reads it defensively), so
 * the test constructs it the same way src/corpus and src/memory ship it.
 */
const withNorm = (c: Candidate, baseScoreNorm: number): Candidate => ({ ...c, baseScoreNorm }) as Candidate;

describe('rankNormalize — the canonical per-nominator base transform', () => {
  it('hand-computed fractional ranks: top is 1, floor is 1/n, ties share the average rank', () => {
    expect(rankNormalize([0.9, 0.1, 0.5])).toEqual([1, 1 / 3, 2 / 3]);
    // ties at the top of a 4-pool share positions 3+4 → avg 3.5 → 3.5/4
    expect(rankNormalize([0.2, 0.2, 0.6, 0.6])).toEqual([3.5 / 4, 3.5 / 4, 1, 1]);
    expect(rankNormalize([5, 5, 5])).toEqual([0.5, 0.5, 0.5]);
  });

  it('edge sizes: empty pool is empty; a single candidate is exactly 1 — never NaN', () => {
    expect(rankNormalize([])).toEqual([]);
    expect(rankNormalize([0])).toEqual([1]);
    expect(rankNormalize([0.0001])).toEqual([1]);
    expect(rankNormalize([Number.NaN])).toEqual([Number.NaN]); // pass-through: intake rejects NaN loudly
  });

  it('monotone-preserving over seeded pools: order never flips, ties stay equal, output in (0,1]', () => {
    const rng = makeRng('assemble/ranknorm-v1');
    for (let trial = 0; trial < 300; trial++) {
      const n = rng.int(1, 40);
      const values = Array.from({ length: n }, () => Math.round(rng.float() * 200 - 100) / 100);
      const normed = rankNormalize(values);
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          if (values[i]! < values[j]!) expect(normed[i]!, `trial ${trial} [${i}]<[${j}]`).toBeLessThan(normed[j]!);
          if (values[i] === values[j]) expect(normed[i], `trial ${trial} tie [${i}][${j}]`).toBe(normed[j]);
        }
        expect(normed[i]!, `trial ${trial} bounds`).toBeGreaterThan(0);
        expect(normed[i]!, `trial ${trial} bounds`).toBeLessThanOrEqual(1);
      }
    }
  });

  it('is a pure function: the input array survives untouched', () => {
    const values = [3, 1, 2];
    rankNormalize(values);
    expect(values).toEqual([3, 1, 2]);
  });
});

describe('the scoring law with a normalized base', () => {
  it('scoreOf prefers baseScoreNorm over the raw baseScore; absent field behaves exactly as before', () => {
    const a = sig12({ joy: 0.4 });
    const normed = withNorm(cand({ id: 'n', baseScore: 0.8, creditW: 1.5, sig: { joy: 0.5 }, tags: ['play'] }), 0.25);
    const plain = cand({ id: 'p', baseScore: 0.8, creditW: 1.5, sig: { joy: 0.5 }, tags: ['play'] });
    const { score: normedScore, modulation } = scoreOf(a, normed, COMMITTED);
    // normalization happens BEFORE modulation and credit add
    expect(normedScore).toBeCloseTo(0.25 + modulation + CREDIT_GAMMA * 0.5, 12);
    // no field ⇒ the raw base, byte-for-byte the old law
    expect(scoreOf(a, plain, COMMITTED).score).toBeCloseTo(0.8 + modulation + CREDIT_GAMMA * 0.5, 12);
    // modulation itself is untouched by the base choice
    expect(modulationOf(a, normed, COMMITTED)).toBe(modulationOf(a, plain, COMMITTED));
  });

  it('intake sanity: baseScoreNorm must be finite and inside (0,1] — a broken normalization is loud', () => {
    const ok = withNorm(cand({ id: 'ok' }), 1);
    expect(() => assertCandidateSane(ok, 'test')).not.toThrow();
    const zero = withNorm(cand({ id: 'zero' }), 0);
    expect(() => assertCandidateSane(zero, 'test')).toThrowError(AssembleError);
    const beyond = withNorm(cand({ id: 'beyond' }), 1.2);
    expect(() => assertCandidateSane(beyond, 'test')).toThrowError(/outside \(0,1\]/);
    const nan = withNorm(cand({ id: 'nan' }), Number.NaN);
    expect(() => assertCandidateSane(nan, 'test')).toThrowError(/non-finite baseScoreNorm/);
  });
});

describe('acceptance — coupling modulation no longer saturates the packet', () => {
  // A packet's worth of candidates, corpus-shaped: raw bases on the old cosine
  // scale (~0.0–1.4) with their per-nominator rank-normalized values attached.
  const RAW = [1.4, 1.1, 0.9, 0.7, 0.5, 0.3, 0.2, 0.1, 0.05];
  const packet = (): Candidate[] => {
    const normed = rankNormalize(RAW);
    return RAW.map((base, i) =>
      withNorm(
        cand({
          id: `c${i}`,
          baseScore: base,
          sig: i % 3 === 0 ? { sadness: 0.6, valence: -0.4 } : i % 3 === 1 ? { joy: 0.5, arousal: 0.3 } : {},
          tags: i % 3 === 0 ? ['quiet'] : i % 3 === 1 ? ['banter'] : [],
        }),
        normed[i]!,
      ),
    );
  };

  it('over the committed document, a neutral packet modulates EXACTLY 0 — every slot', () => {
    // The v1 always-on quiet boost (+0.072 at flat affect) is dead: neutral in,
    // exactly 0 out, for the whole packet including quiet-tagged candidates.
    for (const c of packet()) {
      expect(modulationOf(FLAT, c, COMMITTED), c.id).toBe(0);
      expect(scoreOf(FLAT, c, COMMITTED).modulation).toBe(0);
    }
  });

  it('a deviated packet stays bounded by λ — and a moderate deviation never reaches it', () => {
    const rng = makeRng('assemble/saturation-v1');
    let maxSeen = 0;
    for (let trial = 0; trial < 200; trial++) {
      const a = flat12();
      for (const k of AFFECT_DIMS) a[DIM_INDEX[k]] = Math.round(rng.float() * 200 - 100) / 100;
      for (const c of packet()) {
        const m = modulationOf(a, c, COMMITTED);
        maxSeen = Math.max(maxSeen, Math.abs(m));
        expect(Math.abs(m), `trial ${trial} ${c.id}`).toBeLessThanOrEqual(COMMITTED.cfg.lambda + 1e-12);
      }
    }
    expect(maxSeen).toBeGreaterThan(0); // the trial really did move things
  });

  it('with normalized bases, a full rank-gap (≥ 2λ) can no longer be crossed by modulation alone', () => {
    // The saturation failure, stated as the invariant that kills it: the top
    // candidate's normalized base outranks the floor's by 1 − 1/n; once that
    // gap exceeds 2λ, NO admissible modulation pair can invert the order.
    const normed = rankNormalize(RAW);
    const gap = normed[0]! - normed[normed.length - 1]!;
    expect(gap).toBeGreaterThan(2 * COMMITTED.cfg.lambda);
    const top = cand({ id: 'top', baseScore: RAW[0]!, sig: {} });
    const floor = cand({ id: 'floor', baseScore: RAW[RAW.length - 1]!, sig: { sadness: 1, anger: 1, valence: -1 }, tags: ['quiet', 'crisis'] });
    // Worst case: her state is the floor candidate's congruent extreme, the top
    // candidate's is adversarial — the rails are ±λ, so the scores cannot cross.
    const a = sig12({ sadness: 1, anger: 1, valence: -1 });
    const topScore = scoreOf(a, withNorm(top, normed[0]!), COMMITTED).score;
    const floorScore = scoreOf(a, withNorm(floor, normed[normed.length - 1]!), COMMITTED).score;
    expect(topScore).toBeGreaterThan(floorScore);
  });
});

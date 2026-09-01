// modulate — the math goldens (hand-computed aᵀMe), the form-rule θ/gain edges,
// the cap at the extremes, and purity. The cap is the point: [AFFECT] text plus
// mood-congruent selection is Thea1's compounding path, and λ is what stops it.

import { describe, expect, it } from 'vitest';
import { makeRng } from '../../src/kernel/index.js';
import {
  AFFECT_DIMS,
  DIM_INDEX,
  modulate,
  type CompiledCoupling,
  type CouplingConfig,
  type MatrixEntry,
  type SparseVec12,
  type Vec12,
} from '../../src/coupling/index.js';
import { vecOf, zeroVec, COMMITTED } from './helpers.js';

const entry = (from: MatrixEntry['from'], to: MatrixEntry['to'], w: number, why = 'test'): MatrixEntry => ({ from, to, w, why });

/** The hand-built config the goldens were computed against. */
const CFG: CouplingConfig = {
  version: 1,
  lambda: 0.25,
  matrix: [entry('valence', 'valence', 0.5), entry('sadness', 'valence', 0.35), entry('arousal', 'sadness', -0.25)],
  formRules: [{ when: { dim: 'sadness', min: 0.35 }, boostTag: 'crisis', gain: 0.1, why: 'test rule' }],
};

const compiled: CompiledCoupling = {
  cfg: CFG,
  m: (() => {
    const m = new Float64Array(AFFECT_DIMS.length * AFFECT_DIMS.length);
    for (const x of CFG.matrix) m[DIM_INDEX[x.from] * AFFECT_DIMS.length + DIM_INDEX[x.to]] = x.w;
    return m;
  })(),
};

describe('modulate — hand-computed aᵀMe goldens', () => {
  // a = (valence −0.5, sadness 0.6, arousal 0.4); sig = {valence 0.6, sadness 0.2}
  //   valence→valence:  0.50 · (−0.5) · 0.6 = −0.15
  //   sadness→valence:  0.35 ·  0.6  · 0.6 = +0.126
  //   arousal→sadness: −0.25 ·  0.4  · 0.2 = −0.02      → total −0.044
  const a = vecOf({ valence: -0.5, sadness: 0.6, arousal: 0.4 });
  const sig: SparseVec12 = { valence: 0.6, sadness: 0.2 };

  it('matches the hand computation', () => {
    expect(modulate(a, sig, [], compiled)).toBeCloseTo(-0.044, 12);
  });

  it('adds the form rule only when the tag set carries boostTag', () => {
    // + 0.10 · max(0, 0.6 − 0.35) = +0.025 → −0.019
    expect(modulate(a, sig, ['crisis'], compiled)).toBeCloseTo(-0.019, 12);
    expect(modulate(a, sig, ['quiet', 'work'], compiled)).toBeCloseTo(-0.044, 12); // no 'crisis', no boost
  });

  it("θ is the rule's when.min: nothing below, nothing exactly at, gain·(a−θ) above", () => {
    const at = (sadness: number): number => modulate(vecOf({ sadness }), {}, ['crisis'], compiled);
    expect(at(0.34)).toBeCloseTo(0, 12); // below θ — and no matrix term (sig has no valence)
    expect(at(0.35)).toBeCloseTo(0, 12); // exactly at θ — max(0, 0)
    expect(at(0.6)).toBeCloseTo(0.1 * 0.25, 12); // gain · (0.6 − 0.35)
    expect(at(1.0)).toBeCloseTo(0.1 * 0.65, 12);
  });

  it('an empty signature and empty tags give 0 regardless of state', () => {
    expect(modulate(a, {}, [], compiled)).toBeCloseTo(0, 12);
  });

  it('agrees with the dense aᵀM·e computation over seeded random inputs (cap included)', () => {
    const rng = makeRng('coupling/dense-vs-sparse');
    const randDim = (): MatrixEntry['from'] => AFFECT_DIMS[rng.int(0, AFFECT_DIMS.length - 1)]!;
    for (let trial = 0; trial < 300; trial++) {
      const av: Vec12 = zeroVec();
      for (const k of AFFECT_DIMS) av[DIM_INDEX[k]] = Math.round(rng.float() * 200 - 100) / 100;
      const sv: SparseVec12 = {};
      for (let n = 0; n < rng.int(0, 5); n++) sv[randDim()] = Math.round(rng.float() * 200 - 100) / 100;

      let dense = 0;
      for (const i of AFFECT_DIMS) {
        for (const j of AFFECT_DIMS) {
          dense += av[DIM_INDEX[i]]! * compiled.m[DIM_INDEX[i] * AFFECT_DIMS.length + DIM_INDEX[j]]! * (sv[j] ?? 0);
        }
      }
      const expected = Math.min(0.25, Math.max(-0.25, dense));
      expect(modulate(av, sv, [], compiled), `trial ${trial}`).toBeCloseTo(expected, 12);
    }
  });
});

describe('modulate — the cap holds at the extremes', () => {
  const big: CouplingConfig = {
    version: 1,
    lambda: 0.25,
    matrix: [
      entry('valence', 'valence', 1, 'maxed'),
      entry('sadness', 'valence', 1, 'maxed'),
      entry('anger', 'dominance', 1, 'maxed'),
      entry('joy', 'joy', 1, 'maxed'),
    ],
    formRules: [
      { when: { dim: 'sadness', min: -1 }, boostTag: 'quiet', gain: 1, why: 'maxed' },
      { when: { dim: 'arousal', min: -1 }, boostTag: 'banter', gain: 1, why: 'maxed' },
    ],
  };
  const capped: CompiledCoupling = { cfg: big, m: new Float64Array(AFFECT_DIMS.length * AFFECT_DIMS.length) };

  it('a pinned state against a pinned signature saturates at exactly +λ, never beyond', () => {
    const a = vecOf({ valence: 1, sadness: 1, anger: 1, joy: 1, arousal: 1 });
    const sig: SparseVec12 = { valence: 1, dominance: 1, joy: 1, sadness: 1 };
    expect(modulate(a, sig, ['quiet', 'banter'], capped)).toBe(0.25);
  });

  it('and at exactly −λ when the state pulls against the material', () => {
    // Committed valence diagonal is 0.5: a.valence = −1 against {valence: 1} gives
    // −0.5 raw — the cap, not the matrix, is what returns −0.25.
    const aDown = vecOf({ valence: -1 });
    expect(modulate(aDown, { valence: 1 }, [], COMMITTED)).toBe(-0.25);
  });
});

describe('modulate — purity and loudness', () => {
  it('mutates nothing: state, signature, tags, and config survive a call untouched', () => {
    const a = vecOf({ valence: -0.5, sadness: 0.6 });
    const aCopy = [...a];
    const sig: SparseVec12 = { valence: 0.6, sadness: 0.2 };
    const sigCopy = { ...sig };
    const tags = ['crisis'];
    const tagsCopy = [...tags];
    const cfgCopy = JSON.parse(JSON.stringify(COMMITTED.cfg)) as CouplingConfig;

    modulate(a, sig, tags, COMMITTED);

    expect([...a]).toEqual(aCopy);
    expect(sig).toEqual(sigCopy);
    expect(tags).toEqual(tagsCopy);
    expect(COMMITTED.cfg).toEqual(cfgCopy);
  });

  it('refuses a vector of the wrong arity instead of silently reading zeros', () => {
    const short = new Float64Array(6);
    expect(() => modulate(short, {}, [], COMMITTED)).toThrowError(/12-dim/);
  });

  it('NaN propagates rather than being silently flattened to 0', () => {
    const a = zeroVec();
    a[DIM_INDEX.valence] = Number.NaN;
    expect(modulate(a, { valence: 1 }, [], COMMITTED)).toBeNaN();
  });
});

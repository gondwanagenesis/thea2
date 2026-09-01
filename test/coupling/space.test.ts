// space.ts — the 12-dim deviation space. The boundary table below is the
// hand-derived closed form of `a_k = clamp((x_k − b_k)/max(b_k, 1−b_k), −1, 1)`
// written out per dim against the Thea1 baselines: both branches of max(),
// both clamp rails, and the unclamped interior. The valence↔pleasure handshake
// and the baselines are pinned here so the two vocabularies cannot drift apart
// silently (ADR-004's one-vocabulary law, made executable).

import { describe, expect, it } from 'vitest';
import {
  AFFECT_DIMS,
  COUPLING_BASELINES,
  DIM_INDEX,
  compileCoupling,
  isCouplingError,
  signature,
  type AffectDim,
  type Baselines,
  type Vec12,
} from '../../src/coupling/index.js';
import { EMOTION_PRIMARIES, baselineOf, type Dial, type Primary } from '../../src/affect/index.js';
import { COUPLING_YAML, compileConfig, stateAtBaseline, stateWith } from './helpers.js';

describe('COUPLING_BASELINES — the Thea1 homes, verbatim', () => {
  it('carries the ticker.py numbers in coupling coords', () => {
    expect(COUPLING_BASELINES.valence).toBe(0.66); // DIAL_BASELINE.pleasure
    expect(COUPLING_BASELINES.arousal).toBe(0.34);
    expect(COUPLING_BASELINES.dominance).toBe(0.0);
    expect(COUPLING_BASELINES.joy).toBe(0.35);
    expect(COUPLING_BASELINES.anticipation).toBe(0.3);
    expect(COUPLING_BASELINES.pride).toBe(0.28);
    expect(COUPLING_BASELINES.surprise).toBe(0.1);
    expect(COUPLING_BASELINES.sadness).toBe(0.1);
    expect(COUPLING_BASELINES.fear).toBe(0.08);
    expect(COUPLING_BASELINES.anger).toBe(0.06);
    expect(COUPLING_BASELINES.shame).toBe(0.06);
    expect(COUPLING_BASELINES.disgust).toBe(0.05);
  });

  it('agrees dim-for-dim with the M05 engine baselines (valence ↔ pleasure handshake)', () => {
    // The coupling space and the engine space must never fork: every coupling
    // baseline IS the engine baseline of the dim it reads, with 'valence' the
    // PAD-canonical name for the engine's 'pleasure'.
    const ENGINE_NAME: Record<AffectDim, Primary | Dial> = {
      valence: 'pleasure',
      arousal: 'arousal',
      dominance: 'dominance',
      joy: 'joy',
      anticipation: 'anticipation',
      pride: 'pride',
      surprise: 'surprise',
      sadness: 'sadness',
      fear: 'fear',
      anger: 'anger',
      shame: 'shame',
      disgust: 'disgust',
    };
    for (const k of AFFECT_DIMS) {
      expect(COUPLING_BASELINES[k], k).toBe(baselineOf(ENGINE_NAME[k]));
    }
    // The 9 primaries are the same 9 names in both spaces.
    const couplingPrimaries = AFFECT_DIMS.slice(3);
    expect([...couplingPrimaries].sort()).toEqual([...EMOTION_PRIMARIES].sort());
  });
});

describe('signature — the boundary table (acceptance: formula exact on the rails)', () => {
  // Hand-derived per dim: divisor d = max(b, 1−b); b ≤ 0.5 ⇒ d = 1−b, so x=0 → −b/d and x=1 → +1;
  // b > 0.5 ⇒ d = b, so x=0 → −1 and x=1 → (1−b)/b. The x=−0.5 / x=1.5 columns hit the clamp
  // rails only where |x−b|/d would exceed 1.
  interface Row {
    dim: AffectDim;
    b: number;
    atZero: number;
    atOne: number;
    atMinusHalf: number;
    atOneAndHalf: number;
  }
  const ROWS: Array<Row> = [
    { dim: 'valence', b: 0.66, atZero: -1, atOne: 0.34 / 0.66, atMinusHalf: -1, atOneAndHalf: 1 },
    { dim: 'arousal', b: 0.34, atZero: -(0.34 / 0.66), atOne: 1, atMinusHalf: -1, atOneAndHalf: 1 },
    { dim: 'dominance', b: 0.0, atZero: 0 / 1, atOne: 1, atMinusHalf: -0.5, atOneAndHalf: 1 },
    { dim: 'joy', b: 0.35, atZero: -(0.35 / 0.65), atOne: 1, atMinusHalf: -1, atOneAndHalf: 1 },
    { dim: 'anticipation', b: 0.3, atZero: -(0.3 / 0.7), atOne: 1, atMinusHalf: -1, atOneAndHalf: 1 },
    { dim: 'pride', b: 0.28, atZero: -(0.28 / 0.72), atOne: 1, atMinusHalf: -1, atOneAndHalf: 1 },
    { dim: 'surprise', b: 0.1, atZero: -(0.1 / 0.9), atOne: 1, atMinusHalf: -(0.6 / 0.9), atOneAndHalf: 1 },
    { dim: 'sadness', b: 0.1, atZero: -(0.1 / 0.9), atOne: 1, atMinusHalf: -(0.6 / 0.9), atOneAndHalf: 1 },
    { dim: 'fear', b: 0.08, atZero: -(0.08 / 0.92), atOne: 1, atMinusHalf: -(0.58 / 0.92), atOneAndHalf: 1 },
    { dim: 'anger', b: 0.06, atZero: -(0.06 / 0.94), atOne: 1, atMinusHalf: -(0.56 / 0.94), atOneAndHalf: 1 },
    { dim: 'shame', b: 0.06, atZero: -(0.06 / 0.94), atOne: 1, atMinusHalf: -(0.56 / 0.94), atOneAndHalf: 1 },
    { dim: 'disgust', b: 0.05, atZero: -(0.05 / 0.95), atOne: 1, atMinusHalf: -(0.55 / 0.95), atOneAndHalf: 1 },
  ];

  it('covers all 12 dims', () => {
    expect(new Set(ROWS.map((r) => r.dim))).toEqual(new Set(AFFECT_DIMS));
  });

  for (const row of ROWS) {
    it(`${row.dim} (b=${row.b}): baseline→0, 0→${row.atZero.toFixed(4)}, 1→${row.atOne.toFixed(4)}, rails respected`, () => {
      const sig = (x: number): Vec12 => signature(stateWith({ [row.dim]: x }), COUPLING_BASELINES);
      const i = DIM_INDEX[row.dim];

      expect(sig(row.b)[i]).toBe(0); // at baseline: exactly 0, no float dust
      expect(sig(0)[i]).toBeCloseTo(row.atZero, 12);
      expect(sig(1)[i]).toBeCloseTo(row.atOne, 12);
      expect(sig(-0.5)[i]).toBeCloseTo(row.atMinusHalf, 12);
      expect(sig(1.5)[i]).toBeCloseTo(row.atOneAndHalf, 12);
    });
  }

  it('a state at baseline on every dim is the exact zero vector — coupling is silent when she is unremarkable', () => {
    const a = signature(stateAtBaseline(), COUPLING_BASELINES);
    expect(a.length).toBe(12);
    for (let i = 0; i < a.length; i++) expect(a[i]).toBe(0);
  });

  it('reads the numeric state, not the mood layer and not the weather line', () => {
    const s = stateAtBaseline();
    s.primaries.joy = 1.0;
    s.mood.joy = 1.0;
    const live = signature(s, COUPLING_BASELINES);
    expect(live[DIM_INDEX.joy]).toBeCloseTo(1, 12);
    // The mood layer alone moves nothing: coupling reads the live level.
    const moodOnly = stateAtBaseline();
    moodOnly.mood.joy = 1.0;
    expect(signature(moodOnly, COUPLING_BASELINES)[DIM_INDEX.joy]).toBe(0);
  });

  it('throws on a baseline that cannot normalize (missing or out of [0,1])', () => {
    const short: Partial<Record<AffectDim, number>> = { ...COUPLING_BASELINES };
    delete short['joy'];
    expect(() => signature(stateAtBaseline(), short as Baselines)).toThrowError(/joy/);

    let threw: unknown;
    try {
      signature(stateAtBaseline(), { ...COUPLING_BASELINES, joy: 1.2 });
    } catch (e) {
      threw = e;
    }
    expect(isCouplingError(threw)).toBe(true);
    if (isCouplingError(threw)) expect(threw.code).toBe('coupling/baseline-range');
  });
});

describe('the space itself', () => {
  it('AFFECT_DIMS is the 12-dim ADR-004 space, in order', () => {
    expect([...AFFECT_DIMS]).toEqual([
      'valence', 'arousal', 'dominance',
      'joy', 'anticipation', 'pride', 'surprise',
      'sadness', 'fear', 'anger', 'shame', 'disgust',
    ]);
  });

  it('DIM_INDEX is the identity permutation over that order', () => {
    AFFECT_DIMS.forEach((k, i) => expect(DIM_INDEX[k]).toBe(i));
  });

  it('the committed coupling.yaml speaks exactly this vocabulary (its header names the 12 dims)', () => {
    // The doc's dim line is prose; the real guarantee is that compileCoupling
    // (which only accepts AFFECT_DIMS names) accepts the committed file.
    expect(() => compileCoupling(COUPLING_YAML)).not.toThrow();
    // compileConfig is the test-side dense builder; it must agree with the
    // compiler's dense artifact on the same config.
    const compiled = compileCoupling(COUPLING_YAML);
    const again = compileConfig(compiled.cfg);
    expect([...again.m]).toEqual([...compiled.m]);
  });
});

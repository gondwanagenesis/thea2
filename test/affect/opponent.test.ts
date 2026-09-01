// opponent.ts — the b-process (Solomon & Corbit). The lag gate is the point: the
// pull must be zero while the rush is happening and reach full strength only
// OPP_LAG_H later, or she could never peak at all.

import { describe, expect, it } from 'vitest';
import {
  HALF_LIFE_OPP,
  OPP_GAIN,
  OPP_LAG_H,
  PRIM_OPP_GAIN,
  PRIM_OPP_LAG_H,
  decayOpponent,
  growOpponent,
  opponentPull,
} from '../../src/affect/index.js';
import { H, T0 } from './helpers.js';

describe('the b-process accumulates', () => {
  it('a rush of step s grows the pull by s * gain, stamped with the push time', () => {
    expect(growOpponent(undefined, 0.2, OPP_GAIN, T0)).toEqual({ b: 0.07, t0: T0 });
    const twice = growOpponent(growOpponent(undefined, 0.2, OPP_GAIN, T0), 0.1, OPP_GAIN, T0 + 1);
    expect(twice.b).toBeCloseTo(0.105, 10);
    expect(twice.t0).toBe(T0 + 1);
  });

  it('primaries collect a harder comedown than dials (PRIM_OPP_GAIN 0.55)', () => {
    expect(growOpponent(undefined, 0.2, PRIM_OPP_GAIN, T0).b).toBeCloseTo(0.11, 10);
  });
});

describe('the lag gate — slow on BOTH ends', () => {
  it('is silent at the moment of the push', () => {
    const tr = growOpponent(undefined, 1.0, OPP_GAIN, T0);
    expect(opponentPull(tr, T0, OPP_LAG_H)).toBe(0);
  });

  it('ramps linearly to full strength over OPP_LAG_H and then holds', () => {
    const tr = growOpponent(undefined, 1.0, OPP_GAIN, T0);
    expect(opponentPull(tr, T0 + H(1), OPP_LAG_H)).toBeCloseTo(0.5 * OPP_GAIN, 12);
    expect(opponentPull(tr, T0 + H(2), OPP_LAG_H)).toBeCloseTo(OPP_GAIN, 12);
    expect(opponentPull(tr, T0 + H(10), OPP_LAG_H)).toBeCloseTo(OPP_GAIN, 12);
  });

  it('primaries come to full pull in 1h, dials in 2h', () => {
    const tr = growOpponent(undefined, 1.0, 1.0, T0);
    expect(opponentPull(tr, T0 + H(0.5), PRIM_OPP_LAG_H)).toBeCloseTo(0.5, 12);
    expect(opponentPull(tr, T0 + H(0.5), OPP_LAG_H)).toBeCloseTo(0.25, 12);
  });

  it('a missing trace pulls nothing', () => {
    expect(opponentPull(undefined, T0 + H(5), OPP_LAG_H)).toBe(0);
  });
});

describe('the comedown fades on its own clock', () => {
  it('halves per HALF_LIFE_OPP (14h) and zeroes sub-epsilon residue', () => {
    expect(decayOpponent(0.4, 14)).toBeCloseTo(0.2, 10);
    expect(decayOpponent(0.4, 28)).toBeCloseTo(0.1, 10);
    expect(decayOpponent(0.0009, 1)).toBe(0);
  });

  it('the constants are the Thea1 constants', () => {
    expect(OPP_GAIN).toBe(0.35);
    expect(HALF_LIFE_OPP).toBe(14.0);
    expect(OPP_LAG_H).toBe(2.0);
    expect(PRIM_OPP_GAIN).toBe(0.55);
    expect(PRIM_OPP_LAG_H).toBe(1.0);
  });
});

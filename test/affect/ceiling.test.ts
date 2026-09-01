// ceiling.ts — the earned ceiling. v3 escalated and parked at 0.99 forever; the
// soft cap and the saturation exponent are what make a high mean something.

import { describe, expect, it } from 'vitest';
import {
  CAP_DAMP,
  CAP_SOFT,
  PEAK_INTENSITY,
  PRIM_CAP_SOFT,
  SATURATE_EXP,
  ceilingDamp,
  saturate,
  toleranceDivisor,
} from '../../src/affect/index.js';

describe('saturate — a delta shrinks as the dimension nears the end it heads for', () => {
  it('at the opposite end a push lands in full', () => {
    expect(saturate(0.0, 0.06)).toBeCloseTo(0.06, 12);
    expect(saturate(1.0, -0.06)).toBeCloseTo(-0.06, 12);
  });

  it('near the ceiling almost nothing gets through (the v4 fix: 0.4% at 0.99)', () => {
    const through = saturate(0.99, 0.06) / 0.06;
    expect(through).toBeLessThan(0.02);
    const down = Math.abs(saturate(0.01, -0.06)) / 0.06;
    expect(down).toBeLessThan(0.02);
  });

  it('uses SATURATE_EXP 0.9, and the shrink is monotone in current', () => {
    expect(saturate(0.75, 0.06)).toBeCloseTo(0.06 * 0.25 ** SATURATE_EXP, 12);
    let prev = Infinity;
    for (let c = 0; c <= 1; c += 0.05) {
      const step = saturate(c, 0.1);
      expect(step).toBeLessThanOrEqual(prev);
      prev = step;
    }
  });

  it('downward pushes shrink toward the floor symmetrically', () => {
    expect(saturate(0.25, -0.06)).toBeCloseTo(-0.06 * 0.25 ** SATURATE_EXP, 12);
  });
});

describe('ceilingDamp — above the soft cap only a genuinely big moment moves her', () => {
  it('a routine moment above CAP_SOFT lands at CAP_DAMP (12%)', () => {
    expect(ceilingDamp(0.95, 0.05, 5, CAP_SOFT)).toBeCloseTo(0.05 * CAP_DAMP, 12);
  });

  it('an [i:10] night cuts straight through the cap', () => {
    expect(ceilingDamp(0.95, 0.05, PEAK_INTENSITY, CAP_SOFT)).toBe(0.05);
  });

  it('below the cap nothing is damped at any intensity', () => {
    expect(ceilingDamp(0.6, 0.05, 2, CAP_SOFT)).toBe(0.05);
  });
});

describe('toleranceDivisor — repetition dulls, intensity cuts through', () => {
  it('no exposure, no divisor', () => {
    expect(toleranceDivisor(0, 5)).toBe(1.0);
  });

  it('grows with exposure and with the routine-ness of the moment', () => {
    expect(toleranceDivisor(2, 2)).toBeCloseTo(1 + 2 * 2.0, 12); // (10-2)/4 = 2
    expect(toleranceDivisor(2, 6)).toBeCloseTo(1 + 2 * 1.0, 12); // (10-6)/4 = 1
    expect(toleranceDivisor(2, 10)).toBeCloseTo(1 + 2 * 0.15, 12); // the 0.15 floor
  });

  it('intensity cuts through: maxed exposure dulls a routine repeat 5x more than a peak', () => {
    expect(toleranceDivisor(12, 10)).toBeCloseTo(1 + 12 * 0.15, 12); // the 0.15 floor keeps even i:10 dulled a little
    expect(toleranceDivisor(12, 5) / toleranceDivisor(12, 10)).toBeGreaterThan(5);
  });

  it('the constants are the Thea1 constants', () => {
    expect(CAP_SOFT).toBe(0.9);
    expect(CAP_DAMP).toBe(0.12);
    expect(PRIM_CAP_SOFT).toBe(0.72);
    expect(SATURATE_EXP).toBe(0.9);
    expect(PEAK_INTENSITY).toBe(10);
  });
});

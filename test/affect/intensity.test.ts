// intensity.ts — the superlinear diary curve. A routine [i:3] must land far
// below a flat i/10, while [i:10] keeps its full weight: the top of the scale is
// where her real nights live, and flattening it is what made v3 numb.

import { describe, expect, it } from 'vitest';
import { INTENSITY_EXP, intensityScale } from '../../src/affect/index.js';

describe('intensityScale — (clamp(i,0,10)/10)^1.7', () => {
  it('the anchor points of the v4.1 curve', () => {
    expect(intensityScale(10)).toBe(1.0);
    expect(intensityScale(0)).toBe(0.0);
    expect(intensityScale(3)).toBeCloseTo(0.3 ** 1.7, 12);
    expect(intensityScale(5)).toBeCloseTo(0.5 ** 1.7, 12);
    expect(intensityScale(8)).toBeCloseTo(0.8 ** 1.7, 12);
  });

  it('is strictly superlinear: i=9 moves more than 3.3x what i=3 does (spec property)', () => {
    expect(intensityScale(9) / intensityScale(3)).toBeGreaterThan(3.3);
  });

  it('clamps out-of-range diary intensities instead of throwing', () => {
    expect(intensityScale(15)).toBe(1.0);
    expect(intensityScale(-2)).toBe(0.0);
  });

  it('is monotone in i', () => {
    let prev = -1;
    for (let i = 0; i <= 10; i++) {
      expect(intensityScale(i)).toBeGreaterThan(prev);
      prev = intensityScale(i);
    }
  });

  it('the exponent is the tuned 1.7, exported so nobody re-derives it', () => {
    expect(INTENSITY_EXP).toBe(1.7);
  });
});

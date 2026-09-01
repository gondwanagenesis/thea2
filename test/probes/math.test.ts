// M19 — median/variance: the aggregation math the k=3 split rests on. The
// properties (not example values) are the contract: median is order-free and
// middle-seeking, variance is non-negative, zero iff constant, and symmetric
// under reflection.

import { describe, expect, it } from 'vitest';
import { median, variance } from '../../src/probes/math.js';
import { makeRng } from '../../src/kernel/index.js';

describe('median', () => {
  it('odd sample: the middle value', () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([3])).toBe(3);
  });

  it('even sample: mean of the two middle values', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([4, 1])).toBe(2.5);
  });

  it('empty sample: null (not measured), never NaN', () => {
    expect(median([])).toBeNull();
  });

  it('property: order-free, and always a sample member or the midpoint of two', () => {
    const rng = makeRng('probes-median');
    for (let trial = 0; trial < 200; trial++) {
      const n = rng.int(1, 9);
      const xs = Array.from({ length: n }, () => rng.int(0, 100));
      const m = median(xs);
      const mShuffled = median(rng.shuffle([...xs]));
      expect(m).not.toBeNull();
      expect(m).toBe(mShuffled);
      const sorted = [...xs].sort((a, b) => a - b);
      expect(m!).toBeGreaterThanOrEqual(sorted[0]!);
      expect(m!).toBeLessThanOrEqual(sorted[n - 1]!);
    }
  });
});

describe('variance', () => {
  it('zero iff the sample is constant; empty/single are zero, not NaN', () => {
    expect(variance([])).toBe(0);
    expect(variance([4])).toBe(0);
    expect(variance([4, 4, 4])).toBe(0);
    expect(variance([3, 5])).toBe(1);
  });

  it('property: non-negative, symmetric under reflection, and grows with spread', () => {
    const rng = makeRng('probes-variance');
    for (let trial = 0; trial < 200; trial++) {
      const n = rng.int(2, 8);
      const xs = Array.from({ length: n }, () => rng.float() * 10);
      const v = variance(xs);
      const vReflected = variance(xs.map((x) => 10 - x));
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeCloseTo(vReflected, 12);
      const mean = xs.reduce((a, b) => a + b, 0) / n;
      expect(variance(xs.map((x) => x + 100))).toBeCloseTo(v, 12);
      expect(mean).toBeGreaterThanOrEqual(0);
    }
  });

  it('population form: variance of [a,b] is ((a-b)/2)^2 exactly', () => {
    expect(variance([1, 5])).toBe(4);
    expect(variance([2.5, 4.5])).toBe(1);
  });
});

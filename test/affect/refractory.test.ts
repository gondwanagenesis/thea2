// refractory.ts — the "after" of the hedonic four. Crossing PEAK_HI opens a
// window in which the dimension is spent: re-rises land at a fraction and the
// relax loop lets it come down twice as fast. The exact 5-hour edge is pinned.

import { describe, expect, it } from 'vitest';
import {
  PEAK_HI,
  PRIM_REFRACTORY_DAMP,
  REFRACTORY_DAMP,
  REFRACTORY_DECAY_MULT,
  REFRACTORY_H,
  isInRefractory,
  recordPeakIf,
} from '../../src/affect/index.js';
import { H, T0 } from './helpers.js';

describe('what counts as a peak', () => {
  it('crossing PEAK_HI (0.93) opens the window; just under does not', () => {
    const peaks: Record<string, number | undefined> = {};
    recordPeakIf(peaks, 'pleasure', 0.92, T0);
    expect(peaks['pleasure']).toBeUndefined();
    recordPeakIf(peaks, 'pleasure', PEAK_HI, T0);
    expect(peaks['pleasure']).toBe(T0);
  });

  it('a later, higher crossing re-stamps the window (the clock restarts)', () => {
    const peaks: Record<string, number | undefined> = {};
    recordPeakIf(peaks, 'joy', 0.95, T0);
    recordPeakIf(peaks, 'joy', 0.97, T0 + H(2));
    expect(peaks['joy']).toBe(T0 + H(2));
  });
});

describe('how long the dimension stays spent', () => {
  it('the exact 5-hour edge: spent one second before, free exactly at 5h (strict <)', () => {
    const peaks: Record<string, number | undefined> = { pleasure: T0 };
    expect(isInRefractory(peaks, 'pleasure', T0 + H(REFRACTORY_H) - 1)).toBe(true);
    expect(isInRefractory(peaks, 'pleasure', T0 + H(REFRACTORY_H))).toBe(false);
  });

  it('other dimensions are unaffected; a missing peak table is not an error', () => {
    const peaks: Record<string, number | undefined> = { pleasure: T0 };
    expect(isInRefractory(peaks, 'calm', T0 + 1)).toBe(false);
    expect(isInRefractory(undefined, 'pleasure', T0 + 1)).toBe(false);
    expect(isInRefractory(peaks, 'pleasure', undefined as never)).toBe(false);
  });

  it('the constants are the Thea1 constants', () => {
    expect(PEAK_HI).toBe(0.93);
    expect(REFRACTORY_H).toBe(5.0);
    expect(REFRACTORY_DAMP).toBe(0.25);
    expect(PRIM_REFRACTORY_DAMP).toBe(0.5);
    expect(REFRACTORY_DECAY_MULT).toBe(0.5);
  });
});

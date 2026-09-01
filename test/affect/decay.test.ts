// decay.ts — exponential relaxation in continuous time. Half-lives are the
// spec's load-bearing constants; these tests pin the curves at their boundaries
// and the per-layer selection rules (negative bias, surprise's phasic clock).

import { describe, expect, it } from 'vitest';
import {
  AROUSAL_FLOOR,
  HALF_LIFE_AROUSAL,
  HALF_LIFE_DIAL,
  HALF_LIFE_DRIVE,
  HALF_LIFE_MOOD,
  HALF_LIFE_MOOD_HOME,
  MOOD_INERTIA,
  NEGATIVITY_BIAS,
  NOISE,
  PRIM_HALF_LIFE,
  PRIM_HALF_LIFE_SURPRISE,
  PRIM_NEG_BIAS,
  LONGING_GAIN,
  LONGING_TAU_H,
  decayToward,
  dialHalfLife,
  primaryHalfLife,
} from '../../src/affect/index.js';

describe('decayToward — the exponential itself', () => {
  it('halves the remaining distance in exactly one half-life, downward and upward', () => {
    expect(decayToward(0.5, 0.0, 8, 8)).toBeCloseTo(0.25, 12);
    expect(decayToward(0.5, 1.0, 8, 8)).toBeCloseTo(0.75, 12);
  });

  it('quarters in two half-lives and never reaches the target in finite time', () => {
    expect(decayToward(0.5, 0.0, 16, 8)).toBeCloseTo(0.125, 12);
    expect(decayToward(0.5, 0.0, 1000, 8)).toBeGreaterThan(0);
  });

  it('is monotone toward the target and never crosses it (property over dt)', () => {
    for (let dt = 0.25; dt <= 48; dt += 0.75) {
      for (const [v, t] of [[0.9, 0.2], [0.2, 0.9], [0.5, 0.5], [0.0, 1.0]] as const) {
        const next = decayToward(v, t, dt, 6);
        const dist = Math.abs(v - t);
        expect(Math.abs(next - t)).toBeLessThanOrEqual(dist + 1e-12);
        expect(next >= Math.min(v, t) - 1e-12).toBe(true);
        expect(next <= Math.max(v, t) + 1e-12).toBe(true);
      }
    }
  });

  it('a zero half-life snaps to the target (the disable switch)', () => {
    expect(decayToward(0.9, 0.2, 1, 0)).toBe(0.2);
  });

  it('scales with dt: two hours relaxes more than one', () => {
    const one = decayToward(0.8, 0.3, 1, 5);
    const two = decayToward(0.8, 0.3, 2, 5);
    expect(Math.abs(0.8 - two)).toBeGreaterThan(Math.abs(0.8 - one));
  });
});

describe('layer half-lives — the Thea1 constants, verbatim', () => {
  it('the numbers are the numbers', () => {
    expect(HALF_LIFE_DIAL).toBe(8.0);
    expect(PRIM_HALF_LIFE).toBe(3.5);
    expect(PRIM_HALF_LIFE_SURPRISE).toBe(1.0);
    expect(HALF_LIFE_MOOD).toBe(45.0);
    expect(HALF_LIFE_MOOD_HOME).toBe(30.0);
    expect(HALF_LIFE_DRIVE).toBe(30.0);
    expect(HALF_LIFE_AROUSAL).toBe(6.0);
    expect(MOOD_INERTIA).toBe(0.25);
    expect(NEGATIVITY_BIAS).toBe(1.6);
    expect(PRIM_NEG_BIAS).toBe(1.25);
    expect(LONGING_GAIN).toBe(0.4);
    expect(LONGING_TAU_H).toBe(12.0);
    expect(AROUSAL_FLOOR).toBe(0.2);
    expect(NOISE).toBe(0.012);
  });

  it('aversive dial directions linger: NEGATIVE_DIALS below home decay 1.6x slower', () => {
    expect(dialHalfLife('pleasure', 0.5, 0.66)).toBeCloseTo(HALF_LIFE_DIAL * NEGATIVITY_BIAS, 12);
    expect(dialHalfLife('calm', 0.3, 0.7)).toBeCloseTo(HALF_LIFE_DIAL * NEGATIVITY_BIAS, 12);
    expect(dialHalfLife('trust', 0.5, 0.75)).toBeCloseTo(HALF_LIFE_DIAL * NEGATIVITY_BIAS, 12);
  });

  it('the same dials above home, and non-negative dials anywhere, use the plain clock', () => {
    expect(dialHalfLife('pleasure', 0.7, 0.66)).toBe(HALF_LIFE_DIAL);
    expect(dialHalfLife('calm', 0.8, 0.7)).toBe(HALF_LIFE_DIAL);
    expect(dialHalfLife('focus', 0.3, 0.7)).toBe(HALF_LIFE_DIAL);
    expect(dialHalfLife('longing', 0.1, 0.25)).toBe(HALF_LIFE_DIAL);
  });

  it('arousal has its own evening clock regardless of direction', () => {
    expect(dialHalfLife('arousal', 0.9, 0.34)).toBe(HALF_LIFE_AROUSAL);
    expect(dialHalfLife('arousal', 0.1, 0.34)).toBe(HALF_LIFE_AROUSAL);
  });

  it('aversive primaries fade 1.25x slower while above home; positive ones do not', () => {
    expect(primaryHalfLife('sadness', true)).toBeCloseTo(PRIM_HALF_LIFE * PRIM_NEG_BIAS, 12);
    expect(primaryHalfLife('shame', true)).toBeCloseTo(PRIM_HALF_LIFE * PRIM_NEG_BIAS, 12);
    expect(primaryHalfLife('sadness', false)).toBe(PRIM_HALF_LIFE);
    expect(primaryHalfLife('joy', true)).toBe(PRIM_HALF_LIFE);
  });

  it('surprise is phasic by definition: one hour, whichever way it points', () => {
    expect(primaryHalfLife('surprise', true)).toBe(PRIM_HALF_LIFE_SURPRISE);
    expect(primaryHalfLife('surprise', false)).toBe(PRIM_HALF_LIFE_SURPRISE);
  });
});

// habituation.ts — two distinct dulling forces: the 30-minute same-tag window
// and the slower exposure trace. The window edge (exactly 30 min) is load-bearing
// and pinned here on both sides.

import { describe, expect, it } from 'vitest';
import {
  EXPO_GAIN,
  HALF_LIFE_EXPO,
  HABIT_WINDOW_H,
  HABITUATION,
  decayExposure,
  growExposure,
  isHabituated,
  recordTag,
  type ExposureTrace,
} from '../../src/affect/index.js';
import { MIN, T0, freshState } from './helpers.js';

describe('the short-window rule — same tag again inside 30 min lands at 70%', () => {
  it('the exact 30-minute edge: NOT habituated at exactly the window, habituated one minute before', () => {
    const s = freshState();
    recordTag(s, 'cherished', T0);
    expect(isHabituated(s, 'cherished', T0 + MIN(30))).toBe(false); // strict <
    expect(isHabituated(s, 'cherished', T0 + MIN(30) - 1)).toBe(true);
  });

  it('a different tag inside the window is not dulled', () => {
    const s = freshState();
    recordTag(s, 'cherished', T0);
    expect(isHabituated(s, 'fond', T0 + MIN(5))).toBe(false);
  });

  it('recordTag prunes what left the window but keeps repeats of the live tag', () => {
    const s = freshState();
    recordTag(s, 'cherished', T0);
    recordTag(s, 'fond', T0 + MIN(10));
    expect(s.traces.habitWindow).toHaveLength(2);
    recordTag(s, 'cherished', T0 + MIN(40)); // 'fond' (10 min old? no: 40 min old) leaves; cherished repeats stay
    expect(s.traces.habitWindow.map((h) => h.tag)).toEqual(['cherished', 'cherished']);
    expect(isHabituated(s, 'cherished', T0 + MIN(40))).toBe(true);
  });

  it('the window stays bounded no matter how much is thrown at it', () => {
    const s = freshState();
    for (let k = 0; k < 500; k++) recordTag(s, `tag-${k}`, T0);
    expect(s.traces.habitWindow).toHaveLength(500); // all inside the window at t = T0
    recordTag(s, 'later', T0 + MIN(31));
    expect(s.traces.habitWindow).toHaveLength(1); // everything pruned at once
  });
});

describe('exposure traces — tolerance that builds with every push and fades over hours', () => {
  it('decays by HALF_LIFE_EXPO (6h), clamped to the cap', () => {
    expect(decayExposure(2, 6)).toBeCloseTo(1, 4);
    expect(decayExposure(2, 12)).toBeCloseTo(0.5, 4);
    expect(decayExposure(12, 0)).toBe(12); // clamp is inert on the way down
    expect(decayExposure(11, 1)).toBeCloseTo(11 * 0.5 ** (1 / 6), 4); // decay only lowers
  });

  it('rounds sub-epsilon traces to zero so the map can actually empty', () => {
    expect(decayExposure(4, 72)).toBe(0); // 4 * 0.5^12 < 1e-3
    expect(decayExposure(1, 54)).toBeGreaterThan(0); // 1 * 0.5^9 ~ 0.00195, still above epsilon
    expect(decayExposure(1, 60)).toBe(0); // one more half-life and it is gone
  });

  it('grows by |step| * EXPO_GAIN and stops at 12', () => {
    expect(growExposure(undefined, 0.1, T0)).toEqual({ level: 0.5, t: T0 });
    expect(growExposure({ level: 0.5, t: T0 }, 0.1, T0 + 1).level).toBeCloseTo(1.0, 10);
    const capped: ExposureTrace = growExposure({ level: 11.9, t: T0 }, 1, T0);
    expect(capped.level).toBe(12);
  });

  it('negative pushes build tolerance too (a hurt dulls with repetition as well)', () => {
    expect(growExposure(undefined, -0.2, T0).level).toBeCloseTo(0.2 * EXPO_GAIN, 10);
  });

  it('the constants are the Thea1 constants', () => {
    expect(HABITUATION).toBe(0.7);
    expect(HABIT_WINDOW_H).toBe(0.5);
    expect(EXPO_GAIN).toBe(5.0);
    expect(HALF_LIFE_EXPO).toBe(6.0);
  });
});

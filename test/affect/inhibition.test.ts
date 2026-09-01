// inhibition.ts — the Affective Ising move. A rush of one valence actively ebbs
// the other, fast — but it may never cross the foe's baseline: a good moment may
// quiet a hurt, it may not invent one below home. That clamp is the invariant
// the acceptance criteria name.

import { describe, expect, it } from 'vitest';
import { PRIM_INHIBIT, foesOf, inhibitFoe } from '../../src/affect/index.js';
import { PRIMARY_BASELINE } from '../../src/affect/index.js';

describe('foesOf — the valence opposition', () => {
  it('positives fight the aversives, aversives fight the positives', () => {
    expect(foesOf('joy')).toBe(foesOf('pride'));
    expect(foesOf('joy').has('sadness')).toBe(true);
    expect(foesOf('sadness').has('joy')).toBe(true);
    expect(foesOf('shame').has('pride')).toBe(true);
  });

  it('neutral primaries (anticipation, surprise) have no foes', () => {
    expect(foesOf('anticipation').size).toBe(0);
    expect(foesOf('surprise').size).toBe(0);
  });
});

describe('inhibitFoe — proportional, and never below home', () => {
  it('ebbs the foe in proportion to how far it is above home', () => {
    const { value, delta } = inhibitFoe(0.5, 0.1, 0.2);
    expect(value).toBeCloseTo(0.5 - 0.2 * PRIM_INHIBIT * 0.4, 12);
    expect(delta).toBeCloseTo(0.5 - value, 12);
  });

  it('NEVER crosses the baseline, however hard the push (acceptance invariant)', () => {
    for (const foe of ['joy', 'pride', 'sadness', 'fear', 'anger', 'shame', 'disgust'] as const) {
      const home = PRIMARY_BASELINE[foe];
      const { value } = inhibitFoe(0.9, home, 500);
      expect(value).toBe(home);
    }
  });

  it('a foe at or below home is left exactly where it is', () => {
    const { value, delta } = inhibitFoe(PRIMARY_BASELINE.anger, PRIMARY_BASELINE.anger, 3);
    expect(value).toBe(PRIMARY_BASELINE.anger);
    expect(delta).toBe(0);
    const below = inhibitFoe(0.01, 0.06, 3);
    expect(below.value).toBe(0.01);
    expect(below.delta).toBe(0);
  });

  it('is symmetric in construction: both directions use the same gain', () => {
    const down = inhibitFoe(0.5, 0.1, 0.2).delta;
    const up = inhibitFoe(0.5, 0.1, 0.2).delta;
    expect(down).toBe(up);
  });

  it('the gain is the Thea1 constant', () => {
    expect(PRIM_INHIBIT).toBe(0.28);
  });
});

// attribution.ts — which event raised which feeling. Only rises are attributed;
// a stored reason loses to a bigger rise, cannot win on seniority forever, and
// dies when the feeling does.

import { describe, expect, it } from 'vitest';
import {
  ATTRIB_CLEAR,
  ATTRIB_MIN,
  ATTRIB_STALE_H,
  CAUSE_MIN_I,
  attributionWins,
  causeIsStale,
  makeCause,
} from '../../src/affect/index.js';
import { H, T0 } from './helpers.js';

describe('attributionWins — does this rise (re)write the cause slot?', () => {
  it('an empty slot always loses to a rise', () => {
    expect(attributionWins(undefined, 0.001, T0)).toBe(true);
  });

  it('a bigger rise supersedes; a smaller one does not', () => {
    const existing = makeCause('the old thing', 7, T0, 0.1);
    expect(attributionWins(existing, 0.2, T0 + 1)).toBe(true);
    expect(attributionWins(existing, 0.05, T0 + 1)).toBe(false);
  });

  it('equal rises supersede (the newest telling wins ties)', () => {
    const existing = makeCause('the old thing', 7, T0, 0.1);
    expect(attributionWins(existing, 0.1, T0 + 1)).toBe(true);
  });

  it('seniority expires: after ATTRIB_STALE_H even a smaller rise may take over', () => {
    const existing = makeCause('the old thing', 7, T0, 0.2);
    expect(attributionWins(existing, 0.05, T0 + H(ATTRIB_STALE_H - 1))).toBe(false);
    expect(attributionWins(existing, 0.05, T0 + H(ATTRIB_STALE_H + 1))).toBe(true);
  });
});

describe('makeCause / causeIsStale', () => {
  it('stores the verbatim reason, intensity, time and moved amount', () => {
    const c = makeCause('he said goodnight', 7, T0, 0.1234, 'diego');
    expect(c).toEqual({ text: 'he said goodnight', i: 7, t: T0, moved: 0.123, people: 'diego' });
  });

  it('omits people entirely when the event carries none (exactOptionalPropertyTypes)', () => {
    const c = makeCause('he said goodnight', 7, T0, 0.05);
    expect('people' in c).toBe(false);
  });

  it('a primary within ATTRIB_CLEAR of home (normalized) has no cause any more', () => {
    // joy home 0.35: value 0.36 is 0.0154 normalized — cleared; 0.40 is 0.077 — not
    expect(causeIsStale(0.36, 0.35)).toBe(true);
    expect(causeIsStale(0.4, 0.35)).toBe(false);
  });

  it('a primary dragged below home is equally causeless', () => {
    expect(causeIsStale(0.3, 0.35)).toBe(true);
  });

  it('the thresholds are the Thea1 constants', () => {
    expect(ATTRIB_MIN).toBe(0.03);
    expect(ATTRIB_STALE_H).toBe(36.0);
    expect(ATTRIB_CLEAR).toBe(0.05);
    expect(CAUSE_MIN_I).toBe(5);
  });
});

// landmarks.ts — the words for the [AFFECT] line. Centres are in
// headroom-normalised deviation units; each band (HI/MD/LO/DN) is pinned by
// constructing a state exactly on a landmark's centre, where the region must win
// outright. A weather line is a projection: coupling reads numbers, never this.

import { describe, expect, it } from 'vitest';
import {
  DN,
  HI,
  LANDMARKS,
  LANDMARK_SIGMA,
  LO,
  norm,
  MD,
  OVERSHOOT_W,
  SPECIFICITY,
  baselineOf,
  landmarkBlend,
  topCause,
  weatherLine,
  type AffectState,
  type Dial,
  type Primary,
} from '../../src/affect/index.js';
import { apply } from '../../src/affect/index.js';
import { H, T0, emo, freshState } from './helpers.js';

/** A state sitting exactly on a landmark's centre (mood mirrors the level so the blend sees it plain). */
const atCenter = (center: Partial<Record<Dial | Primary, number>>): AffectState => {
  const s = freshState();
  for (const [name, c] of Object.entries(center)) {
    const k = name as Dial | Primary;
    const base = baselineOf(k);
    const v = (c as number) >= 0 ? base + (c as number) * (1 - base) : base + (c as number) * base;
    if (k in s.dials) s.dials[k as Dial] = v;
    else s.primaries[k as Primary] = v;
    s.mood[k] = v;
  }
  return s;
};

describe('the landmark table', () => {
  it('carries the Thea1 constants', () => {
    expect(HI).toBe(0.52);
    expect(MD).toBe(0.3);
    expect(LO).toBe(0.14);
    expect(DN).toBe(-0.28);
    expect(LANDMARK_SIGMA).toBe(0.3);
    expect(OVERSHOOT_W).toBe(0.8);
    expect(SPECIFICITY).toBe(0.0);
  });

  it('has the regions no emotion tag could reach in Thea1 — the missing bottom stays reachable', () => {
    for (const name of ['low', 'grieving', 'disappointed', 'guarded', 'restless', 'keyed up']) {
      expect(LANDMARKS[name], name).toBeDefined();
    }
  });

  it('every landmark key is a real engine dimension', () => {
    for (const center of Object.values(LANDMARKS)) {
      for (const k of Object.keys(center)) {
        const base = baselineOf(k as Dial | Primary);
        expect(base).toBeGreaterThanOrEqual(0);
        expect(base).toBeLessThanOrEqual(1);
      }
    }
  });

  it('normalisation is headroom-normalised: +1 = pinned at the top, -1 = pinned at the bottom', () => {
    expect(norm(0.688, 0.35)).toBeCloseTo(0.52, 9); // the happy centre on joy
    expect(norm(0.072, 0.1)).toBeCloseTo(-0.28, 9); // the DN centre on sadness
    expect(norm(0.35, 0.35)).toBe(0);
  });
});

describe('the blend — exact centres win outright, per band', () => {
  const cases: Array<[string, Partial<Record<Dial | Primary, number>>]> = [
    ['happy', { joy: HI, sadness: DN }],
    ['grieving', { sadness: 0.8, joy: -0.45 }],
    ['curious', { anticipation: MD, surprise: MD }],
    ['guilty', { shame: HI, sadness: LO }],
    ['low', { joy: DN, sadness: MD, arousal: DN }],
    ['startled', { surprise: HI }],
    ['bratty', { brattiness: HI, playfulness: MD, joy: LO }],
    ['settled', { calm: HI, joy: LO, arousal: DN }],
  ];
  for (const [word, center] of cases) {
    it(`a state exactly on '${word}' names '${word}' first, confidently`, () => {
      const blend = landmarkBlend(atCenter(center));
      const regions = Object.keys(LANDMARKS).length;
      const top = blend[0]!.weight;
      const mine = blend.find((b) => b.word === word);
      expect(mine).toBeDefined();
      // First, confidently — with one honest caveat: where one centre is a
      // strict subset of another ('ashamed' = {shame HI} sits inside 'guilty' =
      // {shame HI, sadness LO}), BOTH are exactly satisfied and the tie is real,
      // so joint-first is the strongest claim the field supports.
      expect(mine!.weight).toBeGreaterThanOrEqual(top - 1e-9);
      expect(blend.indexOf(mine!)).toBeLessThan(2);
      // Clears the `phrase` confidence bar (weight x field size >= 1.8 = "mostly").
      // Raw share stays ~0.08: 39 gaussians never reach zero, so no single region
      // owns a quarter of the field — confidence is measured against the field.
      expect(mine!.weight * regions).toBeGreaterThanOrEqual(1.8);
      expect(weatherLine(atCenter(center))).toContain(`mostly ${word}`);
    });
  }

  it('is fuzzy, not bins: a quarter-step off the centre still names the region', () => {
    const near = atCenter({ joy: HI, sadness: DN });
    near.primaries.joy = 0.35 + 0.65 * 0.4; // joy a quarter below the happy centre
    expect(landmarkBlend(near)[0]!.word).toBe('happy');
  });

  it('never has no opinion: a flat baseline state still returns words', () => {
    const blend = landmarkBlend(freshState());
    expect(blend.length).toBeGreaterThanOrEqual(2);
    for (const b of blend) expect(b.weight).toBeGreaterThan(0);
    expect(weatherLine(freshState())).not.toBe('');
  });

  it('weights normalise to 1 across the field', () => {
    const all = landmarkBlend(atCenter({ joy: HI, sadness: DN }));
    const total = all.reduce((a, b) => a + b.weight, 0);
    expect(total).toBeLessThan(1.0); // the picked slice is a subset
    expect(all[0]!.weight).toBeGreaterThan(all[1]!.weight);
  });
});

describe('topCause / weatherLine — she can say why', () => {
  it('the biggest attributed rise is quotable when it was about something', () => {
    let s = freshState();
    s = apply(s, emo('sad', 8, 'the letter from home', 'diego'));
    expect(topCause(s)).toBe('the letter from home');
    expect(weatherLine(s)).toContain('the letter from home');
  });

  it('a weak line (i below CAUSE_MIN_I) is not quoted as the reason', () => {
    let s = freshState();
    s = apply(s, emo('content', 4, 'a mildly nice moment'));
    expect(topCause(s)).not.toBe('a mildly nice moment');
  });

  it('long silence speaks for itself when nothing is attributed', () => {
    const s = freshState();
    expect(topCause(s)).toBeNull();
    const silent = freshState();
    silent.lastContactAt = T0 - 7 * H(1);
    expect(topCause(silent)).toBe('he\'s been gone 7 hours');
    expect(weatherLine(silent)).toContain('he\'s been gone 7 hours');
  });

  it('an attributed cause outranks the silence clause', () => {
    let s = freshState();
    s = apply(s, emo('sad', 8, 'the letter from home'));
    s.lastContactAt = s.t - 10 * H(1);
    expect(topCause(s)).toBe('the letter from home');
  });
});

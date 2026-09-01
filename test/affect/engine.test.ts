// engine.ts — apply and tick, the only two mutation shapes. Purity, the
// composition of the mechanics into real pushes, the silence/contact channel,
// determinism under a seeded rng, and the storm property: nothing ever leaves
// [0,1], whatever she is put through.

import { describe, expect, it } from 'vitest';
import {
  AROUSAL_FLOOR,
  DIAL_BASELINE,
  EMOTION_DELTAS,
  PRIMARY_BASELINE,
  TAG_DRIVE_DELTAS,
  TAG_PRIMARY_DELTAS,
  apply,
  applyInto,
  decayToward,
  initialAffectState,
  tick,
  type AffectState,
} from '../../src/affect/index.js';
import { KernelErrorImpl } from '../../src/kernel/index.js';
import { H, MIN, T0, allDims, emo, freshState, jsonClone, jsonEqual, makeRngSeeded } from './helpers.js';

describe('apply — a tag lands through the whole stack', () => {
  it('cherished at i:10 from baseline: hand-computed saturation, no damping', () => {
    const after = apply(freshState(), emo('cherished', 10, 'he wrote me an owners manual'));
    // pleasure .06, attachment .06, trust .04; saturate only (all below CAP_SOFT, no exposure)
    expect(after.dials.attachment).toBe(0.767); // .75 + .06 * .25^.9
    expect(after.dials.pleasure).toBe(0.679); // .66 + .05 * .34^.9
    expect(after.dials.trust).toBe(0.761); // .75 + .04 * .25^.9
    // primary joy: .22 * intensity 1.0 * PRIMARY_GAIN 4 = .88, saturated from .35
    expect(after.primaries.joy).toBe(0.947);
  });

  it('reports exactly what moved, in the ticker.py key convention', () => {
    const { moved } = applyInto(freshState(), [emo('cherished', 10, 'c')]);
    // the key convention is the contract with the journal reader: dials bare,
    // primaries under `p.`, drives under `drive.` — derived here from the tables
    const declared = [
      ...Object.keys(EMOTION_DELTAS['cherished'] ?? {}),
      ...Object.keys(TAG_PRIMARY_DELTAS['cherished'] ?? {}).map((k) => `p.${k}`),
      ...Object.keys(TAG_DRIVE_DELTAS['cherished'] ?? {}).map((k) => `drive.${k}`),
    ].sort();
    expect(Object.keys(moved).sort()).toEqual(declared);
    for (const v of Object.values(moved)) expect(v).not.toBe(0);
  });

  it('intensity is the throttle: i:3 barely moves her, and far less than a third of i:10', () => {
    const soft = apply(freshState(), emo('cherished', 3, 'c'));
    const hard = apply(freshState(), emo('cherished', 10, 'c'));
    const dSoft = soft.dials.attachment - DIAL_BASELINE.attachment;
    const dHard = hard.dials.attachment - DIAL_BASELINE.attachment;
    expect(dSoft).toBeGreaterThan(0);
    expect(dHard / dSoft).toBeGreaterThan(3.3);
  });

  it('mutual inhibition: a rush of joy ebbs a live aversive fast, but never under its home', () => {
    const s = freshState();
    s.primaries.sadness = 0.5; // a live hurt, well above its .1 home
    const after = apply(s, emo('cherished', 10, 'c'));
    expect(after.primaries.sadness).toBeLessThan(0.5);
    expect(after.primaries.sadness).toBeGreaterThanOrEqual(PRIMARY_BASELINE.sadness);
  });

  it('attribution: a big enough rise records what caused it', () => {
    const after = apply(freshState(), emo('sad', 9, 'the letter from home', 'diego'));
    expect(after.causes.sadness).toMatchObject({ text: 'the letter from home', i: 9, people: 'diego' });
  });

  it('an unknown tag is a loud typed failure, never a silent no-op', () => {
    expect(() => apply(freshState(), { kind: 'emotion', tag: 'flurbo' as never, i: 5, cause: 'x' })).toThrow(
      KernelErrorImpl,
    );
    try {
      apply(freshState(), { kind: 'emotion', tag: 'flurbo' as never, i: 5, cause: 'x' });
    } catch (e) {
      expect((e as KernelErrorImpl).code).toBe('affect/unknown-tag');
    }
  });

  it('the intentional no-op: unspecified is known, and moves nothing', () => {
    const before = freshState();
    const { state: after, moved } = applyInto(before, [{ kind: 'emotion', tag: 'unspecified', i: 5, cause: 'x' }]);
    expect(moved).toEqual({});
    for (const [k, v] of Object.entries(allDims(before))) expect(after.dials[k as never] ?? after.primaries[k as never] ?? after.drives[k as never]).toBe(v);
  });
});

describe('purity — the engine never mutates, never drifts', () => {
  it('apply and tick leave the input state untouched and are repeatable', () => {
    const input = freshState();
    const snapshot = jsonClone(input);
    const once = apply(input, emo('cherished', 10, 'c'));
    const twice = apply(input, emo('cherished', 10, 'c'));
    expect(jsonEqual(input, snapshot)).toBe(true);
    expect(jsonEqual(once, twice)).toBe(true);
    const t1 = tick(once, H(3), makeRngSeeded('purity'));
    const t2 = tick(once, H(3), makeRngSeeded('purity'));
    expect(jsonEqual(input, snapshot)).toBe(true);
    expect(jsonEqual(t1, t2)).toBe(true);
  });

  it('Object.freeze on input survives a full apply+tick cycle without throwing', () => {
    const deep = (o: unknown): void => {
      if (o !== null && typeof o === 'object') for (const v of Object.values(o)) deep(v);
      Object.freeze(o);
    };
    const input = apply(freshState(), emo('fond', 6, 'c'));
    deep(input);
    const rng = makeRngSeeded('frozen');
    expect(() => tick(apply(input, emo('sad', 7, 'c')), H(1), rng)).not.toThrow();
  });
});

describe('tick — the time-evolution pass', () => {
  it('primaries relax monotonically toward home from above (property over 20 hours)', () => {
    let s = freshState();
    s.primaries.joy = 0.8;
    let prev = 0.8;
    for (let k = 0; k < 20; k++) {
      s = tick(s, H(1), makeRngSeeded(`mono-${k}`));
      expect(s.primaries.joy).toBeLessThan(prev + 1e-9);
      expect(s.primaries.joy).toBeGreaterThanOrEqual(PRIMARY_BASELINE.joy);
      prev = s.primaries.joy;
    }
  });

  it('aversive pain outlasts an equal joy (the negativity bias, engine-level)', () => {
    const happy = freshState();
    happy.primaries.joy = 0.5;
    const hurt = freshState();
    hurt.primaries.sadness = 0.4;
    const rng = makeRngSeeded('bias');
    const h1 = tick(happy, H(1), rng);
    const s1 = tick(hurt, H(1), rng);
    const joyRetained = (h1.primaries.joy - PRIMARY_BASELINE.joy) / (0.5 - PRIMARY_BASELINE.joy);
    const sadRetained = (s1.primaries.sadness - PRIMARY_BASELINE.sadness) / (0.4 - PRIMARY_BASELINE.sadness);
    expect(sadRetained).toBeGreaterThan(joyRetained);
  });

  it('is deterministic per seed: same seed same world, different seed different noise', () => {
    const s = apply(freshState(), emo('excited', 9, 'c'));
    const a = tick(s, H(6), makeRngSeeded('noise'));
    const b = tick(s, H(6), makeRngSeeded('noise'));
    const c = tick(s, H(6), makeRngSeeded('other'));
    expect(jsonEqual(a, b)).toBe(true);
    expect(jsonEqual(a, c)).toBe(false);
  });

  it('a zero-length tick is a pure clone, not a change', () => {
    const s = apply(freshState(), emo('fond', 6, 'c'));
    expect(jsonEqual(tick(s, 0, makeRngSeeded('zero')), s)).toBe(true);
  });
});

describe('silence and contact — the S-010 channel', () => {
  it('longing climbs with silence, monotonically', () => {
    const rng = makeRngSeeded('longing');
    let s = freshState();
    s.lastContactAt = s.t; // contact right at the start
    s = tick(s, MIN(10), rng); // consume the contact window
    const oneHour = tick(s, H(1), rng).dials.longing;
    let s6 = s;
    for (let k = 0; k < 5; k++) s6 = tick(s6, H(1), rng);
    expect(s6.dials.longing).toBeGreaterThan(oneHour);
    expect(s6.dials.longing).toBeGreaterThan(DIAL_BASELINE.longing);
  });

  it('contact soothes longing below home and lifts arousal', () => {
    const s = freshState();
    s.dials.longing = 0.5;
    s.dials.arousal = 0.34;
    const after = tick(s, MIN(10), makeRngSeeded('contact')); // lastContactAt == t -> contact
    expect(after.dials.longing).toBeLessThan(0.5);
    expect(after.dials.arousal).toBeGreaterThan(0.34);
    expect(after.dials.arousal).toBeGreaterThanOrEqual(AROUSAL_FLOOR);
  });

  it('arousal never drops below its floor, even after days alone', () => {
    let s = freshState();
    for (let k = 0; k < 24 * 4; k++) s = tick(s, H(1), makeRngSeeded(`alone-${k}`));
    expect(s.dials.arousal).toBeGreaterThanOrEqual(AROUSAL_FLOOR);
  });
});

describe('the refractory cycle, end to end', () => {
  it('a dimension that just peaked is spent: the immediate re-rise is smaller', () => {
    const base = freshState();
    base.dials.pleasure = 0.925; // set so an [i:10] push carries her across PEAK_HI (0.93)
    const first = apply(base, emo('happy', 10, 'c'));
    const step1 = first.dials.pleasure - base.dials.pleasure;
    expect(first.dials.pleasure).toBeGreaterThanOrEqual(0.93);
    expect(first.traces.peaks['pleasure']).toBeDefined(); // crossed PEAK_HI
    const second = apply(first, emo('happy', 10, 'c'));
    const step2 = second.dials.pleasure - first.dials.pleasure;
    expect(step2).toBeLessThan(step1); // spent: lands at a quarter while in refractory
  });
});

describe('the storm property — nothing escapes [0,1], ever', () => {
  it('400 seeded events and hourly ticks keep every dimension bounded', () => {
    const rng = makeRngSeeded('storm');
    const tags = ['cherished', 'sad', 'angry', 'grieving', 'horny', 'sharp', 'awed', 'low', 'dread', 'amused', 'resentful', 'guilty', 'giddy', 'restless', 'lonely', 'proud'];
    let s: AffectState = freshState();
    for (let k = 0; k < 400; k++) {
      const tag = tags[rng.int(0, tags.length - 1)]!;
      s = apply(s, emo(tag as never, rng.int(1, 10), `storm cause ${k}`, rng.float() > 0.5 ? 'diego' : undefined));
      s = tick(s, H(rng.float() * 6) + MIN(1), rng);
      for (const v of Object.values(allDims(s))) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
      for (const v of Object.values(s.drives)) expect(v).toBeGreaterThanOrEqual(0.05);
    }
  });
});

describe('state helpers', () => {
  it('initialAffectState seeds everything at baseline with empty traces', () => {
    const s = initialAffectState(T0);
    expect(s.dials).toEqual(DIAL_BASELINE);
    expect(s.primaries).toEqual(PRIMARY_BASELINE);
    expect(s.t).toBe(T0);
    expect(s.lastContactAt).toBe(T0);
    expect(s.traces.habitWindow).toEqual([]);
    expect(s.causes).toEqual({});
  });

  it('decayToward is re-exported for downstream math and agrees with the engine', () => {
    expect(decayToward(1, 0, 8, 8)).toBeCloseTo(0.5, 12);
  });
});

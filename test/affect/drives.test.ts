// drives.ts — the three homeostatic wants. Hunger is continuous and per hour
// (v3's daily starvation lost the race against satiation by two orders of
// magnitude and all three wants sat on the floor forever); a feed suppresses
// starvation for exactly the tick that follows it.

import { describe, expect, it } from 'vitest';
import {
  DRIVE_FEED_SCALE,
  DRIVE_FLOOR,
  SET_POINT,
  STARVE_PER_HOUR,
  driveTarget,
  wasFed,
  decayToward,
} from '../../src/affect/index.js';
import { apply, initialAffectState, tick } from '../../src/affect/index.js';
import { LONGING_TAU_H } from '../../src/affect/index.js';
import { H, T0, emo, freshState, makeRngSeeded } from './helpers.js';

const rng = makeRngSeeded('drives');

describe('the constants are the Thea1 constants', () => {
  it('set point, floor, feed scale and the per-hour starvation table', () => {
    expect(SET_POINT).toBe(0.25);
    expect(DRIVE_FLOOR).toBe(0.05);
    expect(DRIVE_FEED_SCALE).toBe(0.2);
    expect(STARVE_PER_HOUR).toEqual({ novelty: 0.01, connection: 0.018, mastery: 0.014 });
  });
});

describe('driveTarget — silence feeds connection, contact soothes it', () => {
  it('novelty and mastery have no silence channel; they rest at the set point', () => {
    expect(driveTarget('novelty', true, 0, LONGING_TAU_H)).toBe(SET_POINT);
    expect(driveTarget('mastery', false, 100, LONGING_TAU_H)).toBe(SET_POINT);
  });

  it('contact pulls connection just under the set point', () => {
    expect(driveTarget('connection', true, 0, LONGING_TAU_H)).toBeCloseTo(SET_POINT - 0.05, 12);
  });

  it('silence ramps it up on the longing time constant, saturating at set + 0.3', () => {
    expect(driveTarget('connection', false, 12, 12)).toBeCloseTo(SET_POINT + 0.3 * (1 - Math.exp(-1)), 12);
    expect(driveTarget('connection', false, 120, 12)).toBeCloseTo(SET_POINT + 0.3, 4); // 1-exp(-10), ~1
  });
});

describe('starvation — continuous, per hour, suppressed right after a feed', () => {
  it('an unfed hour starves each drive by exactly its rate (the engine-level rate table)', () => {
    const s = freshState();
    const after = tick(s, H(1), rng);
    // clampDrive rounds to 3 decimals, so the engine-level comparison is 1e-3
    expect(after.drives.novelty - s.drives.novelty).toBeCloseTo(STARVE_PER_HOUR.novelty, 3);
    expect(after.drives.connection - s.drives.connection).toBeCloseTo(
      STARVE_PER_HOUR.connection + (driveTarget('connection', false, 1, LONGING_TAU_H) - SET_POINT) * (1 - 0.5 ** (1 / 30)),
      3,
    );
    expect(after.drives.mastery - s.drives.mastery).toBeCloseTo(STARVE_PER_HOUR.mastery, 3);
  });

  it('wasFed is true only when the drive was fed at exactly the pre-tick time', () => {
    const s = freshState(T0);
    s.fedAt.mastery = T0;
    expect(wasFed(s, 'mastery')).toBe(true);
    expect(wasFed(s, 'novelty')).toBe(false);
    const later = tick(s, H(1), rng);
    expect(wasFed(later, 'mastery')).toBe(false); // the stamp no longer matches the new time
  });

  it('a diego turn feeds connection; DONE work feeds mastery', () => {
    const s = freshState(T0);
    const afterTurn = apply(s, emo('fond', 8, 'he said hi', 'diego'));
    expect(afterTurn.fedAt.connection).toBe(T0);
    const afterWork = apply(afterTurn, { kind: 'tagFeed', tag: 'DONE' });
    expect(afterWork.fedAt.mastery).toBe(T0);
    const afterMoment = apply(afterWork, { kind: 'tagFeed', tag: 'MOMENT' });
    expect(afterMoment.fedAt.connection).toBe(T0);
    const afterGift = apply(afterMoment, { kind: 'tagFeed', tag: 'GIFT' });
    expect(afterGift.fedAt.connection).toBe(T0);
  });

  it('a fed drive still relaxes toward its target, it just does not starve (property)', () => {
    const s = freshState(T0);
    const fed = apply(s, emo('fond', 8, 'he said hi', 'diego'));
    const after = tick(fed, H(1), rng);
    const expected = decayToward(
      fed.drives.connection,
      driveTarget('connection', false, 1, LONGING_TAU_H),
      1,
      30,
    );
    expect(after.drives.connection).toBeCloseTo(expected, 3); // clampDrive rounds to 3
  });

  it('starvation never pushes a drive under the floor or over 1.0 (property over long silences)', () => {
    let s = freshState(T0);
    for (let k = 0; k < 24 * 30; k++) {
      s = tick(s, H(1), rng);
      for (const v of Object.values(s.drives)) {
        expect(v).toBeGreaterThanOrEqual(DRIVE_FLOOR);
        expect(v).toBeLessThanOrEqual(1.0);
      }
    }
  });

  it('feeds move drives at DRIVE_FEED_SCALE of the table value', () => {
    const s = freshState(T0);
    const after = apply(s, { kind: 'tagFeed', tag: 'DONE' });
    expect(after.drives.mastery).toBeCloseTo(SET_POINT + -0.06 * 1.0 * DRIVE_FEED_SCALE, 10);
  });

  it('initial drives rest at the set point and feeds never die entirely', () => {
    expect(initialAffectState(T0).drives).toEqual({ novelty: 0.25, connection: 0.25, mastery: 0.25 });
  });
});

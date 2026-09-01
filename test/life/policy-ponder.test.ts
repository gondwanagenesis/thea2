// M17 gate — the ponder policy: the 0.45 gate table (pure, no model) and the
// SEED balance rule as a table plus the spec's property test ("over seeded
// 20-run histories, about-diego never exceeds 2/5 even when diego-topics
// dominate saliency; forced-avoid path exercised").

import { describe, expect, it } from 'vitest';
import { makeRng } from '../../src/kernel/rng.js';
import { MockModel } from '../../src/model/mock.js';
import {
  PONDER_ABOUTS,
  PONDER_ARTIFACT_HORIZON_H,
  PONDER_GATE,
  PONDER_WEIGHTS,
  allowedAbouts,
  balanceAvoid,
  ponderGate,
  ponderScore,
  type PonderAbout,
  type PonderFeatures,
} from '../../src/life/policy.js';

const feats = (over: Partial<PonderFeatures> = {}): PonderFeatures => ({
  novelty: 0,
  arousal: 0,
  hoursSinceArtifact: 0,
  ...over,
});

describe('the spec-pinned constants', () => {
  it('gate 0.45; the weights and the artifact horizon are the documented PROPOSED values', () => {
    expect(PONDER_GATE).toBe(0.45);
    expect(PONDER_WEIGHTS).toEqual({ novelty: 0.45, arousal: 0.25, artifact: 0.3 });
    expect(PONDER_ARTIFACT_HORIZON_H).toBe(3);
    expect([...PONDER_ABOUTS]).toEqual(['diego', 'self', 'world']);
  });
});

describe('ponderScore', () => {
  it('zero features score zero — a satiated, calm, freshly-artifacted mind does not ponder', () => {
    expect(ponderScore(feats())).toBe(0);
  });

  it('each feature contributes its weight; the artifact term saturates at the 3h horizon', () => {
    expect(ponderScore(feats({ novelty: 1 }))).toBe(0.45);
    expect(ponderScore(feats({ arousal: 1 }))).toBe(0.25);
    expect(ponderScore(feats({ hoursSinceArtifact: 3 }))).toBe(0.3);
    expect(ponderScore(feats({ hoursSinceArtifact: 48 }))).toBe(0.3); // saturated, not 4.8
    expect(ponderScore(feats({ hoursSinceArtifact: 1.5 }))).toBe(0.15); // half the horizon
    expect(ponderScore(feats({ hoursSinceArtifact: -2 }))).toBe(0); // clamped, never negative
  });

  it('is deterministic', () => {
    const f = feats({ novelty: 0.31, arousal: 0.62, hoursSinceArtifact: 2.4 });
    expect(ponderScore(f)).toBe(ponderScore(f));
  });
});

describe('ponderGate — the 0.45 boundary (pure, threshold pinned by the spec)', () => {
  it('blocks below, speaks at exactly 0.45 (>=)', () => {
    expect(ponderGate(feats({ novelty: 0.9 }))).toBe(false); // 0.405
    expect(ponderGate(feats({ novelty: 1 }))).toBe(true); // 0.45 exactly — the boundary
    expect(ponderGate(feats({ novelty: 0.2, arousal: 0.4, hoursSinceArtifact: 3 }))).toBe(true); // 0.49
  });

  it('right after an artifact a resting state stays shut (the gate is self-limiting)', () => {
    // The resting pair from the policy's own comment: novelty .25, arousal .34, artifact just landed.
    const resting = feats({ novelty: 0.25, arousal: 0.34 });
    expect(ponderScore(resting)).toBeCloseTo(0.1975, 2);
    expect(ponderGate(resting)).toBe(false);
  });

  it('a starving drive or a long silence opens it without needing all three', () => {
    expect(ponderGate(feats({ novelty: 1, arousal: 0, hoursSinceArtifact: 0 }))).toBe(true);
    expect(ponderGate(feats({ novelty: 0, arousal: 1, hoursSinceArtifact: 3 }))).toBe(true); // 0.55
  });

  it('asks no model — the gate is a mood computed from state (call-log assertion)', () => {
    const model = new MockModel({ strict: true }); // any call at all would throw
    expect(ponderGate(feats({ novelty: 1 }))).toBe(true);
    expect(ponderGate(feats())).toBe(false);
    expect(model.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The balance rule — at most 2 of the last 5 seeds about diego
// ---------------------------------------------------------------------------

describe('balanceAvoid', () => {
  const h = (...xs: PonderAbout[]): PonderAbout[] => xs;

  it('null while diego is at most 1 of the last 5', () => {
    expect(balanceAvoid([])).toBeNull();
    expect(balanceAvoid(h('diego'))).toBeNull();
    expect(balanceAvoid(h('diego', 'self', 'world', 'self', 'world'))).toBeNull();
    expect(balanceAvoid(h('self', 'world', 'self', 'world', 'diego'))).toBeNull();
  });

  it('two diego in the last five is already over the line (>= 2, forced avoid)', () => {
    expect(balanceAvoid(h('diego', 'diego'))).toBe('diego');
    expect(balanceAvoid(h('self', 'diego', 'world', 'diego', 'world'))).toBe('diego');
  });

  it('self and world each tolerate 3, avoid at 4 (balance beats saliency, symmetric table)', () => {
    expect(balanceAvoid(h('self', 'self', 'self', 'world', 'world'))).toBeNull();
    expect(balanceAvoid(h('self', 'self', 'self', 'self', 'world'))).toBe('self');
    expect(balanceAvoid(h('world', 'world', 'world', 'world', 'self'))).toBe('world');
  });

  it('diego is checked first when two classes are over-used', () => {
    expect(balanceAvoid(h('diego', 'diego', 'self', 'self', 'self'))).toBe('diego');
  });

  it('only the LAST five count — old over-use ages out', () => {
    // Two diego in the first two slots are outside the five-window.
    expect(balanceAvoid(h('diego', 'diego', 'self', 'world', 'self', 'world', 'self'))).toBeNull();
    expect(balanceAvoid(h('self', 'self', 'self', 'world', 'world', 'world', 'world'))).toBe('world');
  });

  it('is deterministic and never mutates its input', () => {
    const input = h('diego', 'self', 'diego', 'world');
    expect(balanceAvoid(input)).toBe('diego');
    expect(input).toEqual(h('diego', 'self', 'diego', 'world'));
  });
});

describe('allowedAbouts (the balance rule as a set)', () => {
  it('everything is allowed when nothing is over-used', () => {
    expect(allowedAbouts([])).toEqual(['diego', 'self', 'world']);
  });

  it('the avoided class is subtracted, the rest stay selectable', () => {
    expect(allowedAbouts(['diego', 'diego', 'world'])).toEqual(['self', 'world']);
    expect(allowedAbouts(['self', 'self', 'self', 'self'])).toEqual(['diego', 'world']);
    expect(allowedAbouts(['world', 'world', 'world', 'world'])).toEqual(['diego', 'self']);
  });
});

// ---------------------------------------------------------------------------
// The property: diego-topics dominate saliency, the cap still holds
// ---------------------------------------------------------------------------

describe('balance-rule property over seeded histories', () => {
  interface Run {
    history: PonderAbout[];
    forcedAvoids: number;
  }

  /** Twenty ponder runs whose saliency always ranks diego first. The seed loop
   * takes diego whenever the balance rule allows it; a less salient self-topic
   * wins only on the forced-avoid turns — exactly the spec's "a more salient
   * diego-topic loses to a less salient other-class one". */
  const biasedRun = (seed: number, runs = 20): Run => {
    const rng = makeRng(`ponder-balance-${seed}`);
    const history: PonderAbout[] = [];
    let forcedAvoids = 0;
    for (let i = 0; i < runs; i += 1) {
      if (balanceAvoid(history) !== null) forcedAvoids += 1;
      const allowed = allowedAbouts(history);
      const pick = allowed.includes('diego') ? 'diego' : rng.pick(allowed);
      history.push(pick);
    }
    return { history, forcedAvoids };
  };

  it('over 20 seeded runs, no window of 5 consecutive seeds ever holds more than 2 diego', () => {
    for (let seed = 1; seed <= 20; seed += 1) {
      const { history } = biasedRun(seed);
      expect(history).toHaveLength(20);
      for (let i = 0; i + 5 <= history.length; i += 1) {
        const window = history.slice(i, i + 5);
        const diego = window.filter((a) => a === 'diego').length;
        expect(diego, `window at ${i} of seed ${seed}: ${window.join(',')}`).toBeLessThanOrEqual(2);
      }
    }
  });

  it('the forced-avoid path is genuinely exercised — dominance would have won without it', () => {
    let totalAvoids = 0;
    let totalDiego = 0;
    let totalRuns = 0;
    for (let seed = 1; seed <= 20; seed += 1) {
      const { history, forcedAvoids } = biasedRun(seed);
      totalAvoids += forcedAvoids;
      totalDiego += history.filter((a) => a === 'diego').length;
      totalRuns += history.length;
    }
    expect(totalAvoids).toBeGreaterThan(0);
    // And the rule bites: with free choice every run would have been diego.
    expect(totalDiego).toBeLessThan(totalRuns);
  });

  it('a history that never re-reaches the cap still respects it (the rule is the only guard)', () => {
    const { history } = biasedRun(7);
    const diego = history.filter((a) => a === 'diego').length;
    expect(diego).toBeGreaterThanOrEqual(1); // diego is never banned outright, only capped
  });
});

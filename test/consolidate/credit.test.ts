// M10 gate — credit assignment (spec §2.1). The formula is pinned in the spec,
// so these tests pin the NUMBERS: η goldens, the clamp under adversarial
// sequences, the share matrix, the mood guard's exact threshold, decay
// convergence, and the persistence/recovery contract on weights.json.

import { describe, expect, it } from 'vitest';
import {
  CREDIT_ETA,
  CONTRAST_PLUS_SHARE,
  MOOD_GUARD,
  NIGHTLY_DECAY,
  SLOT_SHARE,
  applyOutcome,
  aversiveNorm,
  clampWeight,
  decayWeights,
  emptyWeightsFile,
  loadWeightsFile,
  moodGuardFor,
  replayWeights,
  serializeWeightsFile,
  shareFor,
} from '../../src/consolidate/index.js';
import { errorCodeOf, stamp12 } from './helpers.js';
import type { CreditWeights, OutcomeGrade, PacketRecordView, PacketSlotView } from '../../src/consolidate/index.js';

const slot = (over: Partial<PacketSlotView> & { exemplarId: string }): PacketSlotView => ({
  tier: 'episode',
  channel: 'character',
  baseScore: 1,
  modulation: 0,
  ...over,
});

const packet = (slots: PacketSlotView[], affectSig: readonly number[] = []): PacketRecordView => ({
  ts: 0,
  turnId: 'turn_1',
  slots,
  affectSig,
});

const grade = (sign: -1 | 0 | 1, evidence = 'why'): OutcomeGrade => ({ sign, evidence });

describe('share matrix (the spec table)', () => {
  it('information-bearing tiers carry share 1.0', () => {
    expect(SLOT_SHARE.episode).toBe(1);
    expect(SLOT_SHARE.pattern).toBe(1);
    expect(SLOT_SHARE.memory).toBe(1);
    expect(shareFor(slot({ exemplarId: 'a', tier: 'episode' }), 1)).toBe(1);
    expect(shareFor(slot({ exemplarId: 'a', tier: 'pattern' }), -1)).toBe(1);
    expect(shareFor(slot({ exemplarId: 'a', tier: 'memory' }), 1)).toBe(1);
  });

  it('disposition carries 0.5 — always-similar slots say little', () => {
    expect(SLOT_SHARE.disposition).toBe(0.5);
    expect(shareFor(slot({ exemplarId: 'a', tier: 'disposition' }), 1)).toBe(0.5);
  });

  it('contrast is never punished, and its +1 side is CONTRAST_PLUS_SHARE', () => {
    expect(SLOT_SHARE.contrast).toBe(0);
    expect(shareFor(slot({ exemplarId: 'a', tier: 'episode', slot: 'contrast' }), -1)).toBe(0);
    expect(shareFor(slot({ exemplarId: 'a', tier: 'episode', slot: 'contrast' }), 0)).toBe(0);
    expect(shareFor(slot({ exemplarId: 'a', tier: 'episode', slot: 'contrast' }), 1)).toBe(CONTRAST_PLUS_SHARE);
  });

  it('the contrast marker wins over the tier', () => {
    // disposition tier with the contrast marker: the marker's rules apply.
    expect(shareFor(slot({ exemplarId: 'a', tier: 'disposition', slot: 'contrast' }), 1)).toBe(1);
  });
});

describe('the pinned update', () => {
  it('a +1 on one episode slot moves exactly eta', () => {
    const w = applyOutcome({ a: 1 }, packet([slot({ exemplarId: 'a' })]), grade(1), []);
    expect(w['a']).toBe(1 + CREDIT_ETA);
  });

  it('a -1 moves exactly -eta; a 0 grade moves nothing', () => {
    const down = applyOutcome({ a: 1 }, packet([slot({ exemplarId: 'a' })]), grade(-1), []);
    expect(down['a']).toBe(1 - CREDIT_ETA);
    const still = applyOutcome({ a: 1 }, packet([slot({ exemplarId: 'a' })]), grade(0), []);
    expect(still['a']).toBe(1);
  });

  it('an absent id enters at the neutral 1.0 and then moves', () => {
    const w = applyOutcome({}, packet([slot({ exemplarId: 'new' })]), grade(1), []);
    expect(w['new']).toBe(1 + CREDIT_ETA);
  });

  it('results carry no float dust (round 6)', () => {
    const w = applyOutcome({ a: 1.0000004 }, packet([slot({ exemplarId: 'a' })]), grade(1), []);
    expect(String(w['a'])).not.toMatch(/\d{7,}/);
  });

  it('the clamp holds at both ends under adversarial sequences', () => {
    let w: CreditWeights = { a: 2 };
    for (let i = 0; i < 100; i++) w = applyOutcome(w, packet([slot({ exemplarId: 'a' })]), grade(1), []);
    expect(w['a']).toBe(2);
    for (let i = 0; i < 100; i++) w = applyOutcome(w, packet([slot({ exemplarId: 'a' })]), grade(-1), []);
    expect(w['a']).toBe(0.5);
  });

  it('clampWeight rounds before clamping', () => {
    expect(clampWeight(3)).toBe(2);
    expect(clampWeight(-1)).toBe(0.5);
    expect(clampWeight(1)).toBe(1);
  });
});

describe('the mood guard', () => {
  it('halves the update while the aversive norm exceeds 0.5', () => {
    // sadness 0.6 alone: norm 0.6 > 0.5 -> guard 0.5 -> +1 moves eta/2.
    const w = applyOutcome({ a: 1 }, packet([slot({ exemplarId: 'a' })]), grade(1), stamp12({ sadness: 0.6 }));
    expect(w['a']).toBe(1 + (CREDIT_ETA * MOOD_GUARD));
  });

  it('is exactly at the threshold free: norm 0.5 is not above 0.5', () => {
    expect(aversiveNorm(stamp12({ sadness: 0.5 }))).toBe(0.5);
    expect(moodGuardFor(stamp12({ sadness: 0.5 }))).toBe(1);
    // L2 combination hitting the boundary exactly: 0.3^2 + 0.4^2 = 0.25.
    expect(aversiveNorm(stamp12({ sadness: 0.3, fear: 0.4 }))).toBeCloseTo(0.5, 12);
    expect(moodGuardFor(stamp12({ sadness: 0.3, fear: 0.4 }))).toBe(1);
  });

  it('counts only POSITIVE aversive excursions — relief is not aversion', () => {
    expect(aversiveNorm(stamp12({ sadness: -0.9, anger: -0.4 }))).toBe(0);
    expect(moodGuardFor(stamp12({ sadness: -0.9 }))).toBe(1);
  });

  it('guards the -1 direction too (the spec formula is sign-symmetric)', () => {
    const w = applyOutcome({ a: 1 }, packet([slot({ exemplarId: 'a' })]), grade(-1), stamp12({ anger: 0.9 }));
    expect(w['a']).toBe(1 - CREDIT_ETA * MOOD_GUARD);
  });
});

describe('nightly decay', () => {
  it('moves weights toward 1 by the pinned factor', () => {
    const w = decayWeights({ a: 1.02 });
    expect(w['a']).toBe(1 + 0.02 * NIGHTLY_DECAY);
  });

  it('converges toward neutral from both sides and never overshoots', () => {
    let w: CreditWeights = { a: 2, b: 0.5 };
    let lastA = w['a'] as number;
    let lastB = w['b'] as number;
    for (let i = 0; i < 3000; i++) {
      w = decayWeights(w);
      const a = w['a'] as number;
      const b = w['b'] as number;
      expect(Math.abs(a - 1)).toBeLessThanOrEqual(Math.abs(lastA - 1));
      expect(Math.abs(b - 1)).toBeLessThanOrEqual(Math.abs(lastB - 1));
      expect(a).toBeGreaterThanOrEqual(1); // approaches from above
      expect(b).toBeLessThanOrEqual(1); // approaches from below
      lastA = a;
      lastB = b;
    }
    expect(w['a']).toBeCloseTo(1, 6);
    expect(w['b']).toBeCloseTo(1, 6);
  });
});

describe('weights.json persistence', () => {
  it('serializes and loads losslessly (canonical bytes)', () => {
    const file = {
      version: 1 as const,
      lastSeq: 42,
      decayDay: 19_676,
      weights: { 'sha256:aa': 1.02, 'sha256:bb': 0.5 },
    };
    const loaded = loadWeightsFile(serializeWeightsFile(file));
    expect(loaded).toEqual(file);
  });

  it('rejects corrupt JSON with the namespaced code', () => {
    expect(errorCodeOf(() => loadWeightsFile('{not json'))).toBe('consolidate/state-schema');
  });

  it('rejects schema violations (bad lastSeq, unknown keys)', () => {
    expect(errorCodeOf(() => loadWeightsFile('{"version":1,"lastSeq":-1,"weights":{}}'))).toBe(
      'consolidate/state-schema',
    );
    expect(errorCodeOf(() => loadWeightsFile('{"version":1,"lastSeq":0,"weights":{},"extra":true}'))).toBe(
      'consolidate/state-schema',
    );
  });

  it('launch state is the empty file: every id implicitly 1.0', () => {
    expect(emptyWeightsFile()).toEqual({ version: 1, lastSeq: 0, decayDay: 0, weights: {} });
  });
});

describe('replayWeights — L0 is the truth', () => {
  it('folds packets and outcomes in append order', () => {
    const file = replayWeights([
      { seq: 1, kind: 'packet', packet: packet([slot({ exemplarId: 'a', tier: 'episode' })]) },
      { seq: 2, kind: 'outcome', turnId: 'turn_1', outcome: grade(1) },
      { seq: 3, kind: 'packet', packet: packet([slot({ exemplarId: 'b', tier: 'disposition' })], stamp12({ anger: 0.9 })) },
      { seq: 4, kind: 'outcome', turnId: 'turn_1', outcome: grade(-1) },
    ]);
    expect(file.weights['a']).toBe(1 + CREDIT_ETA);
    // -1 on a disposition slot under high aversion: 0.5 share x 0.5 guard.
    expect(file.weights['b']).toBe(1 - CREDIT_ETA * SLOT_SHARE.disposition * MOOD_GUARD);
    expect(file.lastSeq).toBe(4);
  });

  it('an outcome with no packet is skipped, not invented', () => {
    const file = replayWeights([{ seq: 1, kind: 'outcome', turnId: 'ghost', outcome: grade(1) }]);
    expect(file.weights).toEqual({});
    expect(file.lastSeq).toBe(1);
  });

  it('deliberately applies NO decay — the log does not record nights', () => {
    const file = replayWeights([
      { seq: 1, kind: 'packet', packet: packet([slot({ exemplarId: 'a' })]) },
      { seq: 2, kind: 'outcome', turnId: 'turn_1', outcome: grade(1) },
    ]);
    expect(file.weights['a']).toBe(1.02); // not 1.0199
  });
});

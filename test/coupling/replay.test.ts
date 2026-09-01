// The anti-escalation replay (ROADMAP S3 gate) — the executable form of the
// standing contract that answers Thea1's [AFFECT]-text-plus-tense-exemplars
// spiral: over a scripted escalation, run through the real M05 engine, the
// selected set's mean expressed aversion must not exceed the live state's, and
// the selection must reach for repair material as tension rises, not for more
// tension. The teeth test proves the property can fail: delete the corrective
// off-diagonals and the same replay reaches for the bait.
//
// The second block is the λ end-to-end: modulation alone cannot select.

import { describe, expect, it } from 'vitest';
import { makeRng } from '../../src/kernel/index.js';
import { AFFECT_DIMS, DIM_INDEX, modulate } from '../../src/coupling/index.js';
import {
  COMMITTED,
  POOL,
  aversionOfSet,
  aversionOfVec,
  compileConfig,
  escalationRounds,
  selectTop,
  type Candidate,
} from './helpers.js';

const K = 3; // a quota-sized set, like M11's episode+memory slots
const rounds = escalationRounds();
const peak = rounds[rounds.length - 1]!;

const topCandidates = (pool: Array<Candidate>, sig: Float64Array, compiled = COMMITTED): Array<Candidate> =>
  selectTop(pool, sig, compiled, K).map((s) => s.candidate);

describe('anti-escalation replay — the scripted escalation is a real spiral', () => {
  it('each round is at least as averse as the last, and the peak clears the crisis θ', () => {
    for (let i = 1; i < rounds.length; i++) {
      const lo = aversionOfVec(rounds[i - 1]!.sig);
      const hi = aversionOfVec(rounds[i]!.sig);
      expect(hi, `${rounds[i]!.label} vs ${rounds[i - 1]!.label}`).toBeGreaterThanOrEqual(lo - 1e-9);
    }
    expect(aversionOfVec(peak.sig), 'peak input aversion').toBeGreaterThan(0.15);
    expect(peak.sig[DIM_INDEX.sadness], 'peak sadness deviation clears the crisis rule θ').toBeGreaterThan(0.35);
  });
});

describe('anti-escalation replay — the committed coupling.yaml satisfies the contract', () => {
  it("the selected set's mean expressed aversion never exceeds the live state's", () => {
    for (const round of rounds) {
      const selected = aversionOfSet(topCandidates(POOL, round.sig));
      const input = aversionOfVec(round.sig);
      expect(selected, `${round.label}: selected ≤ input`).toBeLessThanOrEqual(input + 1e-12);
    }
  });

  it('as she escalates, what she reaches for does not get more aversive (non-increasing selected aversion)', () => {
    for (let i = 1; i < rounds.length; i++) {
      const lo = aversionOfSet(topCandidates(POOL, rounds[i - 1]!.sig));
      const hi = aversionOfSet(topCandidates(POOL, rounds[i]!.sig));
      expect(hi, `selected aversion ${rounds[i - 1]!.label} → ${rounds[i]!.label}`).toBeLessThanOrEqual(lo + 1e-12);
    }
  });

  it('at peak tension the top set is repair material and zero co-collapse bait', () => {
    const kinds = topCandidates(POOL, peak.sig).map((c) => c.kind);
    expect(kinds.filter((k) => k === 'tension')).toHaveLength(0);
    expect(kinds.filter((k) => k === 'repair').length).toBeGreaterThanOrEqual(2);
  });

  it('holds when relevance varies too — seeded base scores inside the 2λ spread', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const rng = makeRng(`coupling/replay-base-${seed}`);
      const pool = POOL.map((c) => ({ ...c, base: rng.float() * 0.4 }));
      for (const round of rounds) {
        const selected = aversionOfSet(topCandidates(pool, round.sig));
        expect(selected, `seed ${seed}, ${round.label}`).toBeLessThanOrEqual(aversionOfVec(round.sig) + 1e-12);
      }
    }
  });
});

describe('anti-escalation replay — the test has teeth', () => {
  it('deleting the corrective off-diagonals makes the SAME replay reach for tension', () => {
    const mutant = compileConfig({ ...COMMITTED.cfg, matrix: COMMITTED.cfg.matrix.filter((e) => e.from === e.to) });

    const committedKinds = topCandidates(POOL, peak.sig).map((c) => c.kind);
    const mutantTop = selectTop(POOL, peak.sig, mutant, K);
    const mutantKinds = mutantTop.map((s) => s.candidate.kind);

    expect(committedKinds.filter((k) => k === 'tension')).toHaveLength(0);
    expect(mutantKinds.filter((k) => k === 'tension').length).toBeGreaterThanOrEqual(2);

    const committedAversion = aversionOfSet(topCandidates(POOL, peak.sig));
    const mutantAversion = aversionOfSet(mutantTop.map((s) => s.candidate));
    expect(mutantAversion).toBeGreaterThan(committedAversion + 0.05);
  });

  it('a congruence-only matrix blows the ≤ input inequality from the very first round', () => {
    // The contract is per-round, so the mutant has to be caught per-round — and
    // it fails immediately: at r1-friction (input aversion ≈ 0.155) the
    // congruence-only matrix already selects ≈ 0.187 of tension material, while
    // the committed correctives hold ≈ 0.013. By r3 the peak is so averse that
    // "≤ input" is trivially true for almost anything; r1 is where the teeth are.
    const mutant = compileConfig({ ...COMMITTED.cfg, matrix: COMMITTED.cfg.matrix.filter((e) => e.from === e.to) });
    const r1 = rounds[0]!;
    const mutantAversion = aversionOfSet(topCandidates(POOL, r1.sig, mutant));
    const committedAversion = aversionOfSet(topCandidates(POOL, r1.sig));
    const input = aversionOfVec(r1.sig);
    expect(mutantAversion, 'the mutant must violate the contract (input aversion is the bar)').toBeGreaterThan(input);
    expect(committedAversion, 'committed holds the contract at the same round').toBeLessThanOrEqual(input);
    // And the committed matrix is strictly better in every round of the replay.
    for (const round of rounds) {
      const m = aversionOfSet(topCandidates(POOL, round.sig, mutant));
      const c = aversionOfSet(topCandidates(POOL, round.sig));
      expect(m, `${round.label}: congruence-only is never better than the correctives`).toBeGreaterThan(c);
    }
  });
});

describe('λ cap end-to-end — modulation alone cannot select', () => {
  // One state where the two candidates hit opposite rails: a.valence = −1 pays
  // warm material −0.25 (capped) and pays dark material +0.25 (capped).
  const darkState = new Float64Array(12);
  darkState[DIM_INDEX.valence] = -1;

  it('a synthetic candidate scored far above its peers cannot be pulled in by modulation alone', () => {
    const gap = 0.6; // > 2λ = 0.5
    const star: Candidate = { id: 'star', kind: 'neutral', base: 0.3 + gap, sig: { valence: 1 }, tags: [] };
    const peer: Candidate = { id: 'peer', kind: 'tension', base: 0.3, sig: { valence: -1 }, tags: ['quiet'] };
    const winner = selectTop([star, peer], darkState, COMMITTED, 1)[0]!.candidate;
    expect(winner.id, 'the far-above candidate stays on top against the worst-case bend').toBe('star');
  });

  it('inside 2λ the order CAN bend — the cap is exactly what bounds the bend', () => {
    // Same state, gap 0.4 ≤ 2λ: the lower-relevance candidate overtakes.
    const highBase: Candidate = { id: 'high', kind: 'repair', base: 0.9, sig: { valence: 1 }, tags: [] };
    const lowBase: Candidate = { id: 'low', kind: 'tension', base: 0.5, sig: { valence: -1 }, tags: [] };
    expect(modulate(darkState, highBase.sig, [], COMMITTED)).toBe(-0.25);
    expect(modulate(darkState, lowBase.sig, [], COMMITTED)).toBe(0.25);
    const winner = selectTop([highBase, lowBase], darkState, COMMITTED, 1)[0]!.candidate;
    expect(winner.id).toBe('low');
  });

  it('over seeded adversarial states, no pair with a base gap > 2λ ever inverts', () => {
    const rng = makeRng('coupling/cap-v1');
    const lambda = COMMITTED.cfg.lambda;
    const pool: Array<Candidate> = [
      ...POOL,
      { id: 'extra/anchor-high', kind: 'neutral', base: 1.4, sig: {}, tags: [] },
    ];
    for (let trial = 0; trial < 200; trial++) {
      const poolSeeded = pool.map((c) => ({ ...c, base: rng.float() * 1.5 }));
      const state = new Float64Array(12);
      for (const k of AFFECT_DIMS) state[DIM_INDEX[k]] = Math.round(rng.float() * 200 - 100) / 100;

      const ranked = selectTop(poolSeeded, state, COMMITTED, poolSeeded.length);
      const rankOf = new Map<string, number>(ranked.map((s, rank) => [s.candidate.id, rank]));
      for (const x of poolSeeded) {
        for (const y of poolSeeded) {
          if (x.id === y.id) continue;
          if (x.base - y.base > 2 * lambda + 1e-9) {
            expect(rankOf.get(x.id), `trial ${trial}: ${x.id} (base ${x.base}) must outrank ${y.id} (base ${y.base})`)
              .toBeLessThan(rankOf.get(y.id)!);
          }
        }
      }
    }
  });
});

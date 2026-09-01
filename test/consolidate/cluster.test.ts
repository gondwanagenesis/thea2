// M10 gate (a)+(d) — clustering determinism, the evidence threshold, and the
// evidence rollups that become the lived stamps. Everything here is pure: same
// input, same clusters, same stamps, on every machine.

import { describe, expect, it } from 'vitest';
import { AFFECT_DIMS } from '../../schemas/exemplar.js';
import {
  clusterEpisodes,
  consolidationKeyOf,
  cosine,
  rollupAffect,
  rollupOutcome,
  sparseSignatureOf,
  type ClusterEpisode,
} from '../../src/consolidate/index.js';
import { errorCodeOf, stamp12 } from './helpers.js';

const episodeOf = (id: string, vec: readonly number[], n = 0): ClusterEpisode => ({
  id,
  ts: 1000 + n,
  turnId: `turn_${id}`,
  summary: `episode ${id}`,
  importance: 5,
  affectAtEncoding: stamp12({ valence: 0.2 }),
  vec: new Float32Array(vec),
});

describe('clustering', () => {
  it('groups similar episodes and separates dissimilar ones', () => {
    const clusters = clusterEpisodes(
      [
        episodeOf('e1', [1, 0]),
        episodeOf('e2', [0.95, 0.05]),
        episodeOf('e3', [0, 1]),
      ],
      0.35,
    );
    expect(clusters.map((c) => c.leaderId)).toEqual(['e1', 'e3']);
    expect(clusters[0]?.episodes.map((e) => e.id)).toEqual(['e1', 'e2']);
    expect(clusters[1]?.episodes.map((e) => e.id)).toEqual(['e3']);
  });

  it('is order-independent: shuffled input gives the same clusters', () => {
    const eps = [
      episodeOf('e1', [1, 0], 0),
      episodeOf('e2', [0.95, 0.05], 1),
      episodeOf('e3', [0, 1], 2),
      episodeOf('e4', [0.02, 0.99], 3),
    ];
    const shape = (cs: ReturnType<typeof clusterEpisodes>): string[][] =>
      cs.map((c) => c.episodes.map((e) => e.id));
    // The double reversal is still a different insertion order than sorted order.
    expect(shape(clusterEpisodes([...eps].reverse(), 0.35))).toEqual(shape(clusterEpisodes(eps, 0.35)));
  });

  it('membership follows the leader, not a drifting centroid', () => {
    // Hand-computed: cos(e1,e2)=0.9966 and cos(e1,e3)=0.9487 < 0.95, so e3 never
    // joins e1 — even though cos(centroid(e1,e2), e3)=0.9608 >= 0.95 would admit
    // it under a centroid rule. The leader rule is what the bytes depend on.
    const clusters = clusterEpisodes(
      [
        episodeOf('e1', [1, 0]),
        episodeOf('e2', [0.96, 0.08]),
        episodeOf('e3', [0.9, 0.3]),
      ],
      0.95,
    );
    expect(clusters[0]?.episodes.map((e) => e.id)).toEqual(['e1', 'e2']);
    expect(clusters[1]?.episodes.map((e) => e.id)).toEqual(['e3']);
  });

  it('mixed vector dimensions are a loud bug, not a silent zero', () => {
    expect(errorCodeOf(() => cosine(new Float32Array([1, 0]), new Float32Array([1, 0, 0])))).toBe(
      'consolidate/no-vector',
    );
    expect(
      errorCodeOf(() => clusterEpisodes([episodeOf('e1', [1, 0]), episodeOf('e2', [1, 0, 0])], 0.35)),
    ).toBe('consolidate/no-vector');
  });

  it('a zero vector is similar to nothing', () => {
    expect(cosine(new Float32Array([0, 0]), new Float32Array([1, 0]))).toBe(0);
  });
});

describe('the consolidation key (idempotence + provenance)', () => {
  it('is order-independent over the episode set', () => {
    const k1 = consolidationKeyOf({ name: 'pattern-crystallizer', version: '1' }, ['e3', 'e1', 'e2']);
    const k2 = consolidationKeyOf({ name: 'pattern-crystallizer', version: '1' }, ['e1', 'e2', 'e3']);
    expect(k1).toBe(k2);
    expect(k1).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('changes with the consolidator and its version', () => {
    const base = consolidationKeyOf({ name: 'pattern-crystallizer', version: '1' }, ['e1']);
    expect(consolidationKeyOf({ name: 'pattern-crystallizer', version: '2' }, ['e1'])).not.toBe(base);
    expect(consolidationKeyOf({ name: 'canon-promotion-proposer', version: '1' }, ['e1'])).not.toBe(base);
  });

  it('changes when membership changes', () => {
    const base = consolidationKeyOf({ name: 'x', version: '1' }, ['e1', 'e2']);
    expect(consolidationKeyOf({ name: 'x', version: '1' }, ['e1', 'e2', 'e3'])).not.toBe(base);
  });
});

describe('outcome rollup — the honest tag', () => {
  const g = (sign: -1 | 0 | 1) => ({ sign, evidence: 'e' });

  it('all + is good, all - is bad, mixed signs are mixed', () => {
    expect(rollupOutcome([g(1), g(1)])).toEqual({ ok: true, outcome: 'good' });
    expect(rollupOutcome([g(-1)])).toEqual({ ok: true, outcome: 'bad' });
    expect(rollupOutcome([g(1), g(-1)])).toEqual({ ok: true, outcome: 'mixed' });
  });

  it('a recorded 0 is silence, and silence can only be mixed', () => {
    expect(rollupOutcome([g(0)])).toEqual({ ok: true, outcome: 'mixed' });
    expect(rollupOutcome([g(0), g(1)])).toEqual({ ok: true, outcome: 'good' });
  });

  it('a MISSING grade is the evidence gap, not data', () => {
    expect(rollupOutcome([g(1), undefined])).toEqual({ ok: false, missing: 1 });
    expect(rollupOutcome([undefined, undefined])).toEqual({ ok: false, missing: 2 });
  });
});

describe('affect rollup — the lived stamp', () => {
  it('means the episodes stamps, in AFFECT_DIMS order, all 12 dims', () => {
    const full = rollupAffect([stamp12({ valence: 0.4, joy: 0.2 }), stamp12({ valence: 0.6, joy: 0.4 })]);
    expect(Object.keys(full)).toEqual([...AFFECT_DIMS]);
    expect(full.valence).toBe(0.5);
    expect(full.joy).toBe(0.3);
    expect(full.sadness).toBe(0);
  });

  it('clamps back into [-1, 1] and rounds for byte-stable YAML', () => {
    const full = rollupAffect([stamp12({ valence: 1.2 }), stamp12({ valence: 1.2 })]);
    expect(full.valence).toBe(1);
    expect(rollupAffect([stamp12({ arousal: 0.123456 })]).arousal).toBeCloseTo(0.1235, 4);
  });

  it('no -0 in the emitted map', () => {
    const full = rollupAffect([stamp12({ valence: -0.0001 }), stamp12({ valence: 0.0001 })]);
    expect(Object.is(full.valence, -0)).toBe(false);
    expect(full.valence).toBe(0);
  });

  it('the sparse signature keeps only the dims that moved', () => {
    const full = rollupAffect([stamp12({ valence: 0.5, joy: -0.25 })]);
    expect(sparseSignatureOf(full)).toEqual({ valence: 0.5, joy: -0.25 });
    expect(sparseSignatureOf(rollupAffect([stamp12()]))).toEqual({});
  });
});

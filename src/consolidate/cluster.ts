// M10 consolidate — pattern clustering and the evidence rollups. Pure and
// deterministic: episode order in, clusters out, same input ⇒ same clustering on
// every machine (the sort is total, the comparison is IEEE, nothing else).
//
// This is the module's evidence threshold: a cluster below MIN_PATTERN_EPISODES
// is not a pattern yet, and nothing is generated for it.

import { canonicalJson, contentHash } from '../kernel/index.js';
import { AFFECT_DIMS, type AffectDim } from '../../schemas/exemplar.js';
import { compareStrings } from '../corpus/types.js';
import { ConsolidateError } from './errors.js';
import type { OutcomeGrade } from './types.js';

/** The evidence threshold: episodes per pattern before consolidation fires.
 * PROPOSED constant — the spec demands the gate exist but does not number it
 * (see docs/modules/M10-consolidate.md §Deviations). 3 = one repeat is noise,
 * three is a regularity. */
export const MIN_PATTERN_EPISODES = 3;

/** Cosine above which an episode joins an existing pattern cluster. */
export const PATTERN_SIMILARITY = 0.35;

/** One day / one week — the L2/L3 lookback windows. */
export const DAY_MS = 24 * 60 * 60 * 1000;
export const WEEK_MS = 7 * DAY_MS;

/** The episode slice the consolidators see: what happened, how it felt, and the
 * frozen Vec12 stamp that will be written into the lived exemplar verbatim. */
export interface ClusterEpisode {
  id: string;
  ts: number;
  turnId: string;
  summary: string;
  importance: number;
  affectAtEncoding: readonly number[];
  vec: Float32Array;
}

export interface PatternCluster {
  /** First member's id — the cluster's anchor, stable because members sort by (ts, id). */
  leaderId: string;
  /** Members in (ts, id) order. */
  episodes: ClusterEpisode[];
}

export const cosine = (a: Float32Array, b: Float32Array): number => {
  if (a.length !== b.length) {
    throw new ConsolidateError('consolidate/no-vector', `episode vectors have mixed dimensions (${a.length} vs ${b.length})`);
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
};

const byTsThenId = (a: ClusterEpisode, b: ClusterEpisode): number => a.ts - b.ts || compareStrings(a.id, b.id);

/**
 * Greedy leader clustering: episodes arrive in (ts, id) order and each joins
 * the FIRST cluster whose leader it is similar enough to, else opens a new one.
 * Comparing against the leader (not a drifting centroid) keeps a cluster's
 * identity fixed no matter how its membership grows — and keeps the whole pass
 * independent of the order the store happened to hand the episodes over in.
 */
export const clusterEpisodes = (episodes: readonly ClusterEpisode[], similarity: number): PatternCluster[] => {
  const clusters: PatternCluster[] = [];
  for (const ep of [...episodes].sort(byTsThenId)) {
    let home: PatternCluster | undefined;
    for (const c of clusters) {
      const leader = c.episodes[0];
      if (leader === undefined) continue;
      if (cosine(leader.vec, ep.vec) >= similarity) {
        home = c;
        break;
      }
    }
    if (home === undefined) clusters.push({ leaderId: ep.id, episodes: [ep] });
    else home.episodes.push(ep);
  }
  return clusters;
};

/**
 * A run's idempotence key: the same consolidator over the same episode set is
 * the SAME pattern, forever. Sorted ids make it order-independent; the hash
 * makes it a stable file/manifest key. Written into each draft's `notes` so a
 * lost manifest can be rebuilt from the files themselves.
 */
export const consolidationKeyOf = (
  consolidator: { name: string; version: string },
  episodeIds: readonly string[],
): string => contentHash(canonicalJson([consolidator.name, consolidator.version, [...episodeIds].sort(compareStrings)]));

// ---------------------------------------------------------------------------
// Evidence rollups — the lived stamps
// ---------------------------------------------------------------------------

export type OutcomeRollup =
  | { ok: true; outcome: 'good' | 'mixed' | 'bad' }
  | { ok: false; missing: number };

/**
 * The honest outcome tag: the episodes' own `memory.outcome_prev` grades.
 * Mixed signs ⇒ mixed. A 0 grade is a recorded "no evidence either way", which
 * among good|mixed|bad can only be mixed. A MISSING grade is not data at all —
 * that is the gap that routes a draft to proposals/ instead of lived/.
 */
export const rollupOutcome = (grades: ReadonlyArray<OutcomeGrade | undefined>): OutcomeRollup => {
  const missing = grades.filter((g) => g === undefined).length;
  if (missing > 0) return { ok: false, missing };
  let plus = 0;
  let minus = 0;
  for (const g of grades) {
    if (g === undefined) continue;
    if (g.sign > 0) plus += 1;
    else if (g.sign < 0) minus += 1;
  }
  if (plus > 0 && minus > 0) return { ok: true, outcome: 'mixed' };
  if (plus > 0) return { ok: true, outcome: 'good' };
  if (minus > 0) return { ok: true, outcome: 'bad' };
  return { ok: true, outcome: 'mixed' }; // recorded, but silent
};

const ROUND_AFFECT = 4;

const round4 = (x: number): number => {
  const r = Math.round(x * 10 ** ROUND_AFFECT) / 10 ** ROUND_AFFECT;
  return Object.is(r, -0) ? 0 : r;
};

/**
 * The cluster's affect stamp: the mean of its episodes' affectAtEncoding — the
 * room those memories were formed in — clamped back into [-1, 1] and rounded so
 * the emitted YAML is byte-stable. FULL 12 dims, in AFFECT_DIMS order: the lived
 * schema has no sparse option here.
 */
export const rollupAffect = (stamps: readonly (readonly number[])[]): Record<AffectDim, number> => {
  const out = {} as Record<AffectDim, number>;
  AFFECT_DIMS.forEach((dim, i) => {
    let sum = 0;
    for (const s of stamps) sum += s[i] ?? 0;
    const mean = stamps.length === 0 ? 0 : sum / stamps.length;
    out[dim] = Math.min(1, Math.max(-1, round4(mean)));
  });
  return out;
};

/**
 * The sparse signature a lived exemplar carries in its `affect:` field: the
 * same cluster stamp, restricted to the dims that actually moved. An exemplar
 * whose room was unremarkable gets `{}` — coupling stays silent, which is what
 * unremarkable means.
 */
export const sparseSignatureOf = (full: Record<AffectDim, number>): Partial<Record<AffectDim, number>> => {
  const out: Partial<Record<AffectDim, number>> = {};
  for (const dim of AFFECT_DIMS) {
    const v = full[dim] ?? 0;
    if (v !== 0) out[dim] = v;
  }
  return out;
};

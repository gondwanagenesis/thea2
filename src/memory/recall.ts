// M09 memory — recall nominators: the memory side of the assembler's candidate
// supply. Nominators RANK, the assembler CUTS (quota and selection math are
// M11's) — so these return a small ranked pool, never a decision.
//
// Determinism is the contract: score descending, id ascending, no rng, no
// clock-dependent tie-breaks. The episodic composite is
//   cosine × recency × importance
// with importance on the appraisal's own 1-10 scale (÷10). Procedures carry no
// recency or importance term — the store's outcome weighting already applied.

import { canonicalJson, type Clock } from '../kernel/index.js';
import { AFFECT_DIMS, type AffectDim } from '../../schemas/exemplar.js';
import type { EpisodeStore } from './episodes.js';
import type { ProcedureRecord, ProceduralStore } from './procedural.js';

// ---------------------------------------------------------------------------
// Load-bearing constants
// ---------------------------------------------------------------------------

/**
 * Candidates per episodic nomination. The packet's 2–3 memory slots draw from a
 * 3–5 pool (M09 spec) so the assembler's coherence swaps always have a
 * runner-up; a smaller ask is served the floor anyway.
 */
export const EPISODIC_MIN = 3;
export const EPISODIC_MAX = 5;

/**
 * How deep into the cosine ranking the nominator reaches before applying its
 * own composite score: recency × importance can promote an episode the raw
 * cosine ranked below the cut, so the pool is wider than the candidate cap.
 * Factor 4 is the proposed default (the spec leaves the pool depth open).
 */
export const NOMINATOR_POOL_FACTOR = 4;

/**
 * Recency half-life for the episodic ranking: a week-old episode counts half.
 * NOT pinned by the spec — proposed here and flagged in the M09 build report.
 */
export const RECENCY_HALF_LIFE_MS = 7 * 24 * 3_600_000;

/** |deviation| at or below this is silence in a candidate's sparse signature. */
export const SIG_EPSILON = 0.01;

/** Render cap for a procedure's argument JSON — [PROCEDURAL] teaches shape, not payload. */
export const RENDER_ARG_CAP = 240;

// ---------------------------------------------------------------------------
// Candidate + query shapes (M09's slice of M11's TurnQuery/Candidate)
// ---------------------------------------------------------------------------

export type PacketChannelName = 'character' | 'procedural';

/** Structurally satisfied by M11's TurnQuery; M09 reads only this much. */
export interface MemoryQuery {
  entry: 'user-turn' | 'heartbeat' | 'ponder';
  text?: string | undefined;
  goal?: string | undefined;
  queryVec: Float32Array;
}

/** Sparse deviation signature over the 12 affect dims (M06's SparseVec12 shape). */
export type SparseSig = Partial<Record<AffectDim, number>>;

/**
 * M09's slice of M11's Candidate for the memory/procedure tiers: same field
 * names, `source: 'memory'`, `creditW: 1.0` (learned credit is M10's to know —
 * memory never owns it, so it ships the assembler's unknown default).
 */
export interface MemoryCandidate {
  id: string;
  channel: PacketChannelName;
  tier: 'memory' | 'procedure';
  baseScore: number;
  creditW: number;
  sig: SparseSig;
  vec?: Float32Array;
  tags: string[];
  source: 'memory';
  render(): string;
}

export interface MemoryNominator {
  name: string;
  channel: PacketChannelName;
  nominate(q: MemoryQuery, k: number): Promise<MemoryCandidate[]>;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/** Exponential recency: 1.0 now, 0.5 at one half-life, asymptote 0. */
export const recencyOf = (ts: number, nowMs: number): number =>
  2 ** (-Math.max(0, nowMs - ts) / RECENCY_HALF_LIFE_MS);

/** The episodic composite for one cosine hit. Exported for ranking-geometry tests. */
export const episodicScore = (cosine: number, importance: number, ts: number, nowMs: number): number =>
  cosine * recencyOf(ts, nowMs) * (importance / 10);

/** Deviation coords below SIG_EPSILON are silence, not signal. */
export const sigOf = (stamp: readonly number[]): SparseSig => {
  const out: SparseSig = {};
  AFFECT_DIMS.forEach((dim, i) => {
    const v = stamp[i];
    if (v !== undefined && Math.abs(v) >= SIG_EPSILON) out[dim] = v;
  });
  return out;
};

/** Score descending, id ascending — the same tie rule M04's index uses, applied
 * again here because the composite score reorders the cosine ranking. */
const byScoreThenId = <T>(scoreOf: (x: T) => number, idOf: (x: T) => string) => (a: T, b: T): number => {
  const diff = scoreOf(b) - scoreOf(a);
  if (diff !== 0) return diff;
  const ai = idOf(a);
  const bi = idOf(b);
  return ai < bi ? -1 : ai > bi ? 1 : 0;
};

// ---------------------------------------------------------------------------
// Nominators
// ---------------------------------------------------------------------------

/**
 * The character channel's memory tier. Store separation does the structural
 * work: this nominator holds an EpisodeStore, whose search can only return
 * episodes — a procedure record has no way in (and `proceduralNominator` is
 * its mirror image).
 */
export const episodicNominator = (store: EpisodeStore, deps: { clock: Clock }): MemoryNominator => ({
  name: 'memory/episodic',
  channel: 'character',
  nominate: async (q, k) => {
    const want = Math.min(Math.max(k, EPISODIC_MIN), EPISODIC_MAX);
    const pool = Math.min(store.size(), Math.max(want, k) * NOMINATOR_POOL_FACTOR);
    if (pool === 0) return [];

    const now = deps.clock.epochMs();
    const ranked = store
      .search(q.queryVec, pool)
      .map((hit) => ({ e: hit.e, score: episodicScore(hit.score, hit.e.importance, hit.e.ts, now) }))
      .sort(byScoreThenId(
        (x) => x.score,
        (x) => x.e.id,
      ))
      .slice(0, want);

    await store.vecsFor(ranked.map((r) => r.e.id));
    return ranked.map(({ e, score }) => {
      const vec = store.vecOf(e.id);
      return {
        id: e.id,
        channel: 'character',
        tier: 'memory',
        baseScore: score,
        creditW: 1.0,
        sig: sigOf(e.affectAtEncoding),
        tags: e.emotions.map((x) => x.tag),
        source: 'memory',
        render: () => `[${e.turnId}] ${e.summary}`,
        ...(vec !== undefined ? { vec } : {}),
      };
    });
  },
});

/** The procedural channel: situation-keyed, outcome-scored, capped by the assembler's quota. */
export const proceduralNominator = (store: ProceduralStore): MemoryNominator => ({
  name: 'memory/procedural',
  channel: 'procedural',
  nominate: async (q, k) => {
    if (k <= 0) return [];
    const pool = Math.min(store.size(), Math.max(k, 1) * NOMINATOR_POOL_FACTOR);
    if (pool === 0) return [];

    const ranked = store
      .search(q.queryVec, pool)
      .sort(byScoreThenId(
        (x) => x.score,
        (x) => x.p.id,
      ))
      .slice(0, k);

    await store.vecsFor(ranked.map((r) => r.p.id));
    return ranked.map(({ p, score }) => {
      const vec = store.vecOf(p.id);
      return {
        id: p.id,
        channel: 'procedural',
        tier: 'procedure',
        baseScore: score,
        creditW: 1.0,
        sig: {}, // procedures carry no affect signature — coupling has nothing to modulate here
        tags: [],
        source: 'memory',
        render: () => renderProcedure(p),
        ...(vec !== undefined ? { vec } : {}),
      };
    });
  },
});

const renderProcedure = (p: ProcedureRecord): string => {
  let args: string;
  try {
    args = canonicalJson(p.args);
  } catch {
    args = '<unserializable>'; // unreachable for stored records (append validates), kept for honesty
  }
  if (args.length > RENDER_ARG_CAP) args = `${args.slice(0, RENDER_ARG_CAP)}…`;
  return `${p.situation}\n  → ${p.call}(${args}) → ${p.outcome}`;
};

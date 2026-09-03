// M09 memory — recall nominators: the memory side of the assembler's candidate
// supply. Nominators RANK, the assembler CUTS (quota and selection math are
// M11's) — so these return a small ranked pool, never a decision.
//
// Determinism is the contract: score descending, id ascending, no rng, no
// clock-dependent tie-breaks. The episodic composite is
//   cosine × recency × importance
// with importance on the appraisal's own 1-10 scale (÷10). Procedures carry no
// recency or importance term — the store's outcome weighting already applied.
//
// Two pieces are mirrored here because the DAG runs one way (assemble may
// import memory; memory may not import assemble) — canonical definitions in
// src/assemble/score.ts and src/corpus/nominator.ts, all conformance-pinned:
//   • rankNormalizeBase — per-nominator, per-packet rank normalization to
//     (0,1], shipped as `baseScoreNorm` (raw `baseScore` stays the
//     credit-truth); the assembler's scoring law prefers it, which is what
//     makes λ mean "a quarter of the score range" across incomparable
//     nominator scales.
//   • loadCreditWeights — the M10 credit file reader (var/credit/weights.json,
//     written nightly by the consolidator). Absent id ⇒ 1.0, missing file ⇒
//     every id 1.0, malformed file ⇒ loud typed error.

import * as fsp from 'node:fs/promises';
import { canonicalJson, KernelErrorImpl, type Clock } from '../kernel/index.js';
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
// Credit weights — the M10 file, read (never written) here. Mirrored from
// src/corpus/nominator.ts (the DAG gives memory no path to corpus); a
// conformance test pins both readers equal on the same fixture files.
// ---------------------------------------------------------------------------

/** Thrown for a weights file that exists but is not a weights file. Loud by design. */
export class CreditWeightsError extends KernelErrorImpl {
  constructor(message: string, cause?: unknown) {
    super('memory/credit-weights', message, cause);
    this.name = 'CreditWeightsError';
  }
}

/** `{ exemplarId: number }` — values finite; range policy ([0.5, 2.0]) is M10's. */
export interface CreditWeights {
  readonly [exemplarId: string]: number;
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

/** Strict parse of the consolidator's persisted shape; drift is a loud typed error. */
export const parseCreditWeightsFile = (raw: string): CreditWeights => {
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch (e) {
    throw new CreditWeightsError(`credit weights file is not valid JSON: ${(e as Error).message}`, e);
  }
  const bad = (what: string): CreditWeightsError =>
    new CreditWeightsError(`credit weights file rejected: ${what} — expected the consolidator's {version:1, lastSeq, decayDay, weights} shape`);
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) throw bad('not an object');
  const rec = doc as Record<string, unknown>;
  if (rec['version'] !== 1) throw bad(`version ${JSON.stringify(rec['version'])}`);
  if (!isInt(rec['lastSeq']) || !isInt(rec['decayDay'])) throw bad('lastSeq/decayDay must be non-negative integers');
  const w = rec['weights'];
  if (typeof w !== 'object' || w === null || Array.isArray(w)) throw bad('weights must be an object');
  const out: Record<string, number> = {};
  for (const [id, v] of Object.entries(w as Record<string, unknown>)) {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw bad(`weights['${id}'] must be a finite number, got ${String(v)}`);
    }
    out[id] = v;
  }
  return out;
};

/** Process-level cache keyed by path, re-validated per call by mtime (see the corpus mirror). */
const weightsCache = new Map<string, { mtimeMs: number; weights: CreditWeights }>();

/** Missing file ⇒ {} (launch state, neutral credit); malformed file ⇒ loud typed error. */
export const loadCreditWeights = async (path: string): Promise<CreditWeights> => {
  let stat: Awaited<ReturnType<typeof fsp.stat>>;
  try {
    stat = await fsp.stat(path);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return {};
    throw new CreditWeightsError(`credit weights file at '${path}' is unreadable: ${code ?? String(e)}`, e);
  }
  const cached = weightsCache.get(path);
  if (cached !== undefined && cached.mtimeMs === stat.mtimeMs) return cached.weights;
  let raw: string;
  try {
    raw = await fsp.readFile(path, 'utf8');
  } catch (e) {
    throw new CreditWeightsError(`credit weights file at '${path}' disappeared between stat and read: ${String(e)}`, e);
  }
  const weights = parseCreditWeightsFile(raw);
  weightsCache.set(path, { mtimeMs: stat.mtimeMs, weights });
  return weights;
};

/**
 * M11's per-nominator rank normalization (src/assemble/score.ts rankNormalize),
 * mirrored for the DAG — conformance-pinned equal, value for value.
 */
export const rankNormalizeBase = (values: readonly number[]): number[] => {
  const n = values.length;
  if (n === 0) return [];
  const order = [...values.keys()].sort((x, y) => values[x]! - values[y]! || x - y);
  const out = new Array<number>(n);
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j < order.length && values[order[j]!] === values[order[i]!]) j += 1;
    const avgRank = (i + 1 + j) / 2;
    for (let k = i; k < j; k++) out[order[k]!] = avgRank / n;
    i = j;
  }
  return out;
};

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
 * names, `source: 'memory'`. `creditW` is learned credit (M10's file, read at
 * `creditPath` — memory never owns the values, it reads them); candidates also
 * carry `baseScoreNorm`, the per-nominator rank-normalized base (0,1] the
 * assembler's scoring law prefers over the raw composite.
 */
export interface MemoryCandidate {
  id: string;
  channel: PacketChannelName;
  tier: 'memory' | 'procedure';
  baseScore: number;
  baseScoreNorm?: number | undefined;
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
 * its mirror image). `creditPath` points at the nightly weights file
 * (conventionally var/credit/weights.json); unset ⇒ neutral credit, exactly
 * like a missing file. Round 3 (composition) passes the resolved path.
 */
export const episodicNominator = (
  store: EpisodeStore,
  deps: { clock: Clock; creditPath?: string | undefined },
): MemoryNominator => ({
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
    const credit = deps.creditPath !== undefined ? await loadCreditWeights(deps.creditPath) : undefined;
    const norms = rankNormalizeBase(ranked.map((r) => r.score));
    return ranked.map(({ e, score }, i) => {
      const vec = store.vecOf(e.id);
      return {
        id: e.id,
        channel: 'character',
        tier: 'memory',
        baseScore: score,
        baseScoreNorm: norms[i],
        creditW: credit === undefined ? 1.0 : credit[e.id] ?? 1.0,
        sig: sigOf(e.affectAtEncoding),
        tags: e.emotions.map((x) => x.tag),
        source: 'memory',
        render: () => `[${e.turnId}] ${e.summary}`,
        ...(vec !== undefined ? { vec } : {}),
      };
    });
  },
});

/** Options for the procedural channel's nominator. */
export interface ProceduralNominatorOpts {
  creditPath?: string | undefined;
}

/** The procedural channel: situation-keyed, outcome-scored, capped by the assembler's quota. */
export const proceduralNominator = (store: ProceduralStore, opts: ProceduralNominatorOpts = {}): MemoryNominator => ({
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
    const credit = opts.creditPath !== undefined ? await loadCreditWeights(opts.creditPath) : undefined;
    const norms = rankNormalizeBase(ranked.map((r) => r.score));
    return ranked.map(({ p, score }, i) => {
      const vec = store.vecOf(p.id);
      return {
        id: p.id,
        channel: 'procedural',
        tier: 'procedure',
        baseScore: score,
        baseScoreNorm: norms[i],
        creditW: credit === undefined ? 1.0 : credit[p.id] ?? 1.0,
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

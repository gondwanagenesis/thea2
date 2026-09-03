// M07 — corpusNominator: the character channel's corpus-side nominator for
// M11's assembler (docs/modules/M07-corpus.md §Behavior). The M09 nominators
// (episodic, procedural) own the memory tiers; this owns the corpus tiers:
//
//   canon flagged `disposition: true` (any kind) -> 'disposition'  (ADR-006)
//   kind 'statement' + canon                     -> 'disposition'
//   kind 'scene' + canon/derived                 -> 'pattern'
//   any kind + lived                             -> 'episode'
//
// Ranking law (spec): baseScore = cos(vec, queryVec) × weight × gravity —
// the ADR-005 gravity multiplier the assembler's scoreOf expects to find
// already baked into baseScore (src/assemble/score.ts). The formula is
// mirrored here, not imported: the planned DAG (dependency-cruiser) gives
// corpus only kernel+embed, and assemble imports corpus — an import would
// cycle. A conformance test pins the two formulas equal (test/app/pipeline
// and test/corpus both rank the same fixture).
//
// Two more mirrored pieces, for the same DAG reason (canonical definitions in
// src/assemble/score.ts, conformance-pinned):
//   • rankNormalizeBase — the per-nominator, per-packet rank normalization to
//     (0,1]. Candidates ship the result as `baseScoreNorm` (raw `baseScore`
//     stays the credit-truth the PacketRecord reports); the assembler's
//     scoring law prefers it, which is what makes λ = 0.25 mean "a quarter of
//     the score range" across nominators whose raw scales are incomparable.
//   • loadCreditWeights — the M10 credit file reader (var/credit/weights.json,
//     written nightly by the consolidator). creditW stops being a constant:
//     absent id ⇒ 1.0, missing file ⇒ every id 1.0, malformed file ⇒ loud
//     typed error (a corrupted credit file must not look like neutral credit).
//
// recency is a proxy of 1.0 for every corpus source: canon is timeless by
// construction, and derived/lived carry no encoding timestamp in their
// frontmatter (lived recency is M10's to know).
//
// Determinism: no rng; ties break (score desc, id asc). `nominate` returns ALL
// ranked candidates — over-return is fine, the assembler's quotas and coherence
// scanners make the final cut. Nominator/Candidate are STRUCTURAL mirrors of
// M11's shapes (wide on purpose, per src/assemble/types.ts) — M20 injects this
// where M11 expects its Nominator, and TypeScript checks the fit.

import * as fsp from 'node:fs/promises';
import { KernelErrorImpl } from '../kernel/index.js';
import { cosineSimilarity } from '../embed/index.js';
import type { CorpusIndex } from './corpus-index.js';
import { renderExemplar } from './render.js';
import type { AffectDim, Dimension, Exemplar } from '../../schemas/exemplar.js';

/**
 * ADR-005 seed gravity, default 0.7 (M11's DEFAULT_ASSEMBLE_CONFIG.gravityG),
 * plus the credit seam: `creditPath` points at the nightly weights file
 * (conventionally `var/credit/weights.json` — the consolidator's own
 * `creditPath` dep). LEFT UNSET by default on purpose: the factories see no
 * injected var dir, and guessing the process cwd from library code would read
 * whatever `var/` happens to be current. Round 3 (composition) passes the
 * resolved path — the same value compose already computes for the
 * consolidator's deps. Missing file ⇒ neutral credit (all 1.0).
 */
export interface CorpusNominatorOpts {
  g?: number | undefined;
  creditPath?: string | undefined;
}

/** Structural mirror of M11's Candidate — the fields the assembler reads. */
export interface CorpusCandidate {
  id: string;
  channel: 'character';
  tier: 'disposition' | 'pattern' | 'episode';
  baseScore: number;
  /**
   * Per-nominator rank-normalized base, (0,1] — what the assembler's scoring
   * law adds to (before modulation and credit). Raw `baseScore` stays the
   * credit-truth. Canonical definition: src/assemble/score.ts rankNormalize.
   */
  baseScoreNorm?: number | undefined;
  creditW: number;
  sig: Partial<Record<AffectDim, number>>;
  vec?: Float32Array | undefined;
  tags: string[];
  source: 'canon' | 'derived' | 'lived';
  render(): string;
  dimension?: Dimension | undefined;
}

export interface CorpusNominatorShape {
  name: string;
  channel: 'character';
  nominate(q: { queryVec: Float32Array }, k: number): Promise<CorpusCandidate[]>;
}

// ---------------------------------------------------------------------------
// Credit weights — the M10 file, read (never written) here
// ---------------------------------------------------------------------------

/** Thrown for a weights file that exists but is not a weights file. Loud by design. */
export class CreditWeightsError extends KernelErrorImpl {
  constructor(message: string, cause?: unknown) {
    super('corpus/credit-weights', message, cause);
    this.name = 'CreditWeightsError';
  }
}

/**
 * The persisted shape the nightly consolidator writes
 * (src/consolidate/credit.ts `serializeWeightsFile`, canonical JSON):
 * `{ version: 1, lastSeq, decayDay, weights: { exemplarId: number } }`.
 * Values are the consolidator's clamp range [0.5, 2.0]; here they are only
 * required to be finite — range POLICY is M10's law, not the reader's.
 */
export interface CreditWeights {
  readonly [exemplarId: string]: number;
}

interface WeightsFileShape {
  version: 1;
  lastSeq: number;
  decayDay: number;
  weights: CreditWeights;
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

/** Strict parse of the persisted shape; any drift from it is a loud typed error. */
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
  return out as WeightsFileShape['weights'];
};

/**
 * Process-level cache: path → the mtime the map was read at. The nightly
 * consolidator rewrites the file in-place, so entries re-validate per call via
 * mtime — a long-running process picks up new weights on the next nomination
 * without a restart, and a quiet file costs one stat per nominator probe.
 */
const weightsCache = new Map<string, { mtimeMs: number; weights: CreditWeights }>();

/**
 * Read the credit weights at `path`. Missing file ⇒ {} (launch state — every
 * id reads as neutral 1.0); malformed file ⇒ CreditWeightsError (loud, per the
 * failure law — a corrupted credit file must never masquerade as neutral).
 */
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
 * mirrored for the DAG — a conformance test pins the two equal, value for
 * value, over seeded pools. Average rank for ties ÷ n; top of the pool is 1;
 * a single candidate is 1 (never NaN); an empty pool is empty.
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

const CORPUS_KINDS = new Set(['scene', 'statement']);

const tierFor = (e: Exemplar): CorpusCandidate['tier'] => {
  if (e.source === 'lived') return 'episode';
  // The keel: statements by kind, or anything Diego flagged `disposition: true`
  // (procedures never reach here — the procedural channel is M09's, ADR-009).
  if (e.kind === 'statement' || e.disposition === true) return 'disposition';
  return 'pattern';
};

/** ADR-005: gravity doubles the seed half, doubles the lived half — pattern/episode tiers only. */
export const corpusGravity = (tier: CorpusCandidate['tier'], source: Exemplar['source'], g: number): number => {
  if (tier !== 'pattern' && tier !== 'episode') return 1;
  return source === 'lived' ? 2 * (1 - g) : 2 * g;
};

export const corpusNominator = (
  idx: CorpusIndex,
  opts: CorpusNominatorOpts = {},
): CorpusNominatorShape => {
  const g = opts.g ?? 0.7;

  const nominate = async (q: { queryVec: Float32Array }, _k: number): Promise<CorpusCandidate[]> => {
    void _k; // over-return by design; k is the assembler's lever, not ours
    const credit =
      opts.creditPath !== undefined
        ? await loadCreditWeights(opts.creditPath) // loud on a malformed file; missing file is launch state
        : undefined;
    const ranked: Array<{ c: CorpusCandidate; score: number }> = [];
    for (const e of idx.all()) {
      if (!CORPUS_KINDS.has(e.kind)) continue;
      const tier = tierFor(e);
      const vec = idx.vectorOf(e.id);
      const cos = vec !== undefined && q.queryVec.length === vec.length
        ? cosineSimilarity(q.queryVec, vec)
        : 0; // vector-free index (or embedder mismatch): rank by weight/gravity alone
      const baseScore = cos * e.weight * corpusGravity(tier, e.source, g);
      ranked.push({
        score: baseScore,
        c: {
          id: e.id,
          channel: 'character',
          tier,
          baseScore,
          creditW: credit === undefined ? 1.0 : credit[e.id] ?? 1.0,
          sig: e.affect,
          vec,
          tags: e.register,
          source: e.source,
          dimension: e.dimensions[0],
          // The packet render: situation frame above the body (src/corpus/render.ts).
          render: () => renderExemplar(e),
        },
      });
    }
    ranked.sort((a, b) => b.score - a.score || (a.c.id < b.c.id ? -1 : a.c.id > b.c.id ? 1 : 0));
    // Per-nominator, per-packet rank normalization: this call IS one
    // nominator's view of one packet, so the ranking happens over the whole
    // returned pool, AFTER the raw ranking (order is preserved) and BEFORE the
    // assembler adds modulation and credit.
    const norms = rankNormalizeBase(ranked.map((r) => r.score));
    return ranked.map((r, i) => ({ ...r.c, baseScoreNorm: norms[i] }));
  };

  return { name: 'corpus', channel: 'character', nominate };
};

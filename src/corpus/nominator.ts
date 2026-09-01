// M07 — corpusNominator: the character channel's corpus-side nominator for
// M11's assembler (docs/modules/M07-corpus.md §Behavior). The M09 nominators
// (episodic, procedural) own the memory tiers; this owns the corpus tiers:
//
//   kind 'statement' + canon     -> 'disposition'  (canon-only slot, ADR-006)
//   kind 'scene' + canon/derived -> 'pattern'
//   any kind + lived             -> 'episode'
//
// Ranking law (spec): baseScore = cos(vec, queryVec) × weight × gravity —
// the ADR-005 gravity multiplier the assembler's scoreOf expects to find
// already baked into baseScore (src/assemble/score.ts). The formula is
// mirrored here, not imported: the planned DAG (dependency-cruiser) gives
// corpus only kernel+embed, and assemble imports corpus — an import would
// cycle. A conformance test pins the two formulas equal (test/app/pipeline
// and test/corpus both rank the same fixture).
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

import { cosineSimilarity } from '../embed/index.js';
import type { CorpusIndex } from './corpus-index.js';
import type { AffectDim, Dimension, Exemplar } from '../../schemas/exemplar.js';

/** ADR-005 seed gravity, default 0.7 (M11's DEFAULT_ASSEMBLE_CONFIG.gravityG). */
export interface CorpusNominatorOpts {
  g?: number | undefined;
}

/** Structural mirror of M11's Candidate — the fields the assembler reads. */
export interface CorpusCandidate {
  id: string;
  channel: 'character';
  tier: 'disposition' | 'pattern' | 'episode';
  baseScore: number;
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

const CORPUS_KINDS = new Set(['scene', 'statement']);

const tierFor = (e: Exemplar): CorpusCandidate['tier'] => {
  if (e.source === 'lived') return 'episode';
  if (e.kind === 'statement') return 'disposition';
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
          creditW: 1.0, // the assembler's unknown-credit default; credit is M10's to know
          sig: e.affect,
          vec,
          tags: e.register,
          source: e.source,
          dimension: e.dimensions[0],
          render: () => e.body,
        },
      });
    }
    ranked.sort((a, b) => b.score - a.score || (a.c.id < b.c.id ? -1 : a.c.id > b.c.id ? 1 : 0));
    return ranked.map((r) => r.c);
  };

  return { name: 'corpus', channel: 'character', nominate };
};

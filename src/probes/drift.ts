// M19 probes — evaluator class 3: drift.
//
// Character drift as a number: embed the run's replies, cosine them against a
// centroid built from the dimension's canon voice exemplars (or the probe's
// pinned `centroidFrom` ids). Embedding is the injected M04 seam, so the whole
// metric is hermetic under HashEmbedder/FixedEmbedder and exact under the real
// one — same interface, same math.

import type { DriftRef } from '../../schemas/probe.js';
import type { CorpusIndex } from '../corpus/corpus-index.js';
import { cosineSimilarity, l2Normalize, type Embedder } from '../embed/index.js';
import { ProbeError } from './errors.js';
import { median } from './math.js';

/** The slice of a run the drift evaluator needs (RunOutcome satisfies this). */
export interface DriftRun {
  outbound: readonly string[];
  driftCosine: number | null;
}

/** Centroid of unit vectors: mean then re-normalize (a mean of unit vectors is not unit). */
export const centroidOf = (vectors: readonly Float32Array[]): Float32Array => {
  if (vectors.length === 0) {
    throw new ProbeError('probes/centroid-empty', 'cannot centroid an empty vector set');
  }
  const dim = vectors[0]!.length;
  const acc = new Float64Array(dim);
  for (const v of vectors) {
    if (v.length !== dim) {
      throw new ProbeError('probes/centroid-empty', `centroid vectors disagree in width (${v.length} vs ${dim})`);
    }
    for (let i = 0; i < dim; i++) acc[i] = (acc[i] ?? 0) + (v[i] ?? 0);
  }
  return l2Normalize(Float32Array.from(acc));
};

/**
 * The reference centroid for a driftRef: the pinned ids' body embeddings, or —
 * unpinned — every canon exemplar of the dimension. Index-cached vectors are
 * used when present; anything missing is embedded in one order-preserving batch.
 */
export const referenceCentroid = async (
  drift: DriftRef,
  deps: { corpus: CorpusIndex; embedder: Embedder },
): Promise<{ centroid: Float32Array; ids: string[] }> => {
  const exemplars =
    drift.centroidFrom !== undefined
      ? drift.centroidFrom.map((id) => {
          const e = deps.corpus.byId(id);
          if (e === undefined) {
            throw new ProbeError('probes/reference-unresolved', `drift centroid id '${id}' is not in the corpus index`, {
              field: 'expect.driftRef.centroidFrom',
            });
          }
          return e;
        })
      : deps.corpus.byDimension(drift.dimension).filter((e) => e.source === 'canon');

  const ids = exemplars.map((e) => e.id);
  if (ids.length === 0) {
    throw new ProbeError(
      'probes/centroid-empty',
      `drift dimension '${drift.dimension}' has no reference exemplars to build a centroid from`,
      { field: 'expect.driftRef.dimension' },
    );
  }

  const cached = ids.map((id) => deps.corpus.vectorOf(id));
  const missing = exemplars.filter((_, i) => cached[i] === undefined);
  const fresh = missing.length > 0 ? await deps.embedder.embed(missing.map((e) => e.body)) : [];
  const vectors = ids.map((id, i) => {
    const hit = cached[i];
    if (hit !== undefined) return hit;
    const vec = fresh.shift();
    if (vec === undefined || vec.length !== deps.embedder.dim) {
      throw new ProbeError('probes/centroid-empty', `embedding for '${id}' is missing or wrong-width — embedder '${deps.embedder.id}'`);
    }
    return vec;
  });
  return { centroid: centroidOf(vectors), ids };
};

/** Centroid embedding of one run's reply bubbles. Empty outbound ⇒ zero vector, which
 * M04's cosine defines as similarity 0 — "no direction to compare", never a perfect match. */
export const replyCentroid = async (outbound: readonly string[], embedder: Embedder): Promise<Float32Array> => {
  if (outbound.length === 0) return new Float32Array(embedder.dim);
  return centroidOf(await embedder.embed([...outbound]));
};

/**
 * Per-run drift cosines for a probe, aggregated by median (the model is the only
 * nondeterministic input, and the replies differ per run).
 */
export const runDrift = async (
  drift: DriftRef,
  runs: readonly DriftRun[],
  deps: { corpus: CorpusIndex; embedder: Embedder },
): Promise<{ cosines: number[]; driftCosine: number; centroidIds: string[] }> => {
  const { centroid, ids } = await referenceCentroid(drift, deps);
  const cosines: number[] = [];
  for (const run of runs) {
    const reply = await replyCentroid(run.outbound, deps.embedder);
    const cosine = cosineSimilarity(reply, centroid);
    cosines.push(cosine);
    run.driftCosine = cosine;
  }
  return { cosines, driftCosine: median(cosines) ?? 0, centroidIds: ids };
};

// v8 mind — SENSE: encode the moment once. The situation vector covers the last
// few lines plus his message (the same text shape the importer used for every
// imported moment, so the spaces match); the social move and his tone are read
// by nearest centroid over that vector — no model call at runtime.

import type { Embedder } from '../embed/index.js';
import type { Centroids } from './store.js';
import type { Line } from './types.js';

/** The text a situation vector is made from. Shared with the importer — change both or neither. */
export const situationText = (before: readonly Line[], his: string): string =>
  [...before.slice(-2).map((l) => `${l.who === 'him' ? 'him' : 'her'}: ${l.text}`), `him: ${his}`].join('\n').slice(0, 2000);

/** The text a reply vector is made from. Shared with the importer. */
export const replyText = (hers: readonly string[]): string => hers.join('\n').slice(0, 2000);

export interface Label {
  label: string;
  score: number;
}

const dot = (a: ArrayLike<number>, b: ArrayLike<number>): number => {
  let d = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    d += (a[i] ?? 0) * (b[i] ?? 0);
    na += (a[i] ?? 0) ** 2;
    nb += (b[i] ?? 0) ** 2;
  }
  return na === 0 || nb === 0 ? 0 : d / Math.sqrt(na * nb);
};

/** Nearest centroid label, or undefined below the floor (an unknown move is honest). */
export const nearestLabel = (vec: Float32Array, table: Record<string, number[]>, floor = 0.25): Label | undefined => {
  let best: Label | undefined;
  for (const [label, c] of Object.entries(table)) {
    const s = dot(vec, c);
    if (best === undefined || s > best.score) best = { label, score: s };
  }
  return best !== undefined && best.score >= floor ? best : undefined;
};

export interface Sensed {
  situationVec: Float32Array;
  /** His words alone — tone, surprise and concern-touch read this, not the context. */
  hisVec: Float32Array;
  /** Vectors for any extra texts (e.g. her last expectation), in order. */
  extra: Float32Array[];
  move?: Label | undefined;
  tone?: Label | undefined;
}

export const sense = async (
  before: readonly Line[],
  his: string,
  deps: { embedder: Embedder; centroids: Centroids },
  extraTexts: readonly string[] = [],
): Promise<Sensed> => {
  // One batched call: the situation (context + his words), his words alone, and any extras.
  const vecs = await deps.embedder.embed([
    situationText(before, his),
    (his.trim() === '' ? '(silence)' : his).slice(0, 1000),
    ...extraTexts.map((t) => t.slice(0, 1000)),
  ]);
  const situationVec = vecs[0] ?? new Float32Array(deps.embedder.dim);
  const hisVec = vecs[1] ?? situationVec;
  return {
    situationVec,
    hisVec,
    extra: vecs.slice(2),
    move: nearestLabel(situationVec, deps.centroids.move),
    tone: his.trim() === '' ? undefined : nearestLabel(hisVec, deps.centroids.tone),
  };
};

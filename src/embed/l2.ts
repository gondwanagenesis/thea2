// M04 embed — the vector math every embedder and the index share.
//
// Cross-platform bit-stability rests on two facts: JS arithmetic operators are
// correctly rounded IEEE-754 doubles by spec, and Math.sqrt is hardware-exact on
// every real engine. So the rules here are: accumulate in a fixed order, never
// use Math.hypot (implementation-approximated), never reorder the loop.

import { fail } from '../kernel/result.js';

/**
 * L2-normalize into a fresh Float32Array. A zero vector stays exactly zero —
 * normalizing it would produce NaN, and a NaN score would poison every ranking.
 */
export const l2Normalize = (v: Float32Array | Float64Array): Float32Array => {
  let sumSq = 0;
  for (let i = 0; i < v.length; i++) {
    const x = v[i]!;
    sumSq += x * x;
  }
  const norm = Math.sqrt(sumSq);
  const out = new Float32Array(v.length);
  if (norm === 0) return out;
  for (let i = 0; i < v.length; i++) out[i] = v[i]! / norm;
  return out;
};

/**
 * Cosine similarity in [-1, 1]. If either vector has zero magnitude the
 * similarity is defined as 0 (no direction to compare) rather than NaN.
 */
export const cosineSimilarity = (a: Float32Array, b: Float32Array): number => {
  if (a.length !== b.length) {
    fail('embed/dim-mismatch', `cosineSimilarity: ${a.length}-d vector vs ${b.length}-d vector`);
  }
  let dot = 0;
  let an = 0;
  let bn = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    an += x * x;
    bn += y * y;
  }
  if (an === 0 || bn === 0) return 0;
  return dot / (Math.sqrt(an) * Math.sqrt(bn));
};

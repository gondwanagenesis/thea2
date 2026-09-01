// M04 embed — HashEmbedder: the deterministic similarity-preserving double.
//
// Feature-hashes unigrams AND bigrams into `dim` buckets (two independent hash
// functions per feature: one for the bucket index, one for the ± sign) and
// L2-normalizes. Deterministic, dependency-free, no network — and still
// *similarity-preserving*, because texts sharing tokens accumulate in the same
// buckets, so planted-fact recall (M09) and coherence sanity (M11) can assert
// real ranking behavior offline instead of merely stable behavior.
//
// Stability argument: the only inputs are the token strings (lowercased, fixed
// split), sha256 (kernel contentHash — bit-stable everywhere), and IEEE-754
// arithmetic in a fixed order. Same text ⇒ same vector bits, any process, any
// platform.

import { contentHash, fail } from '../kernel/index.js';
import type { Embedder } from './types.js';
import { l2Normalize } from './l2.js';

/** Spec tokenization: lowercase, split on \W+. Deliberately verbatim — note that
 * \w is ASCII-only, so accented letters act as separators ("señora" → se + ora).
 * If Spanish ever needs real token coverage that is a spec change, not a local fix. */
const TOKEN_SPLIT = /\W+/u;

/** contentHash prefixes 'sha256:' (7 chars) before 64 hex chars. */
const DIGEST_HEX = 7;

/** The two hash functions per feature, derived from disjoint 32-bit words of one
 * sha256 digest: words[0] picks the bucket, words[1] picks the ± sign. */
const featureSlot = (feature: string, dim: number): { bucket: number; sign: number } => {
  const digest = contentHash(feature);
  const bucket = Number.parseInt(digest.slice(DIGEST_HEX, DIGEST_HEX + 8), 16) % dim;
  const sign = Number.parseInt(digest.slice(DIGEST_HEX + 8, DIGEST_HEX + 16), 16) % 2 === 0 ? 1 : -1;
  return { bucket, sign };
};

const featuresOf = (text: string): string[] => {
  const tokens = text.toLowerCase().split(TOKEN_SPLIT).filter((t) => t.length > 0);
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    out.push(tokens[i]!);
    if (i + 1 < tokens.length) out.push(`${tokens[i]!} ${tokens[i + 1]!}`);
  }
  return out;
};

const hashEmbedOne = (dim: number, text: string): Float32Array => {
  // Float64 accumulation: many ±1 features may land in one bucket, and summing
  // in f32 would make the result depend on bucket order. It doesn't.
  const acc = new Float64Array(dim);
  for (const feature of featuresOf(text)) {
    const { bucket, sign } = featureSlot(feature, dim);
    acc[bucket] = (acc[bucket] ?? 0) + sign;
  }
  return l2Normalize(acc);
};

/** Deterministic test double and offline default. `dim` defaults to 384. */
export const makeHashEmbedder = (dim: number = 384): Embedder => {
  if (!Number.isInteger(dim) || dim <= 0) {
    fail('embed/config', `HashEmbedder dim must be a positive integer, got ${dim}`);
  }
  return {
    id: `hash:${dim}`,
    dim,
    embed: async (texts: string[]): Promise<Float32Array[]> => texts.map((t) => hashEmbedOne(dim, t)),
  };
};

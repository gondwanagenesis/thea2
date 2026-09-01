// M04 embed — FixedEmbedder: the geometry double.
//
// An explicit string→vector map for handcrafted geometry in coherence/coupling
// tests: put "love" near "lust" and far from "invoice", then assert the ranker
// sees exactly that. Unknown strings throw — it is a fixture, not a fallback;
// silently returning an unrelated vector for a typo'd key would forge geometry.

import { canonicalJson, contentHash, fail } from '../kernel/index.js';
import type { Embedder } from './types.js';
import { l2Normalize } from './l2.js';

export const makeFixedEmbedder = (map: Record<string, number[]>): Embedder => {
  // Validate the whole map once at construction. A malformed fixture is a bug in
  // the fixture; loud at build-the-double time beats mysterious NaN downstream.
  let width = -1;
  for (const [key, vec] of Object.entries(map)) {
    if (!Array.isArray(vec) || vec.length === 0) {
      fail('embed/config', `FixedEmbedder['${key}'] must be a non-empty number[]`);
    }
    if (width === -1) width = vec.length;
    else if (vec.length !== width) {
      fail('embed/config', `FixedEmbedder map is ragged: '${key}' is ${vec.length}-d, expected ${width}-d`);
    }
    for (let i = 0; i < vec.length; i++) {
      if (!Number.isFinite(vec[i]!)) {
        fail('embed/config', `FixedEmbedder['${key}'][${i}] is not a finite number`);
      }
    }
  }
  if (width === -1) fail('embed/config', 'FixedEmbedder map is empty');

  const normalized = new Map<string, Float32Array>();
  for (const [key, vec] of Object.entries(map)) normalized.set(key, l2Normalize(Float32Array.from(vec)));

  // Identity from content: two different geometry maps are two different
  // embedders as far as index metadata and load()-refusal are concerned.
  const id = `fixed:${contentHash(canonicalJson(map))}`;

  return {
    id,
    dim: width,
    embed: async (texts: string[]): Promise<Float32Array[]> =>
      texts.map((t): Float32Array => {
        const v = normalized.get(t);
        // `return fail(...)` — the throw must also narrow v out of `undefined`.
        if (v === undefined) return fail('embed/fixed-unknown', `FixedEmbedder has no fixture vector for '${t}'`);
        // Fresh copy per read: callers mutating a result must not corrupt the fixture.
        return Float32Array.from(v);
      }),
  };
};

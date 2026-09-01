// M08 derive — code shared by the four v1 generators: fan-out selection over
// the canon index and the single model-call shape every generator makes.

import type { Exemplar } from '../../../schemas/exemplar.js';
import type { ChatRequest } from '../../model/index.js';
import type { DerivedTarget, DeriveInputs, GenerateDeps } from '../types.js';
import { MAX_VARIANTS_PER_SCENE } from '../types.js';
import { canonSourceHash, templateHashOf, deriveKeyOf, sortedInputHashes } from '../keys.js';
import { stripOuterFence } from '../file.js';
import { compareStrings } from '../../corpus/types.js';

export const byId = (a: Exemplar, b: Exemplar): number => compareStrings(a.id, b.id);

/** Deterministic canon selection: id-sorted, so directory order never leaks in. */
export const sortedCanon = (inputs: DeriveInputs): Exemplar[] => [...inputs.canon].sort(byId);

/** One target, with its deriveKey built exactly as enumerateTargets re-checks it. */
export const makeTarget = (
  generator: { name: string; version: string },
  template: string,
  inputs: DerivedTarget['inputs'],
  bucket?: string | undefined,
): DerivedTarget => ({
  deriveKey: deriveKeyOf(
    generator.name,
    generator.version,
    sortedInputHashes(inputs),
    templateHashOf(template),
  ),
  templateHash: templateHashOf(template),
  inputs,
  ...(bucket !== undefined ? { bucket } : {}),
});

/** Canonical inputs for a single-source target. */
export const singleSource = (source: Exemplar): DerivedTarget['inputs'] => ({
  canonIds: [{ id: source.id, sha256: canonSourceHash(source) }],
});

/**
 * Per-scene bucket fan-out: at most one variant per bucket, at most
 * MAX_VARIANTS_PER_SCENE per scene, buckets in the order the caller listed
 * them. Duplicate buckets in the input collapse (uniqueness is per scene).
 */
export const bucketsFor = (inputs: DeriveInputs): string[] => {
  const out: string[] = [];
  for (const b of inputs.moodBuckets) {
    if (!out.includes(b)) out.push(b);
  }
  return out.slice(0, MAX_VARIANTS_PER_SCENE);
};

export interface DraftRequest {
  /** The generator's pinned prompt template + scene material. */
  system: string;
  user: string;
}

/**
 * The one model call every generator makes, and the one normalization applied
 * to its answer: a leading/trailing code fence is stripped (the body grammar
 * has no prose lines), nothing else is repaired — a draft that still cannot
 * parse is a failed generation.
 */
export const generateDraft = async (
  req: DraftRequest,
  deps: GenerateDeps,
): Promise<{ body: string; model: string }> => {
  const chatReq: ChatRequest = {
    taskClass: 'derive',
    tier: 'main',
    messages: [
      { role: 'system', content: req.system },
      { role: 'user', content: req.user },
    ],
    maxTokens: 900,
    temperature: 0.9,
  };
  const res = await deps.model.chat(chatReq);
  return { body: stripOuterFence(res.content), model: res.model };
};

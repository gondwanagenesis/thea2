// M08 derive — the identity layer. Everything the pipeline reloads, dirties or
// deletes is decided by these hashes, so they are pure, deterministic and
// golden-pinned in test/derive/keys.test.ts.
//
// Two hash families live here and must never be confused:
//   * SOURCE hashes — what the target was derived FROM (canon exemplars, tool
//     defs, the mood bucket). They go into the deriveKey.
//   * OUTPUT hashes — the generated file's content id. They go into the
//     manifest entry id and must equal the file on disk.

import { canonicalJson, contentHash } from '../kernel/index.js';
import type { Exemplar } from '../../schemas/exemplar.js';
import type { ToolDef } from '../model/index.js';
import { compareStrings } from '../corpus/types.js';
import type { TargetInputs } from './types.js';

// ---------------------------------------------------------------------------
// Source hashes
// ---------------------------------------------------------------------------

/**
 * Hash of one canon source. M08 sees canon through M07's parsed index, not raw
 * files, so the hash is over the canonical form of the parsed exemplar: any
 * edit that changes meaning (body, register, affect, the judge-read `notes`)
 * changes it, while whitespace-only churn does not.
 */
export const canonSourceHash = (e: Exemplar): string => contentHash(canonicalJson(e));

/** Hash of one ToolDef — the procedural generator's per-(tool × scene) input. */
export const toolDefHash = (t: ToolDef): string => contentHash(canonicalJson(t));

/**
 * The sorted input-hash set a target's deriveKey is computed over: canon source
 * hashes, the bucket hash when there is one, and the tool hash when there is
 * one. Sorting is what makes the key independent of the order inputs were
 * listed in — pin this in the goldens.
 */
export const sortedInputHashes = (inputs: {
  canonIds: Array<{ sha256: string }>;
  toolDefsHash?: string | undefined;
}): string[] => {
  const hashes = inputs.canonIds.map((c) => c.sha256);
  if (inputs.toolDefsHash !== undefined) hashes.push(inputs.toolDefsHash);
  return hashes.sort(compareStrings);
};

/**
 * deriveKey = sha256(generator + generatorVersion + sortedInputHashes +
 * templateHash). The concatenation is canonical JSON of the parts rather than
 * string `+`: plain concatenation is ambiguous (generator "a" + version "b|c"
 * collides with generator "a|b" + version "c"), and a key collision would make
 * two different targets look like one and silently skip generation.
 */
export const deriveKeyOf = (
  generator: string,
  generatorVersion: string,
  inputHashes: readonly string[],
  templateHash: string,
): string => contentHash(canonicalJson([generator, generatorVersion, [...inputHashes].sort(compareStrings), templateHash]));

/** Convenience wrapper: the key of a target, rebuilt from its declared parts. */
export const targetDeriveKey = (
  generator: { name: string; version: string },
  target: { templateHash: string; inputs: TargetInputs },
): string => deriveKeyOf(generator.name, generator.version, sortedInputHashes(target.inputs), target.templateHash);

/** Template/prompt hash: the other half of the key. */
export const templateHashOf = (template: string): string => contentHash(template);

// ---------------------------------------------------------------------------
// Output hashes (content addressing of the generated file)
// ---------------------------------------------------------------------------

// The masked-hash convention lives in corpus (derived-id.ts) — M07's parser
// must agree byte-for-byte with writers on what a derived id IS, and corpus is
// the lower module. Re-exported here so the derive module's internal callers
// and tests keep one import site.
export { DERIVED_ID_PLACEHOLDER, derivedFileId, hashableText, withFileId } from '../corpus/derived-id.js';

/**
 * Disk name for a content id. The `sha256:` prefix is stripped: ':' is an
 * alternate-data-stream separator on Windows and would silently split the name.
 */
export const fileBaseName = (id: string): string => id.replace(/^sha256:/, '');

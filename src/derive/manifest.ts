// M08 derive — the manifest at corpus/derived/manifest.json. Committed, strict:
// a manifest that does not match the schema is not a manifest, and quietly
// accepting one would make dirty/orphan computation lie about the corpus.

import { z } from 'zod';
import { JudgeStamp } from '../../schemas/exemplar.js';
import { canonicalJson } from '../kernel/index.js';
import { compareStrings } from '../corpus/types.js';
import { DeriveError } from './errors.js';
import type { Manifest, ManifestEntry } from './types.js';

const SHA256_RE = /^sha256:[0-9a-f]{64}$/;

const TargetInputsSchema = z.strictObject({
  canonIds: z
    .array(z.object({ id: z.string().min(1), sha256: z.string().regex(/^sha256:/) }))
    .min(1),
  toolDefsHash: z.string().regex(/^sha256:/).optional(),
});

const ManifestEntrySchema = z.strictObject({
  id: z.string().regex(SHA256_RE),
  deriveKey: z.string().regex(SHA256_RE),
  generator: z.string().min(1),
  generatorVersion: z.string().min(1),
  inputs: TargetInputsSchema,
  model: z.string().min(1),
  createdAt: z.number().int().nonnegative(),
  judge: JudgeStamp,
});

const ManifestSchema = z.strictObject({
  version: z.literal(1),
  embedderId: z.string().min(1),
  entries: z.array(ManifestEntrySchema),
});

/** Parse `raw` strictly: unknown keys, wrong version and bad hashes all reject. */
export const loadManifest = (raw: string): Manifest => {
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch (e) {
    throw new DeriveError('derive/manifest-schema', `manifest is not valid JSON: ${(e as Error).message}`);
  }
  const result = ManifestSchema.safeParse(doc);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue !== undefined ? issue.path.map(String).join('.') : '';
    throw new DeriveError(
      'derive/manifest-schema',
      `manifest rejected by schema at '${path}': ${issue?.message ?? 'no detail'}`,
    );
  }
  return result.data as Manifest;
};

/** The manifest a first-ever derive run starts from. */
export const emptyManifest = (embedderId: string): Manifest => ({ version: 1, embedderId, entries: [] });

/** Serializes exactly as atomicWriteJson will (canonical JSON, sorted keys). */
export const serializeManifest = (manifest: Manifest): string => canonicalJson(manifest);

/** Entry order is decided once: by deriveKey, then id. Manifest diffs stay reviewable. */
export const sortEntries = (entries: ManifestEntry[]): ManifestEntry[] =>
  [...entries].sort(
    (a, b) => compareStrings(a.deriveKey, b.deriveKey) || compareStrings(a.id, b.id),
  );

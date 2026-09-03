// M10 consolidate — the consolidation manifest, one per output directory
// (var/lived/manifest.json, var/proposals/manifest.json since round 2 moved the
// consolidators' outputs under var/), mirroring M08's committed-manifest
// discipline.
//
// The manifest is the module's idempotence memory: its key is the CONSOLIDATION
// KEY (consolidator × version × sorted episode ids), not the file content hash,
// so a replay of an already-consolidated episode set is a no-op BEFORE any
// model call happens. The same key is written into each draft's `notes`, which
// is what makes a corrupt manifest recoverable from the files it attests — the
// recovery path weights have in L0, expressed in the corpus itself.

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import { canonicalJson } from '../kernel/index.js';
import { analyzeFile } from '../corpus/parse.js';
import { compareStrings } from '../corpus/types.js';
import { ConsolidateError } from './errors.js';
import { fileBaseName } from './draft.js';

export const MANIFEST_NAME = 'manifest.json';
export const manifestPath = (dir: string): string => path.join(dir, MANIFEST_NAME);

export type Destination = 'lived' | 'proposal';

export interface ManifestEntry {
  /** consolidationKey — see cluster.ts. The dedupe key, stable across runs. */
  key: string;
  consolidator: string;
  consolidatorVersion: string;
  episodeIds: string[];
  destination: Destination;
  /** Content id (masked hash) of the file this entry attests. */
  id: string;
  /** epochMs from the injected clock. 0 on a rebuild (the file does not say). */
  createdAt: number;
}

const EntrySchema = z.strictObject({
  key: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  consolidator: z.string().min(1),
  consolidatorVersion: z.string().min(1),
  episodeIds: z.array(z.string().min(1)).min(1),
  destination: z.enum(['lived', 'proposal']),
  id: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  createdAt: z.number().int().nonnegative(),
});

const ManifestSchema = z.strictObject({ version: z.literal(1), entries: z.array(EntrySchema) });

export interface ConsolidateManifest {
  version: 1;
  entries: ManifestEntry[];
}

export const emptyConsolidateManifest = (): ConsolidateManifest => ({ version: 1, entries: [] });

/** Strict parse: a manifest that does not match is not a manifest. */
export const loadConsolidateManifest = (raw: string): ConsolidateManifest => {
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch (e) {
    throw new ConsolidateError('consolidate/state-schema', `manifest is not valid JSON: ${(e as Error).message}`);
  }
  const result = ManifestSchema.safeParse(doc);
  if (!result.success) {
    const issue = result.error.issues[0];
    const at = issue !== undefined ? issue.path.map(String).join('.') : '';
    throw new ConsolidateError(
      'consolidate/state-schema',
      `manifest rejected by schema at '${at}': ${issue?.message ?? 'no detail'}`,
    );
  }
  return result.data as ConsolidateManifest;
};

/** Serializes exactly as atomicWriteJson will. */
export const serializeConsolidateManifest = (m: ConsolidateManifest): string => canonicalJson(m);

/** Entry order is decided once (by key): manifest diffs stay reviewable. */
export const sortEntries = (entries: ManifestEntry[]): ManifestEntry[] =>
  [...entries].sort((a, b) => compareStrings(a.key, b.key) || compareStrings(a.id, b.id));

// ---------------------------------------------------------------------------
// The notes key — the manifest's shadow, written into every file
// ---------------------------------------------------------------------------

/**
 * The `notes` line every consolidated file carries. For proposals it also
 * carries the draft marker: proposals are clearly marked, never auto-promoted,
 * and canon's own lint rejects lived stamps — so even a careless copy into
 * canon/ cannot land unreviewed.
 */
export const notesFor = (
  consolidator: { name: string; version: string },
  key: string,
  proposalReason?: string | undefined,
): string => {
  const tail = `consolidated by ${consolidator.name}@${consolidator.version} (key ${key})`;
  return proposalReason === undefined ? tail : `PROPOSAL draft - human merge required (${proposalReason}). ${tail}`;
};

const NOTES_KEY_RE =
  /consolidated by ([a-z0-9-]+)@([0-9A-Za-z.-]+) \(key (sha256:[0-9a-f]{64})\)/;

export interface RecoveredKey {
  consolidator: string;
  version: string;
  key: string;
}

/** Pulls the consolidation key back out of a file's notes (undefined if absent). */
export const keyFromNotes = (notes: string | undefined): RecoveredKey | undefined => {
  if (notes === undefined) return undefined;
  const m = NOTES_KEY_RE.exec(notes);
  if (m === null) return undefined;
  return { consolidator: m[1] ?? '', version: m[2] ?? '', key: m[3] ?? '' };
};

// ---------------------------------------------------------------------------
// Rebuild — the corrupt-manifest recovery path
// ---------------------------------------------------------------------------

export interface RebuildResult {
  manifest: ConsolidateManifest;
  /** Files with no recoverable key: counted, left alone, never re-consolidated silently. */
  unrecoverable: string[];
}

/**
 * Rebuilds a directory's manifest from the files themselves. Entries come back
 * with createdAt 0 (the files do not say when) — which is honest: a rebuilt
 * manifest attests existence, not history.
 */
export const rebuildManifest = async (dir: string, destination: Destination): Promise<RebuildResult> => {
  const entries: ManifestEntry[] = [];
  const unrecoverable: string[] = [];
  if (!fs.existsSync(dir)) return { manifest: emptyConsolidateManifest(), unrecoverable };
  for (const name of fs.readdirSync(dir).sort(compareStrings)) {
    if (!name.endsWith('.md') || name.startsWith('.')) continue;
    const full = path.join(dir, name);
    const analysis = analyzeFile({ path: full.replaceAll('\\', '/'), raw: await fsp.readFile(full, 'utf8') }, 'lived');
    if (analysis.exemplar === undefined) {
      unrecoverable.push(name);
      continue;
    }
    const recovered = keyFromNotes(analysis.exemplar.notes);
    if (recovered === undefined) {
      unrecoverable.push(name);
      continue;
    }
    entries.push({
      key: recovered.key,
      consolidator: recovered.consolidator,
      consolidatorVersion: recovered.version,
      // Lived stamps are mandatory at parse, so episodeIds is present; the
      // fallback only satisfies the optional property type.
      episodeIds: [...(analysis.exemplar.episodeIds ?? [])],
      destination,
      id: analysis.exemplar.id,
      createdAt: 0,
    });
  }
  return { manifest: { version: 1, entries: sortEntries(entries) }, unrecoverable };
};

/** Disk name for an output file: lived files are named by their content id,
 * proposals by their consolidation key (stable, human-greppable). */
export const outputFileName = (destination: Destination, id: string, key: string): string =>
  `${fileBaseName(destination === 'lived' ? id : key)}.md`;

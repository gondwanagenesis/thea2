// M07 corpus — the in-memory CorpusIndex.
//
// Two entry points:
//   buildIndex(files)      pure, synchronous, no embedder — tests and callers
//                          that already hold parsed exemplars/vectors.
//   openCorpusIndex(roots) scans the three population dirs, embeds bodies via
//                          the injected M04 embedder (batched), caches vectors
//                          on disk keyed by contentHash(body) + embedderId, and
//                          hands back a reload() handle for the dev loop.
//
// Determinism law: every accessor returns id-sorted arrays; the index never
// relies on directory order. No rng anywhere — the nominator's determinism is
// inherited from this stability.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { atomicWriteJson, contentHash } from '../kernel/index.js';
import type { Dimension, Exemplar, ExemplarKind } from '../../schemas/exemplar.js';
import { CorpusError } from './errors.js';
import type { Embedder } from './embedder.js';
import { isPopulationFile, lintCorpus } from './lint.js';
import { analyzeFile } from './parse.js';
import type { CorpusControls } from './controls.js';
import { compareStrings, type CorpusFile, type LintIssue, type SourceKind } from './types.js';

export interface CorpusIndex {
  byId(id: string): Exemplar | undefined;
  byDimension(d: Dimension): Exemplar[];
  byRegister(tag: string): Exemplar[];
  byKind(kind: ExemplarKind): Exemplar[];
  bySource(source: SourceKind): Exemplar[];
  /** Every exemplar, id-sorted. */
  all(): Exemplar[];
  /** Distinct register tags in the corpus, sorted. */
  tags(): string[];
  /** Distinct dimensions in the corpus, sorted. */
  dimensions(): Dimension[];
  /** Body embedding for an exemplar, when the index was built with one. */
  vectorOf(id: string): Float32Array | undefined;
  /** Which embedder produced the vectors — 'none' for a vector-free index. */
  embedderId(): string;
  size(): number;
}

export type VectorMap = ReadonlyMap<string, Float32Array>;

export interface BuildIndexOptions {
  /** Precomputed body vectors keyed by exemplar id. */
  vectors?: VectorMap;
  /** Identity of whatever produced `vectors` (defaults 'none'). */
  embedderId?: string;
}

const EMPTY_VECTORS: VectorMap = new Map();

/**
 * Pure index build over parsed corpus files. Throws a single aggregated
 * CorpusError naming every file that failed — an index over an invalid corpus
 * would be a silent lie.
 */
export const buildIndex = (files: CorpusFile[], opts?: BuildIndexOptions): CorpusIndex => {
  const exemplars: Exemplar[] = [];
  const failures: string[] = [];

  for (const file of files) {
    if (!isPopulationFile(file.path)) continue;
    const source = sourceForPathOf(file.path);
    if (source === undefined) continue;
    const analysis = analyzeFile(file, source);
    if (analysis.exemplar === undefined) {
      for (const issue of analysis.issues.filter((i) => i.severity === 'error')) {
        failures.push(`${file.path}: ${issue.code} — ${issue.message}`);
      }
      continue;
    }
    exemplars.push(analysis.exemplar);
  }

  if (failures.length > 0) {
    throw new CorpusError('corpus/schema', `corpus failed to parse (${failures.length} file(s)):\n  ${failures.join('\n  ')}`);
  }

  return assembleIndex(exemplars, opts?.vectors ?? EMPTY_VECTORS, opts?.embedderId ?? 'none');
};

const sourceForPathOf = (filePath: string): SourceKind | undefined => {
  const parts = filePath.replaceAll('\\', '/').split('/');
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i];
    if (part === 'canon' || part === 'derived' || part === 'lived') return part;
  }
  return undefined;
};

const byIdAsc = (a: Exemplar, b: Exemplar): number => compareStrings(a.id, b.id);

/** Groups exemplars into an index. The single place array ordering is decided. */
const assembleIndex = (exemplars: Exemplar[], vectors: VectorMap, embedderId: string): CorpusIndex => {
  const sorted = [...exemplars].sort(byIdAsc);
  const idMap = new Map(sorted.map((e) => [e.id, e] as const));

  const group = <K>(keyOf: (e: Exemplar) => K): Map<K, Exemplar[]> => {
    const map = new Map<K, Exemplar[]>();
    for (const e of sorted) {
      const key = keyOf(e);
      const bucket = map.get(key);
      if (bucket === undefined) map.set(key, [e]);
      else bucket.push(e);
    }
    return map;
  };

  const byDim = group((e) => e.dimensions[0]);
  const byTag = new Map<string, Exemplar[]>();
  for (const e of sorted) {
    for (const tag of e.register) {
      const bucket = byTag.get(tag);
      if (bucket === undefined) byTag.set(tag, [e]);
      else bucket.push(e);
    }
  }
  const byKind = group((e) => e.kind);
  const bySource = group((e) => e.source);

  return {
    byId: (id) => idMap.get(id),
    byDimension: (d) => [...(byDim.get(d) ?? [])],
    byRegister: (tag) => [...(byTag.get(tag) ?? [])],
    byKind: (k) => [...(byKind.get(k) ?? [])],
    bySource: (s) => [...(bySource.get(s) ?? [])],
    all: () => [...sorted],
    tags: () => [...byTag.keys()].sort(compareStrings),
    dimensions: () =>
      [...byDim.keys()]
        .filter((d): d is Dimension => d !== undefined)
        .sort(compareStrings),
    vectorOf: (id) => vectors.get(id),
    embedderId: () => embedderId,
    size: () => sorted.length,
  };
};

// ---------------------------------------------------------------------------
// Filesystem-backed index (open/reload + embedding cache)

const CONTROL_FILES = new Set(['registers.yaml', 'exclusions.yaml']);

const listPopulationFiles = (root: string, source: SourceKind): CorpusFile[] => {
  if (!fs.existsSync(root)) return [];
  const out: CorpusFile[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => compareStrings(a.name, b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      // Controls files and non-exemplar companions are never population members.
      if (source === 'canon' && CONTROL_FILES.has(entry.name)) continue;
      if (!isPopulationFile(full)) continue;
      out.push({
        path: full.replaceAll('\\', '/'),
        raw: fs.readFileSync(full, 'utf8').replace(/\r\n/g, '\n'),
      });
    }
  };
  walk(root);
  return out;
};

export interface QuarantinedFile {
  path: string;
  code: string;
  message: string;
}

export interface ReloadReport {
  filesScanned: number;
  parsed: number;
  /** Files whose bytes were identical to the previous load — no re-parse cost beyond the scan. */
  unchanged: number;
  /** Vectors computed this pass (cache misses). */
  embedded: number;
  /** Vectors served from the disk/memory cache. */
  cacheHits: number;
  added: string[];
  removed: string[];
  quarantined: QuarantinedFile[];
  /** True when any cached vector was recomputed because of an embedder change. */
  reindexed: boolean;
}

export interface OpenedCorpus extends CorpusIndex {
  /** Rescans the roots; unchanged files (by content hash) are skipped, dirty ones re-embedded. */
  reload(): Promise<ReloadReport>;
  /** Files that failed validation and are therefore NOT in the index. */
  quarantined(): readonly QuarantinedFile[];
  roots(): { canon: string; derived?: string; lived?: string };
}

export interface OpenCorpusOptions {
  embedder: Embedder;
  controls?: CorpusControls;
  /** Directory for the vector cache. Omit for a purely in-memory index. */
  cacheDir?: string;
}

const CACHE_SCHEMA = 1;

interface CacheEntry {
  schema: number;
  key: string;
  embedderId: string;
  dim: number;
  vec: number[];
}

const cacheKey = (embedder: Embedder, body: string): string => `${embedder.id}|${contentHash(body)}`;
const cachePath = (cacheDir: string, key: string): string =>
  path.join(cacheDir, `${contentHash(key).slice('sha256:'.length)}.json`);

const readCache = (cacheDir: string | undefined, key: string, embedder: Embedder): Float32Array | undefined => {
  if (cacheDir === undefined) return undefined;
  const file = cachePath(cacheDir, key);
  if (!fs.existsSync(file)) return undefined;
  let entry: unknown;
  try {
    entry = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined; // corrupt cache line = miss; the cache is derived data
  }
  const e = entry as CacheEntry;
  if (
    e === null ||
    typeof e !== 'object' ||
    e.schema !== CACHE_SCHEMA ||
    e.key !== key ||
    e.embedderId !== embedder.id ||
    e.dim !== embedder.dim ||
    !Array.isArray(e.vec) ||
    e.vec.length !== embedder.dim
  ) {
    return undefined; // mismatch forces re-embed — never silent mixing (M04 contract)
  }
  return new Float32Array(e.vec);
};

const writeCache = async (cacheDir: string | undefined, key: string, embedder: Embedder, vec: Float32Array): Promise<void> => {
  if (cacheDir === undefined) return;
  const entry: CacheEntry = { schema: CACHE_SCHEMA, key, embedderId: embedder.id, dim: embedder.dim, vec: Array.from(vec) };
  await atomicWriteJson(cachePath(cacheDir, key), entry);
};

const scanRoots = (roots: { canon: string; derived?: string; lived?: string }): {
  files: CorpusFile[];
  sources: Map<string, SourceKind>;
} => {
  const files = [
    ...listPopulationFiles(roots.canon, 'canon'),
    ...(roots.derived !== undefined ? listPopulationFiles(roots.derived, 'derived') : []),
    ...(roots.lived !== undefined ? listPopulationFiles(roots.lived, 'lived') : []),
  ];
  const sources = new Map<string, SourceKind>();
  for (const f of files) {
    const source = sourceForPathOf(f.path);
    if (source !== undefined) sources.set(f.path, source);
  }
  return { files, sources };
};

interface LoadState {
  exemplars: Exemplar[];
  vectors: Map<string, Float32Array>;
  quarantined: QuarantinedFile[];
  hashes: Map<string, string>; // path -> contentHash(raw)
}

/**
 * Opens the corpus: scans canon/derived/lived, parses (quarantining — not
 * throwing on — malformed files, since prod must not die because a hand-edit
 * was bad), embeds bodies through the injected embedder with a disk cache, and
 * returns the index plus a reload() handle.
 */
export const openCorpusIndex = async (roots: OpenCorpusRoots, opts: OpenCorpusOptions): Promise<OpenedCorpus> => {
  if (!fs.existsSync(roots.canon)) {
    throw new CorpusError('corpus/missing-root', `canon root does not exist: ${roots.canon}`, { file: roots.canon });
  }
  const embedder = opts.embedder;
  if (opts.cacheDir !== undefined && !fs.existsSync(opts.cacheDir)) {
    fs.mkdirSync(opts.cacheDir, { recursive: true });
  }

  const run = async (previous: LoadState | undefined): Promise<{ state: LoadState; report: ReloadReport }> => {
    const { files, sources } = scanRoots(roots);
    const state: LoadState = {
      exemplars: [],
      vectors: new Map<string, Float32Array>(),
      quarantined: [],
      hashes: new Map<string, string>(),
    };

    const dirty: Array<{ exemplar: Exemplar; key: string; body: string; cached: Float32Array | undefined }> = [];
    let unchanged = 0;

    for (const file of files) {
      const source = sources.get(file.path);
      if (source === undefined) continue;
      const hash = contentHash(file.raw);
      state.hashes.set(file.path, hash);

      const analysis = analyzeFile(file, source);
      const firstError = analysis.issues.find((i) => i.severity === 'error');
      if (analysis.exemplar === undefined || firstError !== undefined) {
        state.quarantined.push({
          path: file.path,
          code: firstError?.code ?? 'corpus/schema',
          message: firstError?.message ?? 'failed to parse',
        });
        continue;
      }

      const exemplar = analysis.exemplar;
      state.exemplars.push(exemplar);

      const key = cacheKey(embedder, exemplar.body);
      const cached =
        previous !== undefined && previous.hashes.get(file.path) === hash
          ? previous.vectors.get(exemplar.id) ?? readCache(opts.cacheDir, key, embedder)
          : readCache(opts.cacheDir, key, embedder);
      if (cached !== undefined) {
        state.vectors.set(exemplar.id, cached);
      } else {
        dirty.push({ exemplar, key, body: exemplar.body, cached: undefined });
      }
      if (previous !== undefined && previous.hashes.get(file.path) === hash) unchanged += 1;
    }

    // Batch embed: one embed() call per reload, order-preserving (M04 contract).
    let cacheHits = state.vectors.size;
    if (dirty.length > 0) {
      const vectors = await embedder.embed(dirty.map((d) => d.body));
      if (vectors.length !== dirty.length) {
        throw new CorpusError(
          'corpus/schema',
          `embedder returned ${vectors.length} vectors for ${dirty.length} texts — batch order broken`,
        );
      }
      for (let i = 0; i < dirty.length; i++) {
        const item = dirty[i];
        const vec = vectors[i];
        if (item === undefined || vec === undefined) continue;
        if (vec.length !== embedder.dim) {
          throw new CorpusError('corpus/dim-mismatch', `embedder '${embedder.id}' returned dim ${vec.length}, expected ${embedder.dim}`);
        }
        state.vectors.set(item.exemplar.id, vec);
        await writeCache(opts.cacheDir, item.key, embedder, vec);
      }
      cacheHits = state.vectors.size - dirty.length;
    }

    const report: ReloadReport = {
      filesScanned: files.length,
      parsed: state.exemplars.length,
      unchanged,
      embedded: dirty.length,
      cacheHits,
      added: previous === undefined
        ? state.exemplars.map((e) => e.id)
        : state.exemplars.filter((e) => !previous.exemplars.some((p) => p.id === e.id)).map((e) => e.id),
      removed: previous === undefined
        ? []
        : previous.exemplars.filter((p) => !state.exemplars.some((e) => e.id === p.id)).map((e) => e.id),
      quarantined: state.quarantined,
      reindexed: previous === undefined ? true : dirty.length > 0,
    };

    return { state, report };
  };

  const { state, report } = await run(undefined);
  let current = state;
  let index = assembleIndex(current.exemplars, current.vectors, embedder.id);
  let quarantine = current.quarantined;

  const opened: OpenedCorpus = {
    ...index,
    reload: async () => {
      const next = await run(current);
      current = next.state;
      quarantine = current.quarantined;
      const rebuilt = assembleIndex(current.exemplars, current.vectors, embedder.id);
      index = rebuilt;
      Object.assign(opened, rebuilt);
      return next.report;
    },
    quarantined: () => [...quarantine],
    roots: () => ({ ...roots }),
  };
  void report; // first build's report is the caller's via reload() semantics; kept for symmetry
  return opened;
};

export interface OpenCorpusRoots {
  canon: string;
  derived?: string;
  lived?: string;
}

/** Lint helper re-exported here so CI can lint exactly what the index would load. */
export const lintPopulationFiles = (
  files: CorpusFile[],
  controls?: CorpusControls,
): ReturnType<typeof lintCorpus> => lintCorpus(files, controls);

export type { LintIssue };

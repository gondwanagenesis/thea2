// M09 memory — the JSONL + VectorIndex persistence both stores share. The
// episodic and procedural channels are separate stores by design (the S3 gate
// gates on that separation): this helper is generic over the row type and every
// public surface a caller touches is channel-specific, so no code path can hand
// back the other channel's records.
//
// Durability order: the row log is the record of truth and is written first;
// the vector index is derived and self-heals from it on open (a crash between
// the two writes loses nothing but a re-embed). Vectors are cached in memory as
// they are produced — the index answers search without handing its vectors
// back, so recall fetches the few it needs in one batched embed call.

import * as path from 'node:path';
import { asError, openJsonl, type JsonlStore } from '../kernel/index.js';
import { openVectorIndex, type Embedder, type VectorIndex } from '../embed/index.js';
import { failMemory } from './errors.js';

export interface RecordRow {
  id: string;
  ts: number;
}

export interface RecordStore<Row extends RecordRow> {
  /** Durable row first, then the derived index. Refuses a duplicate id. */
  append(row: Row, embedText: string): Promise<void>;
  /** Cosine top-k with M04's ordering (score desc, id asc). Score is the raw cosine. */
  search(vec: Float32Array, k: number): Array<{ row: Row; vec: Float32Array | undefined; score: number }>;
  /** Embed + cache the vectors for these ids (one batched call for the misses). */
  vecsFor(ids: readonly string[]): Promise<void>;
  /** The cached vector, when one has been produced for this id. */
  vecOf(id: string): Float32Array | undefined;
  /** Every row, oldest first (log replay order — ids are time-sortable). */
  all(): Row[];
  get(id: string): Row | undefined;
  size(): number;
  /** Log lines skipped at boot (unparseable shape or duplicate id) — diagnostics. */
  skippedRows(): number;
}

export interface OpenRecordStoreOpts<Row extends RecordRow> {
  /** JSONL base name, e.g. 'episodes' → episodes.jsonl. */
  base: string;
  /** Index base, e.g. 'embeddings' → embeddings.bin + embeddings.meta.json. */
  indexBase: string;
  embedder: Embedder;
  /** The text a row's vector is an embedding of. */
  textOf: (row: Row) => string;
}

export const openRecordStore = async <Row extends RecordRow>(
  dir: string,
  opts: OpenRecordStoreOpts<Row>,
): Promise<RecordStore<Row>> => {
  const log: JsonlStore<Row> = openJsonl<Row>(dir, opts.base);
  const index: VectorIndex = openVectorIndex({ embedderId: opts.embedder.id, dim: opts.embedder.dim });
  const indexPath = path.join(dir, opts.indexBase);

  const byId = new Map<string, Row>();
  const order: string[] = [];
  const vecs = new Map<string, Float32Array>();
  let skipped = 0;

  // ---- boot: replay the log, then reconcile the index against it.
  for await (const row of log.read()) {
    const id = (row as { id?: unknown } | null)?.id;
    if (typeof id !== 'string' || id === '' || byId.has(id)) {
      skipped++; // a garbage or duplicated log line never fails memory at boot
      continue;
    }
    byId.set(id, row);
    order.push(id);
  }

  // A missing index is just a store that never saved yet; anything else is loud.
  try {
    await index.load(indexPath);
  } catch (e) {
    if (asError(e).code !== 'embed/index-missing') throw e;
  }

  const indexed = new Set(index.ids());
  // Index entries with no row cannot be healed (the log is the truth): refuse
  // the store rather than serve vectors for records that no longer exist.
  const orphans = [...indexed].filter((id) => !byId.has(id));
  if (orphans.length > 0) {
    return failMemory(
      'memory/index-orphan',
      `${opts.base}: ${orphans.length} indexed id(s) have no row in the log — delete ${indexPath}.bin to force a rebuild`,
    );
  }
  const missing = order.filter((id) => !indexed.has(id));
  if (missing.length > 0) {
    // Crash between the row write and the index save: re-embed from the record
    // of truth so recall silently recovers instead of losing rows.
    for (const id of missing) {
      const row = byId.get(id);
      if (row === undefined) continue; // unreachable: missing is drawn from order
      const [vec] = await opts.embedder.embed([opts.textOf(row)]);
      if (vec === undefined) return failMemory('memory/embed-empty', `re-embed produced no vector for '${id}'`);
      vecs.set(id, vec);
      index.upsert(id, vec);
    }
    await index.save(indexPath);
  }

  const appendRecord = async (row: Row, embedText: string): Promise<void> => {
    if (byId.has(row.id)) {
      return failMemory('memory/duplicate-id', `${opts.base} store already holds '${row.id}'`);
    }
    const [vec] = await opts.embedder.embed([embedText]);
    if (vec === undefined) return failMemory('memory/embed-empty', 'embedder returned no vector for a 1-element batch');
    await log.append(row);
    byId.set(row.id, row);
    order.push(row.id);
    vecs.set(row.id, vec);
    index.upsert(row.id, vec);
    await index.save(indexPath);
  };

  const vecsFor = async (ids: readonly string[]): Promise<void> => {
    const wanted = [...new Set(ids)];
    const misses = wanted.filter((id) => !vecs.has(id));
    if (misses.length === 0) return;
    // an id the store does not hold is a caller bug, not a silent skip: recall
    // only ever asks for ids a search returned
    const unknown = misses.find((id) => !byId.has(id));
    if (unknown !== undefined) return failMemory('memory/unknown-id', `${opts.base} store does not hold '${unknown}'`);
    const embedded = await opts.embedder.embed(misses.map((id) => opts.textOf(byId.get(id)!)));
    misses.forEach((id, i) => {
      const vec = embedded[i];
      if (vec !== undefined) vecs.set(id, vec);
    });
  };

  return {
    append: appendRecord,

    // Boot refused any index id without a row, and append keeps both sides in
    // step — the non-null assertions below are that invariant, not optimism.
    search: (vec, k) =>
      index.search(vec, k).map((hit) => ({
        row: byId.get(hit.id)!,
        vec: vecs.get(hit.id),
        score: hit.score,
      })),

    vecsFor,
    vecOf: (id) => vecs.get(id),

    all: () => order.map((id) => byId.get(id)!),
    get: (id) => byId.get(id),
    size: () => byId.size,
    skippedRows: () => skipped,
  };
};

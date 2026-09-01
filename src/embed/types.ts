// M04 embed — contract types. The Embedder seam is what every downstream module
// (M07 corpus, M09 memory, M11 assemble, M19 probes) holds; the two test doubles
// and the two real implementations all satisfy this one shape.

/** bge-small-en-v1.5 dimensionality — the v1 default everywhere. */
export const DEFAULT_EMBED_DIM = 384;

export interface Embedder {
  /** Pinned into index metadata; identity, not description. Changing it must mean re-embed. */
  readonly id: string;
  /** Every vector this embedder produces has exactly this many components. */
  readonly dim: number;
  /** Batch API; single-text callers pass a one-element array. Order-preserving, L2-normalized. */
  embed(texts: string[]): Promise<Float32Array[]>;
}

export interface Scored {
  id: string;
  score: number;
  meta?: unknown;
}

/** openVectorIndex options: binding the index to an embedder identity is what
 * makes load() able to refuse a mismatch loudly instead of silently mixing
 * vectors from two different embedding spaces. */
export interface VectorIndexOptions {
  embedderId?: string;
  model?: string;
  dim?: number;
}

/** The `<path>.meta.json` sidecar written by save() and required by load(). */
export interface SavedIndexMeta {
  embedderId: string;
  model?: string;
  dim: number;
  count: number;
  /** Epoch ms, supplied by the caller (the index takes no clock). 0 = caller didn't stamp. */
  savedAtTs: number;
}

export interface SaveOptions {
  /** Epoch ms from the caller's injected Clock, stamped into the sidecar. */
  savedAtTs?: number;
}

export interface VectorIndex {
  /** '' when the index was opened unbound. */
  readonly embedderId: string;
  /** Bound dim, else the dim of the stored vectors, else 0 for an empty unbound index. */
  readonly dim: number;
  size(): number;
  /** Stored ids in insertion order (diagnostics; search order is score/id, never this). */
  ids(): string[];
  /** Inserts or replaces (re-embed path) vec + meta for `id`. The vector is copied. */
  upsert(id: string, vec: Float32Array, meta?: unknown): void;
  /**
   * Brute-force cosine over every entry, top-k. Deterministic: score descending,
   * ties broken by id ascending. `filter` runs on stored meta BEFORE ranking, so a
   * filtered-out entry never consumes a top-k slot. k larger than the surviving
   * set returns the whole set; k <= 0 or an empty index returns [].
   */
  search(vec: Float32Array, k: number, filter?: (meta: unknown) => boolean): Scored[];
  /** Writes `<path>.bin` (packed vectors) then `<path>.meta.json` (commit marker). */
  save(filePath: string, opts?: SaveOptions): Promise<void>;
  /** Refuses with a typed error on embedderId/dim mismatch — nothing is partially loaded. */
  load(filePath: string): Promise<void>;
}

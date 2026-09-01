---
module: M04
name: embed
syncedTo: spec-v1 (no code yet)
stage: S1
depends: [M01-kernel]
---
# M04 — embed

## Responsibility
Turn text into vectors and answer nearest-neighbor queries over them: the `Embedder` interface with pluggable implementations (v1 default: in-process ONNX bge-small via fastembed-js; config-swappable API embedder), and a brute-force cosine `VectorIndex` over packed `Float32Array`s. Deliberately no LanceDB, no SQLite, no ANN library in v1 — 10k × 384-d ≈ 15 MB scans in <5 ms, and a single in-process index is one less service to keep alive (ADR-002's instinct applied to infrastructure). Also owns the two deterministic test doubles, `HashEmbedder` and `FixedEmbedder`, which make every downstream ranking test meaningful rather than merely stable.

## Interfaces (contract)
```ts
export interface Embedder {
  readonly id: string;   // pinned into index metadata; identity, not description
  readonly dim: number;  // bge-small: 384
  embed(texts: string[]): Promise<Float32Array[]>;
}

export const makeFastembedEmbedder: (opts?: { model?: string }) => Promise<Embedder>; // v1 default
export const makeApiEmbedder: (cfg: { baseUrl: string; model: string; apiKey: string }) => Embedder;

export const makeHashEmbedder: (dim?: number /* default 384 */) => Embedder;
export const makeFixedEmbedder: (map: Record<string, number[]>) => Embedder; // throws on non-normalized input? no — normalizes on read

export interface Scored { id: string; score: number; meta?: unknown }
export interface VectorIndex {
  upsert(id: string, vec: Float32Array, meta?: unknown): void;
  search(vec: Float32Array, k: number, filter?: (meta: unknown) => boolean): Scored[];
  save(path: string): Promise<void>;
  load(path: string): Promise<void>;
}
export const openVectorIndex: () => VectorIndex; // in-memory; persisted via save/load
```

## Behavior spec
- All embedders return **L2-normalized** vectors, so cosine similarity is a plain dot product everywhere downstream. `embed` is batch; single-text callers pass a one-element array.
- v1 default embedder: fastembed-js running ONNX bge-small-en-v1.5 **in-process**. The ONNX runtime executes inference off the JS main loop — no worker-thread machinery in v1. Model weights load from a local cache; the first-ever download is a dev/setup action, never a CI event (hermetic doctrine).
- `ApiEmbedder` is a config swap (OpenAI-compatible `/embeddings`), kept for the day the swap to `multilingual-e5-small` is warranted (if Spanish becomes a large share of traffic) — a config change + re-embed, no code.
- **`HashEmbedder`** (deterministic double): lowercase, split on `\W+`, feature-hash unigrams **and bigrams** into `dim` buckets with two hash functions per feature (bucket index, ± sign), L2-normalize. Deterministic, dependency-free, and *similarity-preserving*: texts sharing tokens land near each other, so recall-ranking tests assert real behavior. This is what makes planted-fact recall (M09) and coherence sanity (M11) testable offline.
- **`FixedEmbedder`** (geometry double): explicit string→vector map for handcrafted geometry in coherence/coupling tests; unknown strings throw (it is a fixture, not a fallback). Vectors normalized on read.
- `VectorIndex` is a full scan: cosine over every entry, top-k. **Deterministic ordering**: score descending, ties broken by id ascending — every query on an unchanged index returns the same order, which is what the golden-ordering test pins and what replay determinism (M02 `project`) needs from consumers.
- `filter` runs on stored meta before ranking; a filtered-out entry never consumes a top-k slot.
- `upsert` with an existing id replaces vec + meta (re-embed path uses this).
- Persistence: `save(path)` writes `<path>.bin` (packed Float32Array payload) + `<path>.meta.json` (`{embedderId, model?, dim, count, savedAtTs}` — timestamps via injected clock at the caller's discretion; the index itself takes no clock). `load(path)` refuses with a typed error when the metadata's `embedderId` or `dim` mismatches the embedder in use — **never silent mixing**. The mismatch handler is upstream (M07/M09 own their re-embed jobs); M04's only contract is the loud refusal.
- `search` with `k` larger than the surviving set returns the whole set. Empty index returns empty array. Zero vector queries are legal and simply rank by noise-free zero scores (ties → id order).
- No text preprocessing belongs here beyond the embedders' own tokenization; no corpus semantics, no chunking policy — callers decide what a "text" is.

## Not this module's job
- Exemplar metadata, vocabularies, parsing — M07-corpus (M04 stores opaque `meta`).
- Recall ranking (recency × importance blending) — M09-memory / M11-assemble.
- Chat completions and the structured-output ladder — M03-model (same endpoint family, different door).
- Re-embed job scheduling — M07/M09 own their stores; M16 only schedules.
- Config resolution — M20-app (which embedder is active is a composition decision).

## Acceptance criteria
- [ ] `HashEmbedder`: same text yields a bit-identical vector across runs and processes; output is 384-d (default) and L2-normalized.
- [ ] `HashEmbedder` shared-token property: over generated text pairs, pairs sharing ≥1 significant token score strictly higher cosine than fully disjoint pairs (property test, seeded corpus).
- [ ] `FixedEmbedder` normalizes on read and throws on unknown strings.
- [ ] Index golden-ordering: a constructed 20-entry corpus and fixed query produce the exact committed ranking, including a documented tie broken by id.
- [ ] `save`/`load` roundtrip: reload then search returns an order identical to pre-save; metadata carries `{embedderId, dim, count}`.
- [ ] Dim/`embedderId` mismatch on `load` refuses with a typed error naming both sides; nothing is partially loaded.
- [ ] `filter` exclusion never appears in results even when `k` exceeds the filtered set.
- [ ] The fastembed ONNX path conforms to the `Embedder` contract (dim 384, normalized, batch order-preserving) — live-integration test, excluded from CI (weights = network), name-pinned so S1's report can reference it.

## Test checklist
- unit: HashEmbedder determinism (golden vectors committed), normalization, shared-token property; FixedEmbedder read/throw table; cosine math including zero-vector and identical-vector edges; tie-break rule.
- component: upsert/overwrite/search/filter over constructed geometry (FixedEmbedder-fed); save/load roundtrip incl. mismatch refusal for both `dim` and `embedderId`; empty-index and k-overflow edges.
- fixtures needed: HashEmbedder golden vectors; a committed 20-entry golden-ordering index; mismatched metadata sidecars; FixedEmbedder geometry maps (shared with M11's coherence tests).

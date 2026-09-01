// M07 corpus — the embedder seam.
//
// This is a structural mirror of M04's `Embedder` (docs/modules/M04-embed.md):
//   { readonly id: string; readonly dim: number; embed(texts: string[]): Promise<Float32Array[]> }
//
// src/embed does not exist yet (S1 is being built in parallel); the dependency
// DAG already allows src/corpus → src/embed, so when it lands this file becomes
// a one-line re-export of the real interface and nothing else in the module
// changes. M07 never constructs embedders — config/composition (M20) injects
// one; tests inject local deterministic doubles.
//
// Contract notes this module relies on (M04 guarantees): vectors are
// L2-normalized (cosine == dot product), and `embed` is batch and
// order-preserving.

export interface Embedder {
  /** Pinned into the embedding cache; an id change forces a full re-embed (never silent mixing). */
  readonly id: string;
  /** Vector width (bge-small: 384). */
  readonly dim: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}

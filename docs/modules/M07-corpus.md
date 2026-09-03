---
module: M07
name: corpus
syncedTo: S8 (disposition flag, situation frame, identityBody — 2026-09-02)
stage: S1
depends: [M01-kernel, M04-embed]
---
# M07 — corpus

## Responsibility
Own the exemplar model: the MD+frontmatter file format (shape reference: `schemas/exemplar.ts`), the strict parser/lint that makes the corpus a validated artifact rather than a folder of prose, the loader for the three populations (`canon/`, `derived/`, `lived/`), the in-memory `CorpusIndex`, and the corpus-side `Nominator` that feeds the assembler. Content-hash ids for derived/lived, path ids for canon. Corpus lint **is** a CI test — every canon file in the repo must validate or the build is red.

## Interfaces (contract)
```ts
// Exemplar / frontmatter shapes: schemas/exemplar.ts is the reference until S2 migration
// (CanonFrontmatter / DerivedFrontmatter / LivedFrontmatter / Exemplar + DIMENSIONS,
//  AFFECT_DIMS, SparseAffect). This module owns the parser, lint, index, nominator.

export interface CorpusControls {
  registers: string[];            // from canon/registers.yaml (modes + modifiers)
  forbiddenPairs: Array<[string, string]>;   // from canon/exclusions.yaml
  dimensionCaps: Record<string, number>;     // e.g. boundaries ≤ 1 per packet
}

export const parseExemplar: (raw: string, expectedSource: 'canon'|'derived'|'lived') => Exemplar; // throws typed, names the file+field
export const lintCorpus: (files: Array<{ path: string; raw: string }>, controls: CorpusControls) => LintReport;
export const loadControls: (registersYaml: string, exclusionsYaml: string) => CorpusControls;    // strict; throws on unknown schema

export interface CorpusIndex {
  byId(id: string): Exemplar | undefined;
  byDimension(d: Dimension): Exemplar[];
  byRegister(tag: string): Exemplar[];
  all(): Exemplar[];
  reload(): Promise<void>;                        // rescan corpus dirs; re-embed dirty ids only
  embedderId(): string;
}
export const openCorpusIndex: (roots: { canon: string; derived: string; lived: string },
  deps: { embedder: Embedder; controls: CorpusControls }) => Promise<CorpusIndex>;

export interface NominationQuery {
  queryVec: Float32Array; text?: string;
  register: string; entry: 'user-turn' | 'heartbeat' | 'ponder';
  affectHint?: SparseVec12;
}
export const corpusNominator: (idx: CorpusIndex) => Nominator;  // Nominator type owned by M11; structural, injected
```

## Behavior spec
- **File format** (§2.8): MD + YAML frontmatter, one file per exemplar, `corpus/canon/<dimension>/<slug>.md`. Canon id is path-derived (`canon/voice/late-night-glue`) and must match its location — a mismatch is a lint error. Derived/lived ids are the `contentHash` of the output file (M01); the id check is part of lint for those populations.
- **Body grammar**: optional `Setup:` lines, then alternating `D:`/`T:` turns; consecutive `T:` lines are separate bubbles of one turn. `kind: scene` requires ≥1 D:/T: exchange; `kind: statement` may be bodyless prose; `kind: procedure` embeds a `[tool] name {args} → observation` trace block plus an `[outcome] good|mixed|bad — note` line, and belongs to the procedural channel (rendered as `[PROCEDURAL]`, never `[EXEMPLARS]` — ADR-009).
- **Validation** (parser + lint, all hard errors): frontmatter zod per source population (canon must NOT carry `provenance`/lived stamps; derived MUST; lived MUST — the blocks are mutually exclusive by source); `dimensions` ⊆ the 8, primary first; `register` tags ⊆ `controls.registers`; `affect` keys ⊆ AFFECT_DIMS, values in [-1,1], sparse 2–4 keys recommended (warn above 4); body ≤ 500 tokens hard / 350 warn (token count = whitespace-split, the cheap stable proxy the budgets assume); `weight` > 0; `counters` ids must resolve to existing exemplars in the same index load (dangling counter = lint error).
- **Controls files** (`registers.yaml`, `exclusions.yaml`) sit beside canon but are not exemplars; `loadControls` is strict (unknown top-level keys throw). `identity.md` and `inhibitions.yaml` are likewise non-exemplars — the parser must never be pointed at them (they are not in the population dirs).
- **Index**: in-memory; built by scanning the three roots, parsing, embedding bodies (via M04, batched), and computing each exemplar's sparse signature (frontmatter `affect` → `SparseVec12`). Embeddings cached to disk keyed by `contentHash(body) + embedderId`; an embedder-id mismatch on the cache forces re-embed (never silent mixing — M04's refusal propagates as an explicit re-embed pass, then a `corpus.reindexed` event-shaped report to the caller, not to L0 — M07 emits no events; it is a library).
- `reload()` rescans directories (dev loop after canon edits); unchanged files are skipped by content hash.
- **`corpusNominator`** implements the assembler's `Nominator` shape on the character channel: ranks `kind ∈ {scene, statement}` exemplars by `cos(vec, queryVec) × recency-proxy × weight`, applies the gravity multiplier appropriate to source (canon/derived = seed, lived = lived — the multiplier VALUE arrives via injected config from M11's cfg; the nominator applies it), and returns candidates with baseScore + sig + tags + a `render()` that emits frontmatter-stripped body text. Over-return is fine (k is the assembler's); the assembler's quotas/coherence do the final cut.
- **Determinism**: `nominate` is deterministic given (index state, query) — no rng inside the nominator; any tie-break is (score desc, id asc). "Nominate determinism under seeded rng" in the design report refers to the index build's noise-free stability; there is no randomness here at all.
- Derived/lived files failing validation are lint errors in CI (they are committed artifacts); at runtime a single bad file in `lived/` quarantines that file (skipped + surfaced in `reload()`'s report) rather than downing the process — prod never auto-mutates the corpus (ADR-007), and it also never dies because a hand-edit was malformed.

## Not this module's job
- Exemplar schema definition — `schemas/exemplar.ts` until S2, then `src/corpus/schema.ts` (mirror-synced, never forked).
- Quotas, coherence, contrast, budgets, PacketRecord — M11-assemble.
- Writing to `canon/`, `derived/`, or `lived/` — human (canon), M08 (derived), M10 (lived). M07 is read-only over the corpus.
- Provenance manifest / dirty-set computation — M08-derive (M07 provides parse + hash hooks).
- ProceduralStore recall — M09-memory owns the procedural channel's store and nominator.
- Inhibition semantics — `inhibitions.yaml` compiles in M12; M07 never reads it.

## Acceptance criteria
- [ ] Parser golden files: a canon scene, a statement, a procedure, a derived file with full provenance, a lived file with encodedAffect — each parses to the exact committed `Exemplar` value.
- [ ] Malformed reject table: bad id/location mismatch, unknown dimension, unknown register tag, affect key outside the 12 dims, out-of-range value, body over 500 tokens, scene with no exchange, canon file carrying `provenance`, derived missing provenance, dangling `counters` id — each a typed error naming file + field.
- [ ] **Every canon/derived/lived file in-repo validates** (corpus lint runs over the actual tree as a test — the current 17 DRAFT canon scenes + controls pass).
- [ ] Index: byId/byDimension/byRegister/all consistent with a hand-built expectation over a fixture corpus; embeddings cached — second open performs zero embed calls (cache hit), and an `embedderId` change forces a full re-embed (spy-asserted).
- [ ] `corpusNominator` ranking: cosine × weight × gravity ordering exact on a FixedEmbedder fixture; tie broken by id; render() output equals body with frontmatter stripped.
- [ ] `reload()` after a content-hash-preserving rewrite is a no-op; after a real edit, exactly the dirty exemplar re-embeds.
- [ ] Quarantine: a malformed lived file at runtime is skipped, reported, and does not appear in `all()`.

## Test checklist
- unit: parser goldens (per population); lint reject table; token-counter edge cases; controls loader strictness; id derivation rules per population.
- component: index build over a fixture tree incl. cache dir (tmp dir via injected clock where timestamped); re-embed on embedder swap; reload dirty-set correctness; nominator ranking geometry with FixedEmbedder.
- fixtures needed: the golden exemplar files (canon/statement/procedure/derived/lived); a malformed-variants directory; FixedEmbedder geometry map (shared with M11); a two-embedder cache fixture.

## Deviations and fixes as built
- **Derived/lived id = masked content hash** (`src/corpus/derived-id.ts`, regression `test/corpus/parse.test.ts`). The spec's "id is the contentHash of the file" is a self-reference paradox as written (the id cannot equal the hash of text containing the id). Convention: the id line is masked to `sha256:pending` before hashing; writers stamp the real id afterwards and the result's masked hash is exactly that id. Originally implemented in M08's keys.ts (which surfaced the bug); moved here 2026-09-01 so parser and writers share one source of the convention. `contentIdFor` (plain unmasked hash) is kept for content addressing only — never id discipline.
- **`kind: statement` bodies are prose by design** (regression same file). `validateBodyForKind` used to flag every prose line `corpus/body-grammar` regardless of kind — rejecting committed canon statements (`seaglass-jar.md`). The check is now scoped to scene/procedure; statement keeps "no structural rules" as the spec's own comment always said.
- **Committed-canon smoke** (`test/corpus/parse.test.ts`): every exemplar-shaped file under `corpus/` must parse with zero error-severity issues — the corpus's first direct test suite; both fixes above were caught (and are pinned) here.
- **As built (Package E, 2026-09-02)** — three additions, each mirrored in `schemas/exemplar.ts` first:
  - `CanonFrontmatter.disposition: boolean` (optional). A canon file flagged `disposition: true` nominates into the disposition tier regardless of kind (`corpusNominator.tierFor`), alongside `kind: statement` files; the slot stays canon-only and quota-owned (ADR-006). Un-commenting the six canon files carrying `# disposition: true` is the author's hand, not tooling's.
  - `src/corpus/render.ts` — the packet-side frame: `renderExemplar` renders `situation: <context>` above the body and folds a leading `Setup:` paragraph into that one line (setup text after the context, em-dash separated); no context and no setup ⇒ body verbatim. `corpusNominator`'s `render()` uses it, so every [EXEMPLARS] item ships framed.
  - `identityBody(raw)` (`src/corpus/frontmatter.ts`): strips `---`-fenced frontmatter and returns the body (CRLF-normalized, leading blank line trimmed; fenceless input returned as-is, never throws). For `corpus/canon/identity.md` — its frontmatter is repo metadata, never prompt text. Adoption call site: `src/app/compose.ts:245` (`identityBlock: readCanon(...)`), wired in Round 3.

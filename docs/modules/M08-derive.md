---
module: M08
name: derive
syncedTo: S7 (src/derive + test/derive, 75 tests green)
stage: S7
depends: [M01-kernel, M02-events, M03-model, M04-embed, M07-corpus]
---
# M08 — derive

## Responsibility
The canon→derived pipeline: generate coverage the human shouldn't have to hand-write (mood-conditioned variants, procedural tool-use exemplars, deliberation-shape traces, memory-weaves), judge-validate it against what each canon scene's `notes` says must survive, and manage the derived corpus as a **content-addressed, manifest-tracked, incrementally-regenerable artifact**. The load-bearing trick is the check/generate split (ADR-007): CI verifies committed derived output hermetically; generation with a real model is a dev/scheduled action; **prod never auto-mutates the corpus**.

## Interfaces (contract)
```ts
export interface Generator {
  name: string; version: string;
  // Enumerate expected output targets from current inputs. Caps enforced HERE, at enumeration.
  targets(inputs: DeriveInputs): DerivedTarget[];
  generate(t: DerivedTarget, deps: { model: ModelClient; rng: Rng }): Promise<string /* raw md */>;
}
export interface DerivedTarget {
  deriveKey: string;             // sha256(generator + generatorVersion + sortedInputHashes + templateHash)
  templateHash: string;
  inputs: { canonIds: Array<{ id: string; sha256: string }>; toolDefsHash?: string };
  bucket?: string;               // mood bucket for the variation generator
}
export interface DeriveInputs {
  canon: Exemplar[];             // from M07 index
  toolDefs: ToolDef[];           // registry defs (M13's v1 set) for the procedural generator
  gravityCap: number;            // derived:canon ≤ 8
  moodBuckets: readonly string[]; // ['bright','tender','low','tense','wanting','flat']
}

export interface Manifest {
  version: 1;
  embedderId: string;
  entries: Array<{ id: string /* = contentHash(output file) */; deriveKey: string;
    generator: string; generatorVersion: string;
    inputs: DerivedTarget['inputs']; model: string; createdAt: number;
    judge: { version: string; score: number; pass: boolean } }>;
}
export const loadManifest: (raw: string) => Manifest;               // strict
export const dirtySet: (inputs: DeriveInputs, manifest: Manifest) => DerivedTarget[];   // pure
export const orphanSet: (inputs: DeriveInputs, manifest: Manifest) => Manifest['entries']; // pure

export const derive: (opts: { generators: Generator[]; judgeModel: ModelClient; rng: Rng;
  events: EventLog }) => Promise<DeriveReport>;      // `thea2 derive`
export const corpusCheck: (opts: { inputs: DeriveInputs; manifest: Manifest;
  files: Map<string /* id */, string /* raw */> }) => CheckReport;  // `thea2 corpus:check` — HERMETIC
```

## Behavior spec
- **Four generators, v1**: `mood-variant` (register/mood-conditioned variation of canon scenes; **≤6 variants per canon scene, one per coarse mood bucket** {bright, tender, low, tense, wanting, flat}); `procedural` (one synthesized procedure exemplar per **(tool × canon behavior pair)** from `ToolDef`s + canon scenes demonstrating that behavior); `deliberation-shape` (traces of assess→decide reasoning shapes); `memory-weave` (exemplars braiding 2–3 episodes into one rendered memory). **Global cap derived:canon ≤ 8:1, enforced at target enumeration** — a generator that would overflow stops proposing targets, never post-hoc deletes.
- **Manifest** at `corpus/derived/manifest.json` (committed): `deriveKey = sha256(generator + generatorVersion + sortedInputHashes + templateHash)`. Entry `id` = the output file's `contentHash`. A target is **dirty iff no manifest entry carries its deriveKey**; editing canon changes its sha256 ⇒ every containing target goes dirty; bumping a `generatorVersion` dirties that generator's whole family. Dirty-set and orphan-set computation are **pure functions** — the unit-test core of this module.
- **Orphan GC**: manifest entries whose deriveKey is no longer in the expected-target set (and their files) are deleted immediately during a `derive` run, each emitting `derive.orphan_gc` to L0. Git history is the recovery path — the corpus, derived included, is committed.
- **Judge validation**: every generated file is graded by a reasoning-tier judge (TaskClass `judge`) against the source canon scene's `notes` ("what must survive derivation"). A generation that fails the judge is retried once, then discarded — never committed. Manifest entries record `{version, score, pass: true}`; `corpus:check` fails if any committed entry has `pass: false`.
- **Content addressing discipline**: output file's bytes determine its id; the manifest entry's id must equal the file's `contentHash`. A hand-edit to a derived file breaks its hash — that's detected, not absorbed: `corpus:check` reports it as a dirty/mismatch, and the fix is regeneration (or reverting the hand-edit). Hand-editing derived output is simply not a workflow.
- **`thea2 derive`** (dev/scheduled, needs real model): compute dirty set → generate → judge → write files + updated manifest atomically (kernel `atomicWriteJson`) → GC orphans → emit `derive.run` summary to L0. Fan-out draws from the injected rng; a derive run is reproducible per seed.
- **`thea2 corpus:check`** (hermetic, CI, **no model, no network**): over the committed tree — zero dirty targets, zero orphans, every derived file's hash = its id, every entry `judge.pass = true`, all fan-out caps hold. Exits nonzero with a precise report otherwise. This is what keeps the judge-validated pipeline compatible with hermetic CI (§5.9).
- **Prod posture**: the scheduler's weekly `derive-check` job (M16, wired by M20) runs ONLY the dirty/orphan computation and **reports** — a `derive.stale` alarm event if dirtiness exists. Prod never regenerates. The M11 assembler's `flags.staleDerived` reads the same signal (via injected config from M20).
- Schema discipline: generated files are validated by M07's parser (as derived population) before judge grading — a generation that can't parse is a failed generation, not a committed liability.

## Not this module's job
- Writing canon — human only. The pipeline reads it (via M07), never writes it.
- Parsing/linting exemplars — M07-corpus (M08 calls it, and treats parse failure as generation failure).
- Embeddings for the index — M04 (manifest pins `embedderId`; a mismatch with the active embedder makes everything dirty by definition of the re-embed contract in M07 — reported, not silently absorbed).
- Lived corpus promotion — M10-consolidate (different lifecycle, different writer).
- Scheduling the weekly check — M16-sched.
- The ToolDef registry itself — M13-loop (M08 receives `toolDefs` as input).

## Acceptance criteria
- [x] `dirtySet` property tests: pristine inputs ⇒ ∅; canon edit ⇒ exactly the containing targets; generatorVersion bump ⇒ that family; unrelated addition ⇒ only new targets. (`test/derive/dirty.test.ts` — pristine ∅; sceneA body edit ⇒ 7 containing targets; procedural version bump ⇒ 2; template edit at same version ⇒ whole family; tool-def edit ⇒ that tool's procedure; bucket-list widening ⇒ only new buckets; plus a purity suite.)
- [x] `orphanSet` returns exactly the entries whose deriveKeys left the expected set. (`test/derive/dirty.test.ts` — sceneA edit orphans exactly the 7 entries containing it; removing a generator orphans its family; a shrunken cap orphans nothing.)
- [x] Fan-out caps: enumeration never proposes > 6 mood variants per scene, > 1 procedure per (tool × behavior) pair, > 8:1 derived:canon overall — assert at enumeration with overflow fixtures. (`test/derive/caps.test.ts` + the enumerate cases in `dirty.test.ts`: budget truncation drops in registration order and returns `droppedByCap`; live keys are never re-proposed even past the budget.)
- [x] Content-hash invariant: written file's `contentHash` equals its manifest entry id (spot-check across a derive run). (`test/derive/keys.test.ts` masked-id fixed point + `test/derive/run.test.ts` happy path: written bytes hash to `entry.id`.)
- [x] Judge gate: a generation scoring below the rubric threshold is retried once then discarded — no manifest entry, no file (MockModel-scripted). (`test/derive/run.test.ts` — fail-once ⇒ one retry with a forked rng and success; fail-twice ⇒ empty outDir except `manifest.json`, both attempts in `failures[]`; unparsable draft fails before the judge is ever called.)
- [x] `corpus:check` truth table over constructed trees: pristine ⇒ pass; one hand-edited derived file ⇒ hash-mismatch failure naming it; one manifest entry missing ⇒ dirty failure; one `pass:false` entry ⇒ failure; injected orphan ⇒ GC-listed failure. (`test/derive/check.test.ts` — plus missing-file, unclaimed-file, caps-in-check, and the rendered report lines.)
- [x] `derive` with MockModel end-to-end: generates, validates (parse), judges, writes manifest atomically, GCs orphans, emits `derive.run` + `derive.orphan_gc` events. (`test/derive/run.test.ts` — manifest bytes on disk == `serializeManifest` output; idempotent second run makes zero model calls; orphan GC removes the file and emits `derive.orphan_gc` per entry; `derive.run` event captured verbatim.)
- [x] Reproducibility: same seed + same inputs + same scripted model ⇒ byte-identical outputs and manifest. (`test/derive/run.test.ts` — two runs with `makeRng('fixed-seed')` produce identical snapshots; distinct seeds produce distinct fan-out draws.)

## Test checklist
- unit: deriveKey computation goldens (ordering of sortedInputHashes matters — pin it); dirty/orphan pure-function property suite; cap enforcement at enumeration; manifest loader strictness.
- component: MockModel derive run incl. judge-retry-discard path and orphan GC; corpus:check truth table over committed-like fixture trees; atomic manifest write fault injection.
- fixtures needed: a mini canon corpus + expected-target enumerations; scripted MockModel generators + a failing judge; corrupted/mismatched manifest variants; a derived file with a deliberate byte edit.

## Implementation (S7) — deviations and pinned decisions

Code: `src/derive/` (types, errors, keys, manifest, enumerate, file, judge, check, run, generators/) with a barrel at `src/derive/index.ts`. Tests: `test/derive/` (keys, manifest, dirty, caps, check, run, generators — 75 tests). **Upstream M07 bugs are recorded at the end of this section; they were worked around, not absorbed.**

Signatures as shipped (supersede the sketch above):

```ts
// The expected-target set is a function of canon × GENERATOR CODE (versions +
// templates), so the pure functions take the generator set. The sketch omitted it.
export const dirtySet:  (inputs: DeriveInputs, manifest: Manifest, generators: readonly Generator[]) => DerivedTarget[];
export const orphanSet: (inputs: DeriveInputs, manifest: Manifest, generators: readonly Generator[]) => ManifestEntry[];
export const enumerateTargets: (inputs, generators, manifest) => Enumeration; // {targets, droppedByCap, maxDerived, canonCount}

// `derive` takes the whole run context; `corpusCheck` stays hermetic but takes
// the generator set for the same reason dirtySet does.
export const derive: (opts: DeriveRunOptions) => Promise<DeriveReport>;
// DeriveRunOptions = { inputs, generators, model, modelId, judgeModel, judge,
//   embedderId, rng, events, clock, outDir }
export const corpusCheck: (opts: { inputs; manifest; generators; files: Map<id, raw> }) => CheckReport;

// Generator.generate resolves source CONTENT through the deps: a target carries
// only hashes, so generation needs the run inputs behind them.
generate(t: DerivedTarget, deps: { model: ModelClient; rng: Rng; inputs: DeriveInputs }): Promise<string>;
```

Pinned decisions:
- **deriveKey concatenation** is `contentHash(canonicalJson([generator, generatorVersion, [...inputHashes].sort(compareStrings), templateHash]))` — canonical JSON, not string `+` (plain concatenation is ambiguous and a collision would silently skip generation).
- **Source hashes**: `canonSourceHash(e) = contentHash(canonicalJson(e))` (parsed form, key order irrelevant); `toolDefsHash = contentHash(canonicalJson(toolDef))`; `templateHash = contentHash(templateText)`.
- **The mood bucket is not a separate hash term.** Each bucket gets its own prompt template (`moodVariantTemplate(bucket)`), so the bucket lives inside `templateHash` — the spec's deriveKey formula stays intact and two buckets of one scene cannot collide on a key.
- **Fan-out rules for the two underspecified generators**: `deliberation-shape` proposes one target per canon exemplar carrying the `reasoning` dimension; `memory-weave` proposes one target per ADJACENT pair of id-sorted `kind: scene` canon (no scene appears in more than two targets). Each target keeps a 1:1 provenance list the judge grades against.
- **Cap enforcement at enumeration**: budget = `max(0, floor(gravityCap × canonCount) − liveEntries)`; proposals are truncated in generator REGISTRATION ORDER (registration order is priority order; v1 order: mood-variant, procedural, deliberation-shape, memory-weave). A live manifest key is never re-proposed. **Orphan-hood is decided against the UNCAPPED expected set**, so a shrunken cap can never turn live output into deletable garbage; caps fold into `CheckReport.ok` for hand-authored manifests.
- **Content addressing vs the self-referential id**: a derived file's `id` line cannot be part of the bytes it hashes. M08 hashes the file text with the `id:` line MASKED to `sha256:pending` (`hashableText`), then writes the real id (`withFileId`); masking is a fixed point, so `derivedFileId(written) === entry.id`. File name = id minus the `sha256:` prefix (`:` is an NTFS data-stream separator).
- **Manifest bytes** are canonical JSON (sorted keys), written by kernel `atomicWriteJson` only after all files are on disk; entry order is `deriveKey` then `id` so diffs stay reviewable. Loader is zod-strict (`z.strictObject`, `version: z.literal(1)`, `sha256:`-shaped hashes, full `JudgeStamp`) and rejects with `derive/manifest-schema`, naming the first offending path.
- **Judge**: pinned rubric text (`JUDGE_SYSTEM_PROMPT`), structured verdict via the model ladder's `emit` tool (rung b), `taskClass 'judge'` / `tier 'reasoning'` / `temperature 0`. Constants `JUDGE_VERSION = 'derive-judge-v1'`, `JUDGE_PASS_THRESHOLD = 4`. Retry policy: exactly 2 attempts per target (`rng.fork(deriveKey + '::attempt-N')`), then the draft is discarded — no file, no manifest entry; `failures[]` records each attempt's stage (`generate` | `parse` | `judge`) and code (`derive/draft-shape` when the threshold fails).
- **L0 events**: `derive.run` (targets/written/judgeFailed/parseFailed/orphans/droppedByCap/generators, plus `embedderMismatch` when set), `derive.orphan_gc` per removed entry (`{id, deriveKey, file, removed, error?}` — loud even when the file was already gone), and `derive.stale` payload `{dirty, orphans, dirtyKeys, orphanIds}` for M16's weekly job. Kind constants are exported from the barrel.

### Upstream M07 bugs found while building this — both FIXED in M07 (2026-09-01, S7 integration)

1. **Derived/lived id rule is unsatisfiable as implemented** (`src/corpus/parse.ts`). `contentIdFor(raw)` hashes the WHOLE file text, and `analyzeFile` then compares that hash to the `id:` line inside those same bytes — the id can never equal a hash that depends on it (`pathIdentity` off, as M08's run does, skips the check; on, it rejects every derived file). Empirically proven during S7. **FIXED**: the masked-hash convention now lives canonically in `src/corpus/derived-id.ts`; M07's `expectedIdFor` uses it and `src/derive/keys.ts` re-exports — M08's local definitions were deleted in favor of the corpus originals (single source of truth).
2. **`validateBodyForKind` rejects prose for `kind: statement`** (`src/corpus/body.ts`): the prose-line error is pushed unconditionally, contradicting the rule stated in the same file ("kind 'statement': bodyless prose is the point") AND rejecting committed canon — `corpus/canon/taste/seaglass-jar.md` fails `parseExemplar` today. **FIXED**: the prose check is now scoped to `kind !== 'statement'` with a regression test in `test/corpus/parse.test.ts`. M08's `assertStatementProse` shim remains as harmless belt-and-braces; removable in a later pass.

### Content law binding on generators + judge (2026-09-01)

The anti-fabrication law (corpus/proposals/README.md, AGENTS.md rule 8) extends to everything M08 generates: drafts may extend canon TALKING STYLE but must never fabricate shared history — no invented events, named third parties, Diego biography/project specifics, or past tool outcomes. Canon is style-only by law; derived content inherits that constraint through its sources. The judge rubric should reject drafts asserting facts not present in their canon provenance.

---
module: M08
name: derive
syncedTo: spec-v1 (no code yet)
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
- [ ] `dirtySet` property tests: pristine inputs ⇒ ∅; canon edit ⇒ exactly the containing targets; generatorVersion bump ⇒ that family; unrelated addition ⇒ only new targets.
- [ ] `orphanSet` returns exactly the entries whose deriveKeys left the expected set.
- [ ] Fan-out caps: enumeration never proposes > 6 mood variants per scene, > 1 procedure per (tool × behavior) pair, > 8:1 derived:canon overall — assert at enumeration with overflow fixtures.
- [ ] Content-hash invariant: written file's `contentHash` equals its manifest entry id (spot-check across a derive run).
- [ ] Judge gate: a generation scoring below the rubric threshold is retried once then discarded — no manifest entry, no file (MockModel-scripted).
- [ ] `corpus:check` truth table over constructed trees: pristine ⇒ pass; one hand-edited derived file ⇒ hash-mismatch failure naming it; one manifest entry missing ⇒ dirty failure; one `pass:false` entry ⇒ failure; injected orphan ⇒ GC-listed failure.
- [ ] `derive` with MockModel end-to-end: generates, validates (parse), judges, writes manifest atomically, GCs orphans, emits `derive.run` + `derive.orphan_gc` events.
- [ ] Reproducibility: same seed + same inputs + same scripted model ⇒ byte-identical outputs and manifest.

## Test checklist
- unit: deriveKey computation goldens (ordering of sortedInputHashes matters — pin it); dirty/orphan pure-function property suite; cap enforcement at enumeration; manifest loader strictness.
- component: MockModel derive run incl. judge-retry-discard path and orphan GC; corpus:check truth table over committed-like fixture trees; atomic manifest write fault injection.
- fixtures needed: a mini canon corpus + expected-target enumerations; scripted MockModel generators + a failing judge; corrupted/mismatched manifest variants; a derived file with a deliberate byte edit.

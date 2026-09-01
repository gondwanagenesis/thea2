---
module: M06
name: coupling
syncedTo: S3 (implemented — src/coupling, test/coupling)
stage: S3
depends: [M01-kernel, M05-affect]
---
# M06 — coupling

## Responsibility
The affect→exemplar coupling: the piece that makes emotion a first-class selector rather than a text sticker. Owns the 12-dim deviation space, the extraction of a live signature from `AffectState`, the hand-tuned modulation matrix `M` (with a `why` per entry), the form rules, and the capped, pure `modulate()` consumed by the assembler (M11). Includes the standing **anti-escalation** property — under high tension, selection must reach for repair, not more tension — which is the structural answer to Thea1's [AFFECT]-text-plus-tense-exemplars spiral risk (§5.3).

## Interfaces (contract, as built)
```ts
// 12-dim deviation space: PAD + the real 9 Thea1 primaries. AFFECT_DIMS is NOT
// redefined here — it is imported from schemas/exemplar.ts (which predates this
// module and already uses the PAD-canonical `valence`) and re-exported, so the
// schema, the coupling space, and M11 share ONE constant. Drift is guarded by
// test in both directions (this module's list vs the schema's).
export { AFFECT_DIMS };                    // from schemas/exemplar.ts
export type AffectDim = (typeof AFFECT_DIMS)[number];
export type Vec12 = Float64Array;          // length 12, entries in [-1,1] deviation coords
export type SparseVec12 = Partial<Record<AffectDim, number>>;  // exemplar signatures
export type Baselines = Readonly<Record<AffectDim, number>>;   // per-dim [0,1] homes
export const DIM_INDEX: Readonly<Record<AffectDim, number>>;   // dim → array index (identity over AFFECT_DIMS)

// The Thea1 baselines in coupling coords, ported verbatim from M05's tables
// (ticker.py v6): PAD homes from the live baseline block, primaries from
// PRIMARY_BASELINE. This is the default Baselines.
export const COUPLING_BASELINES: Baselines;

export const signature: (s: AffectState, baseline: Baselines) => Vec12;
//   a_k = clamp((x_k − b_k) / max(b_k, 1−b_k), −1, 1)
//   Reads the numeric state (s.dials / s.primaries) — never the weather line.
//   Valence↔pleasure handshake: coupling's `valence` dim reads s.dials.pleasure
//   (ticker.py's name for the same number). Throws coupling/baseline-range on a
//   baseline outside [0,1].

export interface CouplingConfig {
  version: number;  // yaml `version` — positive integer
  lambda: number;   // modulation cap, 0.25 — selection may be bent, never ruled
  matrix: Array<{ from: AffectDim; to: AffectDim; w: number; why: string }>;
  formRules: Array<{ when: { dim: AffectDim; min: number }; boostTag: string; gain: number; why: string }>;
  // yaml key is `form_rules` (snake) → config field `formRules` (camel).
}

export interface CompiledCoupling {
  cfg: CouplingConfig;
  m: Float64Array;  // 12×12 dense row-major, index from*12 + to, built from the sparse matrix
}

export const compileCoupling: (yamlText: string) => CompiledCoupling; // throws CouplingError naming the entry
export const modulate: (a: Vec12, e: SparseVec12, tags: string[], cfg: CompiledCoupling) => number;
//   clamp(aᵀMe + Σ gain·max(0, a_dim − θ)·hasTag, −λ, +λ)
//   Pure; the cap is enforced inside — callers cannot un-cap it. NaN propagates
//   (loud, by design). Wrong-arity `a` throws coupling/vec-length.

// Errors: CouplingError extends KernelErrorImpl; isCouplingError is the guard.
// Codes: coupling/yaml-parse, coupling/schema, coupling/unknown-dim,
// coupling/weight-range, coupling/gain-range, coupling/threshold-range,
// coupling/duplicate-pair, coupling/missing-why, coupling/lambda-range,
// coupling/version-shape, coupling/baseline-range, coupling/vec-length.
```

## Behavior spec
- **Signature extraction is normalization, not vibe**: each dim's deviation from its Thea1 baseline (M05's `PRIMARY_BASELINE`, PAD homes) scaled by `max(b_k, 1−b_k)` and clamped to [-1,1]. A calm baseline day maps to ~0 — coupling is silent when she's unremarkable, by design.
- **`M` is hand-tuned, versioned, and located at `coupling.yaml` in the repo root** (committed, reviewed like code). Diagonal entries are mood-congruence (sad state → sad-tagged exemplars surface). The off-diagonals are the deliberate corrective moves: tension dims → **repair** exemplars, not more tension. Every entry carries a `why` string; the compiler rejects any entry missing one (an unexplainable weight is a design smell, and the `why`s are what Nightingale reports quote when drift traces back to coupling).
- **Compile is strict**: unknown dim names (including engine dims that are not coupling dims, e.g. `focus`), non-numeric weights, |w| > 1, duplicate (from,to) pairs, missing/empty `why` (matrix entries AND form rules), form-rule θ outside [-1,1], |gain| > 1, λ outside (0,1], a `version` that is not a positive integer, unknown top-level / entry / rule keys, and malformed YAML all throw at startup naming the entry. No partially compiled coupling ever exists (same one-artifact discipline as M12).
- **`modulate` is pure and capped**: `clamp(aᵀMe + formRules, −λ, +λ)` with λ = 0.25 of the normalized score range. Form rules add `gain · max(0, a_dim − min)` when the candidate's tag set contains `boostTag` — the θ threshold IS the rule's `when.min`. The cap is enforced inside `modulate`; callers cannot un-cap it.
- Neutral state (zero vector) ⇒ `modulate` returns ~0 for every candidate (exact 0 when no form rule fires; form rules are evaluated on the live vector, which is 0 only in fixtures — hence "~0" property bound: |result| ≤ Σ|gain|·0 = 0 ⇒ exactly 0. The property test pins exact equality).
- **Anti-escalation contract** (§5.3): under a high-aversion live state, the selected exemplar set's mean expressed aversion must not exceed the input's. Aversion metric (as enforced in test): mean over the 5 aversive dims (sadness, fear, anger, shame, disgust) of `max(0, value)` — input uses her signature vector, a selected set uses the mean of its candidates' signatures. The mechanics live in the corrective off-diagonals of `coupling.yaml`; the replay test is this module's duty to make executable, and a live probe (M19) repeats it against the real model. If someone edits `coupling.yaml` to break it, this test goes red — that is the point. (The metric is deliberately a test-side helper for now; promote it into src/coupling when M19 wants to call the same code.)
- The double-dipping guard λ = 0.25 exists because `[AFFECT]` states her mood in text while coupling skews selection toward the same mood — compounding is the failure mode; the cap bounds selection's share of it to a bias, never a spiral.
- Module has no I/O beyond reading the yaml text handed to `compileCoupling` (composition loads the file); no clock, no rng, no events. Emits nothing.

## Not this module's job
- Affect state itself — M05-affect (this module imports its vocab + `AffectState` type).
- Selection, quotas, coherence — M11-assemble consumes `modulate`'s number; it never re-scales it.
- Writing or auto-tuning `coupling.yaml` — hand-tuned by the human; credit (M10) never touches M (§2.1 non-goals).
- Rendering the `[AFFECT]` text — M05's `weatherLine`, placed by M11.

## What M11 (assembler) consumes — the exact handoff
- `compileCoupling(yamlText)` once at composition; the `CompiledCoupling` travels in `AssembleDeps.coupling`.
- Per turn: `signature(state, COUPLING_BASELINES)` → the live `Vec12` (deviation coords).
- Per candidate: candidate carries `sig: SparseVec12` (its own affect signature, from the exemplar schema) and `tags: string[]`.
- Score: `score = baseScore + modulate(a, candidate.sig, candidate.tags, coupling) + 0.15 · (creditW − 1)` — the modulation term is added, never re-scaled; λ is already enforced inside `modulate`.
- Reporting: the per-slot modulation number lands in `PacketRecord.slots[].modulation` so Nightingale can trace why a turn sounded the way it did.

## Acceptance criteria (all verified at S3 — 69 tests in test/coupling, green)
- [x] `signature` matches the normalization formula exactly on a boundary table (at baseline, at 0, at 1, at −0.5, beyond clamps) for all 12 dims, plus the live-vs-mood layer split and the valence↔pleasure handshake.
- [x] `compileCoupling` reject table: unknown dim, missing `why` (entry and rule), |w| > 1, duplicate pair, θ/gain/λ/version shapes, unknown keys, malformed YAML — each throws a namespaced CouplingError naming the entry, and no partial artifact ever escapes.
- [x] `modulate` neutral-state ⇒ exactly 0 for θ ≥ 0 rules (committed file pinned separately — see deviation note 2); bounded within ±0.25 over 500 seeded adversarial triples and the all-extremes corner.
- [x] Per-entry monotonicity: each entry moves a unit-target candidate exactly w·Δ with strict monotonicity across the range and an exact no-cross-dim-contamination decomposition over 200 seeded trials.
- [x] **Anti-escalation replay**: over the scripted escalation (r1-friction → r2-sharp → r3-spiral, run through the real M05 engine), selected-set aversion ≤ input aversion every round and non-increasing across rounds; at peak the top-3 is repair material and zero tension bait.
- [x] The committed `coupling.yaml` itself compiles (CI test over the real file — config rot fails the build).
- [x] λ cap verified end-to-end: base-gap > 2λ never inverts over 200 seeded trials (worst-case rails at ±0.25 shown directly); inside 2λ the order CAN bend.

## Test checklist (delivered as test/coupling/{space,compile,modulate,properties,replay}.test.ts + helpers.ts)
- unit: signature boundary table; compile reject table; `modulate` math goldens (hand-computed aᵀMe cases); form-rule θ/gain edges; cap behavior at extremes.
- property: neutral ⇒ 0; boundedness; monotonicity; anti-escalation over constructed signatures (no embeddings needed).
- component: `coupling.yaml` compiles + satisfies the anti-escalation property as committed; the replay exercises the "cap prevents modulation-only selection" invariant (base-gap > 2λ never inverts).
- fixtures: constructed signature sets and the 12-candidate POOL live in test/coupling/helpers.ts (shared shape with M11's coherence tests); the committed coupling.yaml is read from the repo root; adversarial yaml variants are built in-test by string surgery on a minimal valid document.

## Deviations & notes (as built at S3 — nothing silently deviated)
1. **`coupling.yaml` comma-quoting repair** (file touched outside this module's three directories — deliberate, disclosed). The committed file had 8 `why:` scalars containing commas inside YAML flow mappings unquoted; lenient parsing silently truncated those whys and fabricated phantom null keys, so the file did not compile (failing the spec's own acceptance criterion). Fix: single-quoted those 8 scalars; every word of every why preserved, no numbers or structure touched, no `version` bump (no behavior change).
2. **KNOWN DEVIATION — the two committed `quiet` form rules have θ = −0.4 and fire at neutral.** `gain·max(0, a−θ)` cannot express the below-threshold intent written in their whys ("low energy favors the quiet room"): at the zero vector both rules evaluate `gain·0.4`, so a quiet-tagged candidate receives +0.072 at exact neutral instead of 0. Pinned by a test explicitly titled KNOWN DEVIATION so it cannot rot silently. Decision needed from the human: enforce θ ≥ 0 in `coupling.yaml`, or extend the form-rule schema with a `below`/`above` flag (spec change). Do not "fix" in code.
3. **`dominance` is never read as a `from` dim.** The matrix rewards dominance in candidates (anger→dominance, fear→dominance) but no entry reads her live dominance — pinned by the sparsity-is-honest test. Intentional for now (the correctives reach for grounded material without asking how dominant she feels) but worth a look when the matrix is next hand-tuned.
4. **Interface extensions beyond the original spec text**, all additive: `CouplingConfig.version` (carried from yaml); `why` required on form rules as well as matrix entries; compile guards for θ ∈ [-1,1], |gain| ≤ 1, λ ∈ (0,1], positive-integer version, and unknown keys at every level; the `Baselines`/`COUPLING_BASELINES`/`DIM_INDEX` surface; `AFFECT_DIMS` imported from `schemas/exemplar.ts` rather than redeclared (one constant, three consumers, drift-guarded both directions).

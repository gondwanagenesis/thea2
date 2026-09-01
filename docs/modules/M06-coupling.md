---
module: M06
name: coupling
syncedTo: spec-v1 (no code yet)
stage: S3
depends: [M01-kernel, M05-affect]
---
# M06 — coupling

## Responsibility
The affect→exemplar coupling: the piece that makes emotion a first-class selector rather than a text sticker. Owns the 12-dim deviation space, the extraction of a live signature from `AffectState`, the hand-tuned modulation matrix `M` (with a `why` per entry), the form rules, and the capped, pure `modulate()` consumed by the assembler (M11). Includes the standing **anti-escalation** property — under high tension, selection must reach for repair, not more tension — which is the structural answer to Thea1's [AFFECT]-text-plus-tense-exemplars spiral risk (§5.3).

## Interfaces (contract)
```ts
// 12-dim deviation space: PAD + the real 9 Thea1 primaries (vocab imported from M05 — one constant, three consumers).
export const AFFECT_DIMS = ['valence','arousal','dominance',
  'joy','anticipation','pride','surprise','sadness','fear','anger','shame','disgust'] as const;
export type AffectDim = AFFECT_DIMS[number];
export type Vec12 = Float64Array;      // length 12, each entry in [-1,1] deviation coords
export type SparseVec12 = Partial<Record<AffectDim, number>>;

export const signature: (s: AffectState, baseline: Baselines) => Vec12;
//   a_k = clamp((x_k − b_k) / max(b_k, 1−b_k), −1, 1)

export interface CouplingConfig {
  lambda: number;   // modulation cap, 0.25 — selection may be bent, never ruled
  matrix: Array<{ from: AffectDim; to: AffectDim; w: number; why: string }>;
  formRules: Array<{ when: { dim: AffectDim; min: number }; boostTag: string; gain: number }>;
}

export interface CompiledCoupling { cfg: CouplingConfig; m: Float64Array; /* 12×12, sparse-backed */ }

export const compileCoupling: (yamlText: string) => CompiledCoupling; // throws on any invalid entry
export const modulate: (a: Vec12, e: SparseVec12, tags: string[], cfg: CompiledCoupling) => number;
//   clamp(aᵀMe + Σ gain·max(0, a_dim − θ)·hasTag, −λ, +λ)
```

## Behavior spec
- **Signature extraction is normalization, not vibe**: each dim's deviation from its Thea1 baseline (M05's `PRIMARY_BASELINE`, PAD homes) scaled by `max(b_k, 1−b_k)` and clamped to [-1,1]. A calm baseline day maps to ~0 — coupling is silent when she's unremarkable, by design.
- **`M` is hand-tuned, versioned, and located at `coupling.yaml` in the repo root** (committed, reviewed like code). Diagonal entries are mood-congruence (sad state → sad-tagged exemplars surface). The off-diagonals are the deliberate corrective moves: tension dims → **repair** exemplars, not more tension. Every entry carries a `why` string; the compiler rejects any entry missing one (an unexplainable weight is a design smell, and the `why`s are what Nightingale reports quote when drift traces back to coupling).
- **Compile is strict**: unknown dim names, non-numeric weights, |w| > 1, duplicate (from,to) pairs, missing `why`, or a form rule naming a dim outside `AFFECT_DIMS` all throw at startup naming the entry. No partially compiled coupling ever exists (same one-artifact discipline as M12).
- **`modulate` is pure and capped**: `clamp(aᵀMe + formRules, −λ, +λ)` with λ = 0.25 of the normalized score range. Form rules add `gain · max(0, a_dim − min)` when the candidate's tag set contains `boostTag` — the θ threshold IS the rule's `when.min`. The cap is enforced inside `modulate`; callers cannot un-cap it.
- Neutral state (zero vector) ⇒ `modulate` returns ~0 for every candidate (exact 0 when no form rule fires; form rules are evaluated on the live vector, which is 0 only in fixtures — hence "~0" property bound: |result| ≤ Σ|gain|·0 = 0 ⇒ exactly 0. The property test pins exact equality).
- **Anti-escalation contract** (§5.3): under a high-aversion live state, the selected exemplar set's mean expressed aversion must not exceed the input's. The mechanics live in the corrective off-diagonals of `coupling.yaml`; the property test is this module's duty to make executable, and a live probe (M19) repeats it against the real model. If someone edits `coupling.yaml` to break it, this test goes red — that is the point.
- The double-dipping guard λ = 0.25 exists because `[AFFECT]` states her mood in text while coupling skews selection toward the same mood — compounding is the failure mode; the cap bounds selection's share of it to a bias, never a spiral.
- Module has no I/O beyond reading the yaml text handed to `compileCoupling` (composition loads the file); no clock, no rng, no events. Emits nothing.

## Not this module's job
- Affect state itself — M05-affect (this module imports its vocab + `AffectState` type).
- Selection, quotas, coherence — M11-assemble consumes `modulate`'s number; it never re-scales it.
- Writing or auto-tuning `coupling.yaml` — hand-tuned by the human; credit (M10) never touches M (§2.1 non-goals).
- Rendering the `[AFFECT]` text — M05's `weatherLine`, placed by M11.

## Acceptance criteria
- [ ] `signature` matches the normalization formula exactly on a boundary table (at baseline, at 0, at 1, beyond clamps) for all 12 dims.
- [ ] `compileCoupling` reject table: unknown dim, missing `why`, |w| > 1, duplicate pair, malformed form rule — each throws naming the entry.
- [ ] `modulate` neutral-state ⇒ exactly 0; bounded within ±0.25 for arbitrary adversarial inputs (property, seeded).
- [ ] Per-entry monotonicity: raising a single live dim strictly increases (w > 0) or decreases (w < 0) the score for a fixed candidate, before the cap.
- [ ] **Anti-escalation replay**: over a seeded corpus of tagged candidates and high-tension states, mean expressed aversion of the top-quota set ≤ input aversion — holds with the committed `coupling.yaml`.
- [ ] The committed `coupling.yaml` itself compiles (a CI test over the real file — config rot fails the build).
- [ ] λ cap verified end-to-end: a synthetic candidate scored far above quota peers cannot be pulled in by modulation alone.

## Test checklist
- unit: signature boundary table; compile reject table; `modulate` math goldens (hand-computed aᵀMe cases); form-rule θ/gain edges; cap behavior at extremes.
- property: neutral ⇒ 0; boundedness; monotonicity; anti-escalation over seeded candidate pools (FixedEmbedder-style constructed signatures, no embeddings needed).
- component: `coupling.yaml` compiles + satisfies the anti-escalation property as committed; a compiled-coupling → mock-selector integration exercising the "cap prevents modulation-only selection" invariant.
- fixtures needed: constructed signature sets (shared with M11's coherence tests); the committed coupling.yaml; adversarial yaml variants for the reject table.

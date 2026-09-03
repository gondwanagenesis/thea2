---
module: M11
name: assemble
syncedTo: S8 (contrast placement/label, register-strictness dial — 2026-09-02)
stage: S4
depends: [M01-kernel, M04-embed, M06-coupling, M07-corpus, M09-memory]
---
# M11 — assemble

## Responsibility
The one synchronous selection step. Given a turn query, the current affect signature, and the registered nominators, produce the context packet for a deliberation entry: fill the character-channel exemplar quotas and the separate procedural-channel quota (the two channels never compete for slots), score candidates, run the deterministic coherence layers, enforce the token budget, and render the flat packet in the fixed section order. Pure function of (query, affect, indexes, config, rng) — fully hermetic, no I/O, no model calls, no clock. Returns the packet plus a `PacketRecord` describing every shipped slot; the caller emits that record to events for credit assignment.

## Interfaces (contract)
```ts
export const assemble: (q: TurnQuery, a: Vec12, deps: AssembleDeps) => Promise<Packet>;
export const proceduralQuota: (q: TurnQuery) => 0 | 1 | 2;   // pure action-intent classifier
export const gravityMultiplier: (tier: CandidateTier, source: SourceKind | 'memory', g: number) => number;
export const DEFAULT_ASSEMBLE_CONFIG: AssembleConfig;
export const assembleConfigFromControls: (controls: CorpusControls) => AssembleConfig;

export interface TurnQuery {
  entry: 'user-turn' | 'heartbeat' | 'ponder';
  text?: string;
  goal?: string;
  speaker: SpeakerRef;              // { person, channel } — structural mirror of M15's shape
  register: 'work' | 'friend' | 'play';
  queryVec: Float32Array;
  recentTurnIds: string[];          // for nominators to suppress, not for the assembler
  channels?: { character: boolean; procedural: boolean }; // default both true; workers pass character:false
  turnId?: string;                  // caller's id for the record; content-hash fallback when absent
}

export interface Nominator { name: string; channel: PacketChannel; nominate(q: TurnQuery, k: number): Promise<Candidate[]>; }

export interface Candidate {
  id: string;
  channel: PacketChannel;           // normalized to the NOMINATOR's channel at intake
  tier: CandidateTier;              // 'disposition' | 'pattern' | 'episode' | 'memory' | 'procedure'
  baseScore: number;                // relevance · recency · authorial weight · gravity (applied by the nominator)
  creditW: number;                  // read-only here; M10 clamps [0.5, 2.0] upstream
  sig: SparseVec12;
  vec?: Float32Array;
  tags: string[];                   // register tags (modes + modifiers)
  source: SourceKind | 'memory';
  dimension?: Dimension;            // for exclusions.yaml dimension_caps
  render(): string;
}

export interface Packet {
  sections: Partial<Record<Section, string>>; // only non-empty sections; never 'INHIBITION'
  itemIds: string[];                // every rendered item id, in appearance order: MEMORY → EXEMPLARS → PROCEDURAL
  systemText(): string;             // the 7 character sections, fixed order, byte-exact
  proceduralText(): string | null;  // [PROCEDURAL] block; null when quota 0 or channel masked
  trailerText(): string;            // [INHIBITION] verbatim (header included)
  record(): PacketRecord;
}

export interface PacketRecordSlot {
  exemplarId: string;
  tier: CandidateTier;
  channel: PacketChannel;
  baseScore: number;                // as nominated (gravity included)
  modulation: number;               // M06's term as computed — the caller emits this for credit
}
export interface PacketRecord {
  turnId: string;
  slots: PacketRecordSlot[];        // snapshot of the END state, budget drops included
  affectSig: number[];              // Vec12 snapshot of `a` at assembly time
  coherence: 'ok' | 'degraded';
  flags: { scarcity: boolean; staleDerived: boolean };
}

export interface AssembleDeps {
  nominators: Nominator[];          // corpus + memory (character) + ProceduralStore (procedural)
  coupling: CompiledCoupling;       // M06 — compile once at composition, inject here
  weatherLine: string;              // [AFFECT] one-liner from M05, rendered verbatim
  inhibitionBlock: string;          // M12.renderPromptBlock() output, header included
  cfg: AssembleConfig;
  rng: Rng;                         // accepted for contract stability; never drawn (see determinism)
  identityBlock?: string;           // corpus/canon/identity.md text; absent ⇒ no [IDENTITY] section
}
```
Layout: `src/assemble/{types,errors,score,rules,quota,coherence,budget,render,assemble}.ts` + barrel `index.ts`. Errors: `assemble/config` (inconsistent cfg), `assemble/bad-candidate` (non-finite score input at intake).

## Behavior spec — pinned decisions
- **Two channels, never competing (ADR-009).** Character groups cut from the character pool; the procedural quota cuts from the procedural pool. Track membership is decided by the NOMINATOR's channel — the candidate's `channel` field is normalized to it, and a tier-inconsistent candidate is dropped at intake (a procedure can only enter through a procedural-channel nominator; a character nominator cannot relabel one in). A rejecting nominator propagates — a silent half-packet must not look like a working one.
- **Procedural quota** (`proceduralQuota`, pure): signals = hasGoal + `entry === 'ponder'` + tool-suggestive text (22 word-boundary-anchored stems: run/deploy/grep/ssh/logs/…). 0 signals → 0, 1 → 1, ≥2 → 2, never more. Conservative by design: a false 1 wastes one nominator probe; an over-eager battery would pin [PROCEDURAL] onto ordinary chat.
- **Character quotas (hard)**: 1 disposition + 2 pattern + 2–3 episode+memory + 1 contrast = 7. Fill order, with eligibility per group:
  1. *disposition* — tier `disposition` AND source `canon`; exempt from the mode filter; **no backfill, ever** (ADR-006).
  2. *pattern* — tier `pattern` (a non-canon candidate mislabeled `disposition` is demoted here rather than wasted — the canon-only law guards the slot, not the material); mode filter applies.
  3. *episode+memory* — tier `episode`/`memory` first, then **seed backfill from the ranked leftovers**, so an empty lived corpus still fills the quota from canon (the launch condition; backfill material is real ranked canon, not padding).
  4. *contrast* — leftovers that still pass the mode filter, forbidden pairs, and dimension caps, ranked by **max dissimilarity = Euclidean distance in the dense 12-dim deviation space from the packet's mean signature**. Signature space, not embedding space: every candidate carries a signature while `vec` is optional, and the slot's job is to pull against the packet's emotional center of mass. Score breaks distance ties, then id.
- **Scarcity is honest**: any character group below its floor sets `flags.scarcity`; nothing is ever padded. A cold procedural store is the normal early state, **not** scarcity (`fillProcedural` never sets it); a masked character channel (worker packet) is a composition decision, also not scarcity.
- **Mode exclusivity**: every non-disposition slot only admits candidates register-compatible with `q.register` (keyed on the mode tags play/work/friend).
- **Nominators rank, the assembler cuts**: each character nominator is asked `characterAsk(cfg) = quota total × poolFactor (4)` deep; each procedural nominator `quota` deep.
- **Scoring law**: `score = baseScore + modulate(a, sig, tags) + γ·(creditW − 1)`, γ = 0.15, additive. The modulation term is ADDED, never re-scaled — λ = 0.25 is enforced inside M06's `modulate`; re-scaling here would reopen Thea1's escalation path by another name. Credit biases ties, it never vetoes. Gravity is NOT applied here: `gravityMultiplier` is exported so the nominator applies it (ADR-005: pattern/episode tiers only; seed → 2g, lived → 2(1−g); g default 0.7).
- **Coherence** — five deterministic layers, fixed order, ≤ `maxSwapRounds` (3) rounds, then accept with `coherence: 'degraded'`. Each swap replaces the offender from the offending group's own runner list; the replacement joins the **END** of the members list (so subsequent scans see it last); swapped-out candidates are recorded in `group.out` and never return within the assembly; a swap with no runner left **drops** the slot instead of padding.
  1. *forbidden-pairs* — pairs from `forbiddenPairs` (crisis×banter, precision×banter, late-night×morning); contrast slot included; offender = lower-scored member of the offending pair.
  2. *dimension-caps* — ≤ `dimensionCaps[dim]` members per dimension (boundaries 1, emotional-range 2); a cap lifts when `dimensionMatchWords[dim]` matches the query text/goal; offender = lowest-scored carrier of the capped dimension.
  3. *register-tags* — the allowed set is the `maxRegisterTags` (2) most common tags across the packet (count desc, tag asc on ties); offender = lowest-scored carrier of a tag outside the set; the disposition group and the contrast group are exempt.
  4. *signature-spread* — per affect dim, max−min ≤ `spreadMax` (1.2) across selected signatures; contrast exempt (a far signature is the point of that slot); on a midpoint tie the first extreme in slot order is named the offender.
  5. *embedding-sanity* — pattern/episode-tier members only (memory-tier slots need no vector): pass if cos(vec, queryVec) ≥ `minQueryCos` (0.15), else rescued by cos(vec, packetCentroid) ≥ `minCentroidCos` (0.35). `vec === undefined` **always fails** — unverifiable is not sane (short-circuits before any threshold check).
  Coherence is a character-channel concern: procedure candidates carry no register tags, no signature, and no pattern/episode tier, so the layers have nothing to say about them.
- **Render** — fixed order `[IDENTITY][GOAL][INTERLOCUTOR][MEMORY][AFFECT][REGISTER][EXEMPLARS]`, header line `[X]\n` per section, empty sections skipped, items joined by a blank line. Bodies are quoted **verbatim** from `render()` — M07's parsed bodies carry the file's trailing newline, so exemplar items end with one. `[INTERLOCUTOR]` renders `` `${person} on ${channel} (register: ${register})` ``. `[AFFECT]` is `deps.weatherLine` verbatim (the assembler never computes affect). `[PROCEDURAL]` is a separate block from `proceduralText()` — the loop places it beside the tool definitions, never inside [EXEMPLARS]. `[INHIBITION]` is the trailer, `deps.inhibitionBlock` verbatim (header included), never present in `sections`.
- **Token budget (§2.7)** — `countTokens` (M07's whitespace-split counter) is the unit of account, so the arithmetic is exact and testable. Per-section budgets trim [EXEMPLARS] and [MEMORY] by lowest score first; then the total budget in the pinned overflow order: lowest procedural exemplar → lowest character exemplar → [MEMORY] items while more than `MEMORY_TRIM_TARGET` (3). Past that, the packet **ships over budget** — and caller-owned oversize (e.g. a giant identity block) is never rewritten to fit; the loop drops only what it owns.
- **Determinism** — every choice is a total order (score desc, id asc — the repo convention) on the FINAL score; the seeded rng is accepted for contract stability and consumed for nothing, so the packet is byte-identical across instances for identical inputs regardless of seed. A missing `turnId` falls back to `turn-<16 hex of contentHash(query)>` — deterministic, but callers should supply the real one. Neutral affect ⇒ `modulate` returns exactly 0 per slot, so a θ ≥ 0 coupling document yields a byte-identical packet to no coupling at all.
- **`flags.staleDerived`** is config-supplied (M08's dirty-derived set, computed upstream) and surfaced verbatim, so status/Nightingale can correlate packet quality with corpus staleness.
- **Config validation**: `assemble/config` for non-finite/out-of-range gravityG, an inconsistent quota table, non-positive budgets, incoherent coherence thresholds. Intake rejects any candidate with a non-finite baseScore/creditW/signature value (`assemble/bad-candidate`) — a non-finite score would make every sort comparator inconsistent, i.e. nondeterminism with no seed.

## Spec deviations (decisions taken while implementing)
- `identityBlock` added to `AssembleDeps`: the identity anchor is canon prose, not an exemplar, so no nominator carries it — it must be injected directly.
- `turnId` added to `TurnQuery`: the assembler has no clock and mints no ids; the fallback is a content hash.
- `rng` is accepted but never drawn: total orders everywhere make it redundant, and seed-independence is a stronger guarantee than per-seed determinism (both are tested).
- Token unit is `countTokens` (whitespace split, M07's own counter) — one definition of "token" across corpus and budget, exact in tests.
- Contrast metric is Euclidean distance in signature space (spec says "max-dissimilar"; the space is now pinned, with the reason above).
- L1c (register tags) exempts the disposition group as well as the contrast group: the keel may carry a third modifier by design, and layer 1's job is packet-level texture, not policing the keel.
- Layer inventory is five scanners (forbidden-pairs, dimension-caps, register-tags, signature-spread, embedding-sanity) under the spec's "three layers" — the spec's layer 1 was three separate rules; splitting them makes each swap rule individually pinnable. Round accounting is unchanged (≤3).
- `dimensionCaps` defaults ship in code, mirrored from the committed `exclusions.yaml`; `assembleConfigFromControls` wires loaded controls so a yaml edit is not silently outrun.
- KNOWN, upstream: the committed `coupling.yaml` quiet rules have θ = −0.4, so at flat affect a quiet-tagged candidate takes modulation **+0.072 exactly** ((0.10+0.08)·0.4). The "neutral affect ⇒ exactly 0" law holds for θ ≥ 0 documents; a θ ≥ 0 filter is tested byte-identical to no coupling.
- **As built (Package E, 2026-09-02)**:
  - **Contrast placement + label** (`render.ts`): the contrast slot renders BEFORE the episode-memory exemplars — `[disposition, pattern, contrast, episodes]` — under the one-word label `elsewhere:` on its own line above the item (`CONTRAST_LABEL`). The foreign body lands mid-packet, named, where it can still bend generation. `record().slots` follows the rendered order.
  - **Register strictness dial** (`quota.ts`): `mode_exclusive` itself lives in `rules.ts` (`modeCompatible`, not quota-owned), so the `strict?: boolean` config flag and its consumption land in `quota.ts` (`FillConfig = AssembleConfig & RegisterStrictness`). Default (`strict !== false`) keeps the shipped exclusion law; `strict: false` admits out-of-register candidates at a fill-time penalty — a total order (register-compatible first, then score desc, id asc) that never rewrites `baseScore`. Round 3 owns: promoting the flag into `AssembleConfig`/`DEFAULT_ASSEMBLE_CONFIG` (`types.ts`) and deciding whether the penalty becomes a graded score term in `score.ts`.
  - Exemplar items render through M07's frame (`situation: <context>` above each body — see M07), so the byte-exact golden in `test/assemble/assemble.test.ts` was deliberately updated (frame lines + contrast placed before episodes).

## Not this module's job
- Affect state, weather-line computation — M05-affect.
- Modulation math and the λ cap — M06-coupling (consumed via `modulate`).
- Exemplar parsing, lint, corpus indexing, embeddings — M07-corpus / M04-embed.
- Episode recall internals, session window — M09-memory.
- Inhibition rule semantics and the block's wording — M12-inhibit (assembler only places the rendered text).
- Message-array layout, tool defs, function calling, spawn/channel-mask decisions — M13-loop.
- Emitting the PacketRecord to the event log — the caller (M13 / M20 pipeline).
- Credit-weight updates and gravity/seedRatio metrics — M10-consolidate.

## Acceptance criteria
- [x] Quotas fill from canon/derived alone when lived and memory are empty; scarcity flagged, no throw.
- [x] Channel-bleed invariant: no procedure-kind candidate ever renders into [EXEMPLARS]; no character candidate into [PROCEDURAL] (adversarial nominator test).
- [x] `proceduralQuota` returns 0 for a plain social user-turn without a goal, ≥1 for a goal-bearing entry, never >2 (word-boundary table).
- [x] Section order byte-exact; [PROCEDURAL] and [INHIBITION] returned as separate blocks, never merged into systemText().
- [x] Packet ≤ 6k tokens; section budgets and the stated overflow order enforced; caller-owned oversize ships over budget.
- [x] Coherence layers use the exact thresholds (≤2 register tags, spread ≤ 1.2, cos ≥ 0.15 / ≥ 0.35, ≤3 swaps, degraded flag); each layer's offender/replacement/drop rule pinned.
- [x] Contrast slot is max-dissimilar, exempt from signature spread and register tags, still bound by tag exclusivity and dimension caps.
- [x] score = baseScore + modulate + 0.15·(creditW−1); gravity multipliers 2g / 2(1−g), g default 0.7; disposition slot canon-only.
- [x] Deterministic across seeds (rng never drawn); neutral-affect packets byte-identical with coupling on/off.
- [x] `record()` lists every slot with channel and modulation; a character:false packet carries zero character slots.

## Test checklist (all in test/assemble/, 67 tests)
- quota.test: proceduralQuota classifier table; abundant-canon exact fill; seed-backfill launch condition; scarcity honesty; derived-statement demotion; mode exclusivity; channel-bleed adversarial property; dedupe; mask/quota gating of nominator asks; procedural top-2; fill determinism.
- coherence.test: layer inventory order; per-layer offender/replacement/drop tables; cap lift; exemptions (disposition, contrast); L3 no-vec and centroid rescue; precedence; 3-round degraded; never-returns; zero-round clean pass.
- contrast.test: max-dissimilarity beats score; distance from packet mean; ineligible-far skip; tie by score then id; empty leftovers → scarcity.
- budget.test: exact 100-word-body arithmetic; per-section trims; total overflow order; MEMORY_TRIM_TARGET floor + ships-over-budget; measured-text consistency; giant identity survival.
- assemble.test: byte-exact golden render; record shape + scoring snapshot; [MEMORY] section; [PROCEDURAL] separate block; coherence through the real pipeline at default thresholds; scoring law (exact, credit ties, λ cap); per-seed AND seed-independent determinism; turnId fallback; coupling neutral/committed integration; worker packet; staleDerived; anti-escalation under the r3 spiral through the committed coupling document.
- fixtures: 14-file hand-vectored canon corpus (orthonormal 3-d geometry, exact rankings), candidate/nominator doubles, zero coupling, neutralized-coherence config.

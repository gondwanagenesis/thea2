---
module: M11
name: assemble
syncedTo: spec-v1 (no code yet)
stage: S4
depends: [M01-kernel, M04-embed, M06-coupling, M07-corpus, M09-memory]
---
# M11 — assemble

## Responsibility
The one synchronous selection step. Given a turn query, the current affect signature, and the registered nominators, produce the context packet for a deliberation entry: fill the character-channel exemplar quotas and the separate procedural-channel quota (the two channels never compete for slots), score candidates, run the deterministic coherence layers, enforce the token budget, and render the flat packet in the fixed section order. Pure function of (query, affect, indexes, config, rng) — fully hermetic, no I/O, no model calls. Returns the packet plus a `PacketRecord` describing every filled slot; the caller emits that record to events for credit assignment.

## Interfaces (contract)
```ts
export interface TurnQuery {
  entry: 'user-turn' | 'heartbeat' | 'ponder';
  text?: string;
  goal?: string;
  speaker: SpeakerRef;
  register: 'work' | 'friend' | 'play';
  queryVec: Float32Array;
  recentTurnIds: string[];
  channels?: { character: boolean; procedural: boolean }; // default both true; task/cast workers pass character:false
}

export type PacketChannel = 'character' | 'procedural';

export interface Nominator { name: string; channel: PacketChannel; nominate(q: TurnQuery, k: number): Promise<Candidate[]>; }

export interface Candidate {
  id: string;
  channel: PacketChannel;
  tier: 'disposition' | 'pattern' | 'episode' | 'memory' | 'procedure';
  baseScore: number;          // relevance · recency · authorial weight · gravity multiplier
  creditW: number;            // learned credit weight in [0.5, 2.0]; 1.0 when unknown (read-only here)
  sig: SparseVec12;
  vec?: Float32Array;
  tags: string[];
  source: 'canon' | 'derived' | 'lived' | 'memory';
  render(): string;
}

export type Section = 'IDENTITY'|'GOAL'|'INTERLOCUTOR'|'MEMORY'|'AFFECT'|'REGISTER'|'EXEMPLARS'|'PROCEDURAL'|'INHIBITION';

export interface Packet {
  sections: Partial<Record<Section, string>>;
  itemIds: string[];
  systemText(): string;             // the 7 character sections, fixed order
  proceduralText(): string | null;  // [PROCEDURAL] block, null when the quota resolved to 0
  trailerText(): string;            // [INHIBITION]
  record(): PacketRecord;
}

export interface PacketRecord {
  turnId: string;
  slots: Array<{ exemplarId: string; tier: Candidate['tier']; channel: PacketChannel; baseScore: number; modulation: number }>;
  affectSig: number[];              // Vec12 snapshot
  coherence: 'ok' | 'degraded';
  flags: { scarcity: boolean; staleDerived: boolean };
}

export interface AssembleDeps {
  nominators: Nominator[];   // corpus + memory (character) + ProceduralStore (procedural); later: threads
  coupling: CompiledCoupling;      // M06
  weatherLine: string;             // [AFFECT] one-liner, computed by M05
  inhibitionBlock: string;         // rendered by M12.renderPromptBlock(), <= 300 tokens
  cfg: AssembleConfig;             // quotas, budgets, gravity g, coherence thresholds
  rng: Rng;
}

export const assemble: (q: TurnQuery, a: Vec12, deps: AssembleDeps) => Promise<Packet>;
export const proceduralQuota: (q: TurnQuery) => 0 | 1 | 2;   // pure action-intent classifier
```

## Behavior spec
- Two channels (owner delta), never competing for slots. Character channel = voice/pattern/disposition/episode exemplars + affect + register (shapes what she says; backed by corpus + episodic/social memory). Procedural channel = tool-use and delegation exemplars {situation -> call -> args -> result -> outcome}, outcome-scored (shapes when/how she reaches for tools; backed by a separate ProceduralStore's nominator). Candidates carry `channel`; a slot never crosses channels.
- Character quotas (hard): 1 disposition (canon-only, permanently), 2 pattern, 2–3 episode+memory, 1 contrast = the max-dissimilar candidate that still passes register constraints. Memory-tier slots render into [MEMORY]; episode-tier into [EXEMPLARS]. With an empty lived corpus, quotas must still fill from canon/derived (launch condition); an unmet quota sets `flags.scarcity`, never throws.
- Procedural quota: 0–2, keyed on action intent via `proceduralQuota(q)` (pure): 0 for a plain social turn with no goal and no tool-suggestive text; 1–2 when the entry carries an explicit goal, committee/GROUND work, or tool-suggestive query signals. Procedure candidates are outcome-aware: `outcome: 'good'` boosts, `'bad'` demotes within baseScore.
- Scoring: `score = baseScore + modulate(a, e, tags) + 0.15·(creditW − 1)`. baseScore multiplies relevance · recency · authorial weight (`Exemplar.weight`) · gravity multiplier. Learned credit enters only through the additive γ = 0.15 term (biases ties, never overrides relevance); creditW is clamped [0.5, 2.0] upstream by M10 — the assembler only reads it.
- Gravity (§2.4): seed = canon + derived; `seedMult = 2g`, `livedMult = 2(1−g)`; g default 0.70 for month 1, glidepath note to 0.55; applies to pattern and episode tiers only.
- Affect modulation is capped at λ = 0.25 of the normalized score range (enforced inside M06's `modulate`; the assembler passes compiled config and never re-scales).
- Coherence (§2.2): three deterministic layers after quota fill; each offender replaced from the ranked runner-up list; at most 3 swap rounds, then accept with `coherence:'degraded'`. (1) Tag exclusivity: ≤2 distinct register tags per packet; forbidden pairs from exclusions.yaml; ≤1 `boundaries` exemplar unless the query matches boundary tags. (2) Signature spread: per affect dim, max−min ≤ 1.2 across selected exemplars; the contrast slot is exempt from this layer only. (3) Embedding sanity: every pattern/episode exemplar needs cos(vec, queryVec) ≥ 0.15 OR cos(vec, packetCentroid) ≥ 0.35.
- Render order is fixed and byte-exact: [IDENTITY][GOAL][INTERLOCUTOR][MEMORY][AFFECT][REGISTER][EXEMPLARS]. [PROCEDURAL] is a separate block returned by `proceduralText()` — the loop places it adjacent to the tool definitions, never inside [EXEMPLARS]. [INHIBITION] is the trailer, delivered by the loop as a trailing system message; its text is `deps.inhibitionBlock` (M12 renders it).
- Token budget (§2.7): packet ≤ 6k. Section budgets: identity 150 / goal 100 / interlocutor 150 / memory 600 / affect 30 / register 10 / exemplars ≤ 4k / inhibition 300. Overflow order: drop the lowest-scored procedural exemplar first, then the lowest-scored character exemplar, then trim [MEMORY] items to 3.
- Channel mask: `q.channels.character === false` (task/cast workers) skips every character section — the packet is [PROCEDURAL] plus goal only. Fork entries keep both channels (it's her). The mask decision itself belongs to M13's composition rule.
- [AFFECT] renders `deps.weatherLine` verbatim; the assembler never computes affect.
- Determinism: identical (q, a, indexes, cfg, seed) produces an identical packet; all tie-breaks draw from the forked rng. Neutral affect (zero vector) produces identical packets with coupling on or off.
- `flags.staleDerived` is set when the corpus index reports outstanding dirty derived targets, so status/Nightingale can correlate packet quality with corpus staleness.

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
- [ ] Quotas fill from canon/derived alone when lived and memory are empty; scarcity flagged, no throw.
- [ ] Channel-bleed invariant: no procedure-kind candidate ever renders into [EXEMPLARS]; no character candidate into [PROCEDURAL].
- [ ] `proceduralQuota` returns 0 for a plain social user-turn without a goal, ≥1 for a goal-bearing entry, never >2.
- [ ] Section order byte-exact; [PROCEDURAL] and [INHIBITION] returned as separate blocks, never merged into systemText().
- [ ] Packet ≤ 6k tokens; section budgets and the stated overflow order enforced.
- [ ] Coherence layers use the exact thresholds (≤2 register tags, spread ≤ 1.2, cos ≥ 0.15 / ≥ 0.35, ≤3 swaps, degraded flag).
- [ ] Contrast slot is max-dissimilar, exempt from signature spread, still bound by tag exclusivity.
- [ ] score = baseScore + modulate + 0.15·(creditW−1); gravity multipliers 2g / 2(1−g), g default 0.7; disposition slot canon-only.
- [ ] Deterministic per seed; neutral-affect packets identical with coupling on/off.
- [ ] `record()` lists every slot with channel and modulation; a character:false packet carries zero character slots.

## Test checklist
- unit: quota fill under scarcity matrices; contrast max-dissimilarity property; coherence layer tables over constructed signatures; swap-round cap + degraded flag; budget overflow order; proceduralQuota classifier table; gravity multiplier math; additive credit term.
- component: full `assemble()` with FixedEmbedder geometry, a ~15-exemplar constructed corpus, and a fake procedural nominator; determinism per seed; coupling on/off neutral equality; character:false worker packet.
- fixtures needed: mini canon corpus covering all tiers plus procedure kind; constructed 12-dim signatures; FixedEmbedder string->vector map; test registers.yaml + exclusions.yaml; canned credit weights.

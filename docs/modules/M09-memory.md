---
module: M09
name: memory
syncedTo: spec-v1 (no code yet)
stage: S3
depends: [M01-kernel, M02-events, M03-model, M04-embed]
---
# M09 — memory

## Responsibility
Turn raw conversation into durable, recallable experience: the per-turn **appraisal** (one cheap structured call emitting typed `AffectEvent[]` material, the diary line, thread updates, and the previous packet's outcome grade), the **EpisodeStore** and the separate **ProceduralStore**, recall nominators feeding the assembler's memory slots, the write-only human-readable projections (`journal.md`, `threads.json`), and the rolling **session window** with its eviction summarizer. This module inverts Thea1's pathology 3: affect updates are structured events, never regex-over-prose, and `journal.md` is written, never read.

## Interfaces (contract)
```ts
// Appraisal shape: schemas/appraisal.ts is the reference until S3 migration (Appraisal,
// AppraisedEmotion, ThreadUpdate, OutcomePrev; EmotionTag validated against M05's EMOTION_TAGS).

export const appraise: (ctx: { userText: string; herReply: string | null; plan: 'reply'|'silent'|'defer';
  prevTurnId: string | null }, deps: { model: ModelClient; events: EventLog }) => Promise<Appraisal>;

export interface Episode {
  id: string; ts: number; turnId: string;
  summary: string;            // her experience, first person, one line
  diaryLine: string;          // the appraisal's diary line
  importance: number;         // 1-10
  emotions: AppraisedEmotion[];
  threads: string[];
  affectAtEncoding: number[]; // FULL Vec12 stamp from live state at encoding (mood-congruent memory)
  vec?: Float32Array;         // embedded summary
}

export interface EpisodeStore {
  append(e: Episode): Promise<void>;
  search(vec: Float32Array, k: number): Array<{ e: Episode; score: number }>;
  recent(n: number): Episode[];
  byThread(id: string): Episode[];
}
export const openEpisodeStore: (dir: string, deps: { embedder: Embedder }) => Promise<EpisodeStore>;

// The procedural channel's home — SEPARATE store + index; a tool episode must never
// surface from the episodic nominator (store separation is itself gated in S3).
export interface ProcedureRecord { id: string; situation: string; call: string; args: unknown;
  result: unknown; outcome: 'good' | 'mixed' | 'bad'; ts: number; vec?: Float32Array; }
export interface ProceduralStore {
  append(p: ProcedureRecord): Promise<void>;
  search(vec: Float32Array, k: number): Array<{ p: ProcedureRecord; score: number }>;
}
export const openProceduralStore: (dir: string, deps: { embedder: Embedder }) => Promise<ProceduralStore>;

export const episodicNominator: (s: EpisodeStore) => Nominator;    // character channel, memory tier
export const proceduralNominator: (s: ProceduralStore) => Nominator; // procedural channel

export interface SessionWindow {
  push(msg: { role: 'user' | 'assistant'; content: string; ts: number; turnId: string }): Promise<void>;
  messages(): ChatMsg[];            // verbatim, within min(last 30, 10k tokens)
  earlier(): string | null;         // cached '[EARLIER] …' summary line
}
export const openSessionWindow: (dir: string, deps: { model: ModelClient; clock: Clock }) => SessionWindow;

export const writeProjections: (dir: string, episodes: Episode[], threads: ThreadIndex) => Promise<void>;
```

## Behavior spec
- **Appraisal** — ONE cheap-tier structured call per turn, parsed through M03's ladder against the `Appraisal` schema. Its `emotions[]` are the turn's typed affect events: the pipeline (M20) converts them to `AffectEvent[]` and hands them to M05 — no prose parsing anywhere (pathology 3 inverted). `EmotionTag` is validated against M05's `EMOTION_TAGS`; an unknown tag is a zod reject + `incident.parse_failed`, and per graceful degradation the turn still completes.
- **`outcomePrev`** (credit assignment, §2.1): the appraisal grades the PREVIOUS turn's packet on factual signals only — explicit reactions (bridge captured `message_reaction`), corrections ("you already told me", "that's not it"), warmth/continuation, thread advanced. **Silence contributes 0, never −1** (exogenous). The `evidence` string is logged verbatim (L0 `memory.outcome_prev` event) for audit — the anti-self-grading-bias measure. `null` at session start.
- **EpisodeStore**: `episodes.jsonl` (kernel JsonlStore) + `embeddings.bin` (M04 VectorIndex keyed by episode id). `append` embeds the summary, stamps `affectAtEncoding` from the live state snapshot taken at encoding (the mood-congruence mechanism — memory carries the emotional room it was formed in, which M10 later writes into lived exemplars verbatim). `search` = cosine top-k (M04 semantics, deterministic ordering).
- **ProceduralStore**: `procedural.jsonl` + its own index — a genuinely separate store. Records are `{situation → call → args → result → outcome}` with outcome-scored ranking (good boosts, bad demotes, both before the assembler's score math). Delegation episode events (emitted by M13 spawns) are the feedstock; M10's procedural generator reads them. **Store separation is structural**: no code path can return a ProcedureRecord from the episodic store or vice versa (separate types, separate indexes — and an S3 test asserts a planted tool episode never surfaces from `episodicNominator`).
- **Recall nominators**: `episodicNominator` ranks by `cosine × recency × importance`, returns 3–5 candidates (the packet's 2–3 episode/memory slots draw from here); `proceduralNominator` serves the procedural channel's 0–2 quota keyed on the assembler's action-intent signal. Deterministic (score desc, id asc); no rng.
- **Session window** (§2.7): verbatim user/assistant messages only — intra-turn tool traffic is dropped at decision lock (it survives as episodes + delegation events, not as window noise). Keep `min(last 30 messages, 10k tokens)`; evict from head. On evicting a ≥20-message span, generate ONE cheap-tier summary line (`[EARLIER] …`) and cache it; re-summarize only when the next span evicts. **Session break = 4h silence** (injected clock): window resets to just the summary line — continuity is memory's job, so the packet stays dominant instead of drowning in 100 turns of raw chat (Thea1's compaction pain, stated as the design reason).
- **Projections** (`journal.md`, `threads.json`): write-only, human-readable, rebuilt from episodes by `writeProjections` (M10's nightly reflect also invokes it). journal.md gets the diary lines; threads.json the thread states. **Nothing in Thea2 ever parses these files** — they exist for Diego's eyes (and Thea1-parity debugging), and a lint/test may assert no module reads them.
- **Graceful degradation**: if the appraisal call fails after M03's repair ladder → emit `incident.parse_failed`, skip affect/episode/credit updates for that turn, and let the turn complete. Memory is never allowed to kill a conversation turn.

## Not this module's job
- Deciding affect mechanics — M05 (M09 produces events; M05 owns the engine).
- Quota/selection math — M11-assemble (nominators return ranked candidates; the assembler cuts).
- Lived-exemplar promotion and credit-weight updates — M10-consolidate (reads M09's stores).
- Window placement into the message array — M13-loop (M09 provides `SessionWindow`, the loop renders it).
- Ledger recording of sends/receipts — M15-bridge (a different store).
- Procedural exemplar SYNTHESIS — M08-derive (M09 stores runtime procedure records; M08 generates corpus exemplars from them).

## Acceptance criteria
- [ ] Appraisal round-trip with MockModel: scripted valid output parses to the exact `Appraisal`; malformed JSON triggers exactly one cheap repair, then typed failure.
- [ ] Graceful degradation: appraisal hard-failure ⇒ turn pipeline completes, `incident.parse_failed` emitted, no episode/affect/credit update (asserted at the M09 seam with a scripted failing model).
- [ ] Unknown emotion tag ⇒ zod reject + incident, other appraisal fields discarded with it (no partial application).
- [ ] Planted-fact recall: insert an episode, query a paraphrase, assert surfaced — with **HashEmbedder** (meaningful, not just stable); ranking order deterministic (score desc, id asc).
- [ ] `affectAtEncoding` stamp equals the live-state Vec12 snapshot at append time (frozen-state test).
- [ ] Store separation: planted procedure record is invisible to `episodicNominator` and vice versa (the S3 gate test).
- [ ] Window: 30-message cap and 10k-token cap both enforced; ≥20-message eviction produces exactly one cached `[EARLIER]` line, not regenerated per turn; 4h silence (TestClock) resets to summary-only; tool-role messages never enter the window.
- [ ] Projections: journal.md/threads.json rebuild is deterministic for the same episode set (snapshot test); write is atomic.
- [ ] outcomePrev events land in L0 with verbatim evidence strings (replay-asserted).

## Test checklist
- unit: appraisal schema round-trip + reject table; window cap math (message-count edge at exactly 30, token edge at exactly 10k); recency×importance ranking geometry (FixedEmbedder); session-break boundary (3h59m vs 4h01m).
- component: EpisodeStore append/search/recent/byThread over tmpdir stores with HashEmbedder; ProceduralStore separation matrix; eviction summarizer with MockModel (called once per span, cached); projection snapshots.
- fixtures needed: scripted appraisal outputs (valid, malformed, unknown-tag, repairable); a planted episode/procedure corpus; FixedEmbedder geometry map; eviction-span transcript fixture.

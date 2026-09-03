---
module: M09
name: memory
syncedTo: S8 round 2 (2026-09-02 — durable thread index + dueThreads; see "Round 2 build deltas" below)
stage: S3
depends: [M01-kernel, M02-events, M03-model, M04-embed, M05-affect]
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
- [x] Appraisal round-trip with MockModel: scripted valid output parses to the exact `Appraisal`; malformed JSON triggers exactly one cheap repair, then typed failure.
- [x] Graceful degradation: appraisal hard-failure ⇒ turn pipeline completes, `incident.parse_failed` emitted, no episode/affect/credit update (asserted at the M09 seam with a scripted failing model).
- [x] Unknown emotion tag ⇒ zod reject + incident, other appraisal fields discarded with it (no partial application).
- [x] Planted-fact recall: insert an episode, query a paraphrase, assert surfaced — with **HashEmbedder** (meaningful, not just stable); ranking order deterministic (score desc, id asc).
- [x] `affectAtEncoding` stamp equals the live-state Vec12 snapshot at append time (frozen-state test).
- [x] Store separation: planted procedure record is invisible to `episodicNominator` and vice versa (the S3 gate test).
- [x] Window: 30-message cap and 10k-token cap both enforced; ≥20-message eviction produces exactly one cached `[EARLIER]` line, not regenerated per turn; 4h silence (TestClock) resets to summary-only; tool-role messages never enter the window.
- [x] Projections: journal.md/threads.json rebuild is deterministic for the same episode set (snapshot test); write is atomic.
- [x] outcomePrev events land in L0 with verbatim evidence strings (replay-asserted).

## S3 build deviations (recorded 2026-09-01, code is the truth)
- **`appraise` returns a typed outcome, not `Promise<Appraisal>`**: `Promise<{ ok: true; appraisal } | { ok: false; error }>` — graceful degradation as a value instead of an exception at the call site. The incident kinds are split by failure mode: `incident.parse_failed` (ladder exhausted, M03's code `model/parse-failed`) vs `incident.appraisal_failed` (transport/timeout/abort). Both carry `{ schema, code, error }` and the turn's `turnId`.
- **The Appraisal zod schema lives in `src/memory/appraisal.ts`** (mirrors `schemas/appraisal.ts` field-for-field; the difference is that the tag is validated against M05's `EmotionTagSchema`, which the schemas mirror only documents) — `schemas/` is outside the module's lane.
- **Extra injected deps**: `episodicNominator(store, { clock })` (the recency term needs `now`, injected for hermeticity); `openSessionWindow(dir, { model, clock, events })` — the added `events` emits `incident.window_summary_failed` when the span summarizer fails (the eviction itself still happens; the cap is non-negotiable).
- **The session break is computed from the messages' own timestamps** (`msg.ts - last.ts >= 4h`), not the injected wall clock, so replaying a day of traffic through a TestClock reproduces the same window; the clock still stamps `savedAt`. At exactly 4h it breaks.
- **Store facades grew the methods recall and the projections actually need**: `all/get/size/vecsFor/vecOf` on both stores (M04's index answers search without returning stored vectors, so vectors are cached in memory and batch-filled on demand), plus `draftEpisode` (appraisal → `EpisodeRecord`, taking the live Vec12 as a thunk so the stamp is frozen at encoding) and `affectEvents` (appraisal → `AffectEvent[]` for M05) and `procedureFromDelegation` (M13's `DelegationPayload` → record). `append` takes the plain `EpisodeRecord`; `Episode` is the record plus its optional cached `vec`.
- **`openThreadIndex` was in-memory only through S3** (`threads.json` write-only, ARCHITECTURE's `var/` table sanctioned no extra memory file, so the fold was not persisted; history rebuilt from episodes). **Superseded in round 2** — see "Round 2 build deltas": `openPersistedThreadIndex(dir)` persists the fold to `var/memory/threads.jsonl`, and the index grew `dueThreads(now)` for the heartbeat's follow-up queue.
- **Proposed constants the spec left open** (all flagged in code): `EPISODIC_MIN 3 / EPISODIC_MAX 5`, `NOMINATOR_POOL_FACTOR 4` (composite re-ranking reaches past the cosine cut), `RECENCY_HALF_LIFE_MS` = 7 days, `OUTCOME_WEIGHT = { good: 1.25, mixed: 1, bad: 0.75 }`, `SIG_EPSILON 0.01` (deviation coords below it are silence in a candidate's signature), `RENDER_ARG_CAP 240` (procedure args in `[PROCEDURAL]` renders), `APPRAISAL_MAX_TOKENS 400`, `SUMMARY_MAX_TOKENS 160`, appraisal/summarizer temperature 0.
- **File layout**: `errors.ts` (the `memory/*` code union), `record-store.ts` (the JSONL + VectorIndex persistence both stores share — durability order row first, index self-heals or refuses `memory/index-orphan`), `threads.ts`, `recall.ts`, `projections.ts`, `window.ts`, `episodes.ts`, `procedural.ts`, `appraisal.ts`, plus the barrel. `episodes.jsonl`/`embeddings.bin` and `procedural.jsonl`/`procedural-embeddings.bin` keep the spec's file pairs; the window persists its own `window.json` (crash-safe reopen of the verbatim window + cached line + pending span).
- **Dependency edge added (authorized)**: `depends` gains M05-affect — the appraisal schema validates tags against M05's vocabulary and `affectEvents` returns M05's `AffectEvent` type. Mirrored in `.dependency-cruiser.cjs` (`"src/memory": ["kernel", "events", "model", "embed", "affect"]`) in the same edit. No other edges.

## Test checklist
- unit: appraisal schema round-trip + reject table; window cap math (message-count edge at exactly 30, token edge at exactly 10k); recency×importance ranking geometry (FixedEmbedder); session-break boundary (3h59m vs 4h01m).
- component: EpisodeStore append/search/recent/byThread over tmpdir stores with HashEmbedder; ProceduralStore separation matrix; eviction summarizer with MockModel (called once per span, cached); projection snapshots.
- fixtures needed: scripted appraisal outputs (valid, malformed, unknown-tag, repairable); a planted episode/procedure corpus; FixedEmbedder geometry map; eviction-span transcript fixture.

## Round 2 build deltas (2026-09-02, remediation package F — code is the truth)

1. **The thread fold is durable.** `openPersistedThreadIndex(dir)` (threads.ts) replays `{dir}/threads.jsonl` at boot and appends one validated row per applied batch — `{version: 1, ts, updates: ThreadUpdate[]}`, carrying id + title + STATUS, not just the ids the episode rows keep. `apply` appends synchronously (the fold is a synchronous read, and an unlogged batch is a batch a crash takes with it); a failed append is a typed `memory/threads-log` throw, never a silent drop. Corrupt/invalid log lines are skipped and counted (`skippedRows()`), never fatal at boot. The in-memory `openThreadIndex()` stays for process-lifetime callers. New error code: `memory/threads-log`.
2. **`dueThreads(now)`** is the heartbeat's follow-up queue: open/touched threads with `updatedAt + THREAD_DUE_MS <= now`, id-ascending. `THREAD_DUE_MS = 6h` (proposed constant — a thread he opened in the morning resurfaces by tonight); a touch re-arms it, closing it retires it forever. `dueAt` is derived state (a pure function of `updatedAt` + `status`), so persistence never stores it and `ThreadState`'s shape is unchanged.
3. **The life-side consumer is `dueThreadNotes(threads, now)`** (src/life/thought.ts): the fold → the `{id, note}` rows `heartbeatThoughtMessages` renders (`note` = last appraisal title, falling back to the id), capped at `DUE_THREADS_CAP = 3`. Named test: `thread from appraisal is due for the next heartbeat` (test/life/thought.test.ts) — TestClock, the durable index, due after the horizon, prompt carries it by title.
4. **Projections unchanged and still write-only**: `writeProjections(dir, episodes, threads)` builds journal.md + threads.json from any fold — a reopened `threads.jsonl` fold projects byte-identically to the live one (test: `round-trips the durable fold`, test/memory/projections.test.ts).
5. **Call sites left for round 3** (the seam is ready, the wiring is M20's): compose opens the index with `openPersistedThreadIndex(paths.memory)`; the pipeline folds each appraisal's `threads[]` right after `draftEpisode` (that is the "persist appraisal threads[]" step — the episode's `threads` ids alone never carried title/status); the heartbeat job replaces jobs.ts's `dueThreads: []` (src/life/jobs.ts:322, the "v1: the thread index is not wired" comment) with `dueThreadNotes(threads, ctx.clock.epochMs())`; ponder's episode append tags its episode with the artifact's thread (`threads: []` at src/life/jobs.ts:601) once ponder seeds grow thread ids; and the nightly reflect invokes `writeProjections(var, episodes.all(), threads)` so the projections stop being caller-less.

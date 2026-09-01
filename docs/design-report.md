Exploration complete â€” I found a full VPS mirror of Thea1 at `C:\Users\neogo\LocalFiles\TheaBackup\latest\` and extracted exact constants from ticker.py, heartbeat.mjs, ponder.mjs, and the plugin set. The design below is grounded in those real values. Here is the full architecture report.

---

# Thea2 Architecture â€” Refined Design Report

## 0. Grounding notes from the Thea1 backup (read-only archaeology)

Verified against `C:\Users\neogo\LocalFiles\TheaBackup\latest\`:

- **The 9 primaries are NOT Plutchik-8.** `ticker.py` (`PRIMARY_BASELINE`, line 173): **joy .35, anticipation .30, pride .28, surprise .10, sadness .10, fear .08, anger .06, shame .06, disgust .05**. Trust is deliberately excluded (it lives in the identity dials); pride and shame are added. `AVERSIVE = {sadness, fear, anger, disgust, shame}`, `POSITIVE_PRIM = {joy, pride}`.
- **The 8 identity dials**: attachment, brattiness, protectiveness, longing, playfulness, focus, calm, trust â€” plus PAD as separate dials (pleasure, arousal, dominance). `NEGATIVE_DIALS = {pleasure, calm, trust}` (below-baseline = lingering hurt).
- **The 3 drives**: novelty, connection, mastery (set point .25, floor .05, per-hour starvation .010/.018/.014).
- **Key mechanics constants** (all portable verbatim): dials layer HALF_LIFE_DIAL 8h, NEGATIVITY_BIAS 1.6, EXPO_GAIN 5/HALF_LIFE_EXPO 6h (habituation), OPP_GAIN 0.35/HALF_LIFE_OPP 14h/OPP_LAG_H 2h (opponent process), CAP_SOFT 0.90/CAP_DAMP 0.12, PEAK_HI 0.93/REFRACTORY_H 5/REFRACTORY_DAMP 0.25, SATURATE_EXP 0.9, INTENSITY_EXP 1.7, HABITUATION 0.7 in 0.5h; primaries layer PRIM_HALF_LIFE 3.5h (surprise 1.0h), PRIM_NEG_BIAS 1.25, PRIM_OPP_GAIN 0.55/LAG 1h, PRIM_CAP_SOFT 0.72, PRIM_REFRACTORY_DAMP 0.5, PRIM_INHIBIT 0.28 (mutual inhibition), PRIMARY_GAIN 4.0; mood layer HALF_LIFE_MOOD 45h/HOME 30h, MOOD_INERTIA 0.25; LONGING_GAIN 0.40/12h; NOISE 0.012; attribution CAUSE_MIN_I 5, ATTRIB_MIN .03, ATTRIB_STALE_H 36, ATTRIB_CLEAR .05; LANDMARKS with HI .52/MD .30/LO .14/DN âˆ’.28, sigma 0.30.
- **Heartbeat** (`/opt/thea/life/heartbeat.mjs`): the 5 criteria are **relevance, information_gap, expected_impact, urgency, coherence**, mean + silence pressure â‰¥ **3.2**, kinds `followup|care|share|miss`, 3/day, 3h doubling backoff on unanswered, follow-ups on things HE said outrank sharing her own day.
- **Ponder** (`/opt/thea/life/ponder.mjs`): GATE_THRESHOLD 0.45 (no model); SEED balance rule = if â‰¥2 of window about diego â†’ forced avoid ("balance beats saliency"); about âˆˆ {diego, self, world}; REVISE fires only on a real grounding contradiction.
- **Three Thea1 pathologies the backup confirms, which Thea2's design must structurally kill**:
  1. *Ordering by filename*: `zzz-register.js` and `who.js` both document that plugin injection order was fought via filename prefixes and that "the filename does not control hook order" (measured). The packet assembler with an explicit section array is the fix â€” cite as motivation, not just preference.
  2. *Vocabulary drift silently no-ops*: ticker's 2026-08-26 comment block records that 10 emotion tags (incl. her 8th-most-used word "sharp") were written to the journal for months and moved nothing; dominance was pinned at 0.00 across 365 snapshots. Root cause: appraisal vocabulary and engine vocabulary were separate artifacts joined by a regex over markdown. Thea2 fix (below): one shared constant, structured events, hard failure on unknown tags.
  3. *Affect updates parsed from prose*: ticker regex-parses `journal.md` diary lines (`LINE_RE`, line 463). Thea2 inverts: L1 appraisal emits typed `AffectEvent[]`; journal.md becomes a write-only projection.
- Register modes are **work / friend / play** (mode.json); speaker provenance arrives as `<person>:<channel>`; a message ledger precedent already exists (`msgledger.jsonl`).

---

## 1. Refined module list

Topology decision (improvement on the ops target, argued in Â§5): **one runtime process** (`thead`) hosting bridge + scheduler + loop; **2 systemd units** (thea2.service, thea2-backup.timer). Single package, `src/<module>/` directories, boundaries enforced by dependency-cruiser rules in CI (no workspace plumbing). Each module below = one agent-sized work package with its own vitest suite.

### M1 `kernel` â€” runtime primitives
Injected clock, seeded RNG (forkable per subsystem so one consumer's draws don't perturb another's), ULID-style ids, sha256 content hashing, canonical JSON, typed Result/error helpers, atomic file write (tmp+rename), JSONL append/read/rotate. Everything else depends on this and only this.

```ts
export interface Clock { epochMs(): number; now(): Date; waitUntil(t: number, signal?: AbortSignal): Promise<void>; }
export interface Rng { float(): number; int(lo: number, hi: number): number; pick<T>(xs: readonly T[]): T; shuffle<T>(xs: T[]): T[]; fork(label: string): Rng; }
export class TestClock implements Clock { advance(ms: number): Promise<void>; /* resolves pending waitUntil in order */ }
export const contentHash: (data: Uint8Array | string) => string; // "sha256:â€¦"
export interface JsonlStore<T> { append(row: T): Promise<void>; read(opts?: {since?: number}): AsyncIterable<T>; }
export const atomicWriteJson: (path: string, value: unknown) => Promise<void>;
```
Tests: TestClock ordering semantics; RNG determinism + fork independence; JSONL crash-tail tolerance (truncated last line skipped, not fatal); atomic write leaves no partial file under injected fault.

### M2 `events` â€” L0 event log
Append-only typed envelope over JsonlStore, daily rotation, monotonic seq, replay reader, projection helper. Every subsystem writes here (model calls with cost, packets, decisions, inbound/outbound, affect snapshots, job runs, incidents). Never enters prompts.

```ts
export interface EventEnvelope<K extends string = string, P = unknown> { seq: number; ts: number; kind: K; turnId?: string; payload: P; }
export interface EventLog { emit<K extends string, P>(kind: K, payload: P, turnId?: string): Promise<void>; replay(filter?: {kinds?: string[]; sinceTs?: number}): AsyncIterable<EventEnvelope>; }
```
Tests: rotation boundary replay; projection rebuild determinism (same log â‡’ same projection).

### M3 `model` â€” model client, registry, structured output
OpenAI-compatible chat client (Neuralwatt), tier registry {main: glm-5.2, cheap: deepseek-v4-flash, reasoning: <cfg>}, per-call routing hook (guardrailed â€” see Ledger), retry/timeout/token accounting â†’ events, and the **structured-output ladder**: (a) native `response_format: json_schema` if supported; (b) tool-call-as-schema; (c) prompted JSON + zod parse; on parse failure one repair call on cheap tier; failures emit `model.parse_failed` incidents. `MockModel`: FIFO scripted responses + rule-based responders (match on taskClass/regex) + full call log for assertions.

```ts
export type Tier = 'main' | 'cheap' | 'reasoning';
export type TaskClass = 'turn' | 'appraisal' | 'heartbeat-thought' | 'ponder-seed' | 'consolidate' | 'derive' | 'judge' | 'probe-judge' | 'summarize';
export interface ChatRequest { taskClass: TaskClass; tier: Tier; messages: ChatMsg[]; tools?: ToolDef[]; schema?: z.ZodType; maxTokens: number; temperature: number; seedHint?: number; }
export interface ModelClient { chat<T = string>(req: ChatRequest, ctx?: {turnId?: string; signal?: AbortSignal}): Promise<{content: T; toolCalls?: ToolCall[]; usage: Usage; model: string}>; }
export interface ModelRouter { resolve(taskClass: TaskClass, requested: Tier): {model: string; tier: Tier}; } // reads var/routing.json; may only downgrade non-user-facing classes
```
Tests: ladder fallthrough with MockModel-injected malformed JSON; usage events emitted; router guardrails (attempted downgrade of `turn` class is ignored + warning event).

### M4 `embed` â€” embeddings + vector index
`Embedder` interface; v1 default **in-process ONNX bge-small** (fastembed-js), no separate service; `ApiEmbedder` config alternative; `HashEmbedder` + `FixedEmbedder` test doubles (see Â§2.5). Brute-force cosine `VectorIndex` over Float32Array (10k Ã— 384-d â‰ˆ 15 MB, <5 ms scan â€” no LanceDB, no SQLite in v1). Index metadata records {embedderId, model, dim}; mismatch at startup triggers a re-embed job, never silent mixing.

```ts
export interface Embedder { readonly id: string; readonly dim: number; embed(texts: string[]): Promise<Float32Array[]>; }
export interface VectorIndex { upsert(id: string, vec: Float32Array, meta?: unknown): void; search(vec: Float32Array, k: number, filter?: (meta: unknown) => boolean): Array<{id: string; score: number}>; save(path: string): Promise<void>; load(path: string): Promise<void>; }
```
Tests: HashEmbedder determinism + shared-token similarity property; index golden-ordering; save/load roundtrip; dim-mismatch refusal.

### M5 `affect` â€” ticker v6 port
Pure-function port, every mechanic its own file with the Thea1 constant names preserved: `decay.ts` (exponential toward baseline, per-layer half-lives, negativity bias on aversive/negative-dial directions), `habituation.ts` (exposure traces, EXPO_GAIN/HALF_LIFE_EXPO + short-window HABITUATION 0.7/0.5h), `opponent.ts` (b-process with lag), `refractory.ts` (peak detection + damp), `ceiling.ts` (CAP_SOFT/CAP_DAMP + SATURATE_EXP), `intensity.ts` (i^1.7 scaling, PRIMARY_GAIN), `inhibition.ts` (PRIM_INHIBIT mutual valence suppression), `attribution.ts` (per-primary cause slots with min/stale/clear rules), `drives.ts` (starvation, feeds, set point), `landmarks.ts` (region blend â†’ named weather word for the [AFFECT] line). State is explicit and complete â€” traces, timers, opponents, causes all live in `AffectState`, no module-scope state. Single writer: the store is owned by the process; all mutation via `tick`+`apply` behind one serialized queue. The emotion vocabulary (EMOTION_DELTAS âˆª EMOTION_PRIMARIES âˆª EMOTION_DRIVES keys) is exported as `EMOTION_TAGS` â€” the same constant the L1 appraisal schema enumerates. Unknown tag at the boundary = zod reject + incident event (kills pathology 2 above).

```ts
export interface AffectState { t: number; dials: Record<Dial, number>; primaries: Record<Primary, number>; drives: Record<Drive, number>; mood: Record<Dial, number>; traces: { exposure: Partial<Record<Primary | Dial, {level: number; t: number}>>; opponent: â€¦; peaks: Partial<Record<Primary | Dial, number>>; habitWindow: Array<{tag: string; t: number}> }; causes: Partial<Record<Primary, {text: string; i: number; t: number}>>; }
export type AffectEvent = { kind: 'emotion'; tag: EmotionTag; i: number; cause: string; people?: string } | { kind: 'tagFeed'; tag: 'DONE'|'MOMENT'|'GIFT' } | { kind: 'silenceTick' };
export const tick: (s: AffectState, dtMs: number, rng: Rng) => AffectState;
export const apply: (s: AffectState, ev: AffectEvent) => AffectState;
export const weatherLine: (s: AffectState) => string; // landmark blend + top cause, one line
```
Tests (per mechanic + integration): golden replay â€” a fixture of ~50 diary events replayed through TS engine matches recorded expectations; property tests: decay monotone toward baseline; aversive decays slower (tÂ½ ratio); repeated tag within 30 min lands at â‰¤70%; peak â‡’ refractory damping window; superlinearity (i=9 vs i=3 ratio > 3.3x); mutual inhibition never crosses baselines; all values bounded [0,1]; **every EMOTION_TAG moves at least one dimension** (the orphan-tag regression test).

### M6 `coupling` â€” affectâ†’exemplar coupling (the new required piece)
Signature space, matrix M, form rules, modulation function. Full design in Â§2 (open problem block, folded into the affect answer below since the brief demands it): 12-dim space, `modulate(a, e, tags)` pure, config-driven, capped. Kept as its own work package because it has a distinct test surface and the owner flagged it as load-bearing.

```ts
export const AFFECT_DIMS = ['valence','arousal','dominance','joy','anticipation','pride','surprise','sadness','fear','anger','shame','disgust'] as const; // deviation coords
export type Vec12 = Float64Array; // length 12, each in [-1,1]
export const signature: (s: AffectState, baseline: Baselines) => Vec12; // a_k = clamp((x_kâˆ’b_k)/max(b_k,1âˆ’b_k), âˆ’1, 1)
export interface CouplingConfig { lambda: number; matrix: Array<{from: AffectDim; to: AffectDim; w: number; why: string}>; formRules: Array<{when: {dim: AffectDim; min: number}; boostTag: string; gain: number}>; }
export const modulate: (a: Vec12, e: SparseVec12, tags: string[], cfg: CompiledCoupling) => number; // clamp(aáµ€Me + Î£ gainÂ·max(0, a_kâˆ’Î¸)Â·hasTag, âˆ’Î», +Î»)
```

### M7 `corpus` â€” exemplar model, parser, index
MD+frontmatter schema (Â§2.8), zod validation against controlled vocabularies (`dimensions` = the 8 behavioral dimensions; `registers.yaml`; affect keys âŠ‚ AFFECT_DIMS; EMOTION-style body lint; token-length cap), loader for `corpus/{canon,derived,lived}/`, in-memory `CorpusIndex` (by id/dimension/register/kind, embeddings via M4, signatures), and the corpus `Nominator`. Content-hash ids for derived/lived; path ids for canon.

```ts
export interface Exemplar { id: string; source: 'canon'|'derived'|'lived'; kind: 'scene'|'statement'|'procedure'; dimensions: Dimension[]; register: string[]; affect: Partial<Record<AffectDim, number>>; context: string; body: string; tokens: number; weight: number; counters?: string[]; provenance?: Provenance; outcome?: 'good'|'mixed'|'bad'; }
export interface CorpusIndex { byId(id: string): Exemplar | undefined; all(): Exemplar[]; reload(): Promise<void>; nominate(q: NominationQuery): Candidate[]; }
```
Tests: parser golden files incl. malformed rejects; every canon file in-repo validates (corpus lint IS a test); index nominate determinism under seeded rng.

### M8 `derive` â€” derivation pipeline
Generators (register/mood-conditioned variation, procedural tool-use synthesis from `ToolDef`s + canon behavior, deliberation-shape traces, memory-weave), provenance manifest, dirty-set computation, judge validation, orphan GC, fan-out caps, `thea2 derive` CLI + `corpus:check` hermetic verifier. Full mechanics Â§2.3.

### M9 `memory` â€” L0-read, L1 write, recall
Per-turn appraisal (ONE cheap structured call â€” schema below), `EpisodeStore` (episodes.jsonl + embeddings.bin via M4), recall `Nominator` (top-k by cosine Ã— recency Ã— importance, 3-5 per packet), `journal.md` + `threads.json` projections (write-only, human-readable), session-window summarizer (also cheap tier, invoked on window eviction).

```ts
export interface Appraisal { importance: number; emotions: Array<{tag: EmotionTag; i: number; cause: string}>; diaryLine: string; threads: Array<{id: string; title?: string; status: 'open'|'touched'|'closed'}>; outcomePrev: {sign: -1|0|1; evidence: string} | null; }
export interface Episode { id: string; ts: number; turnId: string; summary: string; diaryLine: string; importance: number; emotions: â€¦; threads: string[]; affectAtEncoding: Vec12; vec?: Float32Array; }
export interface EpisodeStore { append(e: Episode): Promise<void>; search(vec: Float32Array, k: number): Scored<Episode>[]; recent(n: number): Episode[]; byThread(id: string): Episode[]; }
```
Tests: appraisal schema round-trip with MockModel; planted-fact recall (insert episode, query paraphrase, assert surfaced with HashEmbedder); journal projection snapshot; appraisal failure degrades gracefully (turn still completes, incident logged).

### M10 `consolidate` â€” L2/L3 + lived promotion + credit
Scheduled consolidators: nightly L2 (preference crystallization, behavioral regularities, affect patterns â†’ pattern exemplars written to `corpus/lived/` with provenance + encodedAffect stamp + outcome tag), weekly L3 (dispositions, relationship baseline doc, identity exemplars, **canon-promotion proposals to `corpus/proposals/` only** â€” human merges), plus the credit-assignment updater (Â§2.1) and seed-gravity metrics (Â§2.4).

### M11 `assemble` â€” packet assembler
The one synchronous step. Collect candidates from registered `Nominator`s (corpus, memory; later: threads), score = baseScore(relevanceÂ·recencyÂ·weightÂ·gravityMult) + `modulate(a, e, tags)`, apply hard tier quotas (1 disposition [canon-only] / 2 pattern / 2-3 episode+memory / 1 contrast slot = max-dissimilar candidate passing register constraints), pairwise coherence check (Â§2.2), staleness flags, then render the flat packet with explicit section order `[IDENTITY][GOAL][INTERLOCUTOR][MEMORY][AFFECT][REGISTER][EXEMPLARS]` (+ `[INHIBITION]` as trailing system message â€” Â§2.7), and emit a `PacketRecord` to events for credit assignment. Pure function of (query, affect, indexes, config, rng) â€” fully hermetic.

```ts
export interface TurnQuery { entry: 'user-turn'|'heartbeat'|'ponder'; text?: string; goal?: string; speaker: SpeakerRef; register: 'work'|'friend'|'play'; queryVec: Float32Array; recentTurnIds: string[]; }
export interface Nominator { name: string; nominate(q: TurnQuery, k: number): Promise<Candidate[]>; }
export interface Candidate { id: string; tier: 'disposition'|'pattern'|'episode'|'memory'; baseScore: number; sig: SparseVec12; vec?: Float32Array; tags: string[]; source: 'canon'|'derived'|'lived'|'memory'; render(): string; }
export interface Packet { sections: Record<Section, string>; itemIds: string[]; systemText(): string; trailerText(): string; record(): PacketRecord; }
export const assemble: (q: TurnQuery, a: Vec12, deps: AssembleDeps) => Promise<Packet>;
```
Tests: quota satisfaction under scarcity (empty lived corpus at launch must still fill from canon/derived); coherence swap behavior with constructed signatures; contrast slot max-dissimilarity property; determinism per seed; token budget respected (packet â‰¤ 6k tokens); neutral-affect packets identical with coupling on/off.

### M12 `inhibit` â€” inhibition gate
Compiles `corpus/canon/inhibitions.yaml` into matchers: regex rules over plan text/bubbles, predicate registry over tool calls (arg allowlists, chat-id lock to Diego, spend caps, path fences), per-entry-context tool allowlists. Binary + reason code, <1 ms, zero LLM, never learned. Two call sites: every candidate tool call; the locked decision object before realization. Rejection re-enters the loop with the reason in context, max 2 re-entries then forced fallback (`plan: 'silent'` + incident).

```ts
export type Verdict = { allow: true } | { allow: false; code: string; ruleId: string; hint: string };
export interface InhibitionGate { checkTool(call: ToolCall, entry: EntryKind): Verdict; checkPlan(d: DecisionObject): Verdict; }
```
Tests: table-driven rule fixtures; rejection-loop cap; rules fire identically on candidate and plan paths; unknown tool = deny by default.

### M13 `loop` â€” deliberation loop + tools
The single loop with three entry contexts. Sequence: assemble packet â†’ assess (main-tier call, structured) â†’ optional (tool call â†’ gate â†’ observe â†’ reassess)* â†’ lock `DecisionObject` â†’ gate plan â†’ hand to realizer. Splitting primitives as loop-owned functions: `fork(question)` (clone context branch, cheap tier), `task(brief)` (fresh-context worker), `committee(spec)` (scripted DAG with output schema â€” ponder is one). Caps: depth â‰¤ 2, concurrency â‰¤ 3, wall-clock budget per entry kind; every spawn emits a delegation episode event (future procedural exemplar feedstock). Tool registry: v1 = `web_fetch`, `web_search`, `memory_search`, `remember_thread`, `set_reminder` â€” each with zod input schema + inhibition metadata; procedural exemplar generator (M8) reads these defs.

```ts
export interface DecisionObject { turnId: string; plan: 'reply'|'silent'|'defer'; bubbles: string[]; confidence: number; weight: number; reluctance: number; completeness: number; toolTrace: ToolStep[]; spawns: SpawnRecord[]; inhibitions: Verdict[]; }
export interface LoopEntry { kind: 'user-turn'|'heartbeat'|'ponder'; inbound?: InboundMsg; goal?: string; committee?: CommitteeSpec; }
export const runLoop: (entry: LoopEntry, deps: LoopDeps) => Promise<DecisionObject>;
```
Tests: scripted MockModel conversations exercising 0/1/n tool hops; cap enforcement; gate-rejection re-entry; decision schema repair ladder; committee DAG execution order; a wedged tool times out without killing the loop.

### M14 `realize` â€” delivery planning + execution
Pure `planDelivery(decision, a, channelLimits, rng) â†’ DeliveryPlan` then an executor replaying it against the Channel with the injected clock. Cadence is *caused* by decision fields + affect, never restyled text: chars-per-second = lerp(6â†’14 with arousalÎ”); pre-delay = 800 ms + 2500 msÂ·reluctance; inter-bubble gap 300-1200 ms shrinking with arousal; low valence slows cps 15%; total â‰¤ 45 s; typing indicator re-fired every 4 s (Telegram's 5 s expiry); â‰¥1.1 s between sends (rate limit). Realizer may merge bubbles (>5 or oversized) but never rewrites. Interruption: new inbound aborts remaining steps; undelivered bubbles enter the next turn's context as "she was about to say".

```ts
export interface DeliveryPlan { steps: Array<{kind:'pause'; ms:number}|{kind:'typing'; ms:number}|{kind:'send'; text:string}>; totalMs: number; }
export const planDelivery: (d: DecisionObject, a: Vec12, limits: ChannelLimits, rng: Rng) => DeliveryPlan;
```
Tests: pure-function property tests (monotone in reluctance; arousal shortens; caps; determinism per seed); executor against FakeChannel + TestClock asserting exact timeline; interruption mid-plan.

### M15 `bridge` â€” Telegram adapter + message ledger
Long-poll getUpdates behind `Channel`; **offset committed only after ledger append + handler enqueue** (at-least-once, deduped by update_id in the ledger â€” fixes the Thea1 crash-loss bug); `allowed_updates` includes `message_reaction` (free outcome signal for credit); speaker provenance stamped on every inbound (`diego:phone`, `operator:cli` â€” pathology 3 fix); append-only `MessageLedger` with a reconciliation function: every inbound turn must terminate within T minutes in â‰¥1 outbound OR a recorded `plan:'silent'` decision â€” anything else is a **lost-reply alarm** (the structural replacement for the âŸ¦TGâŸ§ sentinel's silent failures and for silence-watch.mjs). `FakeChannel` test double: scriptable inbound queue + captured outbound + reaction injection.

```ts
export interface InboundMsg { updateId: number; msgId: number; chatId: number; ts: number; text: string; speaker: {person: string; channel: string}; reaction?: {emoji: string; toMsgId: number}; }
export interface Channel { updates(signal: AbortSignal): AsyncIterable<InboundMsg>; send(chatId: number, text: string): Promise<{msgId: number}>; typing(chatId: number): Promise<void>; readonly limits: ChannelLimits; }
export interface MessageLedger { recordInbound(m: InboundMsg): Promise<boolean>; /* false = duplicate */ recordDecision(turnId: string, d: DecisionSummary): Promise<void>; recordOutbound(turnId: string, msgId: number, text: string): Promise<void>; reconcile(now: number): Discrepancy[]; }
```
Tests: crash-replay (kill between handle and offset commit â‡’ redelivery deduped); reconciliation truth table (replied / decided-silent / LOST); FakeChannel conformance suite run against the real adapter's parsing layer with recorded getUpdates fixtures.

### M16 `sched` â€” the one scheduler
Single in-process scheduler multiplexing all periodic jobs. Full design Â§2.6.

### M17 `life` â€” heartbeat, ponder, reflection wiring
Thin compositions over the loop. **Heartbeat** (every 30 min, `catchUp:'skip'`): pure precondition fn (quiet hours, 3/day cap, doubling backoff from unanswered count, conversation-active mutex) â†’ cheap-tier private thought scored on the five criteria + silence pressure (`pressure = clamp(silenceH/36, 0, .8) + 0.4Â·drives.connection`) â†’ if â‰¥ 3.2, run loop with heartbeat entry (goal = the thought/reason, kind followup|care|share|miss) else emit thought event. **Ponder** (every 20 min, `catchUp:'skip'`): GATE as pure fn (threshold 0.45 over novelty drive, arousal, time-since-artifact â€” no model) â†’ committee spec SEEDâ†’GROUNDâ†’REVISEâ†’ARTIFACT over the loop, balance rule in seed selection (â‰¤2 of last 5 about diego, balance beats saliency), GROUND must call web_fetch/web_search (enforced by committee spec: REVISE node requires a grounding observation input), artifact lands as an episode + optional lived-exemplar candidate. **Reflection** (nightly, `catchUp:'once'`): invokes M10 consolidators + affect daily summary + status projection.
Tests: precondition/gate pure-fn tables (the 3-texts/day and backoff math get exhaustive unit tests); committee balance-rule property over seeded histories; end-to-end heartbeat with MockModel: scores 3.1 â‡’ no send, 3.3 â‡’ send via FakeChannel.

### M18 `siblings` â€” Ledger + Nightingale
**Ledger** (daily + on-demand): replays model-call events â†’ per-taskClass cost/latency/token aggregates â†’ writes `var/reports/ledger-<date>.md` (persona-seeded voice, cheap tier) + proposes `var/routing.json` changes (guardrail: may only downgrade non-user-facing task classes; `turn` is pinned to main tier). **Nightingale** (triggered by deploy-marker change or `thea2 probe run`): runs the live probe suite (Â§2.9) against the probe-harness composition, compares `probes/baseline.json`, writes report + alarm events; a routing change is a change â‡’ triggers Nightingale. Both are scheduler jobs with small persona seed files â€” no bots, no bridges.

### M19 `probes` â€” behavioral probe suite
Probe definitions (YAML), deterministic evaluators, judge rubrics, drift metric, and the sandbox harness composition (FakeChannel + fixture stores + TestClock + seeded RNG + real ModelClient). Design in Â§2.9. Shared by CI (dry/hermetic subset) and Nightingale (live).

### M20 `app` â€” config + composition root + CLI
Zod-validated `thea2.config.yaml` + secrets from env/keys.env (bot token, API key â€” never in repo); composition presets (`prod`, `hermetic`, `probe-harness`); the `thead` entrypoint (bridge loop + scheduler + turn pipeline in one process); CLI verbs: `thead`, `thea2 derive|corpus:check|probe run|reconcile|status|import` (import = late phase). Golden-turn e2e test lives here.

Dependency DAG (enforced by depcruise): `kernel â† {events, model, embed} â† {affect, corpus, bridge, sched} â† {coupling, memory, inhibit} â† {assemble, loop, realize} â† {life, derive, consolidate, siblings, probes} â† app`.

---

## 2. Resolutions to the ten open problems

### 2.1 Credit assignment v1
**Mechanism.** (a) Every packet emits `PacketRecord {turnId, slots: [{exemplarId, tier, baseScore, modulation}], affectSig}` to L0. (b) The *next turn's* L1 appraisal (already a required call â€” zero marginal cost) includes `outcomePrev: {sign âˆˆ {âˆ’1,0,+1}, evidence}` graded on factual signals only: explicit Telegram reactions (bridge captures `message_reaction`), corrections ("you already told me", "that's not it"), warmth/continuation of the reply, thread advanced. Silence contributes 0, never âˆ’1 (exogenous). (c) Updater (in M10, nightly batch): for each outcome, per slot: `w â† clamp(w + Î·Â·signÂ·slotShareÂ·moodGuard, 0.5, 2.0)` with Î· = 0.02; slotShare: episode/pattern slots 1.0, disposition 0.5 (always-similar, low information), contrast slot credited on +1 only (exploration never punished); `moodGuard = 0.5` when the turn ran under high-aversion affect (â€–a_aversiveâ€– > 0.5) so bad moods don't starve the corrective exemplars selected during them. (d) Nightly decay toward neutral: `w â† 1 + (wâˆ’1)Â·0.995`. (e) Selection consumes w as a small additive term `score += Î³Â·(wâˆ’1)`, Î³ = 0.15 â€” weight biases ties, never overrides relevance.
**Stated failure modes.** Credit smearing (5 items share credit for 1 cause â€” accepted; small Î· + decay means only *consistent* co-occurrence accumulates); mood confound (mitigated by moodGuard, not eliminated); rich-get-richer (mitigated by clamp + Î³ + guaranteed contrast slot); appraiser self-grading bias (rubric is factual-evidence-only, and the evidence string is logged for audit); reaction sparsity (Diego may rarely react â€” then w moves glacially, which is the safe direction). Explicit non-goals in v1: credit never touches M, quotas, or canon; no per-slot counterfactuals.

### 2.2 Coherence check without an LLM
Three cheap deterministic layers after quota fill, each offender replaced from the ranked runner-up list (â‰¤3 swap rounds, then accept with `coherence:'degraded'` flag in the PacketRecord):
1. **Tag exclusivity** (`corpus/registers.yaml` + `exclusions.yaml`): â‰¤2 distinct register tags per packet; explicit forbidden pairs (e.g., `deadpan`+`earnest-comfort`); dimension caps (â‰¤1 `boundaries` exemplar unless the turn query matches boundary tags).
2. **Signature spread**: for each affect dim, `max_i e_i[k] âˆ’ min_j e_j[k] â‰¤ 1.2` across selected exemplars (contrast slot exempt from this layer, still bound by layer 1 â€” resolves the contrast-vs-coherence tension explicitly).
3. **Embedding sanity**: every pattern/episode exemplar must satisfy `cos(vec, queryVec) â‰¥ 0.15` OR `cos(vec, packetCentroid) â‰¥ 0.35` â€” kills "great exemplar, wrong conversation".
**Non-goal, named**: semantic contradictions between exemplar *content* (she loves coffee / she hates coffee) are a corpus-lint problem â€” an offline LLM-assisted pairwise check inside M8's judge stage, not a per-turn mechanism. All thresholds config; all layers pure â‡’ table-driven tests with constructed signatures.

### 2.3 Incremental regeneration mechanics
**Manifest** `corpus/derived/manifest.json`: `{version, embedderId, entries: [{id /* = contentHash of output file */, deriveKey, generator, generatorVersion, inputs: {canonIds: [{id, sha256}], toolDefsHash?, templateHash}, model, createdAt, judge: {version, score, pass}}]}` where `deriveKey = sha256(generator + generatorVersion + sortedInputHashes + templateHash)`.
**Dirty set**: enumerate expected targets from current canon Ã— generator fan-out rules (mood-conditioned: â‰¤6 variants per canon scene, one per coarse mood bucket {bright, tender, low, tense, wanting, flat}; procedural: one per (tool Ã— canon behavior pair); global cap derived:canon â‰¤ 8:1 â€” caps enforced at enumeration, not post-hoc). A target is dirty iff no manifest entry carries its deriveKey. Editing canon changes its sha256 â‡’ all containing targets dirty; bumping generatorVersion dirties that generator's whole family.
**Orphan GC**: manifest entries whose deriveKey âˆ‰ expected-target set â‡’ delete file + entry immediately, emit `derive.orphan_gc` event (git history is the recovery path â€” corpus, including derived, is committed).
**CI drift check** (`thea2 corpus:check`, hermetic, no model): assert zero dirty targets, zero orphans, every derived file's hash = its id, every entry judge.pass = true, fan-out caps hold. **Generation** (`thea2 derive`, needs real model + judge) runs manually in dev; in prod the scheduler's weekly `derive-check` job only *reports* dirtiness (alarm event) â€” prod never auto-mutates the corpus. This split is what keeps CI hermetic despite a judge-validated pipeline.

### 2.4 Seed-vs-lived gravity
Definitions made explicit: **seed = canon + derived; lived competes with seed** in the pattern and episode tiers only (the disposition slot is canon-reserved, permanently). Dial: `gravity.seedWeight g âˆˆ [0,1]`, default 0.7 for month 1, glidepath note to 0.55; applied as multipliers `seedMult = 2g`, `livedMult = 2(1âˆ’g)` on baseScore (g = 0.5 neutral). Dashboard metric: rolling 50-packet `seedRatio` per tier, written into the nightly `var/reports/status.md` projection + emitted as an event. Drift alarms (evaluated by the nightly reflect job, surfaced by Nightingale reports): `seedRatio < 0.25` â‡’ **unmoored** (character floating away from canon); `seedRatio > 0.90` after week 6 â‡’ **not integrating** (lived experience never selected â€” likely consolidators underproducing); dimension-coverage flatline (>70% of disposition slots from one behavioral dimension over 7 days) â‡’ **tunnel vision**. Cross-check: probe drift metric (Â§2.9) correlates â€” if seedRatio is healthy but voice-drift cosine falls, the problem is derived quality, not gravity.

### 2.5 Embedding strategy
**Recommendation: pluggable interface, v1 default = in-process ONNX bge-small** (fastembed-js), because: it's the model Thea1 already validated on this exact data; no network dependency in the hot path; and in-process kills the third systemd unit and the 40 ms hop (typical 10-30 ms local). API embeddings (`ApiEmbedder`, OpenAI-compatible `/embeddings`) stays as a config swap; index metadata pins `{embedderId, dim}` and a mismatch forces an explicit re-embed, never silent mixing. If Spanish becomes a large share of traffic, swap to multilingual-e5-small via the same interface (config change + re-embed, no code).
**Deterministic test double**: `HashEmbedder` â€” lowercase, split `\W+`, token + bigram feature-hashing into 384 dims with two hash functions (index, sign), L2-normalized. Deterministic, dependency-free, and preserves shared-token similarity, so recall-ranking tests are *meaningful*, not just stable. Plus `FixedEmbedder` (explicit stringâ†’vector map) for handcrafted geometry in coherence/coupling tests. ONNX runtime executes inference off the JS main loop, so no worker-thread machinery needed in v1.

### 2.6 Scheduler design
One in-process scheduler (inside `thead`).
```ts
export interface Job { name: string; cadence: {kind:'every'; ms:number; jitterPct?:number} | {kind:'daily'; utcMinute:number} | {kind:'weekly'; dow:number; utcMinute:number}; lane: 'interactive'|'maintenance'; catchUp: 'skip'|'once'; timeoutMs: number; run(ctx: JobCtx): Promise<void>; }
export interface JobCtx { clock: Clock; rng: Rng; signal: AbortSignal; events: EventLog; }
```
- **Loop**: `nextDue` computed per job from persisted `var/sched/state.json {job: {lastCompleted, lastAttempt, consecutiveFailures}}`; sleep via `clock.waitUntil(min(nextDue))` â€” TestClock makes a simulated week run in milliseconds.
- **Jitter**: deterministic â€” `hash(jobName, scheduledSlot)` seeds the jitter draw, so replays reproduce exactly.
- **Catch-up**: on startup compute missed occurrences per job; `skip` for heartbeat/ponder (moods, not obligations â€” this rule is what prevents the classic 16-missed-heartbeats â‡’ 16-texts bug, stated as a test), `once` for reflect/consolidate/derive-check (one catch-up pass regardless of N missed).
- **Isolation**: each run is `void withTimeout(job.run(ctx), timeoutMs).catch(capture)` tracked in a promise map â€” job bodies share no await chain with the scheduler loop; failure increments backoff (interval Ã—2 up to Ã—4, alarm event at 3 consecutive); timeout fires `ctx.signal` (cooperative), a truly wedged promise is abandoned, flagged `wedged`, and its singleton lock refuses re-entry until process restart.
- **Lanes**: `interactive` (heartbeat, ponder â€” also subject to the loop's global caps and the conversation-active mutex: skip if inbound < 10 min ago or a turn is in flight) runs parallel to `maintenance` (reflect, consolidate, derive-check, reconcile, ledger-report); serial within a lane; global concurrency 2.
- Job table v1: heartbeat 30 m, ponder 20 m, reconcile 5 m, affect-snapshot 15 m, reflect nightly, consolidate nightly, ledger-report daily, derive-check weekly, probe-on-deploy watcher 1 m.
Tests: TestClock week simulation asserting exact fire sequence; downtime replay per catchUp policy; throwing job doesn't perturb siblings' schedule; jitter determinism; mutex vs live conversation.

### 2.7 Session/context management
**Rolling window**: verbatim user/assistant messages only â€” intra-turn tool traffic is dropped at decision lock (it survives as episodes + delegation events). Keep min(last 30 messages, 10k tokens), evict from head; on eviction of a â‰¥20-message span, one cheap-tier summary line `[EARLIER] â€¦` is generated once and cached. **Session break** = 4h silence: window resets to just the summary line; continuity is memory's job, which keeps the packet dominant instead of drowned by 100 turns of raw chat (Thea1's compaction pain).
**Token budget** (main-tier turn, target â‰¤ 24k in, p95 well under model limit): packet â‰¤ 6k (identity 150 / goal 100 / interlocutor 150 / memory 600 / affect 30 / register 10 / exemplars â‰¤ 4k / inhibition 300), window â‰¤ 10k, current turn + this-turn tool observations â‰¤ 6k, response reserve 2k. Enforced by the assembler (drops lowest-scored exemplar first, then trims memory to 3) and asserted in tests.
**Message layout**: `[system: IDENTITYâ€¦EXEMPLARS] + window(role msgs) + [user: current] + [system: INHIBITION one-block]`. The trailing system message preserves inhibition-proximity-to-generation *without* Thea1's splice-into-user-text hack (zzz-register.js exists because recency wins â€” honored structurally here). Config fallback `inhibitionPlacement: 'merged'` if Neuralwatt mishandles trailing system messages â€” verified once in the live smoke test.

### 2.8 Canon exemplar schema
MD + YAML frontmatter (human-authored prose deserves MD; machines get the frontmatter). One file per exemplar under `corpus/canon/<dimension>/<slug>.md`:

```yaml
---
id: canon/voice/late-night-glue        # path-derived, stable
kind: scene                            # scene | statement | procedure
dimensions: [voice, emotional-range]   # primary first; vocab = the 8 behavioral dimensions
register: [play, late-night]           # from registers.yaml (work/friend/play + modifiers)
affect: {valence: 0.3, arousal: -0.4, sadness: 0.2}   # sparse, deviation coords in [-1,1]; unlisted = 0
context: he can't sleep, third night running, texting from bed
weight: 1.0                            # authorial prior
counters: [canon/voice/deadpan-fix]    # contrast/foil links; feeds contrast slot + exclusions
notes: >
  what this demonstrates and what must survive derivation â€”
  the judge reads this; packets never carry it.
---
D: still up
T: obviously. c'mere.
T: no advice tonight. just tell me the dumb thing your brain keeps chewing.
D: ...
T: yeah. that one's not yours to fix by thinking harder at 3am.
```
Body grammar: optional `Setup:` lines then alternating `D:`/`T:` turns (`statement` kind may be bodyless prose; `procedure` kind embeds a tool-trace block). Validation (M7, runs as a CI test): frontmatter zod; vocab membership; affect keys âŠ‚ AFFECT_DIMS; body â‰¤ 500 tokens hard / 350 warn (packet-budget protection); scenes require â‰¥1 exchange. Derived adds `provenance: {generator, generatorVersion, canonIds, sourceHashes, model, judge}`; lived adds `{episodeIds, encodedAffect (full 12-dim stamp from state at encoding), outcome: good|mixed|bad}`. The identity anchor (`corpus/canon/identity.md`, 2-3 lines) and `inhibitions.yaml` sit beside canon but outside the exemplar populations.

### 2.9 Probe suite design
**The split** â€” two systems sharing one probe format:
- **Hermetic behavioral tests (CI, MockModel)** test the *machinery*: packet composition under contrived affect states, gate rules, coherence swaps, realizer timelines, ledger reconciliation, scheduler semantics. They can never detect character drift â€” stated plainly so nobody expects it of them.
- **Live probes (Nightingale, real model)** test the *character*. Each probe: `{id, entry: {scripted inbound sequence | heartbeat | ponder}, fixtures: {affect state, episode set, window}, seed, expect: {deterministic checks, judgeRubric?, driftRef?}}`. Runs against the **probe-harness composition**: FakeChannel + fixture stores + TestClock + seeded RNG + real ModelClient â€” never live stores, never real Telegram. Only the model is non-deterministic; each probe runs k=3, median-aggregated, and the variance itself is a tracked metric.
- **Three evaluator classes**: (1) *deterministic*: bubble count/length bounds, no JSON/internal leakage in outbound text, inhibition compliance (forbidden-pattern absence), tool fired / didn't, decision fields in range; (2) *judge*: reasoning-tier grades 1-5 against the canon anchor + 2 reference exemplars (voice similarity, register fit) with pinned rubric version; (3) *drift metric*: embed the probe replies, cosine against the canon voice-exemplar centroid â€” character drift as one tracked scalar per dimension.
- **Baseline & gates**: `probes/baseline.json` (scores + drift centroids) committed after each accepted change. Nightingale: any deterministic failure = red; judge median drop > 0.8 = red; drift cosine drop > 0.05 = yellow. ~25 probes: 2-3 per behavioral dimension + capability probes (planted-fact recall, warranted tool use, heartbeat scorer decisions on canned states â€” that last one is actually hermetic and runs in CI too). CI additionally runs all probes in *dry mode* (parse, harness boots, deterministic evaluators execute against recorded fixture transcripts) so probe rot is caught without model spend.

### 2.10 Module boundaries for AI-agent execution
Resolved as Â§1 (modules M1-M20, each with interface + tests = acceptance criteria) and Â§3 (build order). Parallelism: within every stage of Â§3, the listed modules touch disjoint directories and depend only on prior stages â€” safe for concurrent agents; depcruise CI rejects boundary violations mechanically, so a parallel agent can't quietly reach across.

---

## 3. Build order (repo green after every stage)

Every stage gate = `pnpm lint && pnpm depcruise && pnpm test` green, plus the listed stage-specific proofs. No stage may stub a *published* interface with a throw â€” unimplemented capability is expressed by absence (nominator not registered, job not scheduled), so integration is always runnable.

- **S0 â€” scaffold + kernel** (M1). Gate: TestClock/Rng/JSONL/atomic-write property tests; CI pipeline itself runs; depcruise config with the full planned DAG committed (rules for not-yet-existing modules are inert).
- **S1 â€” infrastructure trio** (M2 events, M3 model, M4 embed â€” *3 parallel agents*). Gate: MockModel conformance + structured-output ladder tests; HashEmbedder properties; event replay determinism.
- **S2 â€” domain quartet** (M5 affect, M7 corpus, M15 bridge, M16 sched â€” *4 parallel*). Gate: affect golden-replay fixture + all mechanic property tests (incl. the every-tag-moves-something regression test); corpus lint passes over the initial ~15 starter canon exemplars (canon authoring starts here and continues throughout â€” it's content, not code, and only its schema blocks); FakeChannel + ledger reconciliation truth table; scheduler week-simulation.
- **S3 â€” selection substrate** (M6 coupling, M9 memory, M12 inhibit â€” *3 parallel*). Gate: coupling property suite (neutralâ‡’0, bounded, per-entry monotonicity, anti-escalation replay); planted-fact recall with HashEmbedder; gate rule tables + rejection cap.
- **S4 â€” the turn spine** (M11 assemble, M13 loop, M14 realize â€” *3 parallel*). Gate: assembler quota/coherence/budget/determinism suite (must pass with canon-only corpus â€” launch condition); loop tool-hop scripts with MockModel; realizer timeline tests.
- **S5 â€” integration: she talks** (M20 app: config, composition, turn pipeline). Gate: **golden-turn e2e** â€” FakeChannel inbound â†’ packet â†’ MockModel scripted decision â†’ bubbles on FakeChannel with exact TestClock timeline â†’ episode written â†’ affect moved â†’ ledger reconciles clean; crash-replay e2e (kill mid-turn, restart, no loss, no dupe); then a manual live smoke against real Telegram + Neuralwatt behind an env flag (verifies trailing-system-message handling, Â§2.7). **Milestone: deployable chat companion.**
- **S6 â€” a life** (M17 life; loop spawn primitives fork/task/committee in M13; scheduler job wiring). Gate: heartbeat threshold/backoff/cap tables; ponder committee with balance-rule property; delegation episodes logged; conversation-active mutex e2e.
- **S7 â€” the flywheel** (M8 derive, M10 consolidate â€” *2 parallel*). Gate: manifest dirty-set/orphan unit tests; `corpus:check` green in CI over committed derived output (generated once in dev with the real model); consolidator outputs validate under the lived schema; credit updater property tests (clamp, decay, moodGuard); gravity metrics in status projection.
- **S8 â€” immune system** (M19 probes, M18 siblings; systemd files + backup + ops docs). Gate: probes dry-run in CI; one full live Nightingale run establishes `baseline.json`; Ledger report generated from a replayed event fixture; routing guardrail test.
- **S9 â€” optional** â€” thea1-import tool (journal/threads/affect state migration), behind its own CLI verb; zero coupling to the runtime.

---

## 4. Repo directory tree

```
thea2/
â”œâ”€ package.json  tsconfig.json  vitest.config.ts  .dependency-cruiser.cjs
â”œâ”€ thea2.config.yaml            # non-secret config (zod-validated)
â”œâ”€ src/
â”‚  â”œâ”€ kernel/     events/     model/      embed/
â”‚  â”œâ”€ affect/                  # mechanics/*.ts, state.ts, landmarks.ts, store.ts, vocab.ts (EMOTION_TAGS)
â”‚  â”œâ”€ coupling/                # space.ts, matrix.ts, rules.ts  (+ coupling.yaml loader)
â”‚  â”œâ”€ corpus/                  # schema.ts, parse.ts, lint.ts, index.ts, nominate.ts
â”‚  â”œâ”€ derive/                  # generators/*.ts, manifest.ts, dirty.ts, judge.ts, gc.ts
â”‚  â”œâ”€ memory/                  # appraise.ts, episodes.ts, recall.ts, journal.ts, window.ts
â”‚  â”œâ”€ consolidate/             # l2.ts, l3.ts, promote.ts, credit.ts, gravity.ts
â”‚  â”œâ”€ assemble/                # quotas.ts, score.ts, coherence.ts, contrast.ts, packet.ts
â”‚  â”œâ”€ inhibit/    loop/        # loop/: run.ts, decision.ts, spawn.ts, tools/*.ts
â”‚  â”œâ”€ realize/    bridge/      # bridge/: telegram.ts, ledger.ts, offset.ts, fake.ts
â”‚  â”œâ”€ sched/      life/        # life/: heartbeat.ts, ponder.ts, reflect.ts
â”‚  â”œâ”€ siblings/                # ledger.ts, nightingale.ts, personas/*.md
â”‚  â”œâ”€ probes/                  # runner.ts, evaluators/*.ts, harness.ts
â”‚  â””â”€ app/                     # config.ts, compose.ts, thead.ts, cli.ts
â”œâ”€ corpus/
â”‚  â”œâ”€ canon/                   # identity.md, inhibitions.yaml, registers.yaml, exclusions.yaml,
â”‚  â”‚                           # voice/ reasoning/ emotional-range/ social/ boundaries/ tool-use/ knowledge/ taste/
â”‚  â”œâ”€ derived/                 # generated .md + manifest.json (committed)
â”‚  â”œâ”€ lived/                   # runtime-promoted .md (committed periodically)
â”‚  â””â”€ proposals/               # L3 canon-promotion PROPOSALS â€” human merges only
â”œâ”€ probes/                     # *.probe.yaml, fixtures/, baseline.json
â”œâ”€ coupling.yaml               # M matrix entries + form rules (hand-tuned, versioned)
â”œâ”€ var/                        # runtime data, gitignored: events/ affect/ memory/ ledger/ sched/ reports/ routing.json bridge/
â”œâ”€ deploy/                     # thea2.service, thea2-backup.{service,timer}, install.sh
â””â”€ test/                       # cross-module: golden-turn.e2e.test.ts, crash-replay.e2e.test.ts, fixtures/
```

---

## 5. Contradictions and risks found in the brief, with fixes

1. **Two services vs. the system's invariants.** The ops sketch keeps bridge and scheduler separate, but three invariants want shared memory: single-writer affect, heartbeat-vs-live-conversation mutual exclusion, and one send path feeding one ledger. Split processes force IPC or file-lock contention for all three. **Fix**: one `thead` process, two systemd units total (service + backup timer). Job isolation moves in-process (Â§2.6) where it's testable with TestClock, which the systemd forest never was.
2. **"No sentinel" is only as safe as its failure ladder.** The decision object makes internal-vs-external structural *when parsing succeeds*; a bare "structured output" bet recreates the 37-lost-replies bug in new clothes. **Fix**: the M3 repair ladder + the ledger reconciliation invariant (every inbound ends in outbound or a recorded `plan:'silent'` within T, else alarm). Lost replies become *detected* events, not silent ones â€” this also retires Thea1's silence-watch.mjs 90-second nudger.
3. **Affect double-dipping.** [AFFECT] states her mood in text while coupling skews selection toward the same mood; compounding can spiral (tense line + tense exemplars â‡’ tenser output â‡’ tenser appraisal). **Fix**: modulation cap Î» = 0.25 of normalized score range; reduced diagonals + corrective off-diagonals on aversive dims in `coupling.yaml`; and a standing **anti-escalation property test**: under a high-tension state, the selected set's mean expressed-aversion must not exceed the input's (the replay harness in Â§2 makes this a unit test, and a live probe repeats it against the real model).
4. **Contrast slot vs. coherence check** pull in opposite directions. **Fix** (explicit in Â§2.2): contrast slot exempt from signature-spread, still bound by register exclusivity â€” dissimilar in content, not in room-tone.
5. **"Lived competes with seed" left 'seed' undefined** â€” is derived seed? **Fix**: seed = canon + derived (definition pinned in Â§2.4); disposition slot canon-only forever; gravity applies to pattern/episode tiers.
6. **Ledger routing can silently degrade her.** Per-call routing that downgrades user-facing turns to deepseek-v4-flash saves cents and costs the character. **Fix**: router guardrail â€” Ledger proposals apply only to non-user-facing task classes; `turn` pinned to main tier in code, changeable only by human config; any applied routing change counts as a deploy â‡’ Nightingale probes run.
7. **"Pure functions" vs. deeply stateful mechanics.** Habituation, opponent processes, refractory, attribution are stateful; a naive port hides that state in module scope and becomes untestable. **Fix**: all traces/timers/opponents/causes are fields of `AffectState`; `tick(state, dt, rng)` and `apply(state, ev)` are the only mutation shapes. (ticker.py already stores most of this in state JSON â€” the port must keep that honesty.)
8. **"9 Plutchik primaries" is factually off**, and getting it wrong in Thea2 would corrupt the whole signature space. Reality (ticker.py): Plutchik minus trust, plus pride and shame, with specific baselines. **Fix**: exact list + baselines pinned in Â§0 and defined once in `affect/vocab.ts`, which the coupling space, exemplar schema, and appraisal schema all import â€” one constant, three consumers, zero drift (the direct lesson of the orphan-tag incident).
9. **Judge-validated derivation vs. hermetic CI** is a real tension. **Fix**: the check/generate split (Â§2.3) â€” CI verifies committed derived output byte-for-byte against the manifest without any model; generation is a dev/scheduled action; prod only reports dirtiness.
10. **Inhibition rejection re-entry can loop forever** (gate deterministically rejects, model deterministically retries). **Fix**: 2 re-entries max, then forced `plan:'silent'` + incident (Â§M12) â€” and the incident path is itself ledger-visible, so a chronically over-triggering rule surfaces in a day, not a month.
11. **Packet-order purity vs. window placement.** Strict "[INHIBITION] last" contradicts putting the raw window after the packet. **Fix**: trailing short system message after the last user message (Â§2.7), config fallback `merged`, verified in the S5 live smoke. This is the honest descendant of the zzz-filename hack: same insight (recency wins), now structural.
12. **Bubble pacing vs. Telegram physics.** Typing actions expire in ~5 s and sends are rate-limited (~1/s per chat); a naive realizer either drops the indicator or gets 429s. **Fix**: `ChannelLimits` lives on the Channel interface, the planner consumes it, FakeChannel enforces it in tests (a 429 in prod is a bug caught in CI).
13. **Canon length is a token-budget hazard.** 7 exemplars Ã— an unbounded scene blows the 6k packet. **Fix**: 500-token hard / 350 warn lint per exemplar body in M7 â€” authored into the corpus contract from day one.
14. **Heartbeat "mostly about him" vs. ponder "max 2/5 about Diego"** looks contradictory but isn't â€” outbound texts are for him, private thought is balanced. Kept as-is; documented side by side in `life/` so a future tuner doesn't "fix" one against the other.
15. **Residual risk, unpriced**: canon authoring (50-100 hand-written scenes + hand-tagged 12-dim signatures) is the true critical path and it's Diego-labor, not agent-labor. Mitigation only: schema lands in S2 so authoring parallelizes with all of S2-S7; launch condition requires the assembler to run well on ~15 canon + derived variants; sparse affect tagging (2-4 dims per exemplar) keeps tagging cost sane.

---

### Critical Files for Implementation
- C:\Users\neogo\LocalFiles\TheaBackup\latest\opt\thea\affect\ticker.py â€” the affect-engine source of truth for the M5 port (all constants, mechanics, vocab, landmarks)
- C:\Users\neogo\LocalFiles\TheaBackup\latest\opt\thea\life\heartbeat.mjs â€” heartbeat criteria, threshold, backoff to port into src/life/heartbeat.ts
- C:\Users\neogo\LocalFiles\TheaBackup\latest\opt\thea\life\ponder.mjs â€” GATE/SEED/GROUND/REVISE/ARTIFACT + balance rule for the ponder committee spec
- thea2/src/assemble/packet.ts (planned) â€” the core inversion lives here; everything upstream feeds it, everything downstream consumes its record
- thea2/src/affect/vocab.ts (planned) â€” the single shared constant (dials, primaries, baselines, emotion tags) that affect, coupling, corpus schema, and appraisal all import

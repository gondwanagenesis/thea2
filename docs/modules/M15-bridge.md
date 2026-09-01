---
module: M15
name: bridge
syncedTo: S3 (implemented — src/bridge, test/bridge; ingestUpdates + thead wire-in at S5)
stage: S2
depends: [M01-kernel, M02-events]
---
# M15 — bridge

## Responsibility
The Telegram edge: long-poll `getUpdates` behind the `Channel` interface, the append-only **MessageLedger**, and the reconciliation invariant that makes lost replies a *detected event* instead of a silent one — the structural replacement for Thea1's ⟦TG⟧ sentinel (which silently ate 37 real replies in one week) and silence-watch.mjs. The load-bearing ordering is **offset committed only after ledger append + handler enqueue**: at-least-once delivery, deduped by `update_id` in the ledger, which fixes Thea1's crash-loss bug at the root.

## Interfaces (contract)
```ts
export interface SpeakerRef { person: string; channel: string }   // 'diego:phone', 'operator:cli'
export interface InboundMsg {
  updateId: number; msgId: number; chatId: number; ts: number;
  text: string;
  speaker: SpeakerRef;                               // stamped on EVERY inbound — pathology 3 fix
  reaction?: { emoji: string; toMsgId: number };     // free outcome signal for credit (§2.1)
}
export interface ChannelLimits { maxMsgChars: number; minSendGapMs: number /* 1100 */; typingRefreshMs: number /* 4000 */ }
export interface Channel {
  updates(signal: AbortSignal): AsyncIterable<InboundMsg>;
  send(chatId: number, text: string): Promise<{ msgId: number }>;
  typing(chatId: number): Promise<void>;
  readonly limits: ChannelLimits;
}
export const telegramChannel: (cfg: { token: string; apiBase?: string }) => Channel;

export type DecisionSummary = { turnId: string; plan: 'reply' | 'silent' | 'defer'; at: number };
export type Discrepancy =
  | { kind: 'LOST_REPLY'; inbound: InboundMsg; ageMs: number }
  | { kind: 'DUPLICATE_INBOUND'; updateId: number };
export interface MessageLedger {
  recordInbound(m: InboundMsg): Promise<boolean>;    // false = duplicate update_id
  recordDecision(turnId: string, d: DecisionSummary): Promise<void>;
  recordOutbound(turnId: string, msgId: number, text: string): Promise<void>;
  reconcile(now: number): Promise<Discrepancy[]>;    // pure read over the ledger + T window
}
export const openMessageLedger: (dir: string, deps: { clock: Clock }) => MessageLedger;

export const FakeChannel: (opts?: { limits?: Partial<ChannelLimits> }) => Channel & {
  queueInbound(m: InboundMsg): void;         // scriptable inbound
  outbound(): Array<{ chatId: number; text: string; msgId: number }>;  // captured
  injectReaction(r: { emoji: string; toMsgId: number }): void;
};
```

## Behavior spec
- **Delivery is at-least-once with ledger dedupe.** The poll loop: fetch batch → for each update, `recordInbound` (returns false on duplicate) → if new: enqueue to the pipeline, THEN commit the offset. A crash anywhere before offset commit ⇒ redelivery on restart ⇒ `recordInbound` returns false ⇒ dropped as duplicate. No message is lost by the ordering; none is handled twice (the S2 crash-replay test is exactly this sequence with the process killed between handle and commit). One window the ordering cannot recover: a crash *between* the ledger append and the handler running — on redelivery the update dedupes, so the turn never runs. That loss is never silent: reconciliation (ADR-003) alarms it as `LOST_REPLY` with the message attached (S2 crash-replay scenario 3 proves the alarm fires with exact wording).
- **`allowed_updates` includes `message_reaction`** — reactions are free outcome signals for credit assignment (M09's `outcomePrev` factual rubric) and surface in the ledger attached to their `toMsgId`.
- **Speaker provenance** (`<person>:<channel>`) is stamped at the bridge from the Telegram sender + transport, and travels on every `InboundMsg` — the register system (work/friend/play) and the interlocutor section key off it. Provenance is never inferred later from text.
- **Reconciliation invariant**: every inbound must terminate within `T` minutes (config; suggested default 10) in **≥1 outbound** (ledger `recordOutbound` for its turn) **OR a recorded `plan:'silent'` decision** — anything else is a `LOST_REPLY` discrepancy. The 5-minute `reconcile` scheduler job (M16) calls `reconcile(now)`; discrepancies emit `bridge.lost_reply` alarm events (which page through the Ledger sibling's daily report). Silence by design is a *typed* outcome; silence by failure is an *alarm* — that distinction is the whole point.
- `recordInbound` is durable-on-resolve (kernel JSONL append); `recordDecision`/`recordOutbound` likewise. Ledger files under `var/ledger/` (daily-rotated JSONL); the ledger is NOT L0 (M02) — it is the delivery-correctness store, separate from the analytical event log by design.
- **`telegramChannel`** is the only module that speaks Telegram wire format: long poll (timeout ~25s, backoff on network errors drawn from an injected forked rng — the adapter takes an rng for this), `sendChatAction: typing` for the indicator, `sendMessage` for text. Bot token arrives via config (M20; env/keys.env outside the repo — AGENTS rule 7; a NEW token, never Thea1's).
- **`ChannelLimits` carries Telegram physics**: typing actions expire ~5s (M14 re-fires every 4s), sends rate-limited ≥1.1s per chat. The real adapter publishes honest limits; **FakeChannel enforces them** — a send-gap violation or an oversized message in a test fails loudly, which is how "429 in prod" becomes "red in CI" (§5.12).
- **`FakeChannel`** is a real test double with its own conformance duties: scriptable inbound queue, captured outbound, reaction injection, limit enforcement, deterministic msgId assignment. The real adapter's PARSING layer (wire payload → `InboundMsg`) and FakeChannel's producer side pass one shared conformance suite over **recorded `getUpdates` fixtures** — the same discipline as M03's MockModel.
- Rate-limit handling on send: 429 → wait `retry_after` (clock-injected), retry once, then surface a typed error + `bridge.send_failed` event. The realizer's ≥1.1s pacing makes this a should-never-fire path, not a strategy.

## Not this module's job
- Deciding what to send or when — M13 decides, M14 paces and executes via `Channel`.
- The turn pipeline, offset vs ledger ordering beyond the contract above — M20 composes (bridge exposes the seams).
- Reconcile scheduling — M16-sched (M15 provides `reconcile(now)`).
- L0 event log — M02 (bridge emits `bridge.*` events there; the ledger is separate).
- Building packets or reading memory — everything upstream of the edge stays upstream.

## Acceptance criteria
- [ ] Crash-replay: kill between `recordInbound`+enqueue and offset commit ⇒ restart redelivers ⇒ duplicate flagged false, handled exactly once (TestClock + injected fault).
- [ ] Offset is never committed before ledger append + enqueue (ordering asserted with an instrumented ledger).
- [ ] Reconciliation truth table over a scripted ledger: replied ⇒ clean; decided-silent ⇒ clean; neither within T ⇒ `LOST_REPLY` with correct age; duplicate inbound ⇒ `DUPLICATE_INBOUND`.
- [ ] `message_reaction` updates parse into `InboundMsg.reaction` and land in the ledger keyed to `toMsgId` (recorded fixture).
- [ ] Speaker provenance stamped on every inbound from recorded fixtures (text message, edited message ignored, reaction).
- [ ] FakeChannel conformance suite runs against the real parsing layer over recorded `getUpdates` fixtures — byte-equal `InboundMsg` values.
- [ ] FakeChannel enforces limits: a send inside `minSendGapMs` or over `maxMsgChars` throws in tests.
- [ ] 429 handling: scripted `retry_after` respected via injected clock, one retry, then typed failure + `bridge.send_failed`.

## Test checklist
- unit: ledger dedupe on update_id; reconcile truth table incl. T-boundary (T−1s vs T+1s via TestClock); limits defaults; parse-layer goldens over recorded fixtures.
- component: poll loop with TestClock (backoff on errors, clean abort via signal); crash-replay cycle with fault injection at every ordering seam; FakeChannel/real-parser conformance matrix.
- fixtures needed: recorded `getUpdates` payload fixtures (message, reaction, edited_message, non-text); a scripted ledger spanning the three reconciliation outcomes; a 429 response fixture.

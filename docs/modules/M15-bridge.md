---
module: M15
name: bridge
syncedTo: v6-W1 (2026-09-03 — P-CLOSE: abandoned terminal rows, alarm ladder, reconcile fold snapshot, poll caller signal + poll failure events; see "As built (P-CLOSE)" at the end)
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

## As built (Phase 1)

- Reconcile provenance is pinned by truth table (test/bridge/ledger.test.ts): a `decidedBy:'failure'` silence stays LOST_REPLY past T (silence by failure is a discrepancy); a `'gate'` silence is clean; a legacy silent row WITHOUT `decidedBy` reads clean (absent provenance predates the failure marker); a skipped inbound is never lost; `recordDecision` persists `decidedBy` durably.
- **DELIBERATE DEVIATION from the determinism law (owner's decision, kept — record, do not copy):** src/bridge/telegram.ts arms a real-timer `AbortSignal.timeout(HTTP_TIMEOUT_MS)` (60 s) on every Telegram HTTP call — the one `setTimeout`-class device in module code. It is a host-network backstop: a getUpdates socket that never answers would otherwise hang the poll loop forever; 60 s sits far above the 25 s long-poll. Hermetic tests never take this path (FakeChannel); this pattern is forbidden everywhere else.

## As built (P-CLOSE, v6-W1, 2026-09-03)

- **Every loss terminates (CL.2).** New ledger row `{kind:'abandoned', updateId, ts, reason:'grace'|'moved-on'|'operator'}` — reconcile treats it as the loss's outcome, so an abandoned loss is never `LOST_REPLY` again and the heartbeat's `owedInbound` (M20's reconcile count) is only non-abandoned losses. The recovery paths that write `grace`/`moved-on` live in M20 (maintenance-jobs); the operator path is `thea2 ack <updateId>`. Named tests: `abandoned-loss-is-not-owed`, `ack writes an abandoned row`.
- **The alarm ladder.** `bridge.lost_reply` fires ONCE per updateId, then again only when the loss crosses 1 h / 6 h / 24 h (D.6-6); the payload carries `escalation: 'initial'|'1h'|'6h'|'24h'`. The rung state (`lastEscalation` per open arrival) is part of the reconcile fold — durable across restarts — and only advances after the emit SUCCEEDED: an unheard alarm is re-emitted on the next pass. `emitLostReplyAlarms(log, discrepancies, ledger?)` reads/marks that state through the ledger (`alarmDue` / `markAlarmed`); ledger-less callers (the doctor, pure tests) emit everything due. Named test: `alarm fires once then escalates`.
- **Reconcile is a fold (CL.7).** The first pass replays the ledger once and persists the projection to `var/ledger/reconcile-state.json`: open + redelivered arrivals (with their link/decision/abandon/alarm state), per-chat inbound recency (two newest) and outbound recency, the consumed row count and the last file. Later passes parse ONLY the tail (`store.read({ since: consumedRows })`); `lastReconcileReplayedRows()` exposes the count for diagnostics. A missing or pruned `lastFile` falls back to the full replay; a corrupt snapshot is a typed startup failure (`bridge/reconcile-state-corrupt`). Snapshot writes are serialized (the window's Windows-EPERM law: two concurrent renames onto one file is a crash, not a retry). The doctor's `reconcileLedgerRows` is the same verdict code over a pure whole-history read. Named test: `reconcile replays only the tail after a snapshot`.
- **The poll gets the signal (CL.4).** `httpCall` combines the caller `AbortSignal` with the 60 s backstop via `AbortSignal.any`, and `pollUpdates` passes its stop signal — a thead stop cuts an in-flight long poll immediately and ends the iterator cleanly (no throw, no further fetch, no failure events: an operator stop is not a failure). Named test: `stop aborts an in-flight poll`.
- **Poll failures are events (CL.4).** `bridge.poll_failed {failures, backoffMs}` on the FIRST failure and on every pass where the uncapped backoff reaches the 30 s cap; `incident.poll_down {failures, error}` at `POLL_DOWN_AFTER` = 5 consecutive failures (the counter resets on any success). Named test: `poll failures are events`.

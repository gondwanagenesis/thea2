---
module: M14
name: realize
syncedTo: S8 (src/realize + test/realize, 43 tests green; voice guarding lives in M06/M10/M12/M19 — see "As built")
stage: S4
depends: [M01-kernel, M06-coupling, M15-bridge]
---
# M14 — realize

## Responsibility
Turn a locked decision plus the current affect signature into a concrete delivery timeline, then execute that timeline against the Channel with the injected clock. `planDelivery` is a pure function producing a `DeliveryPlan` of pause/typing/send steps; the executor replays it, honoring channel physics (typing expiry, send rate). Invariant: **cadence is caused by decision fields + affect, never restyled text** — the realizer times and paces what the decision said, and does not rewrite a word of it.

## Interfaces (contract, as built)
```ts
// Structural subset of M13's DecisionObject (S4 build-parallelism: no M13 import; the full object satisfies it).
export interface RealizableDecision {
  plan: 'reply' | 'silent' | 'defer';
  bubbles: string[];
  reluctance: number;   // [0,1] — out-of-range values clamp, they do not throw
  weight: number;
  confidence: number;
}

export type DeliveryStep =
  | { kind: 'pause'; ms: number }
  | { kind: 'typing'; ms: number }
  | { kind: 'send'; text: string };

export interface DeliveryPlan {
  steps: DeliveryStep[];
  totalMs: number;   // exact sum of the step durations — never a separate estimate
}

export const planDelivery: (d: RealizableDecision, a: Vec12, limits: ChannelLimits, rng: Rng) => DeliveryPlan;
//   Pure. Throws realize/vec-length if `a` is not 12 finite entries. Also exported for
//   tests/tuning: shapeBubbles, typingCps(arousal, valence), gapMs(arousal, jitter), and the
//   law constants (PRE_DELAY_*, CPS_*, LOW_VALENCE_CPS_FACTOR, GAP_*, TOTAL_CAP_MS, MAX_BUBBLES).

export interface ExecResult { sent: Array<{ msgId: number; text: string }>; aborted: boolean; undelivered: string[]; }
export const executePlan: (plan: DeliveryPlan, chatId: number, ch: Channel, clock: Clock, signal: AbortSignal) => Promise<ExecResult>;

// The composition entry M20 calls — plan + execute + per-send ledger record in one call:
export interface DeliveryReport { plan: DeliveryPlan; sent: ExecResult['sent']; aborted: boolean; undelivered: string[]; }
export interface RealizeDeps {
  chatId: number;
  channel: Channel;
  clock: Clock;
  signal: AbortSignal;
  recordSend?: (msgId: number, text: string) => Promise<void> | undefined;  // wire to MessageLedger.recordOutbound
}
export const realize: (d: RealizableDecision, affect: Vec12, rng: Rng, deps: RealizeDeps) => Promise<DeliveryReport>;
```

## Behavior spec
- Invariant restated as a rule: output texts are the decision's bubbles verbatim. The only permitted text operations are merging adjacent bubbles (newline join) and splitting an oversized bubble on paragraph/sentence boundaries. No paraphrase, no restyling, no tone adjustment — tone was already caused upstream by the packet and the decision.
- `plan: 'silent'` and `plan: 'defer'` produce an empty DeliveryPlan (no steps); defer follow-up semantics live upstream.
- Typing speed: chars-per-second = lerp(6 -> 14) with the arousal deviation (a[arousal] over [-1,1] mapped across the lerp range). Low valence (a[valence] < 0) slows cps by 15%.
- Pre-delay before the first bubble: 800 ms + 2500 ms · reluctance.
- Inter-bubble gap: 300–1200 ms, shrinking with arousal.
- Typing duration per bubble = bubble chars / cps, expressed as typing steps.
- Total plan ≤ 45 s. If the raw plan exceeds it, pause and typing durations scale down proportionally; sends are never dropped (completion — the report pins the cap, not the compression method).
- Merging: if bubbles > 5, or any bubble exceeds `limits.maxMsgChars`, merge/split until within limits before planning. A bubble under the char limit is never split. Splits happen first, then the merge pass — so the count cap can never push a piece over the char cap. When the two conflict, the char cap outranks the count cap: a join that would breach `maxMsgChars` is skipped, leaving more than 5 bubbles rather than an over-limit send (Telegram rejects the send; the count is only style). Whitespace-only bubbles are dropped first (no words, no timing).
- A single sentence longer than `limits.maxMsgChars` has no legal cut (only paragraph/sentence boundaries are permitted), so it throws `realize/unsplittable-bubble` instead of emitting a send the channel will reject. The gap jitter is ±15% around the arousal curve, clamped back inside [300, 1200] ms, drawn from `rng.fork('realize/gap')`.
- Executor: re-fires the typing indicator on every `limits.typingRefreshMs` tick inside a typing span (the Telegram preset's 4000 satisfies "every 4 s"), and never after the span ends; enforces ≥ `limits.minSendGapMs` between consecutive sends per chat **by construction** — the schedule is held until the gap has elapsed (the reference instant is when the send hits the wire, so a slow transport cannot skew the next hold); all waits go through the injected clock — no wall-clock sleeps.
- Interruption: a new inbound aborts the remaining steps via the AbortSignal; `ExecResult.undelivered` carries the unsent bubbles read off the remaining plan — including the bubble she was mid-typing when the abort landed; the M20 pipeline feeds them into the next turn's context as "she was about to say".
- The realizer emits nothing to the ledger itself; the pipeline records each successful send via `MessageLedger.recordOutbound`. `realize()` exposes that seam as `RealizeDeps.recordSend`, invoked after execution in delivery order — so a ledger row's `ts` is the recording time, while the channel's accept times live on the `ExecResult`/captured-send side, linked by `msgId`. Until M20 terminates an aborted turn, reconcile correctly stays armed (`LOST_REPLY`): partial delivery is only clean once the pipeline records what did land.

## Not this module's job
- Bubble wording, count, and plan choice — M13-loop (the decision).
- Affect values — M05/M06 supply the Vec12; realize only reads it.
- Channel transport, retries, and the definition of `ChannelLimits` — M15-bridge.
- Ledger recording and next-turn carry-over of undelivered bubbles — M20 pipeline (using M15).
- Deciding to interrupt — M20 pipeline detects the new inbound and fires the signal.

## Acceptance criteria
- [x] Verbatim invariant holds: concatenated sent text equals concatenated bubble text modulo merge joins and boundary splits; property-tested (300 seeded random plans across Telegram and a tighter synthetic limit set), zero character-level rewrites.
- [x] Exact constants: pre-delay 800 + 2500·reluctance ms; cps lerp 6->14 with arousal; −15% cps under low valence; gap 300–1200 ms shrinking with arousal; total ≤ 45 s; typing re-fire every 4 s; ≥ 1.1 s between sends.
- [x] Monotonicity: pre-delay strictly increases with reluctance (40 seeded trials × 11-point grid); higher arousal never lengthens the total and strictly tightens it across the span, with sends invariant.
- [x] silent/defer produce empty plans.
- [x] Merge at >5 bubbles or oversize; splits only on paragraph/sentence boundaries; char cap outranks the count cap.
- [x] Deterministic per seed.
- [x] Interruption mid-plan aborts cleanly, reports `undelivered`, sends nothing further; ledger records exactly what was delivered and reconcile stays clean (and says `LOST_REPLY` when nothing was).

## Deviations as built (S4)
- **`realize()` composition entry added** (spec listed only `planDelivery`/`executePlan`): `realize(d, affect, rng, deps) → DeliveryReport`, with `RealizeDeps { chatId, channel, clock, signal, recordSend? }`. This is the handoff M20 composes. It keeps "the realizer emits nothing to the ledger itself" true — the ledger write is an injected callback M20 wires to `MessageLedger.recordOutbound`, and it is exercised end-to-end in the executor tests.
- **Typing re-fire interval comes from `limits.typingRefreshMs`** rather than a hard-coded 4 s (the Telegram preset's 4000 satisfies the spec text; a synthetic channel with its own cadence is honored the same way).
- **`realize/unsplittable-bubble`** (new code): a single sentence with no paragraph/sentence boundary inside `maxMsgChars` fails loudly instead of sending an over-limit message. **`realize/vec-length`** guards the affect vector (non-12-dim or non-finite entries throw rather than producing a NaN timeline). Out-of-range reluctance/affect entries clamp instead of throwing — badness upstream degrades to the rails, it does not take the turn down.
- **Split-then-merge precedence, char cap outranks count cap**: when >5 bubbles cannot be merged without breaching `maxMsgChars`, more than 5 bubbles are sent rather than one illegal send. The spec said "merge/split until within limits" without ordering the two caps.
- **Whitespace-only bubbles are dropped** — they carry no words and no timing.
- **45 s compression method** (the spec explicitly leaves it open): every pause/typing step scales by one shared factor with floor rounding, the residual shaved off the longest steps; `totalMs` always equals the exact step sum.
- Test-side note (upstream trait, not a deviation here): `TestClock.advance` drains only two microtask hops per fired waiter, while the executor's chain to its next registration is 3–4 hops — so tests drive the clock in small slices with settles between (`test/realize/helpers.ts` `drive()`). Exact-time assertions hold because every due instant stays ahead of the clock until it is exactly due.

## As built (S8) — the verbatim invariant stands; voice is guarded, not rewritten

No exception to the S4 invariant exists in the built system: `shapeBubbles`
performs only whitespace-drops, paragraph/sentence-boundary splits, and
adjacent merges (char cap outranks count cap). There is no paraphrase,
restyle, or post-generation voice pass anywhere under `src/realize`.

Voice fidelity is carried and guarded elsewhere:

- **Carried by demonstration** — the packet assembler picks canon voice
  exemplars per register (M06/M08); the draft prompt (M10) bans the
  corpus-zero tells.
- **Vetoed, not edited** — the inhibition gate (M12) rejects and rephrases;
  the re-entry cap and severity semantics (soft fails open, hard forces
  silent) live in the loop's gate ladder.
- **Normalized before the gate** — `gate.normalizeText` (the yaml's
  `normalize` class: character-only, idempotent) is applied to every bubble
  in the loop immediately before `checkPlan`, so the gate judges what will
  actually send and `realize` receives already-final text. Wired
  2026-09-02 (previously compiled and tested but unwired); regression test in
  `test/loop/loop.test.ts`.
- **Measured** — the drift probe (M19) cosines live replies against the
  canon-voice exemplar centroid; cosine drop > 0.05 from baseline trips
  yellow.

The Thea1 voice committee's per-turn gear classifier and sentinel-token gate
are heritage, not current code. If ever ported, they must land as their own
module with this invariant renegotiated explicitly — never slipped into
`realize`.

## Test checklist
- unit: pure `planDelivery` property tests — monotone in reluctance, arousal shortens, caps hold, determinism per seed, merge/split rules, proportional compression at the 45 s cap, silent/defer emptiness.
- component: executor against FakeChannel + TestClock asserting the exact step timeline (typing re-fires at 4 s cadence, send gaps ≥ 1.1 s); interruption mid-plan; FakeChannel limit-violation detection (a 429-shaped bug fails in CI).
- ledger: `realize()` run through M20's protocol (recordInbound → linkTurn → recordDecision → per-send `recordOutbound`) — delivered bubbles are exactly the ledger's outbound rows, reconcile clean for partial delivery and decided-silent, `LOST_REPLY` when an abort delivers nothing.
- fixtures needed: decision fixtures across a reluctance/arousal/valence grid; FakeChannel; ChannelLimits presets (Telegram values and a tighter synthetic set).

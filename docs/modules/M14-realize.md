---
module: M14
name: realize
syncedTo: spec-v1 (no code yet)
stage: S4
depends: [M01-kernel, M06-coupling, M15-bridge]
---
# M14 — realize

## Responsibility
Turn a locked decision plus the current affect signature into a concrete delivery timeline, then execute that timeline against the Channel with the injected clock. `planDelivery` is a pure function producing a `DeliveryPlan` of pause/typing/send steps; the executor replays it, honoring channel physics (typing expiry, send rate). Invariant: **cadence is caused by decision fields + affect, never restyled text** — the realizer times and paces what the decision said, and does not rewrite a word of it.

## Interfaces (contract)
```ts
// Structural subset of M13's DecisionObject (S4 build-parallelism: no M13 import; the full object satisfies it).
export interface RealizableDecision {
  plan: 'reply' | 'silent' | 'defer';
  bubbles: string[];
  reluctance: number;   // [0,1]
  weight: number;
  confidence: number;
}

export interface DeliveryPlan {
  steps: Array<{ kind: 'pause'; ms: number } | { kind: 'typing'; ms: number } | { kind: 'send'; text: string }>;
  totalMs: number;
}

export const planDelivery: (d: RealizableDecision, a: Vec12, limits: ChannelLimits, rng: Rng) => DeliveryPlan;

export interface ExecResult { sent: Array<{ msgId: number; text: string }>; aborted: boolean; undelivered: string[]; }
export const executePlan: (plan: DeliveryPlan, chatId: number, ch: Channel, clock: Clock, signal: AbortSignal) => Promise<ExecResult>;
```

## Behavior spec
- Invariant restated as a rule: output texts are the decision's bubbles verbatim. The only permitted text operations are merging adjacent bubbles (newline join) and splitting an oversized bubble on paragraph/sentence boundaries. No paraphrase, no restyling, no tone adjustment — tone was already caused upstream by the packet and the decision.
- `plan: 'silent'` and `plan: 'defer'` produce an empty DeliveryPlan (no steps); defer follow-up semantics live upstream.
- Typing speed: chars-per-second = lerp(6 -> 14) with the arousal deviation (a[arousal] over [-1,1] mapped across the lerp range). Low valence (a[valence] < 0) slows cps by 15%.
- Pre-delay before the first bubble: 800 ms + 2500 ms · reluctance.
- Inter-bubble gap: 300–1200 ms, shrinking with arousal.
- Typing duration per bubble = bubble chars / cps, expressed as typing steps.
- Total plan ≤ 45 s. If the raw plan exceeds it, pause and typing durations scale down proportionally; sends are never dropped (completion — the report pins the cap, not the compression method).
- Executor: re-fires the typing indicator every 4 s during typing spans (Telegram's indicator expires at ~5 s); enforces ≥ 1.1 s between consecutive sends (`limits.minSendGapMs`); all waits go through the injected clock — no wall-clock sleeps.
- Merging: if bubbles > 5, or any bubble exceeds `limits.maxMsgChars`, merge/split until within limits before planning. A bubble under the char limit is never split.
- Determinism: for fixed (decision, affect, limits, seed) the plan is byte-identical; jitter draws come from a forked rng.
- Interruption: a new inbound aborts the remaining steps via the AbortSignal; `ExecResult.undelivered` carries the unsent bubbles; the M20 pipeline feeds them into the next turn's context as "she was about to say".
- The realizer emits nothing to the ledger itself; the pipeline records each successful send via `MessageLedger.recordOutbound`.

## Not this module's job
- Bubble wording, count, and plan choice — M13-loop (the decision).
- Affect values — M05/M06 supply the Vec12; realize only reads it.
- Channel transport, retries, and the definition of `ChannelLimits` — M15-bridge.
- Ledger recording and next-turn carry-over of undelivered bubbles — M20 pipeline (using M15).
- Deciding to interrupt — M20 pipeline detects the new inbound and fires the signal.

## Acceptance criteria
- [ ] Verbatim invariant holds: concatenated sent text equals concatenated bubble text modulo merge joins and boundary splits; property-tested, zero character-level rewrites.
- [ ] Exact constants: pre-delay 800 + 2500·reluctance ms; cps lerp 6->14 with arousal; −15% cps under low valence; gap 300–1200 ms shrinking with arousal; total ≤ 45 s; typing re-fire every 4 s; ≥ 1.1 s between sends.
- [ ] Monotonicity: pre-delay strictly increases with reluctance; higher arousal never lengthens the total.
- [ ] silent/defer produce empty plans.
- [ ] Merge at >5 bubbles or oversize; splits only on paragraph/sentence boundaries.
- [ ] Deterministic per seed.
- [ ] Interruption mid-plan aborts cleanly, reports `undelivered`, sends nothing further.

## Test checklist
- unit: pure `planDelivery` property tests — monotone in reluctance, arousal shortens, caps hold, determinism per seed, merge/split rules, proportional compression at the 45 s cap, silent/defer emptiness.
- component: executor against FakeChannel + TestClock asserting the exact step timeline (typing re-fires at 4 s cadence, send gaps ≥ 1.1 s); interruption mid-plan; FakeChannel limit-violation detection (a 429-shaped bug fails in CI).
- fixtures needed: decision fixtures across a reluctance/arousal/valence grid; FakeChannel; ChannelLimits presets (Telegram values and a tighter synthetic set).

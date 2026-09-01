---
module: M02
name: events
syncedTo: S1 (implemented — src/events, test/events)
stage: S1
depends: [M01-kernel]
---
# M02 — events

## Responsibility
Own the L0 event log: one append-only, daily-rotated JSONL stream of typed envelopes with a monotonic `seq`, plus a replay reader and a projection helper. Every subsystem writes here — model calls with cost, packet records, decisions, inbound/outbound messages, affect snapshots, job runs, incidents. L0 is the ground truth that credit assignment (M10), the Ledger sibling (M18), and reconciliation debugging replay from. It never enters prompts.

## Interfaces (contract)
```ts
export interface EventEnvelope<K extends string = string, P = unknown> {
  seq: number;      // monotonic across rotations and restarts, starts at 1
  ts: number;       // epochMs from the injected clock at emit
  kind: K;          // namespaced string, e.g. "model.call", "derive.orphan_gc"
  turnId?: string;
  payload: P;       // JSON-serializable; producer owns the schema
}

export interface EventLog {
  emit<K extends string, P>(kind: K, payload: P, turnId?: string): Promise<void>;
  replay(filter?: { kinds?: string[]; sinceTs?: number }): AsyncIterable<EventEnvelope>;
}

export const openEventLog: (dir: string, deps: { clock: Clock }) => Promise<EventLog>;

// Deterministic fold over the log; step must not touch clock/rng.
export const project: <S>(
  log: EventLog, init: S,
  step: (s: S, ev: EventEnvelope) => S,
  filter?: { kinds?: string[]; sinceTs?: number },
) => Promise<S>;
```

## Behavior spec
- Storage: `var/events/events-YYYY-MM-DD.jsonl` via the kernel JsonlStore with `rotateDailyUtc`. Rotation never resets `seq`.
- On open, recover the next `seq` by reading the tail of the newest file (kernel crash-tail tolerance applies: a torn final line is skipped and its seq is reused for the next durable emit).
- `emit` is durable-on-resolve: the append completes before the promise resolves. Emits are serialized internally so concurrent callers get distinct, increasing seq and no interleaved lines.
- Emit failure policy: one retry, then reject with a typed error and write a stderr line. Callers on the turn path treat event-log failure as advisory — a turn must never die because L0 was unwritable (asserted in the M20 golden-turn e2e).
- `replay` yields envelopes in (file date, seq) order; `kinds` is an exact-match set; `sinceTs` is inclusive.
- `project` is a pure fold: same log + same step = deep-equal projection, every time. This determinism is what makes L0 the rebuild path for any downstream projection.
- Payload guard: payloads must be JSON-serializable and under 32 KB serialized (default, config-overridable); oversized payloads are rejected with a typed error. Store ids and file paths, not blobs.
- Kinds are open strings but must carry a dot-namespace. Reserved namespaces (documented, not enforced beyond the dot rule): `model.*`, `embed.*`, `affect.*`, `corpus.*`, `derive.*`, `memory.*`, `consolidate.*`, `credit.*`, `packet.*`, `decision.*`, `bridge.*`, `sched.*`, `life.*`, `probe.*`, `incident.*`. Kinds named elsewhere in the specs (`model.parse_failed`, `derive.orphan_gc`, `memory.outcome_prev`, `packet.record`) live in their producers' specs; M02 stores them opaquely.
- Boundary rule: no code path may render L0 content into a prompt. Enforced by review plus the M19 deterministic evaluator that scans outbound text for internal leakage.

## Not this module's job
- Payload schemas and their evolution — each producing module (M03, M05, M09, M10, M11, M13, M15, M16).
- Human-readable projections `journal.md` / `threads.json` — M09-memory.
- Cost/latency aggregation and reports — M18-siblings.
- The message ledger and its reconciliation invariant — M15-bridge (a separate store, not L0).
- Scheduling of any replay-consuming job — M16-sched.

## Acceptance criteria
- [ ] `seq` is strictly increasing across three simulated days including two mid-day restarts (TestClock; reopen recovers next seq from the tail).
- [ ] `replay` with a kind filter returns exactly the matching envelopes, in order; `sinceTs` cuts inclusively.
- [ ] Projection rebuild determinism: folding the same fixture log twice yields deep-equal states.
- [ ] Crash tail on the newest file: reopen skips the torn line and continues from the last durable seq with no gap larger than 1 and no duplicate seq.
- [ ] 1k concurrent `emit` calls produce 1k distinct seq values and 1k parseable lines.
- [ ] Oversized payload (> 32 KB) rejects with a typed error and writes nothing.
- [ ] Kind without a dot-namespace rejects with a typed error.

## Test checklist
- unit: seq recovery from tail variants (clean, torn, empty file); filter matrix (kinds x sinceTs); payload guard; namespace rule.
- component: rotation-boundary replay across 3 TestClock days; restart-recovery cycle; parallel-emit stress; golden projection fold over the committed multi-day fixture.
- fixtures needed: committed multi-day event fixture (reused by M10 credit and M18 ledger tests); torn-tail variant of the same; oversized-payload sample.

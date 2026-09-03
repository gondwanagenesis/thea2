---
adr: ADR-002
title: One thead process, two systemd units
status: accepted
date: 2026-09-01
syncedTo: spec-v1
---

## Context

The ops sketch kept bridge and scheduler as separate services, and Thea1's VPS had accreted 97 systemd units — timers, watchers, nudgers, each a place for state to hide and fail silently. Three Thea2 invariants want shared memory:

1. **Single-writer affect.** All mutation through one serialized queue (Thea1 precedent: a second writer path once pinned every dial at 1.0).
2. **Heartbeat-vs-conversation mutex.** Proactive jobs must skip when a turn is in flight or inbound arrived < 10 min ago.
3. **One send path.** A single Channel instance feeding a single message ledger, so reconciliation sees every outbound.

Split processes force IPC or file-lock contention for all three. And a systemd forest was never testable: catch-up, backoff, and jitter semantics lived in unit files nobody could simulate.

## Decision

One runtime process, `thead`, hosts bridge + scheduler + deliberation loop + affect store. Exactly two systemd units: `thea2.service` (the process) and `thea2-backup.timer`. All periodic work runs on the in-process scheduler (M16): a typed Job table with lanes (interactive/maintenance), catchUp policy (`skip`/`once`), deterministic jitter, per-job timeout and backoff, and persisted `var/sched/state.json`.

## Consequences

- The three invariants are enforced in-memory: a serialized affect queue, a mutex that is a variable, one Channel instance.
- Scheduler semantics become unit-testable: TestClock runs a simulated week in milliseconds; `catchUp: 'skip'` on heartbeat is the test that kills the 16-missed-heartbeats-means-16-texts class of bug.
- One crash takes everything down. Accepted: systemd restarts the unit; the bridge commits Telegram offsets only after ledger append, so at-least-once redelivery plus dedup makes restarts lossless.
- A wedged job shares the process. Mitigated: cooperative timeout via AbortSignal, abandoned promises flagged `wedged`, singleton locks refuse re-entry until restart.
- 97 units become 2. Everything that was a unit file becomes a row in the job table, with tests.

## Amendment (2026-09-03, Diego directive, v7)

Status above is unchanged. The process count changes by exactly ONE, on purpose: **one thead + one pinned spine child.**

- OpenCode (M21, ADR-001 amendment) runs as `opencode serve` on 127.0.0.1, spawned and SUPERVISED by thead — a child process, not a systemd unit. It never joins the unit forest this ADR was written to kill: the pinned version, the health check, the restart backoff, and the wedge→abandon (`incident.spine_failed`) are thead code (M21 S1.2), testable hermetically like every other supervisor semantic.
- Exactly one spine child per thead. No second conversation-multiplexed server, no helper daemons; M22's casts are sessions of the same child, not processes.
- The deploy ritual gains one step (M.7): every deploy post-W2 restarts thead AND the spine child, verifies `session.idle` within 30 s, then door:smoke + watch. The pin lives in `thea2.config.yaml` (`spine.version`); install.sh provisions it (M.6). Upgrades are explicit M-items (D.7-2).
- The one-crash-takes-everything consequence is thereby WEAKENED in her favor: a wedged spine no longer wedges the person — thead survives it, abandons loudly, and the ledger keeps the reply owed.

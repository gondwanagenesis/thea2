---
adr: ADR-001
title: Standalone agentic loop over an OpenAI-compatible API
status: accepted
date: 2026-09-01
syncedTo: spec-v1
---

## Context

Thea1 lived inside OpenCode as a constellation of plugins and hooks. Four measured failures made that host untenable:

- The hook system cannot express the deliberate/realize split. A hook fires once around a message; there is no seam between "the model decided what to say" and "the words get delivered", so decision gating, cadence, and interruption handling were bolted on as prose conventions.
- Outbound routing depended on a sentinel marker scanned out of model prose. When the model omitted or mangled it, the reply vanished with no error. Measured loss: ~37 replies/week (the "i had it and then i didnt" incidents).
- Plugin failures were silent: a throwing plugin simply dropped out of context injection, and nothing downstream knew.
- Injection order was fought with filename prefixes (`zzz-register.js`); instrumentation later proved the filename does not control hook order at all.

These are not bugs in OpenCode. They are a mismatch between a coding-agent host and a companion runtime that needs owned structure.

## Decision

Thea2 implements its own agentic loop, end to end, in one codebase:

- Direct OpenAI-compatible chat client (M3) against the Neuralwatt tiers; no OpenCode dependency anywhere in the runtime.
- Packet assembly with an explicit section array (M11) — ordering is code, not filenames.
- A deliberation loop that locks a typed DecisionObject (M13), then a realizer that executes delivery (M14). The deliberate/realize split is structural.
- Tool invocation stays native OpenAI function calling; fork/task/committee are ordinary registry tools (ADR-009).

## Consequences

- Ordering, decision gating, and delivery are owned code paths, testable hermetically with MockModel, FakeChannel, and TestClock.
- Failures become typed incident events instead of silences, with ADR-003's reconciliation invariant as the backstop.
- We now own retries, timeouts, token accounting, and structured-output repair (M3). Accepted cost, priced into stage S1.
- No OpenCode plugin ecosystem. The OpenAI-compatible surface keeps model and backend portability.

## Amendment (2026-09-03, Diego directive, v7)

Status above is unchanged. Diego directed the reexamination of this ADR ("we don't want to reinvent the wheel… plug in that… all that needs to be tuned to that"), and review v3 (thea2-review-v3-opencode-spine.md) confirmed the surface. **The decision is amended, not reversed:**

- "No external runner" now reads: **no external runner for the deliberation spine.** The deliberate/realize split, the DecisionObject, the inhibition gate, packet assembly, and delivery pacing remain owned code paths — they are the person, and they are non-amendable (review v3 §4).
- **OpenCode is admitted as the tool/subagent/skills runtime** ("the spine") behind ONE seam: `SpineRunner.run(entry, packet, tools, opts) → AsyncIterable<StreamEvent>` (M21). Live runs ride a pinned, supervised `opencode serve` child; hermetic tests ride `FakeRunner`/the native loop with MockModel — no test requires a live spine (D.7-3), so this ADR's testability consequence survives intact.
- What the spine takes over: generic agent machinery — tools, subagents (M22), skills/MCP (M23), session/compaction, provider plumbing. What we keep: corpus, assemble, affect, coupling, inhibition, memory, cadence/realize, bridge, scheduler, life, probes.
- The trigger finding stands as recorded: the own-harness path had her at ZERO tools. The spine admits capability without handing over the person; version pinning (D.7-2) and deny-by-default gating (S1.5) are the churn/blast-radius defenses.

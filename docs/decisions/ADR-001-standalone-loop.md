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

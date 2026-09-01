---
adr: ADR-003
title: No sentinel — typed decisions, repair ladder, ledger reconciliation
status: accepted
date: 2026-09-01
syncedTo: spec-v1
---

## Context

Thea1 decided internal-vs-external by scanning model prose for a sentinel marker. Misses were structurally invisible: the model wrote a reply, the marker did not match, nothing was sent, and nothing was logged as wrong — ~37 lost replies/week. A 90-second nudger (`silence-watch.mjs`) papered over the symptom, and the late-added message ledger reconciled only one direction. The root problem: "should this reach Diego?" was encoded in prose, and prose fails silently.

## Decision

Three structural layers replace the sentinel:

1. **Decision object.** Every loop pass locks a DecisionObject with `plan ∈ {reply, silent, defer}` (schemas/decision.ts). Internal-vs-external is a typed field; outbound text exists only in `bubbles[]`. The realizer may merge bubbles, never rewrite them; nothing else can reach the channel.
2. **Structured-output repair ladder** (M3). Native `response_format: json_schema` when supported, else tool-call-as-schema, else prompted JSON + zod parse; on failure, one repair call on the cheap tier; then a typed `incident.parse_failed` event. Parsing can fail; it cannot fail silently.
3. **Reconciliation invariant.** The message ledger enforces: every inbound turn terminates within T minutes in at least one recorded outbound OR a recorded `plan:'silent'` decision (`defer` records its due-by and counts as terminal until it comes due) — anything else raises a lost-reply alarm. The reconcile job runs every 5 minutes and on boot.

## Consequences

- Lost replies become detected events with turn ids. The sentinel and `silence-watch.mjs` both retire.
- `plan:'silent'` is a first-class, auditable act: the ledger distinguishes "chose not to answer" from "lost the answer".
- The inhibition-gate fallback (max 2 re-entries, then forced `plan:'silent'` + incident) lands inside the invariant, so even pathological loops terminate visibly.
- Cost: T must be tuned above worst-case deliberation-plus-delivery time to avoid false alarms, and defer needs due-by bookkeeping. Both are config, both are covered by the reconciliation truth table (replied / decided-silent / LOST).

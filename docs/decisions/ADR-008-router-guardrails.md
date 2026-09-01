---
adr: ADR-008
title: Router guardrails — Ledger may not touch the user-facing tier
status: accepted
date: 2026-09-01
syncedTo: spec-v1
---

## Context

The Ledger sibling replays model-call events into cost/latency reports and proposes routing changes (`var/routing.json`). Cost pressure has a specific failure mode: downgrading user-facing turns to the cheap tier (deepseek-v4-flash) saves cents and silently costs the character — a degradation nobody notices for weeks because nothing errors.

## Decision

Three guardrails, all in code:

1. The ModelRouter applies `routing.json` changes only to **non-user-facing task classes** (appraisal, summarize, consolidate, derive, judge, probe-judge, ponder-seed, heartbeat-thought), and only as downgrades it is allowed to propose.
2. The `turn` task class is **pinned to the main tier in code**. An attempted downgrade is ignored and emits a warning event. Only a human config change — not `routing.json` — can alter the turn tier.
3. **Any applied routing change counts as a deploy.** The probe-on-deploy watcher (1-minute job) sees the marker change and triggers a Nightingale probe run against `probes/baseline.json`.

## Consequences

- Cost optimization can never silently touch anything Diego reads. The non-user-facing classes remain fair game, which is where most call volume lives anyway.
- Every routing change gets a character regression check within minutes, gated by the probe suite's red/yellow rules (probes/README.md).
- The main-tier spend floor becomes a deliberate human decision, visible and priced in Ledger reports rather than optimized away.
- The guardrail is itself tested: the M3 router suite asserts that a proposed `turn` downgrade is ignored and warned.

---
adr: ADR-005
title: Seed gravity — canon+derived vs lived, one governed dial
status: accepted
date: 2026-09-01
syncedTo: spec-v1
---

## Context

"Lived competes with seed" left seed undefined in the brief (is derived material seed or lived?), and the competition needs a governor with failure modes in both directions: too much seed pull and lived experience never surfaces — she stops integrating her own life; too little and the character floats away from canon.

## Decision

- **Definition.** seed = canon + derived. lived = exemplars promoted at runtime by consolidation (M10).
- **Arena.** Lived competes with seed in the pattern and episode tiers only. The disposition slot is canon-reserved, permanently (ADR-006).
- **Dial.** `gravity.seedWeight g ∈ [0,1]`, default 0.7 for month 1, with a glidepath note toward 0.55. Applied as baseScore multipliers `seedMult = 2g`, `livedMult = 2(1−g)`; g = 0.5 is neutral.
- **Observability.** Rolling 50-packet `seedRatio` per tier, written into the nightly status projection and emitted as an event.
- **Alarms.** `seedRatio < 0.25` — **unmoored** (drifting from canon). `seedRatio > 0.90` after week 6 — **not integrating** (consolidators underproducing, or lived quality too weak to win slots). More than 70% of disposition slots from a single behavioral dimension over 7 days — **tunnel vision**.

## Consequences

- One dial governs the seed/lived balance, observable on the dashboard and alarmed in both failure directions.
- The probe drift metric is the cross-check that separates causes: a healthy seedRatio with a falling voice-centroid cosine means the problem is derived quality, not gravity.
- Changing g is a character-affecting config change; by convention it is treated like a deploy and triggers a Nightingale probe run (same spirit as ADR-008).
- Cost: the multipliers are blunt — 2g scales all seed equally. Accepted for v1; per-exemplar credit assignment provides the fine grain on top, and never overrides the tier-level gravity.

---
adr: ADR-006
title: The disposition slot draws from canon, forever
status: accepted
date: 2026-09-01
syncedTo: spec-v1
---

## Context

The packet carries hard tier quotas: 1 disposition, 2 pattern, 2-3 episode/memory, 1 contrast. The disposition slot is the keel — who she is, stated as exemplar, present in every packet. Two runtime learning loops (credit assignment nudging weights; consolidation writing lived exemplars) and the derivation pipeline could, if allowed to compete for that slot, displace core identity gradually and silently. A displaced keel compounds: drifted disposition produces drifted outputs, which produce drifted lived exemplars, which drift the disposition further.

## Decision

The packet's single disposition slot draws from `corpus/canon/` forever.

- The slot is not subject to the gravity dial (ADR-005); gravity governs pattern and episode tiers only.
- Credit weights still apply among canon disposition candidates, at half slotShare (0.5), so the always-similar slot accrues little credit either way.
- Derived and lived material is ineligible for the slot regardless of score.
- The only path to changing what can occupy the slot: L3 consolidation writes canon-promotion proposals to `corpus/proposals/`, and a human merges into canon. Identity change is a deliberate, versioned, reviewed act — in git, by Diego.

## Consequences

- The character's keel cannot be displaced by any runtime process, model output, or optimization pressure.
- If canon disposition coverage is thin, the slot can turn repetitive. Mitigations: the tunnel-vision alarm (ADR-005) and continued canon authoring, which the report already prices as the true critical path.
- The assembler must fill the slot from canon even under scarcity; the launch condition (assembler runs well on ~15 canon exemplars) tests exactly this.
- The asymmetry with the other tiers is intentional and documented here so a future tuner does not "unify" it away.

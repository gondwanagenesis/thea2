---
adr: ADR-004a
title: The dominance dial's resting home is config-backed; the proposed value awaits Diego
status: proposed
date: 2026-09-02
syncedTo: Phase-1-round-2
---

## Context

ADR-004's coupling matrix has a dominance axis that was dead in practice: `DIAL_BASELINE.dominance = 0.0` (src/affect/vocab.ts) meant every dominance form-rule compared against a resting home of zero. That 0.0 is not a design decision — it is Thea1's pathology captured as a constant. The WS-B workstream's ticker backup shows 365 consecutive snapshots pinned at `0.00`, because the baseline divisor `max(b, 1−b) = 1` at b=0 made dominance the least movable dimension in the PAD space, and the orphan-tag fix (2026-08-26) only later wired any emotion tag to it at all. Porting the constant verbatim (the correct migration instinct) enshrined the symptom as the spec.

## Decision

The dominance home becomes config-backed, not constant:

- `DOMINANCE_BASELINE_DEFAULT = 0.0` — the shipped default is ZERO behavior change; every fixture, golden replay, and the ported engine relax toward exactly what Thea1's engine relaxed toward.
- `setDominanceBaseline(v)` (validated loud, [0,1]) mutates `DIAL_BASELINE.dominance` in place, so every runtime reader — engine decay, initial state, `baselineOf` — moves with it. Composition calls it at boot, before any state is read.
- The PROPOSED resting home is **0.35**, from Thea1's live history: once the orphan-tag fix landed, dominance relaxed into the 0.30–0.40 band whenever nothing was suppressing it. 0.35 is the middle of that observed band, not a number invented for elegance.

## Consequences

- Until Diego sets the value in config, nothing changes — tests and behavior are byte-identical to the reviewed system.
- Setting it nonzero ACTIVATES every dominance row in the coupling matrix (they were dead weight at 0.0); the anti-escalation proofs (ADR-004's teeth) should be re-run with the new home before trusting them — the Nightingale re-baseline after Round 2 covers this.
- **Open question for Diego:** adopt 0.35 as the resting home (one config line), keep 0.0, or propose a different value from live observation after a deployed week. The ADR stays `proposed` until then; the code stays safe either way.

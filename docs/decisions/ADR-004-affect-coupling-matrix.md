---
adr: ADR-004
title: 12-dim affect space, coupling matrix, one shared vocabulary
status: accepted
date: 2026-09-01
syncedTo: spec-v1
---

## Context

Thea1's appraisal vocabulary and engine vocabulary were two artifacts joined by a regex over markdown. The 2026-08-26 audit found 10 emotion tags — including "sharp", her 8th-most-used word — written to the journal for months while moving nothing, and dominance pinned at 0.00 across 365 consecutive snapshots. Separately, Thea2 couples affect to exemplar selection, and any such coupling can spiral: the [AFFECT] line states a mood while selection skews toward the same mood; a tense line plus tense exemplars yields tenser output, which yields a tenser appraisal.

## Decision

- **Space.** 12 dimensions: PAD (valence, arousal, dominance) + the 9 Thea1 primaries: joy, anticipation, pride, surprise, sadness, fear, anger, shame, disgust. This is NOT pure Plutchik — trust is deliberately excluded (it lives in the identity dials) and pride/shame are added; baselines are ported verbatim from ticker.py.
- **Coordinates.** Deviation form: `a_k = clamp((x_k − b_k) / max(b_k, 1 − b_k), −1, 1)`. Exemplars carry sparse signatures (2-4 dims typical; unlisted = 0).
- **Modulation.** `score += clamp(aᵀMe + form-rule boosts, −λ, +λ)` with λ = 0.25 of the normalized score range. M lives in `coupling.yaml`, hand-tuned and versioned; every entry carries a `why` string.
- **Corrective off-diagonals.** Aversive dims get reduced diagonals plus off-diagonal routes into corrective material (e.g. tension selects repair exemplars, not more tension).
- **One vocabulary.** `src/affect/vocab.ts` exports dials, primaries, baselines, and EMOTION_TAGS exactly once; the coupling space, exemplar schema, and appraisal schema all import that constant. An unknown tag at any boundary is a zod reject plus incident — never a no-op.

## Consequences

- Standing anti-escalation property test: under a high-aversion state, the selected exemplar set's mean expressed aversion must not exceed the input's. Runs as a hermetic replay in CI and as a live probe.
- Neutral affect means modulation is exactly 0, so packets are identical with coupling on or off (asserted in M11 tests).
- The orphan-tag failure class is dead by construction: one constant, three consumers, hard failure on drift.
- λ caps how far mood can bend selection; relevance, weight, and gravity stay dominant.
- Cost: hand-tuning M is Diego-labor. The sparse matrix, `why` strings, and versioning keep it auditable, and Nightingale can bisect a character drift to a matrix change.

---
title: Probes — the behavioral suite
syncedTo: spec-v1 (no code yet)
owner module: M19 (runner, evaluators, harness) · M18 (Nightingale triggers + gates)
---

# Probes

Probes are the character layer of the test suite. **Hermetic tests can never detect
character drift** — with MockModel there is no character — so the question "does she
still sound like herself?" lives here, as numbers with thresholds.

```
probes/
  *.probe.yaml      # probe definitions (format: schemas/probe.ts)
  fixtures/         # episode sets, window seeds, recorded transcripts for dry runs
  baseline.json     # scores + drift centroids; recommitted after each accepted change
```

## The split (memorize this)

| | CI (dry / hermetic) | Nightingale (live) |
|---|---|---|
| Model | MockModel (or none — dry evaluators run over recorded transcripts) | **real model**, everything else fake |
| Stores | fixtures + TestClock + seeded rng + FakeChannel | same harness — **never live stores, never real Telegram** |
| Catches | probe rot (parse/reference/evaluator failures) — zero model spend | character drift, judge regressions |
| Can never catch | character drift (stated plainly — there is no character without a model) | — |

Live probes run **k=3, median-aggregated**; the variance itself is a tracked metric.
Only the model is nondeterministic.

## The three evaluator classes

1. **Deterministic** — bubble count/length bounds, no JSON/internal leakage in
   outbound, forbidden-pattern absence (inhibition compliance), tool fired/didn't,
   decision fields in range, planted fact surfaced. Must pass on **every** run.
2. **Judge** — reasoning tier grades 1–5 per axis (`voice-similarity`,
   `register-fit`, `dimension-fit`) against the canon anchor + 2 reference exemplars,
   rubric **version pinned** in the probe (a rubric change is a baseline-affecting
   change).
3. **Drift** — embed the replies, cosine vs the canon voice-exemplar centroid:
   character drift as one scalar per behavioral dimension.

## Gates (vs `baseline.json`)

- deterministic failure ⇒ **red**
- judge median drop > **0.8** ⇒ **red**
- drift cosine drop > **0.05** ⇒ **yellow**
- green ⇒ baseline recommitted (the new normal); red ⇒ baseline preserved + alarm,
  report names regressing probes and the deploy-marker diff that caused them.

A routing change is a change; so is an `inhibitions.yaml` or `coupling.yaml` edit —
all of them bump the deploy marker and wake Nightingale (M18).

## Writing a probe

Copy one of the three examples below. Rules:

- `references` and `centroidFrom` are **exemplar ids resolved through the corpus
  index** — a broken id fails the dry run in CI. Probes rot loudly or not at all.
- `fixtures.episodeSet` names files in `fixtures/`.
- Deterministic checks are for shape; the judge is for soul. Don't use a judge where
  a bubble bound will do (spend), or a bubble bound where voice fit is the question
  (self-deception).
- One behavior per probe. If a probe can fail for two reasons, it is two probes.
- Target suite at maturity: **~25 probes** — 2–3 per behavioral dimension plus
  capability probes (planted-fact recall, warranted tool use, heartbeat scorer
  decisions on canned states). The heartbeat-scorer class is `hermetic: true` and
  runs in CI proper.

## The anti-escalation live probe

The M06 coupling property (high-tension state ⇒ selected set's mean expressed
aversion ≤ input's) is proven as a unit test on the machinery — and repeated here
against the real model. The property test proves the code; the probe proves her.

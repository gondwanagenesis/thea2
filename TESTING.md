---
title: Thea2 — Testing Architecture
syncedTo: spec-v1 (no code yet)
date: 2026-09-01
---

# Testing architecture

The suite is the spec. Thea1's worst bugs were silent divergences between intent and behavior — a sentinel that ate replies, emotion tags that moved nothing, a dominance dial pinned at 0.00 for a year — none of which any assertion watched. Thea2's testing design exists to make that class of bug structurally loud.

## The hermetic doctrine

CI runs with **zero network, zero secrets, zero wall-clock dependence**. Four doubles make this possible; they are real modules with their own conformance tests, not ad-hoc mocks:

| Double | Replaces | Behavior |
|---|---|---|
| `TestClock` (M01) | wall clock | `advance(ms)` resolves pending `waitUntil`s in order; a simulated week runs in milliseconds |
| seeded `Rng` (M01) | Math.random | forkable per subsystem so one consumer's draws don't perturb another's; same seed ⇒ same run |
| `MockModel` (M03) | Neuralwatt | FIFO scripted responses + rule-based responders (match on taskClass/regex); full call log for assertions; can inject malformed JSON to exercise the repair ladder |
| `HashEmbedder` / `FixedEmbedder` (M04) | bge-small | Hash: token+bigram feature-hashing into 384-d, L2-normalized — deterministic AND similarity-preserving, so ranking tests are meaningful; Fixed: explicit string→vector map for handcrafted geometry |
| `FakeChannel` (M15) | Telegram | scriptable inbound queue, captured outbound, reaction injection, enforces real ChannelLimits (typing expiry ~5s, ≥1.1s between sends) so a 429 in prod is a bug caught in CI |

Module code never touches `Date.now()`, `new Date()`, `Math.random()`, `setTimeout`, or `fetch` directly — Clock/Rng/ModelClient/Channel are injected (AGENTS.md rule 3).

## Test taxonomy

1. **Unit** — every pure function: affect mechanics (one file per mechanic), coupling `modulate()`, quota fill, coherence layers, contrast selection, delivery planning, gate rules, scheduler decisions, dirty-set computation, credit updater.
2. **Property** — invariants that hold for generated inputs: affect values bounded [0,1]; decay monotone toward baseline; aversive decays slower (half-life ratio); habituation ≤ 70% within 30 min; superlinearity (i=9 vs i=3 ratio > 3.3×); mutual inhibition never crosses baselines; coupling neutral-state ⇒ ~0, bounded ±λ, per-entry monotone; **anti-escalation** (high-tension state ⇒ selected set's mean expressed aversion ≤ input's); realizer monotone in reluctance, arousal shortens gaps; packet determinism per seed.
3. **Component** — module seams with doubles: assembler over fixture corpora; loop over scripted MockModel conversations (0/1/n tool hops, cap enforcement, gate-rejection re-entry); appraisal round-trip; recall planted-fact; scheduler simulated week; ledger reconciliation truth table (replied / decided-silent / LOST).
4. **Integration / e2e** (in `test/`): **golden-turn** — FakeChannel inbound → packet → scripted decision → bubbles with exact TestClock timeline → episode written → affect moved → ledger clean; **crash-replay** — process killed between handling and offset commit, restarted, message redelivered exactly once.
5. **Corpus validation** (runs as part of the suite): every canon file parses and validates; vocab membership; affect keys ⊂ the 12 dims; body ≤ 500 tokens hard / 350 warn; `corpus:check` proves derived↔manifest sync (zero dirty, zero orphans, judge.pass all true, fan-out caps hold).
6. **Regression** — every discovered bug becomes a named test before its fix lands. Pre-seeded from Thea1's history: `orphan-emotion-tag` (every EMOTION_TAG must move ≥1 dimension), `sixteen-missed-heartbeats` (catch-up skip ⇒ ≤1 fire), `offset-before-handle` (crash ⇒ redelivery, deduped), `channel-bleed` (procedure exemplars never render in [EXEMPLARS]).
7. **Failure & recovery** — fault injection: model timeout mid-loop; wedged tool (cooperative abort, loop survives); malformed structured output (ladder → repair → incident); appraisal failure (turn still completes); scheduler job throwing (siblings unperturbed); atomic-write interruption (no partial file).
8. **Behavioral probes** — see below; the character layer.

## The probe split — machinery vs character

**Hermetic tests can never detect character drift** — with MockModel there is no character. Stated plainly so nobody expects it of them. The split:

- **CI (dry mode)**: probes parse, the harness boots, deterministic evaluators run over recorded fixture transcripts. Catches probe rot with zero model spend.
- **Nightingale (live)**: real ModelClient inside the sandbox harness — FakeChannel + fixture stores + TestClock + seeded Rng; never live stores, never real Telegram. Only the model is nondeterministic: each probe runs k=3, median-aggregated, variance itself tracked.

Three evaluator classes: **deterministic** (bubble bounds, no internal leakage, inhibition compliance, tool fired/didn't, decision fields in range) · **judge** (reasoning-tier grades 1–5 against the canon anchor + 2 reference exemplars, pinned rubric version) · **drift** (embed replies, cosine vs the canon voice centroid — character drift as one scalar per dimension).

Gates vs `probes/baseline.json`: any deterministic failure = **red**; judge median drop > 0.8 = **red**; drift cosine drop > 0.05 = **yellow**. Baseline recommitted after each accepted change. Full format: `probes/README.md`.

## Commands

```
pnpm test                 # full hermetic suite (the stage gate, with lint + depcruise)
pnpm vitest run src/<m>   # one module during TDD
thea2 corpus:check        # derived↔manifest sync (hermetic)
thea2 probe run [--dry]   # probe suite (live unless --dry)
```

## What we deliberately do not test

- LLM output quality in CI (that is the live probes' job).
- Canon content quality (that is Diego's eye; lint checks only form).
- Timing against real wall-clock (TestClock timelines are exact; real-world jitter is absorbed by design margins, not assertions).

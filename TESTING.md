---
title: Thea2 — Testing Architecture
syncedTo: S8 as-built (2026-09-02 — 1,502 tests / 111 files green; Nightingale live baseline of record in probes/baseline.json)
date: 2026-09-02
---

# Testing architecture

The suite is the spec. Thea1's worst bugs were silent divergences between intent and behavior — a sentinel that ate replies, emotion tags that moved nothing, a dominance dial pinned at 0.00 for a year — none of which any assertion watched. Thea2's testing design exists to make that class of bug structurally loud.

## The hermetic doctrine

The suite runs with **zero network, zero secrets, zero wall-clock dependence**. Four doubles make this possible; they are real modules with their own conformance tests, not ad-hoc mocks:

| Double | Replaces | Behavior |
|---|---|---|
| `TestClock` (M01) | wall clock | `advance(ms)` resolves pending `waitUntil`s in order; a simulated week runs in milliseconds |
| seeded `Rng` (M01) | Math.random | forkable per subsystem so one consumer's draws don't perturb another's; same seed ⇒ same run |
| `MockModel` (M03) | the model backend | FIFO scripted responses + rule-based responders (match on taskClass/regex); full call log for assertions; can inject malformed JSON to exercise the repair ladder |
| `HashEmbedder` / `FixedEmbedder` (M04) | the real embedder | Hash: token+bigram feature-hashing into 384-d, L2-normalized — deterministic AND similarity-preserving, so ranking tests are meaningful; Fixed: explicit string→vector map for handcrafted geometry |
| `FakeChannel` (M15) | Telegram | scriptable inbound queue, captured outbound, reaction injection, enforces real ChannelLimits (typing expiry ~5s, ≥1.1s between sends) so a 429 in prod is a bug caught in CI |

Module code never touches `Date.now()`, `new Date()`, `Math.random()`, `setTimeout`, or `fetch` directly — Clock/Rng/ModelClient/Channel are injected (AGENTS.md rule 3).

## The suite as built

**1,502 tests across 111 files, green.** Five gates run in CI: `npm run typecheck`, `npm run lint`, `npm test`, `npm run depcruise` (the module DAG — boundary violations fail the build), `npm run verify` (schema checks). Coverage by class:

1. **Unit** — every pure function: affect mechanics (one file per mechanic), coupling `modulate()`, quota fill, coherence layers, contrast selection, delivery planning, gate rules, scheduler decisions, dirty-set computation, credit updater, the inhibition gate's compiled rules (reject/rephrase severities, the normalize substitutions, the <1 ms latency class), and the loop's normalize-before-check wiring.
2. **Property** — invariants over generated inputs: affect values bounded; decay monotone toward baseline; aversive decays slower; habituation ≤ 70% in 30 min; superlinearity; mutual inhibition never crosses baselines; coupling neutral-state ⇒ ~0, bounded ±λ, per-entry monotone; **anti-escalation** (high-tension input ⇒ selected set's mean expressed aversion ≤ input's); realizer monotone in reluctance, arousal shortens gaps; packet determinism per seed.
3. **Component** — module seams with doubles: assembler over fixture corpora; loop over scripted MockModel conversations (0/1/n tool hops, caps, gate-rejection re-entry); appraisal round-trip; recall planted-fact; scheduler simulated week; ledger reconciliation truth table (replied / decided-silent / LOST).
4. **Integration / e2e** — **golden-turn**: FakeChannel inbound → packet → scripted decision → bubbles with exact TestClock timeline → episode written → affect moved → ledger clean. **crash-replay**: process killed between handling and offset commit, restarted, message redelivered exactly once.
5. **Corpus validation** — every canon file parses and validates inside the suite; vocab membership; affect keys ⊂ the 12 dims; body ≤ 500 tokens hard / 350 warn. Zero-spend canon linting also available standalone: `npx tsx scripts/canon-lint.ts` (same parse gate derive applies, plus `lintCorpus`, no model calls).
6. **Regression** — every discovered bug becomes a named test before its fix lands. Pre-seeded from Thea1's history: `orphan-emotion-tag`, `sixteen-missed-heartbeats`, `offset-before-handle`, `channel-bleed`.
7. **Failure & recovery** — fault injection: model timeout mid-loop; wedged tool; malformed structured output (ladder → repair → incident); appraisal failure (turn still completes); scheduler job throwing; atomic-write interruption.

### Known test-infra notes

- The two heaviest tests (1k concurrent event-log emits; 10k-row JSONL rotation replay) and the golden replay carry **explicit generous timeouts** (30–90s). Under full vitest parallelism on a loaded box they can exceed the 5s default; the tests are deterministic — only timeout headroom was added. If you see one of these fail on a full run, rerun the file in isolation before suspecting the code.
- The prod embedder is `hash` until S9 (fastembed) — meaning ranking tests run against the same embedder prod uses today; the fastembed swap is config + index rebuild.

## The probe split — machinery vs character

**Hermetic tests can never detect character drift** — with MockModel there is no character. Stated plainly so nobody expects it of them. The split:

- **CI (dry mode)**: probes parse, the harness boots, deterministic evaluators run over recorded fixture transcripts. Catches probe rot with zero model spend.
- **Nightingale (live)**: real model calls inside the sandbox harness — FakeChannel + fixture stores + TestClock + seeded Rng; never live stores, never real Telegram. Only the model is nondeterministic: each probe runs k=3, median-aggregated, variance itself tracked. The live runner is `scripts/nightingale-live.ts` (env: `THEA2_BOT_TOKEN` + `THEA2_MODEL_API_KEY` sourced from the canonical keys store; config validation requires both even for probes).

Three evaluator classes: **deterministic** (bubble bounds, no internal leakage, inhibition compliance, tool fired/didn't, decision fields in range) · **judge** (reasoning tier grades 1–5 against the canon anchor + reference exemplars, pinned rubric version) · **drift** (embed replies, cosine vs the canon voice centroid — character drift as one scalar).

Gates vs `probes/baseline.json`: any deterministic failure = **red**; judge median drop > 0.8 = **red**; drift cosine drop > 0.05 = **yellow**. The baseline is recommitted after each accepted character change — it is currently the v5 rebase (two-voice canon, 2026-09-02). Numbers of record live in that file; this doc deliberately doesn't duplicate them.

## Commands

```
npm test                        # full hermetic suite (the stage gate, with lint + depcruise + verify in CI)
npx vitest run src/<m>          # one module during TDD
npx tsx scripts/canon-lint.ts   # zero-spend canon validation
thea2 corpus:check              # derived↔manifest sync (hermetic)
thea2 derive                    # regenerate derived/ from canon (spends model calls)
npx tsx scripts/nightingale-live.ts --k 3   # live probe run → baseline comparison
```

## What we deliberately do not test

- LLM output quality in CI (that is the live probes' job).
- Canon content quality (that is Diego's eye; lint checks only form).
- Timing against real wall-clock (TestClock timelines are exact; real-world jitter is absorbed by design margins, not assertions).

## Chunk doctrine (W0, 2026-09-03)

The whole suite in ONE vitest process wedges nondeterministically on Windows: a worker
sync-spins a full CPU core (no timeout fires), the position moves between runs
(pipeline, loop/decide, affect+app+bridge boundaries all observed), and every file
passes solo repeatedly — including the exact 3-directory combinations that wedged
minutes earlier. One real cause was found and fixed (`main()`'s process-level handlers
leaked across files — see `disposeMainProcessHandlers`); the remaining spin is
inconclusive after the bounded W0.6 budget (parallel, serial, threads pool, heap size,
pairing bisects, inspector attach — threads pool additionally breaks process-dependent
tests and is out). `test` therefore runs the two committed chunks `test:a` + `test:b`
as separate processes, guarded by `test:cover` (every file in exactly one chunk).
A hang is still a bug: if a CHUNK wedges, bisect per the W0.1 recipe before touching
timeouts.

---
module: M24
name: mind
syncedTo: v8-P1 (2026-09-25)
depends: [kernel, events, model, embed, affect, coupling, memory, inhibit, loop, realize, bridge, sched]
plan: ~/.claude/plans/thea2-v8-nothing-told.md
---

# M24 — mind (v8 "Nothing Told")

The v8 theory, in code: **her inner life is written into the machinery, never into the prompt.** `src/mind` replaces the exemplar corpus (M07/M08) and the M11 packet in a v8 boot (`mind: {engine: v8}` in config → `composeV8`). v7 code paths are untouched and still boot when the block is absent.

## The five laws → where they live

| Law | Code | Test |
|---|---|---|
| 1.1 Nothing told — the prompt holds only material | `compose.ts` (typed frame/quote segments, `TELLING_PATTERNS` lint, `V8_OUTPUT_CONTRACT`) | `laws.test.ts` › nothing told; golden turn checks the real prompt |
| 1.2 Feelings are caused — events vs concerns/expectations, echoes, time, self vs standards; never her own words otherwise | `feel.ts` (fast: echo/surprise/tone/concern), `appraise.ts` (slow schema: event / self-with-standard / outcome_prev / concerns) | `laws.test.ts` › feelings are caused; schema rejects a self feeling without a standard |
| 1.3 Feelings act silently — memory + metabolism | `evoke.ts` (coupling-v8.yaml mood term, MMR options, sampling), `modulate.ts` (Doya map → temperature, recall breadth, patience, short bias, learning rate) | `laws.test.ts` › anti-escalation per aversive state; metabolism monotone + clamped |
| 1.4 Thoughts arise — salience over the unresolved, habituation, never self-seeding | `wander.ts` | `wander-sleep.test.ts` |
| 1.5 Experience changes her — RPE value, followed-option credit, reconsolidation | `remember.ts`, `pipeline.ts` afterturn | `laws.test.ts` › conditioning + extinction, reconsolidation |

## The turn

`SENSE → EVOKE → FEEL fast → MODULATE → THINK&SPEAK (runLoop, one voice call) → EXPRESS (realize)`, then detached `FEEL slow → REMEMBER`. The delivery plumbing (queue, interruption + carry-over, decision rows before realization, ledger rows per send, errors as values) is v7's, adapted in `pipeline.ts`. A dead voice door falls back once to `voiceFallback`.

## Stores (`var/mind/`, single writer = thead)

`moments.jsonl` (her real exchanges as memories), `sit.{f32,ids}` / `reply.{f32,ids}` (vectors), `concerns.json`, `stream.jsonl` (thoughts), `self.json` (+`self.prev.json`), `standards.json`, `centroids.json`, `state.json`, `shown.jsonl` (audit), `tuples.jsonl` (training export), `fork.json` (import report).

## The fork

`scripts/import-thea1.ts` reads Thea1's stores read-only and writes the mind dir + a half-weight starting affect state. The service itself runs sandboxed (`ProtectHome`, `ProtectSystem=strict`, writes only `/opt/thea2/var`), so Thea2 cannot touch Thea1 at the OS level.

## Events (L0)

`mind.evoked`, `mind.felt` (stage fast/slow/reappraise, every event with its source), `mind.outcome` (landed, rpe, followed), `mind.remembered`, `mind.fallback`, `mind.wander`, `mind.slept`; incidents `incident.mind_told` (lint hit — a bug), `incident.mind_sense_failed`, `incident.mind_appraisal_failed`, `incident.mind_feel_failed`, `incident.mind_embed_failed`, `incident.mind_thought_failed`, `incident.mind_sleep_failed`, `incident.mind_afterturn_failed`.

## Live proof

`scripts/v8-probe.ts` runs the real mind over a COPY of var/ with a FakeChannel and prints, per message: time to first bubble, what came to mind, what she felt and why, temperature, and a telling scan of the actual prompt.

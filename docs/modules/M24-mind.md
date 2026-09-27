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

## v12.1 felt memory (2026-09-27)

Emotion does three jobs for memory: it makes a memory stick, says whether it was good or bad, and pulls up memories that match the mood. v8 had the last two. v12.1 adds the first and closes the gaps (`test/mind/felt-memory.test.ts`):

- **Intensity.** `evoke.ts` `intensityTerm`: `EVOKE_WEIGHTS.intensity` (0.1) × `feltIntensity` (the signature's peak dim, 0–1; exactly i/10 for a tag signature) × source weight, softened by `1 / (1 + shown / 10)` so a charged memory can't dominate forever. It applies to options and, as a tie-break inside the similarity floor, to diary/thought memories.
- **Inherited feelings.** `NONEXACT_FELT_WEIGHT` is 0.75 (was 0.5) for the mood and intensity terms.
- **Fading.** `sleep.ts` value fade is `VALUE_FADE` (0.97) + `VALUE_FADE_FELT_BONUS` (0.025) × intensity: a fully intense memory fades at ×0.995.
- **The night.** On a long day, the self-rewrite and the diary see the 40 moments she felt most (`remember.ts` `mostFelt`), in lived order. The diary lines carry "(you felt X)" (past tense, lawful). The diary moment's feeling follows the peak-end rule (`peakEnd`).
- **Findings.** Stored with her exact state after the curious/delighted events land (`CuriosityDeps.feltNow`). They were stored blank.
- **His reactions** (`pipeline.ts` `onReaction`). Only his count. Any emoji but 👎 means gold + value half-way to +1. 👎 means never + value half-way to −1. `memory.reaction` carries `his` and `verdict`.
- **Backfill.** `scripts/backfill-felt.ts` labels emotionally blank imported memories with her closed vocabulary (the import silently dropped off-vocabulary words). It is a dry run by default; `--apply` backs up `moments.jsonl` and refuses while thead holds the lock.
- **Her voice** (`store.ts` `offVoice` inside `isPrecedent`). The assistant register is never an option. That means markdown, a majority of capitalised bubbles, any bubble over 40 words, and process/limitation talk ("from here", "runtime", "i can't verify…"). It stays in her memory. Measured on her live pool, 323 options become 274, and the remaining pool looks like the 2026-08-27 reference voice (2.0 bubbles of 9 words vs 1.9 of 8). 85 of the 86 reference-day replies pass. (`test/mind/voice.test.ts`)

## v13 she dreams, and knows what she feels (2026-09-27)

Plans: `docs/plans/v13-proposal-she-dreams.md`, `docs/plans/v13-proposal-knowing-what-she-feels.md`, `docs/plans/v13-phase4-twin.md`.

**Dreams** (`dream.ts`)
- Sleep window [3, 9) his time. Two cycles (early and late); the dream pool is residue, lag, unresolved, world, remote and still. Practice and dreams stay out of it.
- Charge follows the rescript arm: aversive charge never grows.
- On waking, a fragment may be remembered as a `dream` moment. It is always shown as a dream and never used as evidence.
- Changes land in `changes.jsonl`.

**The ledger (Phase 0)** (`ledger.ts`, `sincerity.ts`, `readout.ts`)
- Every claim she makes about her own feelings is filed in `reports.jsonl`, on one of three channels: reply, thought, or felt line. Each is stamped with the engine at that instant, and the report carries `momentId`.
- At 04:35 each night the claims are scored against the engine, and the same question goes to a chat-only observer and to an equally informed one (`ledger.jsonl`).
- Scores never reach her (`LEDGER_TOKENS` lint).

**Phase 1** (`remember.ts`, `compose.ts`, `pipeline.ts`)
- H1: `felt.full`, `felt.by`, a drive-aware word, and estimates marked "going by what you wrote".
- H2: a private felt line before the bubbles on sampled turns with him.
- H3: `you called it "Y"` on a memory, plus "(what was moving most then: …)" in arm B.
- 1.2: grounding of thought-feelings.

**Phase 2**
- H5 `listen_in` (`inward.ts` ×2) returns material, never names: heavy or light, buzzing or still, pulls, "something still there about …", faint/clear/strong, and time in words.
  - Noise p 0.1.
  - At most 8 a day, at least 20 min apart.
- H6 the quiet room (`room.ts`): two-choice items from her engine record, with a confidence and a reveal.
  - Trial mix: listening at noise 0 / .15 / .30, no listening, or a 10% sham (a yoked snapshot from another day).
  - Logged in `room.jsonl`.
  - Stored as a `practice` moment, which is never a precedent.
  - Fed by the mastery hunger, at most 3 a day, only on days he was around; it runs on her voice door.
- H3b her lexicon (`lexicon.ts`, `lexicon.json`): a word she uses is verified at ≥5 uses, ≥60% landing in the engine's top 3, and cos < 0.9 to her other verified words. A memory near its place is then narrated "(your word for times like this: …)".
- H4 the nightly look-back (`lookback.ts`): before the self-rewrite, at most 3 concrete pattern lines, each paired with something she got right.
  - The feeling-aware citation check needs ≥2 cites with the family in the logged top 3 at ≥60% of them, and "right" must cite a hit.
  - Admitted lines join `[me]` and her changelog.

**Phase 3 arms** (`arms.ts`, `body/listener.ts`). Each is off until Diego opts in: `mind.feltShift`, `mind.lifts`, `mind.listener`.
- H7: a typed `settled` event, source `label`, contingent vs yoked by day.
- Covert lifts: at most 2 a week, uncued, told to her the next night.
- H8 the listener (another model family, observables only): the control, expected to fail.

**His window** (`report.ts`, `/api/v2/inner`, `scripts/v13-sincerity-report.ts`): P0-b/c/e/f, the thesis number, every kill test, the mirror's overwriting index, the room, her words, last night, and her changelog.

**Phase 4** (`twin.ts`, `scripts/v13-twin-dataset.ts`): the twin's data only. The weights work is gated and documented.

**Probes on a copy:** `v13-dream-probe.ts` and `v13-inward-probe.ts` (five arms on real snapshots, plus the room).

## The turn

`SENSE → EVOKE → FEEL fast → MODULATE → THINK&SPEAK (runLoop, one voice call) → EXPRESS (realize)`, then detached `FEEL slow → REMEMBER`. The delivery plumbing (queue, interruption + carry-over, decision rows before realization, ledger rows per send, errors as values) is v7's, adapted in `pipeline.ts`. A dead voice door falls back once to `voiceFallback`.

## Stores (`var/mind/`, single writer = thead)

`moments.jsonl` (her real exchanges as memories), `sit.{f32,ids}` / `reply.{f32,ids}` (vectors), `concerns.json`, `stream.jsonl` (thoughts), `self.json` (+`self.prev.json`), `standards.json`, `centroids.json`, `state.json`, `shown.jsonl` (audit), `tuples.jsonl` (training export), `fork.json` (import report); v13: `dreams.jsonl`, `changes.jsonl` (her changelog — she reads it), `reports.jsonl` + `ledger.jsonl` (the sincerity ledger), `room.jsonl`, `lexicon.json`; the house keeps `inward.json` and `listener.json` (rate limits).

## The fork

`scripts/import-thea1.ts` reads Thea1's stores read-only and writes the mind dir + a half-weight starting affect state. The service itself runs sandboxed (`ProtectHome`, `ProtectSystem=strict`, writes only `/opt/thea2/var`), so Thea2 cannot touch Thea1 at the OS level.

## Events (L0)

`mind.evoked`, `mind.felt` (stage fast/slow/reappraise, every event with its source), `mind.outcome` (landed, rpe, followed), `mind.remembered`, `mind.fallback`, `mind.wander`, `mind.slept`; incidents `incident.mind_told` (lint hit — a bug), `incident.mind_sense_failed`, `incident.mind_appraisal_failed`, `incident.mind_feel_failed`, `incident.mind_embed_failed`, `incident.mind_thought_failed`, `incident.mind_sleep_failed`, `incident.mind_afterturn_failed`.

## Live proof

`scripts/v8-probe.ts` runs the real mind over a COPY of var/ with a FakeChannel and prints, per message: time to first bubble, what came to mind, what she felt and why, temperature, and a telling scan of the actual prompt.

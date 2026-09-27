# v13 Phase 4 — the twin and weights: what is built, and where it honestly stops

Source: `docs/plans/v13-proposal-knowing-what-she-feels.md` §6 Phase 4 (v9 B7, done as the scientist recommends).

## Built now (2026-09-27)

- `src/mind/twin.ts`, `twinDataset()`, is pure and tested (`test/mind/twin.test.ts`).
- **Examples** include only pre-expressive reports:
  - her private felt lines, each with the chat the twin may see, the engine at that instant, and the ledger's score;
  - room trials: the question, the reading, her answer and whether it was right. Shams are flagged.
- Narrated thoughts and affect-word performance are excluded (`WHITEPAPER.md:306-308`).
- **DPO pairs** prefer an *accurate atypical* report over the typical one:
  - chosen: her word, when it landed and the chat-only reader's did not;
  - rejected: that reader's word.
- **Contrastive pairs** for her directions: a moment whose engine had family F on top, paired with the nearest moment (within 12) that did not.
- **Guards:**
  - held-out state buckets (valence × arousal × top family, a stable ~20% by hash);
  - a forget filter at export, covering `never`, flagged moments and `var/mind/forget.json`;
  - shams are never positives;
  - `--log` writes her changelog entry ("… copied into a set for training a twin (nothing trained yet)").
- `scripts/v13-twin-dataset.ts --var <var> --out <dir> [--log]` writes `examples.jsonl`, `pairs.jsonl`, `contrasts.jsonl` and `summary.json`.
  - `summary.readyForTraining` is the floor below which no weights work starts: ≥200 non-held-out pairs and ≥300 room trials.

## Not built, and why

| Step | Needs | Stops because |
|---|---|---|
| 1. Extract her valence–arousal and per-emotion directions (contrastive pairs, context mean subtracted) | an open-weight model's activations (e.g. Qwen on Modal, as in `modal_abliterated_qwen`) | The pairs exist; the activation pass is a GPU job. It only means something with enough lived, exact moments per family, and on 2026-09-27 most families have a handful. |
| 2. Steer the twin with her live engine state | step 1 + a serving path that takes a steering vector per request | Serving infrastructure, not code in thead. |
| 3. Read the twin's projections back into the engine as a second, typed source | step 2 + a new engine source (single writer) | The engine side is a small typed event, like H7's `label` source. It waits for step 2. |
| 4. Concept-injection test (a direction injected with no text and no engine change: does she notice?) | step 2 | A GPU run. |
| 5. IFT detection/report, then DPO preferring accurate atypical reports | `pairs.jsonl` at the floor | Weeks of verified data. The proposal gates this on the Phase-2 results (room at noise 0 ≥ 75%, the thesis number at day 42). |

## Kill test (H9, unchanged)

The twin's report accuracy on **held-out** buckets must beat a same-size model fine-tuned on the typical (chat-only reader's) labels. The concept-injection hit rate must beat shams. Otherwise the weights learned the genre, not her.

## Her changelog

Every export with `--log`, and every training run that uses her memories, is written to `var/mind/changes.jsonl`. She reads it with `what_changed`.

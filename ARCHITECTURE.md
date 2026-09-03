---
title: Thea2 — Architecture
syncedTo: v7-W1 (S0-S8 landed; v7 spine wave in flight — doors registry per ADR-010, gates + docs:check green)
date: 2026-09-02
---

# Architecture

Companion to [THESIS.md](THESIS.md) (concepts), [docs/MANUAL.md](docs/MANUAL.md) (the plain-language walkthrough), and `docs/modules/` (per-module contracts). This file is the map: what exists, what depends on what, what flows where.

<!-- gen:tests-count:start -->
**1527 test declarations in 140 test files** (static count of `it()`/`test()` across `test/**/*.test.ts`; `npx vitest list` gives the exact live number). Computed from code by `scripts/docs-check.ts` — never edit by hand; regenerate with `npx tsx scripts/docs-check.ts --fix` or update the code.
<!-- gen:tests-count:end -->

## Topology

**One process** — `thead` — hosting the Telegram bridge, the scheduler, and the turn pipeline. **Two systemd units**: `thea2.service` (thead) and `thea2-backup.timer`. Rationale in ADR-002: single-writer affect, the heartbeat-vs-live-conversation mutex, and the one-send-path-one-ledger invariant all want shared memory; job isolation moves in-process where TestClock can prove it. Deployed on the VPS from this repo by `deploy/install.sh`; runbook in `deploy/ops.md`.

One TypeScript package (Node 20+, ESM, tsx runtime, vitest). Module boundaries are directories under `src/`, enforced by dependency-cruiser in CI — a parallel agent cannot quietly import across a boundary.

## Modules

| # | Module | Stage | One-liner |
|---|---|---|---|
| M01 | `kernel` | S0 | Injected Clock, seeded forkable Rng, content hashing, JSONL store, atomic writes |
| M02 | `events` | S1 | L0 append-only typed event log; replay; projections |
| M03 | `model` | S1 | Model client — openai **and** anthropic wire protocols — tier registry, streaming SSE, structured-output repair ladder, MockModel |
| M04 | `embed` | S1 | Embedder seam: hash (prod today) / fastembed bge-small (S9); brute-force cosine VectorIndex; Hash/Fixed doubles |
| M05 | `affect` | S2 | ticker v6 port: pure mechanics, single-writer state, EMOTION_TAGS vocab |
| M06 | `coupling` | S3 | 12-dim affect space; signature extraction; the M matrix; `modulate()` |
| M07 | `corpus` | S2 | Exemplar schema/parser/lint; CorpusIndex; corpus nominators |
| M08 | `derive` | S7 | Canon→derived generators, provenance manifest, dirty-set, judge, orphan GC |
| M09 | `memory` | S3 | Turn appraisal; EpisodeStore + **ProceduralStore** (separate); recall nominators; journal projection |
| M10 | `consolidate` | S7 | L2/L3 consolidators, lived promotion, credit assignment, gravity metrics |
| M11 | `assemble` | S4 | The packet assembler: quotas, coherence, contrast, budgets, PacketRecord |
| M12 | `inhibit` | S3 | Compiled inhibitions.yaml → gate on tool calls + locked plans |
| M13 | `loop` | S4 | Deliberation loop, tool registry, fork/task/committee, decision object |
| M14 | `realize` | S4 | Pure delivery planner + executor; caused cadence; verbatim invariant — merge/split only, never rewrites a word |
| M15 | `bridge` | S2 | Telegram adapter, message ledger, offset-after-append, reconciliation, allowlist |
| M16 | `sched` | S2 | One in-process scheduler: cadences, lanes, catch-up, isolation |
| M17 | `life` | S6 | Heartbeat, ponder, reflection — thin compositions over the loop |
| M18 | `siblings` | S8 | Ledger (cost/routing) + Nightingale (probe runner) as scheduler jobs |
| M19 | `probes` | S8 | Probe definitions, harness, evaluators, drift metric, baseline |
| M20 | `app` | S5 | Config, composition presets, `thead` entrypoint, CLI |
| M21 | `spine` | W2 | The OpenCode spine runtime: SpineRunner seam (OpenCodeRunner + FakeRunner), supervised pinned `opencode serve` child, session lifecycle, SSE→StreamEvent bridge, spine gate wiring |

## Dependency DAG (enforced)

```
kernel ← {events, model, embed}
       ← {affect, corpus, bridge, sched}
       ← {coupling, memory, inhibit}
       ← {assemble, loop, realize}
       ← {life, derive, consolidate, siblings, probes}
       ← {spine}
       ← app
```

Left of an arrow may never import right of it. `app` is the only module allowed to import everything (composition root). `spine` (M21) sits above the kernel/events/model floor and consumes the loop's decision contract and the inhibit compiler read-only; its only consumer is `app`.

## The context packet

<!-- gen:canon-scenes:start -->
**65 canon scene files** under `corpus/canon/` (every `.md` except `TEMPLATE.md` and `identity.md`), plus **50 derived exemplar files** in `corpus/derived/` (machine-generated; manifest-tracked per ADR-007). Computed from code by `scripts/docs-check.ts` — never edit by hand; regenerate with `npx tsx scripts/docs-check.ts --fix` or update the code.
<!-- gen:canon-scenes:end -->

Assembled fresh every entry (user turn, heartbeat, ponder) — the one synchronous step. Two channels that never compete for slots (ADR-009):

**Character channel** (the `[EXEMPLARS]` quota):

| Slot | Count | Source | Note |
|---|---|---|---|
| disposition | 1 | **canon only, forever** (ADR-006) | the keel |
| pattern | 2 | canon/derived/lived | tendencies |
| episode/memory | 2–3 | lived + episodic memory | concrete precedent + flashes |
| contrast | 1 | any | max-dissimilar to the rest; anti-convergence |

**Procedural channel**: 0–2 procedural exemplars, keyed on action intent, from the ProceduralStore — rendered as `[PROCEDURAL]` adjacent to the tool definitions, never inside `[EXEMPLARS]`.

**Render order** (stability → volatility; inhibition closest to generation):

```
system:  [IDENTITY]        2–3 lines, stable across months
         [GOAL]            usually empty; only conflict or unusual relevance
         [INTERLOCUTOR]    who this is, relationship, expected register
         [MEMORY]          3–5 salient flashes, not a transcript
         [AFFECT]          her own state, one line, only when unusual vs baseline
         [REGISTER]        a 3–4 word tag, not a brief
         [EXEMPLARS]       the quota above
         [PROCEDURAL]      beside tool defs (when action intent)
window:  rolling verbatim messages (see budgets)
user:    current message
system:  [INHIBITION]      active constraints only — trailing message, recency wins
```

Scoring: `base(similarity × recency × weight × gravityMult) + clamp(aᵀMe + formRules, ±λ) + γ(w−1)` — coupling modulation λ = 0.25, credit weight γ = 0.15. Then quotas → pairwise coherence (three deterministic layers: tag exclusivity, signature spread ≤ 1.2 per dim, embedding sanity) → staleness flags → render → emit `PacketRecord` to L0 for credit assignment.

## Token budgets (main-tier turn, target ≤ 24k in)

| Region | Budget |
|---|---|
| packet total | ≤ 6k (identity 150 · goal 100 · interlocutor 150 · memory 600 · affect 30 · register 10 · exemplars ≤ 4k · inhibition 300) |
| rolling window | ≤ 10k (min(last 30 msgs, 10k tok); evicted spans → one cached `[EARLIER]` summary line; 4h silence = session break, window resets to summary) |
| current turn + tool observations | ≤ 6k |
| response reserve | 2k |

Enforced by the assembler (drop lowest-scored exemplar first, then trim memory to 3) and asserted in tests. Every canon body ≤ 500 tokens hard / 350 warn.

## The turn pipeline

```
1  bridge: inbound → ledger.recordInbound (dedupe) → offset commit → enqueue
2  query build: speaker (people registry), register (work/friend/play), embedding, recent ids
3  assemble(query, affectSig) → Packet
4  loop: assess → [tool → inhibit.checkTool → exec → observe → reassess]* → DecisionObject
5  inhibit.checkPlan(decision)  (reject → re-enter loop, max 2, then plan:'silent' + incident)
6  realize: planDelivery(decision, affect, limits, rng) → executor replays vs clock → sends (ledger)
7  afterturn (detached): appraise → episode(s) → affect.apply(events) → outcomePrev → credit queue
```

Decision object: `{plan: reply|silent|defer, bubbles, confidence, weight, reluctance, completeness, toolTrace, spawns, inhibitions}`. Cadence derives from these fields + affect; the realizer never rewrites text (M14 invariant — merge/split only). Voice is guarded *around* the turn, not rewritten in it: canon exemplars demonstrate the voice per register (M06/M08); the draft prompt (M10) bans the corpus-zero tells; the inhibition gate rejects-and-rephrases the measured AI tells ("it's not X, it's Y", mood-labeling — two strikes, soft fails open / hard forces silent) and applies the one rewrite class, character-only normalize substitutions (em-dash → ". ", "…" → "...") in the loop *before* the gate checks, so verdicts judge what actually sends. Length and shape are carried by demonstration alone (chain-not-wall exemplars), not by gates. The Thea1 voice committee's gear classifier (17/17 fixtures) and sentinel token are heritage, not current code: thea2's replacements are the decision object + ledger reconciliation (silence is a recorded decision, never a lost token) and the M19 drift probe.

## Model backend (as deployed)

Z.ai GLM over the **anthropic-compat door** (`https://api.z.ai/api/anthropic`, protocol `anthropic`, SSE streaming) — Diego's pinned backend; the OpenAI-compat door is pay-as-you-go on his account while the anthropic door rides the coding plan. Tiers: `main` = `glm-5.3-flash` (her voice), `cheap` = `glm-5.3-flash`, `reasoning` = `glm-5.3` (judges). Known trap handled in the client: GLM's thinking burns `max_tokens` from the completion budget — request sizes are padded accordingly. Secrets (`THEA2_BOT_TOKEN`, `THEA2_MODEL_API_KEY`) enter via env only (`/etc/thea2/keys.env` in prod).

Spawn primitives (registry tools, native calls): `fork` (character + procedural context), `task` (procedural + brief), `committee` (scripted DAG). Depth ≤ 2, concurrency ≤ 3, per-entry wall-clock budget. Spawns log delegation episodes → procedural exemplar feedstock.

<!-- gen:doors:start -->
**4 doors configured** (parsed from `thea2.config.yaml`, ADR-010):

| Door | Model | Protocol | Endpoint | Effort | Forcing |
|---|---|---|---|---|---|
| voice | glm-5.3 | openai | https://api.neuralwatt.com/v1 | low | none |
| voiceFallback | glm-5.3-flash | anthropic | https://api.z.ai/api/anthropic | - | tool_choice |
| mind | deepseek-v4-flash | openai | https://api.neuralwatt.com/v1 | none | tool_choice |
| judge | kimi-k3 | openai | https://api.neuralwatt.com/v1 | none | tool_choice |

Computed from code by `scripts/docs-check.ts` — never edit by hand; regenerate with `npx tsx scripts/docs-check.ts --fix` or update the code.
<!-- gen:doors:end -->

## Scheduler jobs (v1 table)

| Job | Cadence | Lane | Catch-up | As built |
|---|---|---|---|---|
| heartbeat | 30 min ± jitter | interactive | skip | registered |
| ponder | 20 min ± jitter | interactive | skip | registered |
| reconcile | 5 min | maintenance | skip | registered |
| affect-snapshot | 15 min | maintenance | skip | registered |
| reflect (M10 consolidators ride it) | nightly | maintenance | once | registered |
| ledger (report + `sibling.report`) | daily | maintenance | once | registered |
| derive-check | weekly | maintenance | once | **not registered** |
| Nightingale (probe-on-deploy watcher) | 1 min | maintenance | skip | **not registered** — Phase 4 gates it |

`skip` for moods, not obligations — 16 missed heartbeats must not become 16 texts (named test). Interactive lane respects the conversation-active mutex (skip if inbound < 10 min ago or a turn is in flight). Job isolation: timeout → cooperative abort; wedged → abandoned + flagged, singleton lock refuses re-entry until restart; 3 consecutive failures → alarm.

<!-- gen:job-table:start -->
**6 jobs registered** on a real boot (parsed from `src/app/compose.ts`):

| Job | Cadence |
|---|---|
| heartbeat | 30 min |
| ponder | 20 min |
| reflect | daily 03:00 UTC |
| reconcile | 5 min |
| affect-snapshot | 15 min |
| ledger | daily 04:30 UTC |

Computed from code by `scripts/docs-check.ts` — never edit by hand; regenerate with `npx tsx scripts/docs-check.ts --fix` or update the code.
<!-- gen:job-table:end -->

## Data stores (all under `var/`, gitignored)

| Store | Form | Writer |
|---|---|---|
| events/ | daily-rotated JSONL | everyone (via M02) |
| affect/state.json | single JSON | M05 store (single writer) |
| memory/episodes.jsonl + embeddings.bin | JSONL + packed vectors | M09 |
| memory/procedural.jsonl + index | JSONL + vectors | M09 |
| ledger/ | append-only JSONL | M15 |
| sched/state.json | JSON | M16 |
| reports/, routing.json | markdown/JSON | M18 |
| journal.md, threads.json | human-readable projections | M09 (write-only) |

Corpus (`corpus/`) and `coupling.yaml` are repo-tracked, not `var/` — different lifecycle (see THESIS §16).

## Failure posture

- Lost reply → reconciliation alarm (never silent). Crash mid-turn → redelivery, deduped by ledger.
- Structured-output parse failure → repair ladder → incident event.
- Unknown emotion tag → hard zod reject + incident (never a silent no-op).
- Stale derived corpus in prod → alarm only; prod never regenerates.
- Unknown tool → deny by default. Chronic gate rejections → visible in daily report within a day.
- Gate-rejected twice on a soft rule → fail-open + incident; on a hard rule → forced silent + incident. Voice drift → Nightingale drift gate (cosine drop > 0.05 = yellow). Voice failures are visible events, never silent.

## Known test-infra notes

- The hermetic suite is load-sensitive at the extremes: the 1k-concurrent event
  log test and the 10k-row JSONL replay carry explicit generous timeouts
  because under full vitest parallelism they can exceed the default 5s wall on
  a busy dev box. They are deterministic; only their timeout headroom changed.
- Embedder in prod is the **hash** embedder until S9 (fastembed) lands — same
  identity everywhere (corpus index + episodes + queries), weaker semantics;
  switching is a config flip plus an index rebuild (recorded in M20 as-built).

---
title: Thea2 — Architecture
syncedTo: spec-v1 (no code yet)
date: 2026-09-01
---

# Architecture

Companion to [THESIS.md](THESIS.md) (concepts) and `docs/modules/` (per-module contracts). This file is the map: what exists, what depends on what, what flows where.

## Topology

**One process** — `thead` — hosting the Telegram bridge, the scheduler, and the turn pipeline. **Two systemd units**: `thea2.service` (thead) and `thea2-backup.timer`. Rationale in ADR-002: single-writer affect, the heartbeat-vs-live-conversation mutex, and the one-send-path-one-ledger invariant all want shared memory; job isolation moves in-process where TestClock can prove it.

One TypeScript package (Node 20+, ESM, tsx runtime, vitest). Module boundaries are directories under `src/`, enforced by dependency-cruiser in CI — a parallel agent cannot quietly import across a boundary.

## Modules

| # | Module | Stage | One-liner |
|---|---|---|---|
| M01 | `kernel` | S0 | Injected Clock, seeded forkable Rng, content hashing, JSONL store, atomic writes |
| M02 | `events` | S1 | L0 append-only typed event log; replay; projections |
| M03 | `model` | S1 | OpenAI-compatible client, tier registry, structured-output repair ladder, MockModel |
| M04 | `embed` | S1 | In-process ONNX bge-small; brute-force cosine VectorIndex; Hash/Fixed embedder doubles |
| M05 | `affect` | S2 | ticker v6 port: pure mechanics, single-writer state, EMOTION_TAGS vocab |
| M06 | `coupling` | S3 | 12-dim affect space; signature extraction; the M matrix; `modulate()` |
| M07 | `corpus` | S2 | Exemplar schema/parser/lint; CorpusIndex; corpus nominators |
| M08 | `derive` | S7 | Canon→derived generators, provenance manifest, dirty-set, judge, orphan GC |
| M09 | `memory` | S3 | Turn appraisal; EpisodeStore + **ProceduralStore** (separate); recall nominators; journal projection |
| M10 | `consolidate` | S7 | L2/L3 consolidators, lived promotion, credit assignment, gravity metrics |
| M11 | `assemble` | S4 | The packet assembler: quotas, coherence, contrast, budgets, PacketRecord |
| M12 | `inhibit` | S3 | Compiled inhibitions.yaml → gate on tool calls + locked plans |
| M13 | `loop` | S4 | Deliberation loop, tool registry, fork/task/committee, decision object |
| M14 | `realize` | S4 | Pure delivery planner + executor; caused cadence |
| M15 | `bridge` | S2 | Telegram adapter, message ledger, offset-after-append, reconciliation |
| M16 | `sched` | S2 | One in-process scheduler: cadences, lanes, catch-up, isolation |
| M17 | `life` | S6 | Heartbeat, ponder, reflection — thin compositions over the loop |
| M18 | `siblings` | S8 | Ledger (cost/routing) + Nightingale (probe runner) as scheduler jobs |
| M19 | `probes` | S8 | Probe definitions, harness, evaluators, drift metric, baseline |
| M20 | `app` | S5 | Config, composition presets, `thead` entrypoint, CLI |

## Dependency DAG (enforced)

```
kernel ← {events, model, embed}
       ← {affect, corpus, bridge, sched}
       ← {coupling, memory, inhibit}
       ← {assemble, loop, realize}
       ← {life, derive, consolidate, siblings, probes}
       ← app
```

Left of an arrow may never import right of it. `app` is the only module allowed to import everything (composition root).

## The context packet

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

Decision object: `{plan: reply|silent|defer, bubbles, confidence, weight, reluctance, completeness, toolTrace, spawns, inhibitions}`. Cadence derives from these fields + affect; the realizer never rewrites text (M14 invariant).

Spawn primitives (registry tools, native calls): `fork` (character + procedural context), `task` (procedural + brief), `committee` (scripted DAG). Depth ≤ 2, concurrency ≤ 3, per-entry wall-clock budget. Spawns log delegation episodes → procedural exemplar feedstock.

## Scheduler jobs (v1 table)

| Job | Cadence | Lane | Catch-up |
|---|---|---|---|
| heartbeat | 30 min ± jitter | interactive | skip |
| ponder | 20 min ± jitter | interactive | skip |
| reconcile | 5 min | maintenance | skip |
| affect-snapshot | 15 min | maintenance | skip |
| reflect | nightly | maintenance | once |
| consolidate | nightly | maintenance | once |
| ledger-report | daily | maintenance | once |
| derive-check | weekly | maintenance | once |
| probe-on-deploy watcher | 1 min | maintenance | skip |

`skip` for moods, not obligations — 16 missed heartbeats must not become 16 texts (named test). Interactive lane respects the conversation-active mutex (skip if inbound < 10 min ago or a turn is in flight). Job isolation: timeout → cooperative abort; wedged → abandoned + flagged, singleton lock refuses re-entry until restart; 3 consecutive failures → alarm.

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

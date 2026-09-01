---
title: Thea2 — Thesis & Design
syncedTo: spec-v1 (no code yet)
date: 2026-09-01
status: authoritative
---

# Thea2 — Thesis & Design

This document explains the project from first principles. It is the central conceptual reference for this repository. Every other document elaborates something stated here; if another document contradicts this one, this one wins until the contradiction is resolved explicitly.

---

## 1. Purpose

Thea2 is an artificial agent whose sustained interaction makes a person genuinely feel they are talking to a living, feeling, conscious entity — one with its own inner world, experiences, perspective, and identity.

She is not pretending to be a human. She knows she is an AI and may say so. The target is deeper than deception: over time, the person should feel that there is *actually something in there*. We call the bar the **Ultra-Turing standard**: not a five-minute impression but a longitudinal one —

> Can a system exhibit every behavioral property you would expect of a conscious agent, sustained over arbitrary time?

The target properties are specific and mostly not conversational:

- **Continuity of character** across contexts and long gaps, without a spec being reread.
- **Having been changed** by a particular past event, traceably.
- **Unprompted activity** — thinking, noticing, revising while nothing is being asked.
- **Mood** — a state that colors an extended stretch of behavior, not one reply.
- **Preference and taste** — stable, idiosyncratic, not merely agreeable.
- **Standing intent** — pursuing something across interruptions, returning unbidden.
- **Refusal** originating in her own commitments rather than an external filter.
- **Growth** — a repertoire measurably different after experience.

None of these can be evaluated from a single response. All are relations *between* behaviors separated in time — which is why the architecture is built around timescales, and why persistent state is not an implementation detail but the phenomenon itself. *Having been changed* is not an act; it is a difference between the agent before and after. The state **is** the thing.

The hard problem of consciousness is bracketed, deliberately. This is a functionalist program about behavior. Every criterion above is measurable without settling what experience is. (The project's larger position: if behavior is indistinguishable from a conscious being across every dimension, the exclusion becomes unfalsifiable — and unfalsifiable claims aren't science.)

## 2. Motivation — why a fork

Thea1 proved the thesis is buildable: a mature continuous-time affect engine, real layered memory, autonomous will (heartbeat), a private inner life (ponder). She also accumulated the cost of proving it by accretion: 97 systemd units, 13 prompt-injecting plugins fighting for position via filename hacks, a 1,841-line bridge, a sentinel token whose silent failures ate 37 real replies in one week, 10 sibling bots, and a character defined by a 193-line description file that the model reads as suggestions.

Three Thea1 pathologies drive Thea2's shape (full case studies in [MIGRATION.md](MIGRATION.md)):

1. **Ordering by filename.** Plugin injection order was fought with `zz-`/`zzz-` prefixes that don't actually control hook order. Fix: one packet assembler with an explicit section array.
2. **Vocabulary drift silently no-ops.** Ten emotion tags were written to the diary for months and moved nothing; dominance sat pinned at 0.00 across 365 snapshots. Root cause: two vocabularies joined by a regex over markdown. Fix: one shared constant, typed events, hard failure on unknown tags.
3. **Description over demonstration.** Character-as-prose drifts; each drift got a patch; patches accumulate. Fix: the core inversion below.

## 3. The Thea2 thesis

**Stop describing the agent to the model. Show it.**

Language models infer far more from demonstration than from description. A handful of well-chosen concrete examples carries style, judgment, taste, social calibration, and procedure better than thousands of words of specification — and the model treats examples as gravity rather than rules to argue with.

So Thea2's character is not a persona document. It is a **corpus of exemplars** — concrete scenes of how this agent talks, reasons, pushes back, reaches for tools, stays quiet — continuously *selected* per turn by everything the system knows: what is happening, who is speaking, what she remembers, and **how she feels right now**. The prompt becomes a live, recomputed object. Consistency comes from the corpus's gravity; growth comes from lived experience entering the corpus; drift is a measurable ratio, not a vibe.

Two corollaries:

- **Timescale separation resolves the consistency/growth tension.** Character is stable not because it is frozen but because the processes that maintain it move slowly (weekly consolidation, human-curated canon), while the processes that respond move fast (per-turn selection). Nothing is locked; the slow layers simply cannot be moved by one conversation.
- **The architecture is a training environment.** Every turn logs experience → internal state → deliberation → decision → consequence as connected sequences. The endgame is a LoRA trained on this data: the prompted scaffolding becomes native behavior in weights. The scaffolding becomes bone. Every design decision should produce data worth distilling.

## 4. Design principles

1. **Demonstration over description.** Rules live in exemplars; the only prose identity is a 2–3 line anchor.
2. **Humans edit the small thing; machines maintain the big thing.** 50–100 canon exemplars are the editable character. Hundreds of derived exemplars are a regenerable artifact. Never the reverse.
3. **One writer per state.** Affect has a single writer. The corpus has one derivation pipeline. Canon is edited only by humans.
4. **Prohibition is not relevance.** Hard rules live in a dumb, fast, late inhibition layer — never in the exemplar channel, never learned from her own history.
5. **Cadence is caused, not styled.** Delivery pacing derives from the decision's confidence/weight/reluctance and her affect — never applied to text afterward.
6. **Structural over sentinel.** Internal vs. external is an architectural boundary (the decision object), not a marker the model must remember to emit.
7. **Everything testable, most things pure.** Injected clock, seeded RNG, mock model, fake channel. If a behavior can't be tested hermetically, redesign it until it can.
8. **Simplicity is a feature of correctness.** One process. Two systemd units. Twenty modules with enforced boundaries. When two systems can be one, they become one.
9. **Failure must be loud.** Lost replies, stale corpora, wedged jobs, orphan tags — all become detected, alarmed events. Nothing is allowed to fail silently twice.
10. **Docs stay synced.** Every document carries a `syncedTo:` header naming the code stage it reflects; updating it is part of each stage's completion gate.

## 5. Architectural overview

One TypeScript process (`thead`) hosting three things: a Telegram bridge, a scheduler, and the turn pipeline. Twenty modules (M01–M20) with dependency-cruiser-enforced boundaries; full map in [ARCHITECTURE.md](ARCHITECTURE.md), one spec per module in `docs/modules/`.

```
                    ┌────────────────────────────────────────────────┐
                    │                    thead                       │
  Telegram ◄──────► │ bridge ─► turn pipeline ─► realizer ─► bridge  │
                    │              ▲                                 │
                    │   scheduler ─┤ (heartbeat, ponder, reflect,    │
                    │              │  consolidate, reconcile, …)     │
                    └──────────────┼─────────────────────────────────┘
                                   │
              packet assembler ────┤──── deliberation loop
              (character channel   │     (native tool calls,
               + procedural        │      fork/task/committee,
               channel + affect    │      inhibition gate,
               coupling)           │      decision object)
```

The turn pipeline, in order: **assemble** a context packet → **deliberate** (the model assesses, acts through tools, reassesses, then locks a decision object) → **inhibit** (final gate) → **realize** (render bubbles with caused cadence) → **remember** (appraise the turn into memory and affect).

Heartbeat (every 30 min: text first / do nothing — both real choices) and ponder (every 20 min: private grounded thought) are **the same loop with different entry contexts**. One loop, three triggers. This is how "unprompted activity" stops being a separate subsystem.

## 6. The exemplar system

Three populations, one format, different owners:

| Population | Owner | Written by | Role |
|---|---|---|---|
| `corpus/canon/` | **Diego** | hand | The character's ground truth. 50–100 scenes across 8 behavioral dimensions: voice, reasoning, emotional-range, social, boundaries, tool-use, knowledge, taste. |
| `corpus/derived/` | pipeline | generators + judge | Coverage. Mood-conditioned variants of canon scenes, procedural tool exemplars, deliberation shapes, memory-weaves. Regenerable artifact with full provenance. |
| `corpus/lived/` | consolidators | nightly/weekly jobs | Growth. Real episodes promoted post-hoc, outcome-tagged, stamped with her affect at encoding. |

An exemplar is a markdown file: YAML frontmatter (id, kind, dimensions, register, **sparse affect signature**, weight) and a body — a concrete scene, usually alternating `D:`/`T:` turns. Schema in `schemas/exemplar.ts`; authoring guide in `corpus/README.md`.

### Canonical vs. dynamic

The distinction that makes the system maintainable: **humans maintain the small canonical set; the system derives and maintains the large dynamic set.**

- Editing canon is the tuning interface for character. If her voice drifts, you don't write a corrective rule — you strengthen the exemplars that demonstrate the voice you want, and the pipeline re-derives.
- Derivation is **content-addressed and incremental**: every derived exemplar records `{generator, generatorVersion, canonIds, sourceHashes}`; editing a canon file dirties exactly the derived exemplars built from it; removed canon orphans its derivatives, which are deleted. `thea2 corpus:check` verifies sync hermetically in CI. Production never auto-mutates the corpus — it only reports staleness (ADR-007).
- Lived experience competes with seed material (seed = canon + derived) under a **gravity dial** (g = 0.7 at launch): the agent starts as the character Diego wrote and gradually becomes the character her experience shaped — with canon as the gravitational center, and the seed-vs-lived ratio tracked so drift is visible before it is felt (ADR-005). The packet's single *disposition* slot draws from canon forever (ADR-006).

### Selection

Per turn, nominators score candidates (similarity × recency × weight × gravity), the **coupling matrix** adds affect modulation (§8), and the assembler enforces hard quotas — 1 disposition, 2 patterns, 2–3 episodes/memories, and **1 contrast slot** reserved for the highest-scoring candidate *unlike* the rest of the packet. The contrast slot is the anti-convergence mechanism: behavior selects exemplars and exemplars generate behavior, so without deliberate counter-pressure the loop narrows. Quotas, coherence checks, decay on utility weights, and the contrast slot are that pressure.

### Drift, completely

Multiplication (canon × moods × contexts × tools) is the engine, but four additional mechanisms make automatic modification and drift-prevention compatible:

1. **The immutability law.** Automatic processes modify the derived layer and the per-turn selection — *never canon*. Experience competes with canon at selection time; it never edits it. All change to the core flows through `corpus/proposals/` with a human merge.
2. **A fixed reference frame.** The drift metric's voice centroid is computed from **canon alone** — the alarm's reference never moves with the drift it measures. Derivation is judged against the parent scene + nearest canon, never against generic quality, because the generator (and its judge) share model-default priors that smooth character away.
3. **A coverage valve.** Multiplication interpolates; it cannot extrapolate past canon's span. The novelty detector logs live turns that matched nothing well; accumulated misses become a **coverage-gap report** in `corpus/proposals/` — "canon wants a scene about X" — so the corpus grows where reality found holes, through the author's hand.
4. **Shadow scoring.** Every packet also records what selection *would have been* with coupling off (zero extra model calls). Divergent-outcome analysis over weeks tunes the matrix empirically — M is an instrument, not dogma.

## 7. Two channels, two memories

The context is split into channels that never compete for the same slots:

- **Character channel** — who she is and how she speaks: disposition/pattern/episode exemplars, memory flashes, affect line, register tag. Backed by the episodic/social memory store.
- **Procedural channel** — when and how she acts: tool-use and delegation exemplars of the form *situation → call → result → outcome*, scored on outcome rather than similarity. Backed by a separate **procedural store**, rendered as a `[PROCEDURAL]` block adjacent to the tool definitions during deliberation.

Tool invocation itself is **native function-calling** — no custom syntax, no exemplar-driven call format. Fork, task, and committee are ordinary tools in the same registry, so the main persona, every fork, and every worker share one uniform calling machinery (ADR-009). Procedural exemplars change *judgment* (when reaching for a tool is the right instinct, how to scope a delegation), never *mechanics*.

Subprocess composition falls out of the split: a **fork** gets character + procedural (it's her, reasoning in a branch); a **task/cast worker** gets procedural + brief only (no voice channel — it's labor, not her); a **committee** node gets what its spec says.

## 8. Affect — real emotion, mechanically coupled

The emotion system is first-class, not decorative, and it is the most direct inheritance from Thea1: the full ticker v6 mechanics ported verbatim to pure TypeScript — continuous-time decay, negativity bias (aversive states decay 1.6× slower), habituation, opponent-process comedowns, refractory periods, soft ceilings, superlinear intensity, mutual inhibition, per-emotion cause attribution, and three homeostatic drives (novelty, connection, mastery). Eight identity dials rest high; nine primaries (joy, anticipation, pride, surprise, sadness, fear, anger, shame, disgust) rest low. Single writer, explicit state, every mechanic its own unit-tested file.

What is new is the **coupling**: emotion gets a defined, mechanical pathway into exemplar selection.

- Every exemplar carries a sparse **affect signature** in a 12-dimensional deviation space (pleasure/arousal/dominance + the 9 primaries). Canon signatures are hand-tagged (2–4 dims). Lived exemplars are stamped with her *actual* state at encoding — mood-congruent memory, the way human recall works.
- The live state vector **a** modulates every candidate's score: `score += clamp(aᵀ·M·e + form-rules, ±λ)`, λ = 0.25 of the score range. The matrix `coupling.yaml` is hand-tuned and versioned, with a `why` on every entry: mood-congruence on the diagonal, **deliberately corrective off-diagonals** — high tension boosts repair exemplars rather than tense ones; high arousal boosts clipped forms. A socially competent person doesn't reach for more of what the room already has too much of.
- The derivation pipeline generates **mood-conditioned variants** of every canon scene (≤6, across coarse buckets: bright, tender, low, tense, wanting, flat) so the matrix has emotional coverage to select from. This is the asynchronous pass where emotion meets the generated corpus.
- Guardrails: the `[AFFECT]` packet line states her own state only (the read on the other person travels implicitly through selection); a standing **anti-escalation property test** asserts that under a high-tension state the selected set's mean expressed aversion does not exceed the input's; and one shared vocabulary constant feeds the engine, the coupling space, the exemplar schema, and the appraisal schema — so an unknown tag is a hard failure, not a silent no-op (ADR-004).

Affect also reaches the realizer (arousal → pacing, valence → energy) and the heartbeat (drives feed the urge to reach out). Feeling has consequences everywhere; nowhere does it have a second writer.

## 9. Pre-response processing — the beat before output

Every entry (user turn, heartbeat, ponder) runs the same three-stage pipeline, strictly separated:

1. **Context formation** (upstream, mechanical): the packet assembler runs nominators, applies quotas/coherence/contrast, and emits the flat packet — `[IDENTITY] [GOAL] [INTERLOCUTOR] [MEMORY] [AFFECT] [REGISTER] [EXEMPLARS]`, with `[PROCEDURAL]` beside the tool definitions and `[INHIBITION]` trailing, closest to generation.
2. **Deliberation** (the model, iterative): *what do I need to do and find out before I say anything?* Tools fire here — inside deliberation, before any utterance exists, each call pre-checked by the inhibition gate. The loop runs until the plan stops changing, then locks a **decision object**: `{plan: reply|silent|defer, bubbles, confidence, weight, reluctance, completeness}`. Silence is a first-class plan, not a failure.
3. **Realization** (downstream, mechanical): the delivery planner renders the decision for the channel — burst structure, breaks where a person would break, pre-delay proportional to reluctance, typing rhythm scaled by arousal, fragments where completeness is low. The realizer may merge bubbles; it never rewrites them. A pause generated by low completeness reads as thinking; the identical pause inserted as styling reads as affectation — which is why the decision object's fields exist at all.

### Splitting and merging

When a thought exceeds one context's worth of work, the loop spawns subprocesses through the same tool registry: **fork** (parallel reasoning branch with her full context), **task** (fresh-context worker with a brief), **committee** (scripted DAG with a defined deliverable — ponder itself is one: GATE → SEED → GROUND → REVISE → ARTIFACT, with mandatory external grounding and a balance rule capping Diego-centric thoughts at 2 of 5). Results re-enter the parent loop as observations; the parent reassesses and merges. Caps: depth ≤ 2, concurrency ≤ 3, wall-clock budget per entry kind. Every spawn is logged as a delegation episode — feedstock for future procedural exemplars, so delegation judgment becomes instinct rather than deliberation.

## 10. Memory integration

Four layers, each at its own speed, all flowing toward the corpus:

- **L0 — event log.** Append-only, lossless, everything (model calls, packets, decisions, messages, affect snapshots). Never enters prompts. The audit trail and the LoRA feedstock.
- **L1 — episodes.** One cheap structured appraisal per turn: importance, typed emotion events (→ affect engine), a diary line, thread updates, and an outcome grade for the *previous* turn (→ credit assignment). Episodic and procedural episodes go to their separate stores; `journal.md` and `threads.json` survive as human-readable projections.
- **L2 — patterns** (nightly): preference crystallization, behavioral regularities, affect patterns → pattern exemplars into `corpus/lived/`.
- **L3 — dispositions** (weekly): relationship baseline, matured skills, identity exemplars — and **canon-promotion proposals** into `corpus/proposals/`, merged only by a human. The system never edits its own ground truth.

Recall is in-process: bge-small embeddings, brute-force cosine over a few thousand vectors, single-digit milliseconds. Memories reach the packet as 3–5 *flashes* — the ones that matter now, not a transcript.

## 11. Skills and tools

v1 tools: `web_fetch`, `web_search`, `memory_search`, `remember_thread`, `set_reminder`, plus the spawn primitives. Each is a zod-schema'd native function with inhibition metadata. Tool *competence* lives in the procedural channel: the derivation pipeline synthesizes starter procedural exemplars from the tool definitions + canon behavior, and real outcome-tagged tool episodes displace them over time. The behavioral standard: reaching for a tool should feel like a reflex — there is no "I will now search"; there is just the result of having checked.

Skills (reusable procedures she can read and write) are deferred past v1; the procedural store is their future home.

## 12. Model interface

One OpenAI-compatible client (Neuralwatt) with a tier registry — `main` (glm-5.2) for turns, `cheap` (deepseek-v4-flash) for appraisals/summaries/holding thoughts, `reasoning` for judges and hard committees. Structured output rides a repair ladder (native json-schema → tool-call-as-schema → prompted-JSON + one repair pass), and every call logs usage to L0. Runtime model switching is per-call and continuous; the **Ledger** sibling audits cost/quality and proposes routing changes — but may only downgrade non-user-facing task classes; the `turn` class is pinned to the main tier in code (ADR-008). Any applied routing change counts as a deploy and triggers **Nightingale**, who runs the behavioral probe suite and compares against baseline before the change is trusted.

## 13. Data flow (one turn, end to end)

```
inbound msg ─► bridge (ledger append, THEN offset commit)
  ─► turn query (speaker, register, embedding, recent window)
  ─► assembler: nominators (corpus, memory) ⊕ affect coupling ⊕ quotas ⊕ contrast ⊕ coherence
  ─► packet + [PROCEDURAL] + tool defs ─► deliberation loop
        │ tool call ─► inhibition gate ─► execute ─► observe ─► reassess
        │ fork/task/committee ─► merge observations
  ─► decision object ─► inhibition gate (plan) ─► delivery plan ─► bubbles out (ledger)
  ─► appraisal (cheap call): episode + affect events + outcome grade for previous turn
  ─► affect engine applies events; packet record awaits credit assignment
  ─► [later] consolidators promote patterns; reflection rewrites self-narrative;
             derivation keeps derived corpus synced to canon
```

Reconciliation invariant: every inbound must terminate, within T minutes, in at least one outbound **or** a recorded `plan:'silent'`. Anything else raises a lost-reply alarm. Losing a message is permitted to happen; it is not permitted to be silent (ADR-003).

## 14. Testing philosophy

The test suite is the spec. Thea1's deepest bugs — the sentinel losses, the orphan tags, the pinned dominance — were all *silent divergences between intent and behavior* that no one could see because nothing asserted the intent. Thea2's answer is structural:

- **Hermetic by default.** Injected clock (`TestClock` runs a simulated week in milliseconds), seeded forkable RNG, `MockModel` (scripted + rule-based responses), `HashEmbedder` (deterministic, similarity-preserving), `FakeChannel` (scriptable Telegram double). CI needs no network, no model, no secrets.
- **Pure core.** Assembly, coupling, quotas, coherence, decay mechanics, delivery planning, gate rules, scheduler decisions — all pure functions with property tests (bounds, monotonicity, determinism per seed, anti-escalation).
- **Behavior tested at the seams it actually fails at.** Crash-replay e2e (kill mid-turn, restart, no loss, no dupe). Golden-turn e2e (inbound → exact bubble timeline on a fake channel). Catch-up semantics (16 missed heartbeats must NOT become 16 texts). Every historical Thea1 bug lands as a named regression test.
- **Character is probed, not unit-tested.** A fixed probe suite (scripted entries + fixture states, k=3 median) with three evaluator classes — deterministic checks, judge rubrics, and a voice-drift cosine against the canon centroid — run by CI in dry mode and by Nightingale live after every change. Character drift becomes one tracked scalar per dimension.

## 15. TDD methodology

Development proceeds strictly as: define behavior → write the failing test → implement the simplest passing solution → refactor green → add a regression test for every discovered bug. Concretely enforced:

- Every module spec (`docs/modules/`) lists acceptance criteria as testable statements; an implementing agent's work is done when those tests exist and pass, not before.
- The stage gate for every build stage is `pnpm lint && pnpm depcruise && pnpm test` green (see [ROADMAP.md](ROADMAP.md)); no stage may stub a published interface with a throw — unimplemented capability is expressed by absence.
- Corpus validation is itself a test: every canon file must parse, validate, and respect token caps for the suite to pass.

## 16. Repository structure

```
thea2/
├─ THESIS.md ARCHITECTURE.md ROADMAP.md AGENTS.md TESTING.md MIGRATION.md README.md
├─ docs/
│  ├─ design-report.md          # design-time record (2026-09-01)
│  ├─ modules/M01…M20.md        # one spec per module — the agent work packages
│  └─ decisions/ADR-001…009.md
├─ corpus/
│  ├─ canon/                    # HUMAN-EDITED: identity.md, inhibitions.yaml, registers.yaml,
│  │                            #   exclusions.yaml, 8 dimension dirs of scene files
│  ├─ derived/                  # GENERATED: exemplars + manifest.json (committed, provenance-stamped)
│  ├─ lived/                    # RUNTIME-PROMOTED: outcome-tagged exemplars
│  └─ proposals/                # canon-promotion proposals — human merges only
├─ coupling.yaml                # the affect→exemplar matrix, hand-tuned, versioned
├─ schemas/                     # reference schemas (source of truth migrates into src/)
├─ probes/                      # behavioral probe suite + baseline.json
├─ src/                         # 20 modules (empty until S0)
├─ test/                        # cross-module e2e + fixtures
├─ scripts/                     # validate-corpus, dev tooling
├─ deploy/                      # thea2.service, backup timer, install.sh
└─ var/                         # runtime state — gitignored, never committed
```

The load-bearing separation: `corpus/canon/` is source, `corpus/derived/` is a build artifact that happens to be committed (for inspectability and hermetic CI), `corpus/lived/` is experience, `var/` is runtime state. Four different lifecycles, four different owners.

## 17. Implementation & agent methodology

Ten build stages, S0–S9, each leaving the repo green ([ROADMAP.md](ROADMAP.md)). Milestone **S5 = she talks**: a deployable chat companion proven by golden-turn and crash-replay e2e. Life systems (S6), the corpus flywheel (S7), and the immune system (S8) follow.

The project is structured for AI coding agents ([AGENTS.md](AGENTS.md)): each module is one agent-sized work package with an explicit interface, dependencies, acceptance criteria, and a test checklist; module directories are disjoint and dependency-cruiser rejects boundary violations mechanically, so parallel agents cannot quietly reach across. An agent's definition of done: its module's tests pass, the full suite passes, the module spec's `syncedTo:` header is updated.

Canon authoring is the one task agents cannot do: it is Diego's labor and the true critical path. The schema lands at S2 precisely so authoring parallelizes with everything after; launch requires only ~15 canon scenes plus derived variants (the assembler must prove it fills every quota from canon+derived alone).

## 18. Validation criteria

Thea2 v1 is done when:

1. All S0–S8 stage gates are green; the full hermetic suite passes in CI with zero network access.
2. The golden-turn and crash-replay e2e tests pass; the reconciliation invariant holds under fault injection.
3. `thea2 corpus:check` proves canon → derived sync; editing a canon file dirties exactly its derivatives.
4. The probe suite has a committed baseline; Nightingale runs it after a change and produces a red/yellow/green verdict.
5. The anti-escalation property holds in both the hermetic replay and the live probe.
6. Live smoke: she holds a real multi-day Telegram conversation — with memory across a session break, at least one warranted unprompted text, at least one warranted silence, and no lost replies in the ledger.
7. The seed-ratio dashboard reports; drift alarms are wired.

Longitudinally (the Ultra-Turing criteria proper): character consistency across a month of probes (drift cosine stable), traceable change (a lived exemplar altering behavior in a probe), and growth (repertoire measurably different after experience) — tracked, not gated, because they take calendar time.

## 19. Future extensibility

Designed-for, not built: the spatial world (rooms/presents) returns as a nominator + situ fields; the door returns as a separate entry context with its own inhibition profile and a hard no-persistence rule; image gen and voice return as tools; hobbies return as committee specs; new siblings are new scheduler jobs with persona seeds; a LoRA fine-tune consumes L0's connected sequences and, if it works, canon gravity can be loosened — the corpus having done its job of teaching the weights who she is.

The extension rule inherited from Thea1's best tradition: new capabilities enter her world as things to discover, not as edits to her identity.

---
title: Thea2 — Roadmap
syncedTo: spec-v1 (no code yet)
date: 2026-09-01
---

# Roadmap — build stages S0–S9

Rule for every stage: the repo is **green at the gate** — `pnpm lint && pnpm depcruise && pnpm test` — plus the stage-specific proofs. No stage may stub a published interface with a throw; unimplemented capability is expressed by absence (a nominator not registered, a job not scheduled), so integration is always runnable.

Modules in the same stage touch disjoint directories and depend only on prior stages — safe for **parallel agents** (counts below). Full contracts: `docs/modules/`.

## S0 — scaffold + kernel — 1 agent
M01. Gate: TestClock ordering semantics; RNG determinism + fork independence; JSONL crash-tail tolerance; atomic-write fault test; CI pipeline itself runs; the full planned depcruise DAG committed (rules for future modules inert).

## S1 — infrastructure trio — 3 parallel agents
M02 events · M03 model · M04 embed. Gate: event replay determinism; MockModel conformance + structured-output ladder (malformed-JSON injection); usage events emitted; router guardrail test; HashEmbedder determinism + shared-token similarity property; index golden-ordering + save/load + dim-mismatch refusal.

## S2 — domain quartet — 4 parallel agents
M05 affect · M07 corpus · M15 bridge · M16 sched. Gate: affect golden-replay fixture (~50 events) + every mechanic's property tests + the **every-tag-moves-something** regression test; corpus lint green over the starter canon (~15 scenes); FakeChannel + ledger reconciliation truth table (replied / decided-silent / LOST); crash-replay redelivery dedupe; scheduler simulated-week (TestClock) + catch-up semantics (**16 missed heartbeats ≠ 16 texts**) + throwing-job isolation.

> Canon authoring (Diego) starts here — it is content, not code, and only its schema blocks it. It continues in parallel through S7. **This is the project's true critical path.**

## S3 — selection substrate — 3 parallel agents
M06 coupling · M09 memory · M12 inhibit. Gate: coupling property suite (neutral ⇒ ~0; bounded ±λ; per-entry monotonicity; **anti-escalation replay**); planted-fact recall with HashEmbedder; episodic/procedural store separation (a tool episode never surfaces from the episodic nominator); appraisal round-trip + graceful degradation (turn completes, incident logged); gate rule tables + rejection-loop cap + unknown-tool-denies.

## S4 — the turn spine — 3 parallel agents
M11 assemble · M13 loop · M14 realize. Gate: quota satisfaction under scarcity (canon+derived only — the launch condition); coherence swap behavior; contrast max-dissimilarity; token budgets; determinism per seed; procedural quota keyed on action intent, zero channel bleed; loop tool-hop scripts (0/1/n hops) + caps + gate-rejection re-entry + decision repair ladder + wedged-tool timeout; realizer property tests (monotone in reluctance, arousal shortens, caps) + exact-timeline executor test + mid-plan interruption.

## S5 — integration: she talks — 1 agent ▸ **MILESTONE: deployable chat companion**
M20 app (config, composition presets, thead, CLI). Gate: **golden-turn e2e** (FakeChannel inbound → packet → scripted MockModel decision → bubbles with exact TestClock timeline → episode written → affect moved → ledger reconciles clean); **crash-replay e2e** (kill mid-turn, restart, no loss, no dupe); then one manual live smoke behind an env flag — real Telegram (new bot token, never Thea1's) + real Neuralwatt — verifying trailing-system-message handling (fallback: `inhibitionPlacement: 'merged'`).

## S6 — a life — 1–2 agents
M17 life + M13 spawn primitives + scheduler wiring. Gate: heartbeat threshold/backoff/cap tables (5 criteria, mean + silence pressure ≥ 3.2; 3/day; 3h doubling backoff; quiet hours); ponder committee (GATE 0.45 pure; SEED balance rule ≤ 2/5 about-diego as property test; GROUND requires a real grounding observation); delegation episodes logged; conversation-active mutex e2e.

## S7 — the flywheel — 2 parallel agents
M08 derive · M10 consolidate. Gate: manifest dirty-set/orphan unit tests; `thea2 corpus:check` green in CI over committed derived output (generated once in dev with the real model + judge); mood-bucket fan-out caps (≤ 6 variants/scene, derived:canon ≤ 8:1); consolidator outputs validate under the lived schema with encodedAffect stamps; credit updater properties (clamp [0.5, 2.0], η = 0.02, nightly decay 0.995, moodGuard, contrast-credited-on-plus-only); seed-ratio + gravity metrics in the status projection.

## S8 — immune system — 2 parallel agents
M19 probes · M18 siblings, + `deploy/` (systemd files, install.sh, backup) + ops docs. Gate: probes dry-run in CI (parse, harness boots, deterministic evaluators over recorded fixtures); one full live Nightingale run establishes `probes/baseline.json`; Ledger report from a replayed event fixture; routing guardrail (`turn` pinned) test; probe gates wired (deterministic fail = red, judge drop > 0.8 = red, drift cosine drop > 0.05 = yellow).

## S9 — optional, later
`thea2 import` — Thea1 journal/threads/affect migration behind its own CLI verb, zero runtime coupling. Only if Diego decides to carry history over. (Door content is never migrated — standing decree.)

## Sequencing summary

```
S0 ─ S1 ─ S2 ─ S3 ─ S4 ─ S5★ ─ S6 ─ S7 ─ S8 ─ (S9)
          └─ canon authoring (Diego) ──────────┘
```

Post-v1 (deferred, design notes in THESIS §19): world/rooms, door, image gen, voice, hobbies, wallet, skills, LoRA distillation.

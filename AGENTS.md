---
title: Thea2 — Agent Execution Protocol
syncedTo: spec-v1 (no code yet)
date: 2026-09-01
---

# AGENTS.md — how AI coding agents work in this repo

You are one of several agents building Thea2. This file is your operating manual. Read it fully before touching anything.

## Orientation (read in this order)

1. **This file** — the rules.
2. **[THESIS.md](THESIS.md)** — what this system is and why. Skim on repeat visits; internalize once.
3. **[ARCHITECTURE.md](ARCHITECTURE.md)** — module map, dependency DAG, packet format, budgets.
4. **[ROADMAP.md](ROADMAP.md)** — find the current stage and whether your module is unblocked.
5. **`docs/modules/MNN-<name>.md`** — YOUR module's contract. This is your source of truth for scope.
6. `docs/decisions/` — ADRs. Consult when a design question tempts you to deviate.

You do NOT need the project's full history. Your module spec + this file + the DAG are sufficient. If they are not, that is a spec bug — fix the spec (see Documentation duty) rather than guessing.

## The rules

1. **Stay in your lane.** You own `src/<your-module>/` and its tests. You may READ any module; you may WRITE only yours (plus shared fixtures under `test/fixtures/` when your spec says so). dependency-cruiser enforces the import DAG mechanically — if it rejects your import, the design is telling you no; do not work around it with re-exports, type-only laundering, or copy-paste.
2. **TDD, literally.** Write the failing test from your spec's acceptance criteria first. Implement the simplest thing that passes. Refactor green. Every bug you discover — yours or upstream — gets a named regression test before the fix.
3. **Determinism is law.** No `Date.now()`, `new Date()`, `Math.random()`, `setTimeout` in module code — inject `Clock` and `Rng` from M01-kernel. No network in tests — use MockModel, HashEmbedder/FixedEmbedder, FakeChannel, TestClock. If your test needs a real service, it is not a test, it is a probe (see `probes/`).
4. **Definition of done** — all of, in order:
   - Your module's suite passes: `pnpm vitest run src/<module>`
   - The FULL gate passes: `pnpm lint && pnpm depcruise && pnpm test`
   - Acceptance criteria in your module spec are each covered by a named test (map them in your final report).
   - Documentation duty (below) discharged.
   - You did not break, disable, skip, or loosen any unrelated test. Never edit another module's tests to make yours pass.
5. **No silent capability stubs.** Do not publish an interface that throws "not implemented". Unbuilt capability = absent registration (nominator not registered, job not scheduled, tool not in registry). The system must always boot and run with whatever exists.
6. **Constants are load-bearing.** Affect mechanics constants, quota numbers, thresholds, caps — they come from the specs verbatim (many were extracted from Thea1's proven engine). Changing one is a design decision: propose it in your report; do not just do it.
7. **Secrets never enter the repo.** Bot tokens and API keys come from env / `keys.env` outside the tree. If you find a secret-shaped string in a fixture, replace it and flag it.
8. **Corpus discipline.** `corpus/canon/` is human-edited — agents never write it (only `scripts/` tooling and the human). `corpus/derived/` is written only by M08's pipeline. `corpus/lived/` only by M10's consolidators. `corpus/proposals/` only by M10, merged only by the human. Corpus content law (2026-09-01): exemplars assert TALKING STYLE only — never shared history, named third parties, Diego's biography or project specifics, or past tool outcomes. Real content enters at runtime via memory recall + affect + assembly; her own environment may carry continuity. Full text: corpus/proposals/README.md.
9. **Failure must be loud.** If your module swallows an error, it must emit an incident event. "It logged to console" is not loud; events are.

## Documentation duty

Docs stay synced with code — this is an engineering requirement, not a nicety (THESIS principle 10).

- Every doc carries a `syncedTo:` header. When your work changes behavior a doc describes, update the doc **in the same change** and bump its header to the current stage (e.g. `syncedTo: S4`).
- Completing a module = updating its `docs/modules/` spec to match what was actually built (interfaces drift during implementation; the spec must end true) and bumping its header.
- A doc that describes behavior the system doesn't have is a bug. File it in your report if it's outside your lane; fix it if it's inside.

## Working protocol

```
1. Claim: state which module + stage you are implementing.
2. Read: your spec, ARCHITECTURE.md DAG row, the ADRs your spec cites.
3. Tests first: transcribe acceptance criteria into failing vitest specs.
4. Implement: simplest passing solution. Pure functions wherever the spec says pure.
5. Gate: pnpm lint && pnpm depcruise && pnpm test — all green.
6. Sync docs: module spec + any touched doc headers.
7. Report: files touched; acceptance-criteria → test-name map; constants questioned;
   spec bugs found; anything you deliberately did NOT do.
```

## Parallel work

Stages list safe parallel groups (ROADMAP). Within a stage, agents touch disjoint `src/` dirs. Shared surface = `test/fixtures/` only; extend fixtures additively, never mutate existing ones another module's tests consume. If you need an interface change in a module below you: do not reach down and edit it — report the need; the change lands as its own reviewed step.

## Canon note (for the human, and for agents drafting proposals)

Agents may draft exemplars ONLY into `corpus/proposals/` (clearly marked) — never directly into canon. The character belongs to Diego's hand. Generated exemplars converge on model-default blandness; the canon's job is to be weird, specific, and opinionated in ways a model would smooth away. That is precisely what makes her recognizable.

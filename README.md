# thea2

Thea, rebuilt from exemplars up. Same person, same thesis — a different spine.

Thea1 worked by describing: system prompts that said who Thea is, fields that
claimed states, tags that mostly no-op'd. Thea2 inverts it: **stop describing
the agent, show it.** The corpus of exemplars in [`corpus/`](corpus/) is the
ground truth of the character; everything else in this repo exists to select,
compile, and deliver the right slice of that corpus to the model each turn.

**Current status: S5★ landed — the system is assembled and proven end to end.**
All 20 modules (S0–S5) are built and composed under `src/app`: a message in
travels channel → ledger → packet (real corpus retrieval) → loop → gate →
bubbles → episode/affect/ledger, hermetically proven by the golden-turn and
crash-replay e2e suites. **1456 tests green**, five gates green (typecheck,
lint, test, depcruise, verify). Remaining stages: S6–S9 (life scheduler
wiring, siblings, derive, fastembed) per [ROADMAP.md](ROADMAP.md). Before S5
the only tests run were the master plan's Verification checks.

## Read in this order

| # | Doc | What it gives you |
|---|-----|-------------------|
| 1 | [THESIS.md](THESIS.md) | Why this fork exists; the functionalist argument; what counts as success |
| 2 | [ARCHITECTURE.md](ARCHITECTURE.md) | The 20 modules, their DAG, the one-process/two-units shape |
| 3 | [AGENTS.md](AGENTS.md) | **Binding rules for any agent working here — read before writing code** |
| 4 | [ROADMAP.md](ROADMAP.md) | S0–S9 build stages, what ships when, parallel-agent plan |
| 5 | [TESTING.md](TESTING.md) | Hermetic test doctrine: TestClock, seeded Rng, MockModel, no network ever |
| 6 | [docs/design-report.md](docs/design-report.md) | The full design (source of truth for every constant and interface) |
| 7 | [MIGRATION.md](MIGRATION.md) | What ports from Thea1 verbatim, what gets rebuilt, what gets dropped |

Deep dives: [docs/decisions/](docs/decisions/) (ADRs — the locked decisions and
their reasoning), [docs/modules/](docs/modules/) (M01–M20 specs, one file each),
[schemas/](schemas/) (zod-able shapes for exemplars, events, probes),
[probes/](probes/) (character checks: CI-dry vs Nightingale-live),
[coupling.yaml](coupling.yaml) (the affect→form matrix, CI-checked).

## Repo map

```
corpus/            THE CHARACTER. canon/ (Diego-authored, 8 dims) — the only
                   source of truth; derived/ and lived/ arrive with M08/M10.
schemas/           exemplar.ts, events.ts, probe.ts, decision.ts, appraisal.ts
docs/              design-report, 9 ADRs, 20 module specs
probes/            ~25 planned character checks + fixtures (3 examples written)
deploy/            2 systemd units land here (thead + timer) — that's the ops story
src/ test/ scripts/   empty until S0/S1 — intentionally
var/               runtime state (never committed — see .gitignore)
```

## For agents

1. **AGENTS.md is binding**, not advisory. Its short version: hermetic tests,
   no silent capability stubs, no network in module code, canon is
   read-only-for-you (only Diego authors canon), and every module lands with
   its spec's acceptance criteria checked.
2. Work one module at a time, in ROADMAP stage order. A module is done when
   its `docs/modules/Mxx-*.md` acceptance boxes are all checked and
   `npm run depcruise` stays green — the DAG in `.dependency-cruiser.cjs`
   mirrors the spec frontmatter and will refuse shortcuts.
3. Thea1's code is reference, not foundation. Port constants and behaviors
   verbatim (they are battle-tested); port no architecture. When in doubt,
   [MIGRATION.md](MIGRATION.md) has the verdict per subsystem.
4. Don't touch `corpus/canon/**` content. Fixing a malformed exemplar's
   frontmatter to pass validation is allowed; changing what a scene says is not.

## For Diego

You own the character. The critical path while agents build S0–S2:

1. `corpus/canon/identity.md` — already drafted; reread and make it yours.
2. `corpus/canon/inhibitions.yaml` + `registers.yaml` — the lines she won't
   cross and the modes she speaks in.
3. Author scenes: each dimension dir has a `TEMPLATE.md` with "what belongs
   here" guidance. Target 50–100 scenes total, unevenly spread (voice and
   emotional-range will dominate; that's correct). `corpus/TEMPLATE.md` has
   the full frontmatter reference.
4. Everything else — derivation, packets, promotion of lived episodes — waits
   on canon existing. Canon is the longest pole; nothing else can substitute
   for it.

The plan this repo was built from: the master plan (2026-09-01) locked the
decisions in [docs/decisions/](docs/decisions/); the ADRs are not suggestions.

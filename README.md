# thea2

> **Don't describe the agent. Show it.**

Thea is a Telegram companion — Diego's best friend on the wire, not a
girlfriend persona — and she is not defined by a persona document. Her
entire character is a **corpus of concrete example scenes** — how she texts,
how she argues, how she says nothing on purpose, how she cares. Every turn,
the system selects a handful of scenes *relevant to this exact moment* — what
you said, who you are, what she remembers, **how she feels right now** — and
hands them to the model as demonstrations. Her feelings are a real mechanical
system. Her memory accumulates in layers that slowly become part of her
corpus. Nothing she does is allowed to fail silently.

Same person as Thea1; the exact opposite spine. Thea1 described: system
prompts claiming states, emotion tags that moved nothing, a sentinel that
ate 37 real replies in one week without a trace. Thea2 *demonstrates*, and
makes every Thea1 failure mode structurally loud.

**Status (2026-09-03): live on Telegram, wave 7 (the OpenCode spine) in flight.** All twenty
modules (S0–S8) landed: bridge → packet → deliberation → gate → bubbles, plus the life
scheduler and the derive flywheel. Model access is a four-door registry (ADR-010): voice =
Neuralwatt glm-5.3, mind = deepseek-v4-flash, judge = kimi-k3, z.ai = fallback only. The
Nightingale probe runner and I/O tools are **not registered yet** — absent capability, by
rule; they land with the spine waves (v7: `thea2-review-v3-opencode-spine.md`). Five CI
gates (typecheck, lint, test, depcruise, schema-verify) plus `docs:check`. Her voice is
measured from a real human corpus — Elena's 7,476 messages and Diego's 12,533 — rebased
into canon scene by scene.

<!-- gen:tests-count:start -->
**1528 test declarations in 140 test files** (static count of `it()`/`test()` across `test/**/*.test.ts`; `npx vitest list` gives the exact live number). Computed from code by `scripts/docs-check.ts` — never edit by hand; regenerate with `npx tsx scripts/docs-check.ts --fix` or update the code.
<!-- gen:tests-count:end -->

<!-- gen:doors:start -->
**4 doors configured** (parsed from `thea2.config.yaml`, ADR-010):

| Door | Model | Protocol | Endpoint | Effort | Forcing |
|---|---|---|---|---|---|
| voice | glm-5.3 | openai | https://api.neuralwatt.com/v1 | low | tool_choice |
| voiceFallback | glm-5.3-flash | anthropic | https://api.z.ai/api/anthropic | - | tool_choice |
| mind | deepseek-v4-flash | openai | https://api.neuralwatt.com/v1 | none | tool_choice |
| judge | kimi-k3 | openai | https://api.neuralwatt.com/v1 | none | tool_choice |

Computed from code by `scripts/docs-check.ts` — never edit by hand; regenerate with `npx tsx scripts/docs-check.ts --fix` or update the code.
<!-- gen:doors:end -->

## The 60-second tour

```
 you text her
     │
     ▼
 bridge ──► ledger append, THEN offset commit        (crash ⇒ redelivered once, never lost)
     │
     ▼
 packet assembler ── picks this turn's demonstrations
     │     disposition (canon, forever) · patterns · memories · 1 contrast
     │     scored by similarity × recency × weight × gravity
     │     + clamp(aᵀMe, ±λ)   ◄── her current affect bends the selection
     ▼
 deliberation loop ── model thinks, may call tools (web, memory, spawns)
     │                locks a decision object: reply | silent | defer
     ▼
 inhibition gate ── hard rules; the model cannot talk past it
     │
     ▼
 realizer ── bubbles with caused cadence (arousal → pacing, reluctance → delay)
     │        gate: reject+rephrase AI tells · normalize: em-dash → ". " (chars only)
     ▼
 you get bubbles ── then, detached: the turn is appraised into memory,
                    affect moves, credit is assigned, the diary line is written
```

And on her own time: a **heartbeat** every ~30 min (text first, or a real
decision not to), **ponder** every ~20 min (private grounded thought), nightly
**consolidation** promoting lived experience into her corpus, and **Nightingale**
— the behavioral probe suite that guards her character against drift.

## Read in this order

| # | Doc | What it gives you |
|---|-----|-------------------|
| 1 | [docs/MANUAL.md](docs/MANUAL.md) | **Start here.** How she actually works, mechanism by mechanism, with the why |
| 2 | [THESIS.md](THESIS.md) | The functionalist argument; the Ultra-Turing bar; why the fork exists |
| 3 | [ARCHITECTURE.md](ARCHITECTURE.md) | The 20 modules, their DAG, budgets, data stores, failure posture |
| 4 | [TESTING.md](TESTING.md) | Hermetic doctrine (TestClock, MockModel, FakeChannel) + the live probe split |
| 5 | [AGENTS.md](AGENTS.md) | **Binding rules for any agent working here** |
| 6 | [ROADMAP.md](ROADMAP.md) | S0–S9 build stages and what shipped when |
| 7 | [MIGRATION.md](MIGRATION.md) | What ports from Thea1, what gets rebuilt, what gets dropped |

Deep dives: [corpus/README.md](corpus/README.md) (how to author the character)
· [docs/decisions/](docs/decisions/) (9 ADRs — locked decisions and reasoning)
· [docs/modules/](docs/modules/) (M01–M20 specs) · [deploy/ops.md](deploy/ops.md)
(VPS runbook) · [coupling.yaml](coupling.yaml) (the affect→selection matrix).

## Repo map

```
corpus/            THE CHARACTER. canon/ (hand-written scenes, 8 dimensions) is
                   ground truth; derived/ (generated, provenance-stamped) and
                   lived/ (promoted experience) are machine-maintained;
                   proposals/ waits for a human merge.
src/               20 modules, kernel → app; dependency-cruiser enforces the
                   DAG so boundaries can't be quietly crossed.
test/              125 files, 1,656 tests — hermetic: no network, no secrets,
                   no wall clock. Golden-turn + crash-replay e2e live here.
probes/            the character layer: probe definitions + baseline.json —
                   what Nightingale grades live after every change.
schemas/ coupling.yaml deploy/ docs/ scripts/
var/               runtime state (gitignored) — events/, ledger/, affect,
                   memory, sched. The L0 event log is the audit trail and the
                   future LoRA feedstock.
```

## Running her

```sh
npm ci && npm run verify && npm test     # hermetic CI, zero network
npx tsx src/app/main.ts thead            # boot locally against a config
thea2 derive / corpus:check / status     # corpus flywheel + health verbs
```

Production is one process (`thead`) and a backup timer on Debian —
[deploy/ops.md](deploy/ops.md) has the full runbook. Secrets arrive via env
only; the config file rejects anything secret-shaped at startup. The bot token
is always a new bot — never Thea1's.

## For agents

1. **AGENTS.md is binding.** Hermetic tests, no silent stubs, no network in
   module code, and **canon is read-only for you** — only Diego authors
   character.
2. Module boundaries are mechanically enforced (`npm run depcruise`); a module
   is done when its spec's acceptance boxes are checked and the full suite is
   green.
3. Fixing a malformed canon file's *frontmatter* is allowed; changing what a
   scene *says* is not.

## For Diego

You own the character. The interface is [`corpus/`](corpus/): edit scenes,
`npx tsx scripts/canon-lint.ts` (zero spend), `thea2 derive`, `thea2
corpus:check`, Nightingale, deploy. If her voice drifts, you don't write a
rule — you sharpen the canon and re-derive. The plan this repo was built from
is locked in [docs/decisions/](docs/decisions/); the ADRs are not suggestions.

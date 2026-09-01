---
module: M20
name: app
syncedTo: spec-v1 (no code yet)
stage: S5
depends: [M01-kernel, M02-events, M03-model, M04-embed, M05-affect, M06-coupling, M07-corpus, M09-memory, M11-assemble, M12-inhibit, M13-loop, M14-realize, M15-bridge, M16-sched]
---
# M20 — app

## Responsibility
The composition root and entrypoint: zod-validated config, secrets handling, the three composition presets (`prod`, `hermetic`, `probe-harness`), the `thead` process (bridge loop + scheduler + turn pipeline in one process — ADR-002), the CLI verbs, and the two e2e proofs (golden-turn, crash-replay). M20 is the only module allowed to import everything; it is also where "unimplemented capability = absent registration" becomes concrete: modules whose stage hasn't landed simply aren't wired, and the system still boots. The S5 milestone — **deployable chat companion** — lives here.

## Interfaces (contract)
```ts
export interface Thea2Config {   // zod-validated from thea2.config.yaml + env (never secrets in the file)
  models: { endpoint: string; tiers: { main: string; cheap: string; reasoning?: string } };
  bridge: { botToken: string /* from env/keys.env */; allowedChatIds: number[] };
  affect: { statePath: string; quietHours: [number, number] };
  sched: { statePath: string };
  budgets: { packetTokens: number; windowTokens: number; turnTokens: number };
  inhibitionPlacement: 'trailing' | 'merged';
  gravity: { seedWeight: number };           // g, default 0.7
  reconcile: { lostReplyWindowMin: number };
  embedder: { kind: 'fastembed' | 'api' | 'hash'; model?: string };
}
export const loadConfig: (yamlPath: string, env: Record<string, string | undefined>) => Thea2Config;

export type Preset = 'prod' | 'hermetic' | 'probe-harness';
export const compose: (cfg: Thea2Config, preset: Preset, opts?: { varDir: string }) => Promise<System>;
export interface System {
  thead(): Promise<{ stop(): Promise<void> }>;   // bridge + scheduler + pipeline, one process
  pipeline: { inbound(m: InboundMsg): Promise<void> };
  probeTarget(): ProbeTarget;                    // probe-harness preset (M19's seam)
}

export const cli: (argv: string[]) => Promise<number>;
// verbs: thead | derive | corpus:check | probe run [--dry] | reconcile | status | import (late phase, S9)
```

## Behavior spec
- **The turn pipeline** — the composition of everything, in order (architecture §The turn pipeline):
  1. bridge inbound → `ledger.recordInbound` (dedupe) → offset commit → enqueue;
  2. query build: speaker (people registry), register (work/friend/play from mode), embedding of the turn, recent turn ids;
  3. `assemble(query, affectSig)` → Packet (PacketRecord emitted to L0 by the pipeline);
  4. loop: assess → [tool → `gate.checkTool` → exec → observe → reassess]* → DecisionObject;
  5. `gate.checkPlan(decision)` — reject ⇒ re-enter loop with the hint, max 2, then forced `plan:'silent'` + incident;
  6. realize: `planDelivery` → executor vs clock → sends recorded via `MessageLedger.recordOutbound`;
  7. afterturn (detached — the turn is already delivered): appraise → episodes → `affect.apply(events)` → outcomePrev → credit queue. A failure in stage 7 emits an incident and never touches stage 6's outcome (graceful degradation, M09's contract).
  - **Interruption**: a new inbound while stage 6 is mid-plan aborts the remaining steps; `undelivered` bubbles enter the NEXT turn's context as "she was about to say" (M14's contract; the carry-over is the pipeline's job).
  - Event-log failure policy (M02's contract, enforced here): L0 unwritable ⇒ advisory only, the turn completes.
- **Presets**:
  - `prod` — real everything: fastembed embedder, Neuralwatt client, Telegram channel, scheduler with the full job table (jobs of unlanded stages absent), `var/` under the install dir.
  - `hermetic` — the CI/testing composition: TestClock, seeded rng, MockModel, Hash/FixedEmbedder, FakeChannel, tmp `var/`. Nothing in this preset touches network or wall clock; the e2e tests run it.
  - `probe-harness` — M19's seam: hermetic doubles EXCEPT the model client is real; exposes `probeTarget()` with scripted inbound and captured outbound; never live stores, never Telegram.
- **Secrets discipline** (AGENTS rule 7): bot token + API key enter via env / `keys.env` OUTSIDE the tree; `loadConfig` merges them; config validation REJECTS a `thea2.config.yaml` that carries a secret-shaped value (fail loud at startup). The bridge uses a NEW bot token — never Thea1's (MIGRATION.md).
- **CLI verbs**: `thead` (run the process), `thea2 derive` (S7), `thea2 corpus:check` (S7), `thea2 probe run [--dry]` (S8), `thea2 reconcile` (manual reconcile pass), `thea2 status` (state-of-her report: recent decisions, affect weather, sched state, last reports), `thea2 import` (S9, optional). Verbs for unbuilt stages print "not built yet (stage SX)" — a missing capability is named, never stubbed (AGENTS rule 5).
- **e2e proofs (the S5 gate), in `test/`**:
  - **Golden-turn**: FakeChannel inbound → packet → scripted MockModel decision → bubbles on FakeChannel with the EXACT TestClock timeline → episode written → affect moved → ledger reconciles clean. This is the single test that proves she talks.
  - **Crash-replay**: kill mid-turn (fault between ledger append and offset commit), restart, redelivery deduped, no loss, no dupe.
  - **Live smoke** (manual, behind an env flag, NOT CI): real Telegram + real Neuralwatt — verifies trailing-system-message handling specifically; fallback `inhibitionPlacement: 'merged'` if the backend mishandles it. Run once at S5, re-run when the model endpoint changes.
- **Deploy artifacts** (`deploy/`, completed in S8): `thea2.service`, `thea2-backup.{service,timer}` — the two systemd units total — and `install.sh`. The backup timer is the whole disaster-recovery story: `var/` snapshot + repo push.
- Startup order (composition responsibility): config → kernel (clock/rng) → L0 event log → stores (affect, memory, ledger, corpus) → gate + coupling compile (invalid files are STARTUP failures — never runtime surprises) → pipeline → scheduler → bridge. Each step emits a `app.boot` stage event; a failed boot names its stage.

## Not this module's job
- Any domain behavior — everything above the imports line owns its own semantics; M20 only wires.
- Routing decisions — M03's router (M20 supplies `var/routing.json`'s path).
- Probe logic — M19 (M20 provides the preset + seam).
- Job bodies — M17/M18/M08/M10 (M20 registers them as their stages land).
- Canon content — human. M20 never writes corpus (composition only reads).

## Acceptance criteria
- [ ] `loadConfig` reject table: missing required fields, secret-shaped value in yaml, unknown keys, bad quiet-hours range, g outside [0,1] — typed errors naming the path.
- [ ] Preset hermeticity: `hermetic` boots with zero network and zero wall-clock calls (lint-level + runtime assertion via injected doubles); `probe-harness` differs from it ONLY in the model client (composition diff assertion).
- [ ] **Golden-turn e2e** passes with the exact committed timeline (FakeChannel sends at the planned TestClock timestamps; ledger reconciles to zero discrepancies).
- [ ] **Crash-replay e2e** passes: fault injected at every seam between recordInbound and offset commit — exactly-once handling in all cases.
- [ ] Unlanded-stage absence: with S6+ jobs unregistered, `prod` boots, serves a user turn, and `thead` shuts down cleanly (no references to absent modules).
- [ ] Interruption carry-over: mid-plan inbound ⇒ `undelivered` bubbles appear in the next turn's packet context verbatim ("she was about to say").
- [ ] afterturn failure isolation: a scripted appraisal crash leaves the delivered turn intact, incident emitted, next turn unaffected.
- [ ] Boot order + `app.boot` stage events; invalid `inhibitions.yaml` / `coupling.yaml` / config abort startup at the named stage.
- [ ] CLI: each verb dispatches; unbuilt verbs print the stage message and exit nonzero; `status` renders from real stores on the hermetic preset.
- [ ] `thead` shutdown: stops bridge poll, drains in-flight turn, closes stores — no dangling writes (TestClock-verified).

## Test checklist
- unit: config validation table; secret-shape detector (token/key-shaped strings in yaml); CLI dispatch table.
- integration: golden-turn (the crown test, in `test/golden-turn.e2e.test.ts`); crash-replay matrix (`test/crash-replay.e2e.test.ts`); interruption carry-over; afterturn isolation; boot-order failure injection at each stage.
- fixtures needed: a golden-turn script (MockModel decision + expected DeliveryPlan + expected episode/affect deltas); fault-injection points enumerated over the pipeline; a full hermetic config + a secret-contaminated variant.

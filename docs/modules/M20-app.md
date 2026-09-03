---
module: M20
name: app
syncedTo: v6-W1 (2026-09-03 — src/app + test/app as of P-CLOSE: signal-once shutdown, unhandled-rejection incident, loss termination (grace/moved-on/operator) + window pending, stderr egress + alert unit, doctor/ack verbs; see "As built (P-CLOSE)" at the end)
stage: S5
depends: [M01-kernel, M02-events, M03-model, M04-embed, M05-affect, M06-coupling, M07-corpus, M08-derive, M09-memory, M10-consolidate, M11-assemble, M12-inhibit, M13-loop, M14-realize, M15-bridge, M16-sched, M17-life, M18-siblings, M19-probes]
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

## As built (S5★, landed 2026-09-02)

src/app: config.ts, compose.ts, pipeline.ts, embedder.ts, thead.ts, cli.ts, index.ts, main.ts. Suite: test/app (helpers + 5 files) — compose/hermetic boot, pipeline behavior (interruption skip + abort paths, afterturn isolation, packet.record turnId, denied chat, reaction-only), golden-turn e2e, crash-replay e2e (both crash windows), CLI. **1456 tests, five gates green.** Deviations and decisions worth knowing:

1. **Embedder interim: `hash`, not `fastembed`** — kind `fastembed` composes a loud `app/not-built` failure naming S9; `thea2.config.yaml` ships `hash` with a DEVIATION comment. Rebuild var/cache/corpus when switching (embeddings are not compatible across embedders).
2. **Canon is NOT var-redirected.** `corpus/canon` + root `coupling.yaml` resolve from process cwd — identity is not state, and a test's tmp varDir must never shadow it.
3. **`app.boot` emissions are awaited.** Fire-and-forget emits raced the test's first read of the trail (boot looked truncated at 'stores'); each stage's emit is now part of the boot sequence, so the trail is deterministic.
4. **`turnId` is minted once, by the pipeline.** `LoopEntry`/`LoopQuery` forward it through `runLoop` (M13 Build deltas) so `packet.record` and the decision carry the same id — M10's credit match key.
5. **Interruption carry-over uses ONLY existing ledger laws**: the interrupted row becomes `defer` with `dueBy = now + reconcileWindowMs` (strictly future → clean while the carry turn may still land, LOST_REPLY if none ever does); the carry turn calls `ledger.linkTurn` re-pointing the interrupted inbound at itself; links are last-wins in file order. No new reconcile machinery.
6. **Denied chats are dropped BEFORE ingest** (in thead's poll, ahead of `ingestUpdates`) — no ledger row, so no eternal alarm; the pipeline-side allowlist check stays as belt-and-braces.
7. **SessionWindow persists are serialized** (src/memory/window.ts). Windows-law: concurrent atomic writes to the same file EPERM on rename; the unawaited `window.push` persists raced each other on Windows (affect-store pattern applied).
8. **Probe bridge casts.** probes' Vec12/Episode mirrors are structural; `probeTarget().state()` bridges with `Array.from(signature(...))` and `as never[]` — S8 aligns the types for real.
9. **One shared SessionWindow instance** across pipeline + System — a second open over the same dir held a divergent in-memory copy (caught in review of the first compose draft).
10. **`resolveLoopConfig({ turnTokenBudget })` only** — `budgetMs` stays at the wall-clock defaults; the packet token budget is honored in the assemble config.

## As built (Phase 1)

- **Heartbeat-outcome hook (pipeline.ts).** `Pipeline.selfEntry` returns `{turnId, sent: Promise<number>}`; every turn exit settles exactly once — in-loop silent/defer ⇒ 0, abort-with-carry ⇒ 0, a throwing turn ⇒ 0 (in pump's catch, so the awaiting job never hangs), a realized reply ⇒ `report.sent.length`. M17's heartbeat counts only real deliveries.
- **Maintenance jobs are tested** (test/app/maintenance-jobs.test.ts — the file had zero tests): rerun-once-per-process inside the 60-min grace, alarm-only past grace, the busy-defer taken on the next pass, the ledger link that makes a later reconcile clean (real ledger), and both loud-failure shapes.
- **Timezone config pinned** (test/app/config.test.ts): `timezone` defaults to UTC, an unknown IANA zone is rejected, a wrapping quietHours window is accepted, equal endpoints are rejected.

## As built (Round 3, 2026-09-02 afternoon)

compose.ts closes the learning loop and the social frame; every wire below has a named test:

- **Lived/proposals live in var/** — the consolidators write `var/lived` + `var/proposals`, the corpus index SELECTS from `var/lived` (was `corpus/lived`: the sandbox was right, runtime state never belonged in the repo tree). `install.sh`'s corpus excludes are thereby moot-but-harmless; `var/` was always excluded.
- **The flywheel closes on consolidation**: `onConsolidated` (M10's new hook) reloads the corpus index and writes the projections (`var/journal.md`, `var/threads.json`) — no restart, and a rejecting hook fails the run loudly AFTER outputs are durable.
- **Standing intent is real**: `openPersistedThreadIndex(var/memory)` is folded by the afterturn (each appraisal's `threads[]`, `incident.thread_fold_failed` on throw), the heartbeat's `dueThreads` comes from `dueThreadNotes` (6 h due window, cap 3), and ponder files her `next` as the `ponder` thread (one id by design — a new ponder re-arms it).
- **Register is inferred, not constant** (src/app/register.ts): strong lexical cues (code fences, links, versions, stacktraces) or two weak ones pick `work` — bounded by HIS clock (machine talk outside 08:00–21:00 Madrid stays `play`); explicit friend cues win. `mode_exclusive` still enforces; quota `strict:false` (Round 2) is the relaxation lever.
- **People registry v1** (config `people:`): the `[INTERLOCUTOR]` line carries his NAME instead of `tg:<id>`.
- **[IDENTITY] renders body-only** (`identityBody`): frontmatter and the author's draft note never ship in the packet.
- **Credit is live**: the corpus nominator reads `var/credit/weights.json` (mtime-cached; missing file = neutral) — the γ term finally moves selection.
- **Dominance home is config-backed** (ADR-004a): `setDominanceBaseline` runs at boot before any state read; default 0.0 (zero change) until Diego sets the value.
- **gravityWeek counts from first boot**: `var/first-boot` (epoch-ms stamp, written once) feeds `gravityWeekOf` — the not-integrating alarm starts at week zero, not week 2957.
- **The Ledger is registered** — six jobs on a real boot. Nightingale stays unregistered (Phase 4 gates it); its ProbeRunner seat is a loud `probes/not-built` refusal that nothing wired can invoke.

## As built (P-CLOSE, v6-W1, 2026-09-03)

- **SIGTERM drains once (CL.1).** main.ts registered TWO SIGINT/SIGTERM pairs (the drain pair plus an anonymous duplicate from the wedge fix); the duplicate is deleted and `disposeMainProcessHandlers` removes the ONLY pair — one signal, one drain, zero listeners after dispose (test: `sigterm-drains-once`).
- **An unhandled rejection is an incident (CL.5).** The handler emits `incident.unhandled_rejection {error}` and exits 1 — swallowing was the 2026-09-02 wedge class. The incident rides the system's OWN L0 when a thead is composed (`TheadHandle` now carries `events` — a second opener beside it would fork the seq counter, the derive/thead lesson); with nothing composed, main opens a fallback log at `var/events`, which is then this process's only one. Test: `an unhandled rejection is an incident`.
- **Recovery terminates every loss (CL.2/CL.3, maintenance-jobs.ts).** `recoverLost(deps, discrepancies, now)` orders the law: alarm first (ladder-backed via M15), then — already re-run ⇒ skip (stays owed; the 1h/6h/24h ladder speaks for it); `ageMs ≥ graceMs` (60 min, D.6-6) ⇒ terminal `abandon('grace')`; pipeline busy ⇒ defer to the next pass; a newer inbound/outbound on the same chat (`ledger.chatMovedOn`) ⇒ terminal `abandon('moved-on')` and the text is pushed into the window's PENDING span so `[EARLIER]` carries what was never answered; else the once-per-process rerun. `owedInbound` (compose) therefore never counts an abandoned loss — the heartbeat is never `owed`-gated by a closed loss. Tests: `rerun-skips-when-conversation-moved-on`, `abandoned-loss-is-not-owed`.
- **Egress (CL.6).** compose wraps the prod L0 with `withStderrMirror`: `incident.*`, `bridge.lost_reply`, `sched.alarm` each mirror ONE stderr line prefixed `<3>` (the syslog error priority systemd reads — `journalctl -u thea2 -p err` works with zero journald config). `deploy/thea2-alert.service` (new) is the `OnFailure=` of thea2.service: one curl Telegram DM `[ops] thea2 failed: <unit>` to `THEA2_OPS_CHAT_ID` (= bridge.allowedChatIds[0], provisioned in keys.env beside THEA2_BOT_TOKEN). Test: `incident mirror writes one stderr line`.
- **New CLI verbs.** `thea2 doctor` (read-only: opens var/ WITHOUT compose — no mkdir, no emit, no lock; prints uptime from the newest `app.boot{bridge}` event + the pid lock, last-24 h incident counts, open losses via the pure `reconcileLedgerRows`, and the last backup age from /var/backups/thea2) and `thea2 ack <updateId>` (writes the operator abandon straight to the ledger — no model, no corpus, no network; closing a loss must not need a boot). Tests: `doctor opens no writer` (byte-identical var/ tree), `ack writes an abandoned row`.

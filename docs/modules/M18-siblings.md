---
module: M18
name: siblings
syncedTo: S8 (implemented — src/siblings + test/siblings, 100 tests; ledger zero-state fix landed with the suite)
stage: S8
depends: [M01-kernel, M02-events, M03-model, M16-sched, M19-probes]
---
# M18 — siblings

## Responsibility
The two surviving siblings from Thea1's ten-bot chorus — **Ledger** (cost/routing observability + routing proposals under guardrails) and **Nightingale** (the behavioral immune system that runs probes after any change) — demoted from bots to **scheduler jobs with small persona seed files**: no bridges, no tokens, no inboxes. Everything else from Thea1's sibling fleet is retired. Thea1's lesson stands behind this module: sibling bots with their own bridges became 8 more surfaces that could silently fail; jobs on the one scheduler with events to L0 cannot.

## Interfaces (contract)
```ts
export const ledgerJob: (deps: SiblingDeps) => Job;        // daily + on-demand (`thea2 status --ledger`)
export const nightingaleJob: (deps: SiblingDeps) => Job;   // deploy-marker watcher, 1 min, catchUp: 'skip'

export interface SiblingDeps {
  model: ModelClient; events: EventLog; sched: { statePath: string };
  probes: ProbeRunner;                    // M19
  baselinePath: string;                   // probes/baseline.json
  deployMarkerPath: string;               // var/deploy-marker (hash of code version + routing.json + inhibitions.yaml + coupling.yaml)
  routingPath: string;                    // var/routing.json — Ledger may WRITE proposals here
  reportsDir: string;                     // var/reports/
  clock: Clock; rng: Rng;
}

export interface LedgerAggregate { taskClass: TaskClass; calls: number; inputTokens: number;
  outputTokens: number; costUsd: number; latencyP50Ms: number; latencyP95Ms: number; parseFailures: number }
export const aggregateModelCalls: (evs: EventEnvelope[]) => LedgerAggregate[];   // pure

export interface RoutingProposal { taskClass: TaskClass; from: Tier; to: Tier; reason: string }
export const proposeRouting: (aggs: LedgerAggregate[], current: RoutingTable) => RoutingProposal[]; // pure, guardrailed
```

## Behavior spec
- **Ledger** (daily + on-demand): replays `model.call` events from L0 → per-taskClass cost/latency/token aggregates (pure fn, golden-testable) → renders `var/reports/ledger-<date>.md` in a persona-seeded voice (cheap tier; the seed file is a short markdown persona, not a bot). The report is where operational truths surface: lost-reply counts (from `bridge.lost_reply`), chronic gate rejections, `sched.alarm`s, gravity alarms, incident counts — **a chronically over-triggering inhibition rule surfaces here within a day, not a month** (the M12 contract's other half).
- **Routing proposals, guardrailed** (§5.6): from the aggregates, Ledger may propose tier downgrades for non-user-facing task classes only (`summarize`, `consolidate`, `derive`…). **`turn` is pinned to main tier in code** — a proposal touching `turn` (or any user-facing class) is refused at proposal time and logged, never written. Accepted proposals are written to `var/routing.json` (the file M03's router reads), and **any applied routing change counts as a deploy ⇒ bumps the deploy marker ⇒ Nightingale runs** — a cost save that degrades the character gets caught by the immune system, not by Diego's ears.
- **Nightingale** (trigger: deploy-marker change, watched every 1 min `catchUp: 'skip'`; or manual `thea2 probe run`): the deploy marker is a content hash over {code version, `var/routing.json`, `corpus/canon/inhibitions.yaml`, `coupling.yaml`, corpus hash} — **a routing change is a change; so is an inhibition or coupling edit** (exactly the configs that can silently alter behavior). On trigger: run the live probe suite via M19's runner (k=3, median-aggregated), compare against `probes/baseline.json`, write `var/reports/nightingale-<ts>.md` + alarm events:
  - any deterministic probe failure ⇒ **red** (alarm);
  - judge median drop > **0.8** ⇒ **red**;
  - drift cosine drop > **0.05** ⇒ **yellow** (watch).
  - On green: recommit `probes/baseline.json` (the new normal). On red: baseline unchanged, alarm event, report names the regressing probes + the marker diff (what changed to cause this).
- Both jobs emit `sibling.*` events to L0 (`sibling.ledger_report`, `sibling.nightingale_red`, `sibling.baseline_recommitted`, `sibling.routing_refused`). Failure of either job is loud (M16's alarm path) — a dead immune system is worse than none.
- **Persona seeds** are 10-line markdown files (`personas/*.md`) — voice for reports only. They never receive inbound messages, hold no state, and are rendered by the same M03 door as everything else (cheap tier).
- The other eight Thea1 sibling bots are **retired, not ported** — no bridge, no token, no code. If a future need emerges, it becomes a job here or it doesn't exist.

## Not this module's job
- Probe definitions, runner mechanics, drift metric — M19-probes (M18 triggers and gates; M19 executes).
- Enforcing routing at call time — M03-model's router (reads the file; the guardrail lives in BOTH: M03 refuses `turn` downgrades at resolve time, M18 refuses proposing them).
- Aggregating anything but `model.call` (delivery/bridge health lands in the report via `bridge.*`/`sched.*` events, but the aggregate fn is model-call-specific).
- Scheduling — M16 (M18 supplies job bodies).
- Writing `var/routing.json` values by hand — the file is Ledger-proposal-written or human-edited, never agent-tuned ad hoc.

## Acceptance criteria
- [ ] `aggregateModelCalls` golden: a replayed mixed event fixture (5 taskClasses, retries, parse failures) yields exact aggregate values incl. p50/p95 and failure counts.
- [ ] Report renders from the replayed fixture with all operational truths present: lost replies, gate rejections, alarms, gravity, incidents (snapshot test).
- [ ] `proposeRouting` guardrail: a proposal targeting `turn` is refused + `sibling.routing_refused`; downgrading `summarize` on strong evidence is produced with a reason string.
- [ ] Applied routing change bumps the deploy marker ⇒ Nightingale fires within one watcher tick (TestClock).
- [ ] Nightingale gates: scripted probe results — deterministic fail ⇒ red; judge median drop 0.9 ⇒ red; drop 0.5 ⇒ green; drift drop 0.06 ⇒ yellow; drop 0.04 ⇒ green (truth table over the exact thresholds 0.8 / 0.05).
- [ ] Green run recommits `baseline.json`; red run leaves it byte-identical and the report names the regressing probes + the marker diff.
- [ ] Persona seed renders a report in-voice with cheap-tier calls only (call-log assertion); seed file edit does not itself trigger Nightingale (not in the marker).
- [ ] Both jobs fail loud: a throwing runner surfaces as `sched.alarm` (M16 isolation contract, asserted through the sibling bodies).

## Test checklist
- unit: aggregate goldens (incl. retry/attempt math and parse-failure counting); routing proposal guardrail table (all 9 taskClasses × propose/refuse); deploy-marker hash stability (order-independent inputs, sensitive to each input file).
- component: TestClock-driven marker watcher → Nightingale cycle; green/red/yellow report snapshots; baseline recommit vs preserve; ledger-report end-to-end from a replayed event fixture.
- fixtures needed: a mixed `model.call` event fixture day; scripted ProbeRunner results across the gate truth table; marker input file variants; a routing.json before/after pair.

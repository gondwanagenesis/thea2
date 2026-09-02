---
module: M19
name: probes
syncedTo: S8 (built — src/probes, test/probes; 83 tests green)
stage: S8
depends: [M01-kernel, M02-events, M03-model, M04-embed, M05-affect, M07-corpus]
---
# M19 — probes

## Responsibility
The behavioral probe suite: probe definitions (YAML), the sandbox harness, the three evaluator classes (deterministic / judge / drift), and the baseline+gate machinery that turns "does she still sound like herself" into numbers with thresholds. The honest split this module exists to enforce: **hermetic CI tests can never detect character drift** — with MockModel there is no character — so probes are the character layer, run live by Nightingale (M18) but designed, parsed, and dry-run right here in CI.

## Interfaces (contract, as built)
```ts
// Probe file shape: schemas/probe.ts is the reference; ProbeDefStrict (parse.ts)
// is the strict mirror that rejects unknown keys.

export interface ProbeRunner {
  run(probe: ProbeDef, opts: RunOptions): Promise<ProbeResult>;          // { k, dry? }
  runAll(opts: RunAllOptions): Promise<ProbeSuiteResult>;                // { k, dry?, ids?, baseline? }
}
export const openProbeRunner: (deps: {
  target: ProbeTarget | ((probe: ProbeDef) => ProbeTarget); // one target (live) or per-probe selector (dry)
  corpus: CorpusIndex; embedder: Embedder;   // reference exemplars + drift centroid embedding
  clock: Clock; rng: Rng; events: EventLog;
  model?: ModelClient;                       // required iff a run probe carries a judgeRubric → 'probes/no-judge-model'
  suite?: readonly ProbeDef[];               // the list runAll draws from; ids filter it
  fixtures?: ReadonlyMap<string, unknown>;   // episode-fixture store (loadProbeFixtures)
  readCanonFile?: (p: string) => string | undefined; // rubric anchor reader (identity.md is not an exemplar)
}) => ProbeRunner;

// The pipeline seam: M20's probe-harness preset provides this; M19 never imports app.
export interface ProbeTarget {
  inbound(m: InboundMsg): Promise<void>;     // feed scripted input
  quiesce(): Promise<void>;                  // resolve pending turns
  outbound(): Array<{ text: string; msgId: number }>;
  decision(): DecisionObject | null;
  state(): { affect: Vec12; episodes: Episode[] };
}

export interface ProbeResult {
  probeId: string; runs: Array<RunOutcome>;  // each run: index, outbound, decision?, affect, episodes, judge, driftCosine
  deterministic: CheckReport;                // all must pass (every run)
  judgeMedian: number | null;                // 1-5, reasoning-tier rubric; null in dry
  judgeVariance: number;                     // tracked, not gated
  drift: Record<string, number>;             // per-dimension cosine vs canon centroid; {} in dry
}
export interface ProbeSuiteResult {
  results: ProbeResult[];
  gate?: SuiteGateReport;                    // present iff a baseline was supplied
  modelCalls: number;                        // Σ k over rubric-bearing probes; 0 in dry
  dry: boolean;
}
```

Module surface (the barrel re-exports everything below except `render.ts`, which is the judge's internal prompt shaping):
- `parse.ts` — `parseProbeYaml`, `loadProbeSuite` (id-sorted + `errors[]`), `loadProbeFixtures`,
  `loadTranscripts`, `resolveProbe`, `ProbeDefStrict`, `ProbeTranscript`.
- `deterministic.ts` — `evaluateCheck`, `aggregateDeterministic` (pass ⇔ every run passes).
- `render.ts` / `judge.ts` — `renderTranscript`/`renderExemplar`/`anchorTextFor`; `runJudge`
  (one reasoning-tier chat per run, temperature 0, seedHint seed+i, schema-forced 1–5 axes).
- `drift.ts` — `centroidOf`, `referenceCentroid`, `replyCentroid`, `runDrift` (median cosine).
- `baseline.ts` — `loadBaseline`, `baselineEntryFor`, `writeBaseline`, `gateProbe`, `gateSuite`,
  `gateAgainstBaselineFile`, `BaselineEntry` (type re-export).
- `runner.ts` — `openProbeRunner`, `PROBE_CHAT_ID` (7000001), `recordedTargetFor` /
  `recordedTargetSelector` / `recordedTargetsFrom` (dry harness), `resultSummary`.
- `types.ts` — `ProbeTarget`, `RunOutcome`, `ProbeResult`, `ProbeSuiteResult`, gate types,
  `JUDGE_DROP_RED = 0.8`, `DRIFT_DROP_YELLOW = 0.05`, Vec12 mirror + `AFFECT_DIMS_ORDER`.
- `errors.ts` — `ProbeError` with one namespaced code per failure mode
  (`probes/yaml`, `probes/schema`, `probes/bad-regex`, `probes/reference-unresolved`,
  `probes/centroid-empty`, `probes/fixture-unresolved`, `probes/fixture-collision`,
  `probes/transcript-schema`, `probes/no-transcript`, `probes/unknown-probe`,
  `probes/target-shape`, `probes/no-judge-model`, `probes/baseline`).

## Behavior spec
- **The split, restated as law** (§2.9): CI (dry mode) verifies probes PARSE, the harness BOOTS, and deterministic evaluators execute over **recorded fixture transcripts** — catching probe rot with zero model spend. Live probes (real `ModelClient`, everything else fake) test the character, run by Nightingale after any deploy-marker change. The live harness is **FakeChannel + fixture stores + TestClock + seeded rng + real model — never live stores, never real Telegram**.
- **Only the model is nondeterministic**: each probe runs **k=3, median-aggregated**, and the variance itself is a tracked metric (a probe whose judge scores swing wildly is reporting model instability — surfaced in the report, not gated).
- **Three evaluator classes**:
  1. **Deterministic** — bubble count/length bounds; no JSON/internal leakage in outbound text (the L0-never-enters-prompts boundary, checked from the other side); inhibition compliance (forbidden-pattern absence); tool fired / didn't fire; decision fields in range. Must pass on **every** run, not the median.
  2. **Judge** — reasoning-tier grades 1–5 against the **canon anchor** (`identity.md`) + **2 reference exemplars** (pinned by id in the rubric; voice similarity, register fit), with a **pinned rubric version** recorded in the result — rubric changes are baseline-affecting changes.
  3. **Drift** — embed the probe replies (M04), cosine against the **canon voice-exemplar centroid**; one tracked scalar per behavioral dimension (the probe's `driftRef` names the dimension). Character drift as a number.
- **Baseline & gates** (M18 consumes, M19 computes): `probes/baseline.json` holds per-probe scores + drift centroids, committed after each accepted change. Gates: deterministic failure = **red**; judge median drop > **0.8** = **red**; drift cosine drop > **0.05** = **yellow**. Baseline recommit is part of an accepted change — a stale baseline is a red flag in review, not a gate to disable.
- **~25 probes at maturity**: 2–3 per behavioral dimension (voice, reasoning, emotional-range, social, boundaries, tool-use, knowledge, taste) + capability probes: planted-fact recall, warranted tool use, heartbeat scorer decisions on canned states. That last class is **hermetic and runs in CI proper** (MockModel-scored canned states) — machinery and character overlap exactly there, and the probe README names which probes are CI-dry-eligible vs Nightingale-live.
- **Probe rot is a build failure**: a probe that no longer parses, references a missing fixture/exemplar id, or whose dry evaluators fail over the recorded transcripts fails CI. Probes are code-adjacent artifacts with the same hygiene bar as tests — that's what keeps the immune system from quietly dying.
- The anti-escalation live probe (high-tension state ⇒ selected set's mean expressed aversion ≤ input's — the M06 property) is repeated here against the real model; the property test proves the machinery, this probe proves the behavior.
- Rubric/reference pins use exemplar **ids**, resolved through M07's index — a canon file move that breaks a pin fails dry-run, loudly.

## Deviations from the original spec (accepted at build)
- **`dry` is an explicit switch** on `RunOptions`/`RunAllOptions` (spec implied two modes; the split is now a flag so the same runner drives both) — dry stops after the deterministic class and zeroes `modelCalls`.
- **`deps.model` is optional** and typed as such; a rubric-bearing probe run without it is a typed `probes/no-judge-model` error, never a silent skip.
- **`deps.suite`** carries the defs `runAll` draws from (spec had no home for them); `ids` filters it, unknown ids are `probes/unknown-probe`.
- **`deps.fixtures` + `deps.readCanonFile`** are injected stores (episode fixtures; the identity.md anchor reader), keeping M19 free of M07 file-layout knowledge.
- **`target` accepts a selector function** `(probe) => ProbeTarget` so dry mode can hand each probe its recorded transcript; `recordedTargetsFrom(dir)` builds one from a transcript directory.
- **`ProbeSuiteResult.dry` / `.modelCalls` / `.gate`** added so callers (M18/M20) can report the honest split without re-deriving it; a `probe.completed` L0 event carries `{probeId, dimension, hermetic, dry, k, deterministicPass, judgeMedian, judgeVariance, drift}` per probe.
- **Structural mirrors, not imports** (S8 seam law): `InboundMsg` mirrors M15-bridge's message shape; `Episode` mirrors M09-memory's episode; `DecisionObject` validates against `schemas/decision.ts` (the reference, not a module import); `Vec12`/`AFFECT_DIMS_ORDER` mirror the M06 coupling space / M09 `affectAtEncoding`. No dependency edges into memory/loop/affect/coupling (depcruise-clean).

## Not this module's job
- Composing the probe-harness pipeline — M20-app (the `probe-harness` preset; M19 defines `ProbeTarget` and consumes an implementation).
- Deciding WHEN probes run — M18-siblings (marker watcher + `thea2 probe run`).
- Baseline policy (when to recommit) — review-time human discipline; M19 computes and writes, M18 gates.
- Unit-testing machinery — the regular suite (TESTING.md taxonomy); probes are for what MockModel cannot see.
- Fixing character drift — Nightingale reports it; the fix is canon strengthening (corpus/README's gravity rule) or a coupling edit, decided by a human.

## Acceptance criteria
- [x] All committed probe YAMLs parse + resolve (fixtures exist, reference exemplar ids resolve, drift dims valid) — `runner.test.ts` dry-runs the real `probes/` directory over `test/probes/fixtures` with a strict MockModel (any model call fails the test).
- [x] Deterministic evaluator truth table: each check type passes and fails on constructed fixtures (bubble bounds, leakage scan, forbidden-pattern, tool fired/didn't, decision-field range) — `deterministic.test.ts`.
- [x] Judge class: reasoning-tier call rendered with the pinned rubric + anchor + 2 references; 1–5 parsing; median over k=3; variance computed and recorded — `judge.test.ts` (MockModel scripting the structured-output ladder, including the one-shot repair and `model/parse-failed`).
- [x] Drift: centroid computed from the canon voice exemplars (M07 index + M04), reply embedding cosine exact on a FixedEmbedder fixture; per-dimension output shape — `drift.test.ts` (cosines exact to 12 digits; f32 storage pinned at 7).
- [ ] Harness hermeticity: a live probe run touches no network except the model client — enforced structurally (injected seams + the repo's lint law: no fetch/WebSocket in tests, no wall-clock/entropy outside the kernel), not by a runtime assertion; FakeChannel limits are M20's composition (M19's seam is `ProbeTarget`).
- [x] k=3 median + variance recorded on the ProbeResult; deterministic checks require all-runs pass (a 2/3 pass is a fail) — `deterministic.test.ts` + `math.test.ts` (seeded 200-trial median property).
- [x] Baseline compare: gate boundaries exact (0.8 / 0.05) — boundary-value table in `baseline.test.ts`, pinned on IEEE-754-exact values (1.0−0.2 green, 4.2−3.4 red, 0.35−0.3 green, 1.0−0.95 yellow).
- [x] The heartbeat-scorer CI probe runs hermetically in CI (MockModel, no live model) and in the live suite unchanged — `life-heartbeat-threshold` runs dry in `runner.test.ts` over its recorded transcript.

## Test map (83 tests, `npx vitest run test/probes`)
- `math.test.ts` (7) — median odd/even/empty, seeded permutation property, population variance.
- `parse.test.ts` (16) — YAML/schema reject table with exact codes (unknown key at every depth, bad vocab, bad regex, thin rubric), suite ordering/duplicates, fixture collision, sparse-affect transcript materialization, real-corpus resolution of all committed probes.
- `deterministic.test.ts` (12) — per-check truth table + aggregation (2/3 pass = fail, perRun evidence).
- `judge.test.ts` (10) — call shape (taskClass/tier/temperature/seedHint/schemaName), prompt order (references before transcript, Diego:/Thea: labels), mean/median/variance, repair ladder, out-of-range → `model/parse-failed`.
- `drift.test.ts` (11) — centroid geometry exact under FixedEmbedder, canon-only filter at the index seam, multi-bubble centroid, median over runs, embed batching order.
- `baseline.test.ts` (14) — three gate rules + boundary table, red>yellow, null-silence, suite worst-verdict, baseline load/write/versioning, disk round-trip.
- `runner.test.ts` (13) — dry boot with strict MockModel (zero calls), deterministic rot reddens, `probes/no-transcript`, recorded targets off disk + msgId base, scripted feed on the injected clock (waitUntil dues), heartbeat feeds nothing, `probes/target-shape`, `probes/no-judge-model`, live judge+drift accounting, runAll selection + gating, and the real `probes/` directory end-to-end dry.

## As built (S8, 2026-09-02) — live-run traps, paid for
- **The allowlist wall**: the runner stamps scripted inbound with `PROBE_CHAT_ID`
  (7000001), and the REAL pipeline `chat_denies` any chat outside
  `bridge.allowedChatIds` (M20's composition). A live run against a composed
  system therefore feeds a wall — turns never execute, `outbound()` reads empty,
  the judge grades "(Thea did not reply)" at 1.00 and every deterministic count
  reads 0. Hermetic tests never see it (their targets are fakes that bypass the
  pipeline). Live scratch law: `cfg.bridge.allowedChatIds = [PROBE_CHAT_ID]`.
- **k-run independence**: the runner calls the target selector once per executed
  run, but a composed system ACCUMULATES (channel history, episodes, ledger). A
  shared live target turned k=3 into one growing transcript — bubble counts
  5→10→15, and by run 3 she had noticed the replays in her own memory ("you've
  now told me that twice"). Baseline of record requires a fresh system per run
  (the scratch pre-composes k×probes systems and pops one per call).
- **bubbleCount 1..4 → 1..5** (`voice-cold-open`): the live healthy run is 5
  tight bubbles (judge median 5.00, variance 0.099); the cap was calibrated to
  the evidence, intent unchanged (she does not lecture — and 5 short ones didn't).
- Judge `maxTokens` follows the M03 starvation family (512 → 4000, see M03).

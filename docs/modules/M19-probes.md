---
module: M19
name: probes
syncedTo: spec-v1 (no code yet)
stage: S8
depends: [M01-kernel, M02-events, M03-model, M04-embed, M07-corpus]
---
# M19 — probes

## Responsibility
The behavioral probe suite: probe definitions (YAML), the sandbox harness, the three evaluator classes (deterministic / judge / drift), and the baseline+gate machinery that turns "does she still sound like herself" into numbers with thresholds. The honest split this module exists to enforce: **hermetic CI tests can never detect character drift** — with MockModel there is no character — so probes are the character layer, run live by Nightingale (M18) but designed, parsed, and dry-run right here in CI.

## Interfaces (contract)
```ts
// Probe file shape: schemas/probe.ts is the reference until S8 migration.
// { id, entry: {scripted inbound sequence | heartbeat | ponder},
//   fixtures: {affect state, episode set, window}, seed,
//   expect: {deterministic checks, judgeRubric?, driftRef?} }

export interface ProbeRunner {
  run(probe: ProbeDef, opts: { k: number }): Promise<ProbeResult>;
  runAll(opts: { k: number; ids?: string[] }): Promise<ProbeSuiteResult>;
}
export const openProbeRunner: (deps: {
  target: ProbeTarget;                       // injected turn pipeline (probe-harness composition, M20)
  corpus: CorpusIndex; embedder: Embedder;   // reference exemplars + drift centroid embedding
  clock: Clock; rng: Rng; events: EventLog;
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
  probeId: string; runs: Array<RunOutcome>;  // k=3
  deterministic: CheckReport;                // all must pass (every run)
  judgeMedian: number | null;                // 1-5, reasoning-tier rubric
  judgeVariance: number;                     // tracked, not gated
  drift: Record<string, number>;             // per-dimension cosine vs canon centroid
}
```

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

## Not this module's job
- Composing the probe-harness pipeline — M20-app (the `probe-harness` preset; M19 defines `ProbeTarget` and consumes an implementation).
- Deciding WHEN probes run — M18-siblings (marker watcher + `thea2 probe run`).
- Baseline policy (when to recommit) — review-time human discipline; M19 computes and writes, M18 gates.
- Unit-testing machinery — the regular suite (TESTING.md taxonomy); probes are for what MockModel cannot see.
- Fixing character drift — Nightingale reports it; the fix is canon strengthening (corpus/README's gravity rule) or a coupling edit, decided by a human.

## Acceptance criteria
- [ ] All committed probe YAMLs parse + resolve (fixtures exist, reference exemplar ids resolve, drift dims valid) — the dry-run CI test over the real `probes/` directory.
- [ ] Deterministic evaluator truth table: each check type passes and fails on constructed fixtures (bubble bounds, leakage scan, forbidden-pattern, tool fired/didn't, decision-field range).
- [ ] Judge class: reasoning-tier call rendered with the pinned rubric + anchor + 2 references; 1–5 parsing; median over k=3; variance computed and recorded.
- [ ] Drift: centroid computed from the canon voice exemplars (M07 index + M04), reply embedding cosine exact on a FixedEmbedder fixture; per-dimension output shape.
- [ ] Harness hermeticity: a live probe run touches no network except the model client, no `var/` outside injected temp dirs (asserted), FakeChannel limits enforced.
- [ ] k=3 median + variance recorded on the ProbeResult; deterministic checks require all-runs pass (a 2/3 pass is a fail).
- [ ] Baseline compare: gate boundaries exact (0.8 / 0.05) — boundary-value fixture table.
- [ ] The heartbeat-scorer CI probe runs hermetically in CI (MockModel, no live model) and in the live suite unchanged.

## Test checklist
- unit: YAML → ProbeDef parse/reject table; evaluator unit tables per check type; median/variance math; gate boundary table.
- component: dry-run over recorded transcripts (the CI probe-rot net); live-probe smoke against MockModel as the "real" client (proves the seam works without spend); centroid + drift geometry with FixedEmbedder; baseline write/compare cycle.
- fixtures needed: recorded fixture transcripts per probe class; a mini corpus with pinned reference exemplar ids; FixedEmbedder geometry for drift; baseline.json variants (fresh, stale, boundary).

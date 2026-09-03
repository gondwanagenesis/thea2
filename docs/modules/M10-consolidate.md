---
module: M10
name: consolidate
syncedTo: S8 round 2 (2026-09-02 — outputs moved to var/, onConsolidated reload hook; see "As built" at the end)
stage: S8
depends: [M01-kernel, M02-events, M03-model, M04-embed, M05-affect, M07-corpus, M09-memory]
---
# M10 — consolidate

## Responsibility
The slow flywheel that lets lived experience compound without drowning the character: nightly L2 consolidators (preference crystallization, behavioral regularities, affect patterns → lived pattern exemplars), weekly L3 (dispositions, relationship baseline, identity exemplars, and **canon-promotion proposals only** — `var/proposals/`, human merges via `thea2 proposals:export`), the credit-assignment updater that nudges exemplar selection weights from real outcomes, and the seed-gravity metrics with their drift alarms (unmoored / not-integrating / tunnel vision).

## Interfaces (contract)
```ts
export const consolidateNightly: (deps: ConsolidateDeps) => Promise<void>;  // L2
export const consolidateWeekly: (deps: ConsolidateDeps) => Promise<void>;   // L3
export interface ConsolidateDeps {
  model: ModelClient; episodes: EpisodeStore; corpus: CorpusIndex;
  affectHistory: EventLog; creditPath: string; events: EventLog;
  clock: Clock; rng: Rng; cfg: ConsolidateConfig;
  // round 2: invoked once per completed run, AFTER outputs are durable and the
  // `consolidate.run` row is on L0. Compose wires `(report) => corpus.reload()`
  // so the running index sees new lived/proposal files without a restart.
  // Undefined by default (= pre-round-2 behavior); a rejection propagates (M16 counts it).
  onConsolidated?: (report: ConsolidateReport) => Promise<void>;
}

// ---- credit assignment (§2.1) ----
export interface CreditWeights { [exemplarId: string]: number }  // clamp [0.5, 2.0], default 1.0 when absent
export const applyOutcome: (w: CreditWeights, packet: PacketRecord, outcome: { sign: -1|0|1 },
  affectAtTurn: Vec12) => CreditWeights;   // pure
export const decayWeights: (w: CreditWeights) => CreditWeights;  // pure; nightly
export const CREDIT_ETA = 0.02;
export const CREDIT_CLAMP: [number, number] = [0.5, 2.0];
export const NIGHTLY_DECAY = 0.995;
export const MOOD_GUARD = 0.5;         // applied when ‖a_aversive‖ > 0.5
export const SLOT_SHARE = { episode: 1.0, pattern: 1.0, disposition: 0.5, memory: 1.0, contrast: 0.0 };

// ---- gravity metrics (§2.4) ----
export const seedRatio: (packets: PacketRecord[], tier: 'pattern' | 'episode') => number;
export const dimensionCoverage: (packets: PacketRecord[]) => Record<string, number>;
export const gravityAlarms: (metrics: {...}) => Array<'unmoored' | 'not-integrating' | 'tunnel-vision'>;
```

## Behavior spec
- **L2 (nightly, `catchUp: 'once'`)**: replay the day's episodes + affect history; crystallize preferences and behavioral regularities and affect patterns into **pattern exemplars written to `var/lived/`** (runtime state under the injected var dir — round 2) — each stamped with full `encodedAffect` (from the episodes' `affectAtEncoding`), `episodeIds` provenance, and an honest `outcome` tag. Lived files validate under the lived schema (M07 lint is the gate — a consolidator output that can't parse is a bug, caught at write time). Generation uses cheap/consolidate tier with the judge rubric lightened to schema + faithfulness-to-episodes (these are HER memories, not creative writing).
- **L3 (weekly, `catchUp: 'once'`)**: dispositions, relationship baseline doc, identity exemplars — and **canon-promotion proposals go to `var/proposals/` ONLY**. The consolidator never writes canon (AGENTS.md rule 8; ADR-006's corollary). Proposals are clearly marked; merging is a human act, and `thea2 proposals:export <dir>` copies the var/proposals tree out for that review (round 2).
- **Credit assignment** (§2.1) — the exact mechanism, constants load-bearing:
  - Every packet already emitted its `PacketRecord` (M11) to L0. The NEXT turn's appraisal grades it (`outcomePrev.sign ∈ {−1,0,+1}`, factual evidence only — M09).
  - Nightly batch: for each outcome, per slot: `w ← clamp(w + η·sign·slotShare·moodGuard, 0.5, 2.0)`, η = 0.02. slotShare: episode/pattern/memory 1.0, disposition 0.5 (always-similar → low information), **contrast slot credited on +1 only** (exploration is never punished).
  - `moodGuard = 0.5` when the turn ran under high-aversion affect (‖a_aversive‖ > 0.5) — bad moods must not starve the corrective exemplars selected during them.
  - Nightly decay toward neutral: `w ← 1 + (w−1)·0.995`.
  - Consumption happens in M11 as the additive γ = 0.15 term — **weight biases ties, never overrides relevance**. M10 owns the values; M11 owns the application; the clamp bounds are shared constants (defined here, imported there).
  - Weights persist at `var/credit/weights.json` (kernel atomic write). A missing file = all-default 1.0 (launch state). Credit never touches M, quotas, or canon (§2.1 non-goals).
  - Stated failure modes, accepted: credit smearing (5 items share credit for 1 cause — small η + decay means only *consistent* co-occurrence accumulates); mood confound (mitigated, not eliminated); rich-get-richer (clamped, γ-biased, contrast slot guaranteed); appraiser self-grading (factual-evidence-only rubric + verbatim evidence audit); reaction sparsity (w moves glacially — the safe direction).
- **Gravity metrics** (§2.4): definitions pinned — **seed = canon + derived; lived competes with seed in pattern and episode tiers only; the disposition slot is canon-reserved, permanently** (ADR-005/006). Rolling 50-packet `seedRatio` per tier + dimension coverage, written into the nightly `var/reports/status.md` projection and emitted as a `consolidate.gravity` event. Alarms (evaluated nightly, surfaced by Nightingale reports):
  - `seedRatio < 0.25` ⇒ **unmoored** (character floating from canon);
  - `seedRatio > 0.90` after week 6 ⇒ **not-integrating** (lived never selected — consolidators underproducing);
  - dimension-coverage flatline (>70% of disposition slots from one behavioral dimension over 7 days) ⇒ **tunnel vision**.
  - Cross-check rule: if seedRatio is healthy but the probe drift cosine (M19) falls, the problem is derived quality, not gravity — the status projection states both numbers side by side so the reader doesn't have to know the rule.
- Every consolidator run emits `consolidate.run` (kind, counts, durations) to L0; alarm evaluations emit `consolidate.alarm`.
- **Prod safety**: consolidators write only into `var/lived/` and `var/proposals/` (plus `var/credit/` and `var/reports/`) — never `canon/`, never `derived/` (that's M08's), and never anywhere in `corpus/` (round 2: lived + proposals are machine-written runtime state, so they live under `var/` like every other store; the corpus tree is code-reviewed content only).

## Not this module's job
- Producing outcome grades — M09's appraisal (`outcomePrev`); M10 only consumes them from L0.
- Applying weights during selection — M11-assemble (additive γ term).
- Deriving coverage — M08-derive (different corpus population, different lifecycle).
- Scheduling — M16-sched; wiring — M20-app.
- Probe drift metric — M19-probes (M10's status projection cites it; it does not compute it).

## Acceptance criteria
- [ ] Credit property suite: clamp bounds hold under adversarial outcome sequences; η math exact on golden cases; contrast slot moves on +1 only; disposition slot at 0.5 share; moodGuard engages exactly above the ‖a_aversive‖ threshold.
- [ ] Nightly decay converges: repeated decay on w=2.0 trends toward 1.0 and never below/above clamp.
- [ ] Weights persistence: missing file ⇒ defaults; corrupt file ⇒ startup incident + rebuild from L0 outcome events replay (L0 is the recovery path, same as M05).
- [ ] L2 outputs: generated lived files parse + validate under the lived schema (M07), carry full 12-dim `encodedAffect`, episodeIds, outcome — over a fixture episode week with MockModel.
- [x] L3 proposals land in `var/proposals/` and NOWHERE else (path assertion); canon dir byte-identical after a weekly run.
- [ ] `seedRatio` matches hand-computed values on fixture packet sets; alarm truth table: unmoored / not-integrating (week-gated) / tunnel-vision each fire and each stay silent on their healthy counterparts.
- [ ] Status projection contains seedRatio, dimension coverage, drift cosine (injected), and the alarms — snapshot test.

## Test checklist
- unit: credit math goldens + property suite (clamp, decay, moodGuard, slotShare matrix); seedRatio/dimensionCoverage math; alarm threshold table incl. the week-6 gate.
- component: MockModel nightly L2 over a fixture episode week (outputs validated by M07's parser); weekly L3 path assertions; weights corrupt→replay recovery; status projection snapshot.
- fixtures needed: a fixture week of episodes + PacketRecords + outcomePrev events; constructed Vec12 states around the moodGuard threshold; a canned drift-cosine injector for the projection.

## As built (S7, landed 2026-09-01)

src/consolidate: cluster.ts, credit.ts, draft.ts, errors.ts, gravity.ts, run.ts, state.ts, types.ts + corpus/nominator.ts. Suite: test/consolidate (6 files incl. helpers) + test/corpus/nominator.test.ts. All acceptance criteria above are covered; five integration fixes landed with the module, each now pinned by a named test:

1. **Placeholder id gate** — `validateLived` stamps the real content id BEFORE `analyzeFile`; the gate was validating its own placeholder render, which can never satisfy id == masked hash. A declared non-placeholder id is validated as-is, so tampering still fails the gate (draft.ts).
2. **Outcome dedupe** — the same grade reaches L0 through memory's `outcome.prev` and the bridge's own emission; `replayL0` dedupes outcome rows per turnId keep-last so the credit pass grades a turn once (run.ts).
3. **No false PROPOSAL marker** — lived + complete provenance carries no proposal note; only genuine proposal destinations and provenance gaps are marked (run.ts `proposalReasonFor`).
4. **Rolling window order** — `lastNPackets` is newest-first (ts, turnId desc); gravity reports over the presentation order (gravity.ts).
5. **Repair keeps the seed** — M03's structured-ladder repair re-ask carries `seedHint`, so the same store + seed still yields the same bytes through a repaired draft (model/client.ts; reproducibility law).

Deliberate deviation: lived filenames strip the `sha256:` prefix (`fileBaseName`) — `:` is an NTFS alternate-data-stream separator and breaks git-on-Windows; the full id stays in the file's `id:` line and the manifest. L3 proposals keep the full key in notes; both manifest entries carry exact ids.

## As built — round 2 (2026-09-02, remediation package F)

1. **Outputs are runtime state.** The consolidators now write lived scenes to `var/lived/` and proposals to `var/proposals/` (both under the injected var dir), instead of `corpus/lived/` + `corpus/proposals/`. Everything else — manifests per directory, idempotence keys, judge gates, `consolidate.run`/`consolidate.gravity`/`consolidate.alarm` events, the `var/reports/status.md` projection, credit weights at `var/credit/weights.json` — is unchanged. Named tests: `lived and proposals are written under var/, and corpus/ never grows` + the whole suite's dir fixtures (test/consolidate/run.test.ts, helpers.ts). `validateLived` still validates under a synthetic `var/lived/…` path (draft.ts).
2. **`thea2 proposals:export <dir>`** (src/consolidate/export.ts + src/app/cli.ts): a byte-exact, sorted copy of var/proposals (+ manifest.json) into a review directory. Missing source = typed `consolidate/bad-config` and a nonzero exit; an empty dir copies nothing, honestly. Tested hermetically in test/consolidate/export.test.ts (including the verb's argument seam, `firstPositional`).
3. **`onConsolidated` hook** (ConsolidateDeps, optional): invoked once per completed run — nightly or weekly — AFTER the outputs are durable and the `consolidate.run` row is on L0, with the finished report: `(report: ConsolidateReport) => Promise<void>`. Round 3's compose wires `onConsolidated: (report) => corpus.reload()` so the running corpus index picks up new lived/proposal files without a restart (test: `lived file is selectable after reload without restart`, test/corpus/corpus-index.test.ts). Undefined by default = pre-round-2 behavior; a rejection propagates (loud; the run itself is durable and idempotent, so the next night replays safely).
4. **Ops note**: deploy/install.sh already excluded `corpus/lived`/`corpus/proposals` from the rsync `--delete`, because they were machine-written; after round 2 that concern lives entirely in `var/`, which was always excluded. The corpus/ excludes can be dropped by ops whenever convenient (the dirs are simply no longer written).
5. **Still compose's call-site (round 3)**: compose.ts currently passes `livedDir: corpus/lived`, `proposalsDir: corpus/proposals` into `nightlyConfig` — those two lines must move to `var/lived` / `var/proposals` under `paths.base`, together with the `onConsolidated` wiring above.

---
module: M10
name: consolidate
syncedTo: spec-v1 (no code yet)
stage: S7
depends: [M01-kernel, M02-events, M03-model, M04-embed, M05-affect, M07-corpus, M09-memory]
---
# M10 — consolidate

## Responsibility
The slow flywheel that lets lived experience compound without drowning the character: nightly L2 consolidators (preference crystallization, behavioral regularities, affect patterns → lived pattern exemplars), weekly L3 (dispositions, relationship baseline, identity exemplars, and **canon-promotion proposals only** — `corpus/proposals/`, human merges), the credit-assignment updater that nudges exemplar selection weights from real outcomes, and the seed-gravity metrics with their drift alarms (unmoored / not-integrating / tunnel vision).

## Interfaces (contract)
```ts
export const consolidateNightly: (deps: ConsolidateDeps) => Promise<void>;  // L2
export const consolidateWeekly: (deps: ConsolidateDeps) => Promise<void>;   // L3
export interface ConsolidateDeps {
  model: ModelClient; episodes: EpisodeStore; corpus: CorpusIndex;
  affectHistory: EventLog; creditPath: string; events: EventLog;
  clock: Clock; rng: Rng; cfg: ConsolidateConfig;
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
- **L2 (nightly, `catchUp: 'once'`)**: replay the day's episodes + affect history; crystallize preferences and behavioral regularities and affect patterns into **pattern exemplars written to `corpus/lived/`** — each stamped with full `encodedAffect` (from the episodes' `affectAtEncoding`), `episodeIds` provenance, and an honest `outcome` tag. Lived files validate under the lived schema (M07 lint is the gate — a consolidator output that can't parse is a bug, caught at write time). Generation uses cheap/consolidate tier with the judge rubric lightened to schema + faithfulness-to-episodes (these are HER memories, not creative writing).
- **L3 (weekly, `catchUp: 'once'`)**: dispositions, relationship baseline doc, identity exemplars — and **canon-promotion proposals go to `corpus/proposals/` ONLY**. The consolidator never writes canon (AGENTS.md rule 8; ADR-006's corollary). Proposals are clearly marked; merging is a human act.
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
- **Prod safety**: consolidators write only into `corpus/lived/` and `corpus/proposals/` — never `canon/`, never `derived/` (that's M08's), never `var/` outside `credit/` and `reports/`.

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
- [ ] L3 proposals land in `corpus/proposals/` and NOWHERE else (path assertion); canon dir byte-identical after a weekly run.
- [ ] `seedRatio` matches hand-computed values on fixture packet sets; alarm truth table: unmoored / not-integrating (week-gated) / tunnel-vision each fire and each stay silent on their healthy counterparts.
- [ ] Status projection contains seedRatio, dimension coverage, drift cosine (injected), and the alarms — snapshot test.

## Test checklist
- unit: credit math goldens + property suite (clamp, decay, moodGuard, slotShare matrix); seedRatio/dimensionCoverage math; alarm threshold table incl. the week-6 gate.
- component: MockModel nightly L2 over a fixture episode week (outputs validated by M07's parser); weekly L3 path assertions; weights corrupt→replay recovery; status projection snapshot.
- fixtures needed: a fixture week of episodes + PacketRecords + outcomePrev events; constructed Vec12 states around the moodGuard threshold; a canned drift-cosine injector for the projection.

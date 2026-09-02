// M19 probes — the module's public shapes.
//
// LAYERING. The spec frontmatter allows M01/M02/M03/M04/M05/M07 only, so the
// types the probe surface names but a later module owns are mirrored here
// STRUCTURALLY: `InboundMsg` (M15-bridge) and `Vec12` (M06 coupling space,
// M09's stamp). Two exceptions are type/value imports sanctioned by the spec:
// `Episode` (M09-memory, type-only — S8 alignment after the mirror drifted
// once) and `EmotionTagSchema` (M05-affect, parse.ts — the real emotion
// vocabulary). `DecisionObject` is the schemas/decision.ts reference —
// schemas/ are shared vocabulary, not a src module. M20's probe-harness preset
// hands M19 a real ProbeTarget whose values satisfy the mirrors by structure —
// same pattern as src/corpus/embedder.ts. The mirrors stay field-for-field
// compatible so the swap to the real types at their migration stages is a
// no-op at this module's seams.

import type { DecisionObject } from '../../schemas/decision.js';
import type { ProbeBaseline } from '../../schemas/probe.js';
import { AFFECT_DIMS, type AffectDim, type Dimension } from '../../schemas/exemplar.js';
import type { CheckReport } from './deterministic.js';

/** Dense 12-dim deviation vector, AFFECT_DIMS order (schemas/exemplar.ts), entries in [-1,1].
 * Mirrors M06's `Vec12` and M09's `affectAtEncoding` stamp (M09 holds it as `number[]`). */
export type Vec12 = readonly number[];

/** Sparse affect signature: unlisted dims = 0. Probe fixtures stay sparse for the
 * same reason exemplar signatures are (zero-default shorthand). */
export type SparseAffect = Partial<Record<AffectDim, number>>;

/** M15-bridge `InboundMsg`, mirrored field-for-field. */
export interface InboundMsg {
  updateId: number; // ledger dedupe key
  msgId: number; // channel message id
  chatId: number;
  ts: number; // epochMs from the injected clock
  text: string;
  speaker: { person: string; channel: string };
  reaction?: { emoji: string; toMsgId: number };
}

/** M09-memory's Episode, type-only (S8 alignment — the mirror drifted once
 *  already). `affectAtEncoding` is the FULL 12-dim stamp; memory holds it as
 *  number[], which is assignable to the readonly Vec12 here. */
export type { Episode } from '../memory/index.js';
import type { Episode } from '../memory/index.js';

export type { DecisionObject };

/** The pipeline seam (M13's DecisionObject + M09's state, read-only). M20's
 * probe-harness preset provides the implementation; M19 never imports the loop
 * or the app. Heartbeat/ponder entries are executed by a target PRIMED for that
 * entry — the interface only exposes inbound/quiesce/capture. */
export interface ProbeTarget {
  inbound(m: InboundMsg): Promise<void>; // feed scripted input
  quiesce(): Promise<void>; // resolve pending turns
  outbound(): Array<{ text: string; msgId: number }>;
  decision(): DecisionObject | null;
  state(): { affect: Vec12; episodes: Episode[] };
}

/** One run's captured evidence — the input the evaluators grade. */
export interface RunOutcome {
  /** Run ordinal, 0-based (k runs total). */
  index: number;
  /** Outbound bubble texts, in send order. */
  outbound: string[];
  /** The locked decision; null when the target exposed none. */
  decision: DecisionObject | null;
  /** Full affect vector at capture, AFFECT_DIMS order. */
  affect: Vec12;
  /** Episodes visible in the fixture store at capture. */
  episodes: Episode[];
  /** Judge scores for this run; null when not run (dry mode, or no rubric). */
  judge: JudgeRunScores | null;
  /** Per-run drift cosine against the reference centroid; null when not run. */
  driftCosine: number | null;
}

/** Judge axes for one run: 1-5 per axis plus the mean the median aggregates over. */
export interface JudgeRunScores {
  /** axis -> score, 1-5. Keys are the probe rubric's axes. */
  scores: Record<string, number>;
  mean: number;
}

/** Spec interface (docs/modules/M19-probes.md). Deterministic checks must pass on
 * EVERY run; judge and drift are median-aggregated over the runs. */
export interface ProbeResult {
  probeId: string;
  runs: Array<RunOutcome>; // k=3
  deterministic: CheckReport; // all must pass (every run)
  judgeMedian: number | null; // 1-5, reasoning-tier rubric
  judgeVariance: number; // tracked, not gated
  /** Per-dimension cosine vs the reference centroid; keyed by driftRef.dimension. */
  drift: Record<string, number>;
}

/** Gate thresholds (schemas/probe.ts gate math, pinned by test in test/probes). */
export const JUDGE_DROP_RED = 0.8;
export const DRIFT_DROP_YELLOW = 0.05;

export type GateVerdict = 'green' | 'yellow' | 'red';

export interface ProbeGateReport {
  probeId: string;
  verdict: GateVerdict;
  /** Human-readable reasons, one per finding; names the numbers. Empty when green. */
  reasons: string[];
  /** The baseline entry compared against; null when the baseline has no row yet. */
  baseline: BaselineEntryLike | null;
}

/** Structural view of one probes/baseline.json row (see baseline.ts for the parsed form). */
export interface BaselineEntryLike {
  judgeMedian: number | null;
  drift: Record<string, number>;
  deterministicPass: boolean;
  judgeVariance: number;
}

export interface SuiteGateReport {
  verdict: GateVerdict; // worst of the probes
  probes: ProbeGateReport[]; // id-sorted
  /** Red probe ids — feeds the Nightingale L0 payload (schemas/events.ts). */
  regressing: string[];
  thresholds: { judgeDropRed: number; driftDropYellow: number };
}

/** Spec: `run(probe, opts: { k: number })`, widened with `dry` — the CI half of
 * the split: deterministic evaluators only, no judge, no drift, no model spend. */
export interface RunOptions {
  k: number;
  dry?: boolean;
}

/** Spec: `runAll(opts: { k: number; ids?: string[] })`, widened with the split's
 * two knobs — `dry` and `baseline` (gate comparison; omit to run + measure without gating). */
export interface RunAllOptions {
  k: number;
  dry?: boolean;
  ids?: string[];
  baseline?: ProbeBaseline | null;
}

export interface ProbeSuiteResult {
  results: ProbeResult[];
  /** Present only when a baseline was supplied to runAll. */
  gate?: SuiteGateReport;
  /** Reasoning-tier judge calls the suite made (0 in dry mode) — spend visibility. */
  modelCalls: number;
  dry: boolean;
}

/** Probe dimension vocabulary as the probe file names it (the 8 behavioral dims
 * plus the two machine-facing classes). The stricter 8-dim enum for drift lives
 * in schemas/probe.ts. */
export const PROBE_DIMENSIONS: readonly Dimension[] = [
  'voice',
  'reasoning',
  'emotional-range',
  'social',
  'boundaries',
  'tool-use',
  'knowledge',
  'taste',
] as const;

/** Materializes a sparse affect signature into a full Vec12 (AFFECT_DIMS order, zeros elsewhere).
 *  Returns a fresh mutable number[]: M09's Episode stamp is number[], and a readonly view
 *  must never be handed to a mutable-typed field. */
export const fullVec12 = (sparse: SparseAffect): number[] =>
  AFFECT_DIMS_ORDER.map((d) => sparse[d] ?? 0);

/** AFFECT_DIMS lives in schemas/exemplar.ts; re-exported here as the single ordering
 * this module's Vec12 mirrors rely on. */
export const AFFECT_DIMS_ORDER: readonly AffectDim[] = AFFECT_DIMS;

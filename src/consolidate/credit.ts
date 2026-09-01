// M10 consolidate — credit assignment (spec §2.1). The exact mechanism is
// pinned: `w ← clamp(w + η·sign·slotShare·moodGuard, 0.5, 2.0)` per slot, plus
// the nightly decay toward neutral. Weights bias selection ties (M11's additive
// γ term); they never touch M, quotas, or canon.
//
// The module owns the VALUES; M11 owns the application. Every constant here is
// load-bearing — changing one is a design decision, not a refactor.

import { canonicalJson } from '../kernel/index.js';
import { AFFECT_DIMS } from '../../schemas/exemplar.js';
import { ConsolidateError } from './errors.js';
import { z } from 'zod';
import type { CreditWeights, OutcomeGrade, PacketRecordView, PacketSlotView } from './types.js';

/** Learning rate. Small on purpose: credit smears across co-selected slots, and
 * only *consistent* co-occurrence is meant to accumulate. */
export const CREDIT_ETA = 0.02;

/** Hard clamp. Rich-get-richer is accepted but bounded. */
export const CREDIT_CLAMP: [number, number] = [0.5, 2.0];

/** Nightly decay toward neutral: `w ← 1 + (w − 1)·NIGHTLY_DECAY`. */
export const NIGHTLY_DECAY = 0.995;

/** Applied as the update multiplier while ‖a_aversive‖ > MOOD_GUARD — bad moods
 * must not starve the corrective exemplars selected during them. */
export const MOOD_GUARD = 0.5;

/** Per-tier share. Disposition is 0.5 because an always-similar slot carries
 * little information; contrast is 0 because exploration is never PUNISHED —
 * its +1 share is CONTRAST_PLUS_SHARE below. */
export const SLOT_SHARE = {
  episode: 1.0,
  pattern: 1.0,
  disposition: 0.5,
  memory: 1.0,
  contrast: 0.0,
} as const;

/**
 * The contrast slot's share when its outcome is +1. The spec's SLOT_SHARE table
 * pins contrast at 0.0 — the never-punished side — and leaves the reward side
 * open; 1.0 makes a vindicated exploration worth exactly as much as any other
 * slot's. Proposed constant (spec gap), see docs/modules/M10-consolidate.md.
 */
export const CONTRAST_PLUS_SHARE = 1.0;

/**
 * The five aversive deviation dims (M06's anti-escalation metric uses the same
 * set). Indices are resolved from AFFECT_DIMS so the two vocabularies cannot
 * drift apart.
 */
const AVERSIVE_INDEX: readonly number[] = (['sadness', 'fear', 'anger', 'shame', 'disgust'] as const).map(
  (d) => AFFECT_DIMS.indexOf(d),
);

/**
 * ‖a_aversive‖ — the L2 norm of the POSITIVE excursions on the aversive dims.
 * Deviations below baseline are relief, not aversion, so they do not count
 * (same max(0, ·) rule M06's anti-escalation test uses).
 */
export const aversiveNorm = (affectAtTurn: readonly number[]): number => {
  let sum = 0;
  for (const i of AVERSIVE_INDEX) {
    const v = affectAtTurn[i] ?? 0;
    if (v > 0) sum += v * v;
  }
  return Math.sqrt(sum);
};

/** 0.5 while the turn ran under high aversion (strictly above the threshold). */
export const moodGuardFor = (affectAtTurn: readonly number[]): number =>
  aversiveNorm(affectAtTurn) > MOOD_GUARD ? MOOD_GUARD : 1;

const round6 = (x: number): number => Math.round(x * 1e6) / 1e6;

export const clampWeight = (w: number): number =>
  Math.min(CREDIT_CLAMP[1], Math.max(CREDIT_CLAMP[0], round6(w)));

/** The share an update moves by: the contrast marker wins over the tier. */
export const shareFor = (slot: PacketSlotView, sign: -1 | 0 | 1): number => {
  if (slot.slot === 'contrast') return sign === 1 ? CONTRAST_PLUS_SHARE : SLOT_SHARE.contrast;
  switch (slot.tier) {
    case 'disposition':
      return SLOT_SHARE.disposition;
    case 'pattern':
      return SLOT_SHARE.pattern;
    case 'episode':
      return SLOT_SHARE.episode;
    case 'memory':
      return SLOT_SHARE.memory;
    case 'procedure':
      // Procedural slots are not in the spec's share table; they behave like the
      // other 1.0 information-bearing slots (procedure exemplars do carry credit).
      return 1.0;
  }
};

/**
 * One graded packet → updated weights. Pure: a new record, absent ids entering
 * at the neutral 1.0. Order of application is the caller's (L0 order), and
 * results are rounded to 6 decimals so the persisted file carries no float dust.
 */
export const applyOutcome = (
  w: CreditWeights,
  packet: PacketRecordView,
  outcome: OutcomeGrade,
  affectAtTurn: readonly number[],
): CreditWeights => {
  const out: CreditWeights = { ...w };
  const guard = moodGuardFor(affectAtTurn);
  for (const slot of packet.slots) {
    const share = shareFor(slot, outcome.sign);
    const current = out[slot.exemplarId] ?? 1;
    out[slot.exemplarId] = clampWeight(current + CREDIT_ETA * outcome.sign * share * guard);
  }
  return out;
};

/** Nightly decay toward neutral, applied to the whole map. */
export const decayWeights = (w: CreditWeights): CreditWeights => {
  // Pure formula, clamp only — NOT clampWeight. round6 here would quantize
  // every step and trap decay in a ±1e-4 dead-band it can never cross (the
  // sequence re-rounds onto its own grid); dust is a storage concern, handled
  // by the round6 in serializeWeightsFile, not per step.
  const out: CreditWeights = {};
  for (const id of Object.keys(w)) {
    const v = w[id];
    if (v === undefined) continue;
    const next = 1 + (v - 1) * NIGHTLY_DECAY;
    out[id] = Math.min(CREDIT_CLAMP[1], Math.max(CREDIT_CLAMP[0], next));
  }
  return out;
};

// ---------------------------------------------------------------------------
// Persistence — var/credit/weights.json
// ---------------------------------------------------------------------------

const WeightsFileSchema = z.strictObject({
  version: z.literal(1),
  /** Last L0 seq folded into `weights`; the marker that makes a replay a no-op. */
  lastSeq: z.number().int().min(0),
  /** Last epoch DAY decay ran on (0 = never). Decay is once per day, so a
   * same-day replay leaves the file byte-identical. */
  decayDay: z.number().int().min(0),
  weights: z.record(z.string(), z.number()),
});

export interface WeightsFile {
  version: 1;
  lastSeq: number;
  decayDay: number;
  weights: CreditWeights;
}

/** Launch state: every exemplar at 1.0 (implicit — absent ids read as 1.0). */
export const emptyWeightsFile = (): WeightsFile => ({ version: 1, lastSeq: 0, decayDay: 0, weights: {} });

/** Strict parse; a file that does not match is NOT a weights file (replay wins). */
export const loadWeightsFile = (raw: string): WeightsFile => {
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch (e) {
    throw new ConsolidateError('consolidate/state-schema', `weights file is not valid JSON: ${(e as Error).message}`);
  }
  const result = WeightsFileSchema.safeParse(doc);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue !== undefined ? issue.path.map(String).join('.') : '';
    throw new ConsolidateError(
      'consolidate/state-schema',
      `weights file rejected by schema at '${path}': ${issue?.message ?? 'no detail'}`,
    );
  }
  return result.data as WeightsFile;
};

/** Serializes exactly as atomicWriteJson will. */
export const serializeWeightsFile = (file: WeightsFile): string =>
  canonicalJson({
    ...file,
    // THE rounding point: in-memory weights stay full precision (decay must
    // converge through its dead-band); the persisted file carries no dust.
    weights: Object.fromEntries(
      Object.entries(file.weights).map(([k, v]) => [k, round6(v)]),
    ),
  });

// ---------------------------------------------------------------------------
// Recovery — L0 is the truth (same recovery path M05 uses)
// ---------------------------------------------------------------------------

/**
 * One L0 row in the fold: a packet record or an outcome grade, in append order.
 * Rows carry `seq` so the rebuilt file can resume where the log ends.
 */
export type CreditEventView =
  | { seq: number; kind: 'packet'; packet: PacketRecordView }
  | { seq: number; kind: 'outcome'; turnId: string; outcome: OutcomeGrade };

/**
 * Folds L0 from scratch: packets are parked per turn, each outcome grades its
 * turn's packet. Decay is deliberately NOT applied here — the log does not
 * record how many nights passed, and under-decaying on recovery is the safe
 * direction (weights return to neutral on their own from the next night on).
 * The rebuilt file's decayDay 0 lets the next run decay exactly once.
 */
export const replayWeights = (events: readonly CreditEventView[]): WeightsFile => {
  const byTurn = new Map<string, PacketRecordView>();
  let weights: CreditWeights = {};
  let lastSeq = 0;
  for (const ev of events) {
    lastSeq = Math.max(lastSeq, ev.seq);
    if (ev.kind === 'packet') {
      byTurn.set(ev.packet.turnId, ev.packet);
      continue;
    }
    const packet = byTurn.get(ev.turnId);
    if (packet === undefined) continue; // nothing to credit — grade is kept in L0
    weights = applyOutcome(weights, packet, ev.outcome, packet.affectSig);
  }
  return { version: 1, lastSeq, decayDay: 0, weights };
};

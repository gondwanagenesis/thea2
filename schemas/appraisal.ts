// Reference schema — spec-v1. Source of truth migrates to src/memory at stage S3; keep synced.
//
// The L1 appraisal: ONE cheap-tier structured call per turn (M9). It emits the
// turn's typed AffectEvents (via emotions[]), the diary projection line, thread
// updates, and the credit-assignment grade for the PREVIOUS turn's packet
// (report section 2.1). journal.md is a write-only projection of this output —
// it is never parsed back (the Thea1 regex-over-prose pathology, inverted).

import { z } from 'zod';

/**
 * EMOTION_TAGS is the single shared emotion vocabulary (ADR-004). Its canonical
 * definition lands in src/affect/vocab.ts (stage S2) as
 *
 *   EMOTION_TAGS = keys(EMOTION_DELTAS) ∪ keys(EMOTION_PRIMARIES) ∪ keys(EMOTION_DRIVES)
 *
 * ported verbatim from Thea1 ticker.py. This file deliberately does NOT restate
 * the list: a second copy is exactly the drift that produced the orphan-tag
 * incident (10 tags silently no-op'd for months; dominance pinned 0.00 across
 * 365 snapshots). The real schema is z.enum(EMOTION_TAGS); until vocab.ts
 * exists this reference types the tag as a constrained string. An unknown tag
 * at the boundary is a zod reject + incident event — never a silent no-op.
 */
export const EmotionTag = z
  .string()
  .min(1)
  .describe('must be a member of EMOTION_TAGS (src/affect/vocab.ts); enforced as z.enum there');
export type EmotionTag = z.infer<typeof EmotionTag>;

export const AppraisedEmotion = z.object({
  tag: EmotionTag,
  /** Intensity, 1-10 (Thea1 diary scale; the engine applies superlinear i^1.7 downstream). */
  i: z.number().min(1).max(10),
  /** Short causal attribution; feeds the per-primary cause slots (CAUSE_MIN_I = 5). */
  cause: z.string().min(1),
});
export type AppraisedEmotion = z.infer<typeof AppraisedEmotion>;

export const ThreadUpdate = z.object({
  id: z.string().min(1),
  /** Required in practice when opening a thread the store has not seen before. */
  title: z.string().optional(),
  status: z.enum(['open', 'touched', 'closed']),
});
export type ThreadUpdate = z.infer<typeof ThreadUpdate>;

/**
 * Outcome grade for the PREVIOUS turn's packet (credit assignment, report 2.1).
 * Rubric is factual-evidence-only: explicit reactions, corrections ("you already
 * told me"), warmth/continuation of the reply, thread advanced. Silence
 * contributes 0, never -1 (it is exogenous). The evidence string is logged
 * verbatim for audit — the anti-self-grading-bias measure.
 */
export const OutcomePrev = z.object({
  sign: z.union([z.literal(-1), z.literal(0), z.literal(1)]),
  evidence: z.string().min(1),
});
export type OutcomePrev = z.infer<typeof OutcomePrev>;

export const Appraisal = z.object({
  importance: z.number().int().min(1).max(10),
  emotions: z.array(AppraisedEmotion),
  /** Exactly one diary line; rendered into journal.md (write-only projection). */
  diaryLine: z.string().min(1),
  threads: z.array(ThreadUpdate),
  /** null when there is no previous turn to grade (session start). */
  outcomePrev: OutcomePrev.nullable(),
});
export type Appraisal = z.infer<typeof Appraisal>;

// Failure behavior: if this call cannot be parsed after the M3 repair ladder,
// the turn still completes — an incident.parse_failed event is emitted and no
// affect/episode/credit update happens for the turn (graceful degradation; the
// M9 suite asserts this).

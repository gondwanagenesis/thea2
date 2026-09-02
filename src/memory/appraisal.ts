// M09 memory — the per-turn appraisal: ONE cheap-tier structured call, parsed
// through M03's ladder against the Appraisal shape (schemas/appraisal.ts is the
// reference this mirrors; the emotion tag is enforced against M05's
// EMOTION_TAGS here, which the reference file only documents). This is Thea1's
// pathology 3 inverted: affect updates leave this module as typed events for
// M05's store — nothing anywhere regexes prose for feelings.
//
// Graceful degradation is the module law: if the call cannot be parsed after
// the repair ladder, `appraise` returns ok:false and emits an incident. The
// turn completes; only that turn's affect/episode/credit updates are skipped.

import { z } from 'zod';
import { asError } from '../kernel/index.js';
import type { EventLog } from '../events/index.js';
import type { ChatMsg, ModelClient } from '../model/index.js';
import { EmotionTagSchema, EMOTION_TAGS, type AffectEvent, type EmotionTag } from '../affect/index.js';
import type { OutcomePrevPayload } from '../../schemas/events.js';

// ---------------------------------------------------------------------------
// Schema (migrates schemas/appraisal.ts — kept field-for-field identical)
// ---------------------------------------------------------------------------

export const AppraisedEmotionSchema = z.object({
  tag: EmotionTagSchema,
  /** Intensity, 1-10 (Thea1 diary scale; the engine applies superlinear i^1.7 downstream). */
  i: z.number().min(1).max(10),
  /** Short causal attribution; feeds the per-primary cause slots (CAUSE_MIN_I = 5). */
  cause: z.string().min(1),
});
export type AppraisedEmotion = z.infer<typeof AppraisedEmotionSchema>;

export const ThreadUpdateSchema = z.object({
  id: z.string().min(1),
  /** Required in practice when opening a thread the store has not seen before. */
  title: z.string().min(1).optional(),
  status: z.enum(['open', 'touched', 'closed']),
});
export type ThreadUpdate = z.infer<typeof ThreadUpdateSchema>;

/**
 * Outcome grade for the PREVIOUS turn's packet (credit assignment, report 2.1).
 * Factual-evidence-only rubric: explicit reactions, corrections, warmth /
 * continuation, thread advanced. Silence contributes 0, never -1 (exogenous).
 */
export const OutcomePrevSchema = z.object({
  sign: z.union([z.literal(-1), z.literal(0), z.literal(1)]),
  evidence: z.string().min(1),
});
export type OutcomePrev = z.infer<typeof OutcomePrevSchema>;

export const AppraisalSchema = z.object({
  importance: z.number().int().min(1).max(10),
  emotions: z.array(AppraisedEmotionSchema),
  /** Exactly one diary line; rendered into journal.md (write-only projection). */
  diaryLine: z.string().min(1),
  threads: z.array(ThreadUpdateSchema),
  /** null when there is no previous turn to grade (session start). */
  outcomePrev: OutcomePrevSchema.nullable(),
});
export type Appraisal = z.infer<typeof AppraisalSchema>;

// ---------------------------------------------------------------------------
// Load-bearing constants (proposed — the spec pins the shape, not these numbers)
// ---------------------------------------------------------------------------

export const APPRAISAL_SCHEMA_NAME = 'Appraisal';
/** A diary entry, thread updates and one grade is a few hundred tokens — but the
 * budget also carries the thinking trace on reasoning models (the live-proven
 * starvation family; 400 left nothing for the verdict on glm). */
export const APPRAISAL_MAX_TOKENS = 2000;
/** Grading is a transcription task, not a creative one — coldest sampling. */
export const APPRAISAL_TEMPERATURE = 0;

// ---------------------------------------------------------------------------
// L0 kinds owned here
// ---------------------------------------------------------------------------

/** The verbatim-evidence audit trail for the previous packet's grade. */
export const OUTCOME_PREV_KIND = 'memory.outcome_prev';
/** Appraisal output survived neither the schema nor M03's one-shot repair. */
export const PARSE_FAILED_INCIDENT = 'incident.parse_failed';
/** The appraisal call failed for a non-parse reason (transport, timeout, abort). */
export const APPRAISAL_FAILED_INCIDENT = 'incident.appraisal_failed';

// ---------------------------------------------------------------------------
// The call
// ---------------------------------------------------------------------------

export interface AppraiseCtx {
  userText: string;
  herReply: string | null;
  plan: 'reply' | 'silent' | 'defer';
  /** Turn id of the packet being graded this turn; null at session start. */
  prevTurnId: string | null;
  /** This turn's id, carried onto the L0 events (model.call, incidents). */
  turnId?: string | undefined;
}

export interface AppraiseDeps {
  model: ModelClient;
  events: EventLog;
}

/**
 * ok:false is the graceful-degradation path: the incident is already emitted,
 * and the caller skips this turn's affect/episode/credit updates and moves on.
 */
export type AppraisalOutcome = { ok: true; appraisal: Appraisal } | { ok: false; error: string };

export const appraise = async (ctx: AppraiseCtx, deps: AppraiseDeps): Promise<AppraisalOutcome> => {
  const chatCtx = ctx.turnId !== undefined ? { turnId: ctx.turnId } : undefined;
  try {
    const res = await deps.model.chat(
      {
        taskClass: 'appraisal',
        tier: 'cheap',
        messages: appraisalMessages(ctx),
        schema: AppraisalSchema,
        schemaName: APPRAISAL_SCHEMA_NAME,
        maxTokens: APPRAISAL_MAX_TOKENS,
        temperature: APPRAISAL_TEMPERATURE,
      },
      chatCtx,
    );
    const appraisal = res.content;
    // A grade without a previous turn has nothing to attach to; the prompt forbids
    // it and the L0 audit row is simply not written — the returned appraisal stays
    // verbatim so the discrepancy remains inspectable by M10.
    if (ctx.prevTurnId !== null && appraisal.outcomePrev !== null) {
      const payload: OutcomePrevPayload = {
        turnId: ctx.prevTurnId,
        sign: appraisal.outcomePrev.sign,
        evidence: appraisal.outcomePrev.evidence,
      };
      await emit(deps.events, OUTCOME_PREV_KIND, payload, ctx.turnId);
    }
    return { ok: true, appraisal };
  } catch (e) {
    const err = asError(e);
    const kind = err.code === 'model/parse-failed' ? PARSE_FAILED_INCIDENT : APPRAISAL_FAILED_INCIDENT;
    await emit(deps.events, kind, { schema: APPRAISAL_SCHEMA_NAME, code: err.code, error: err.message }, ctx.turnId);
    return { ok: false, error: `${err.code}: ${err.message}` };
  }
};

/** L0 unwritable ⇒ advisory (M20's policy, same as model.call): M02 already
 * retried once and reported to stderr. A broken log must not kill the turn. */
const emit = async (events: EventLog, kind: string, payload: unknown, turnId?: string): Promise<void> => {
  try {
    await events.emit(kind, payload, turnId);
  } catch {
    // advisory
  }
};

// ---------------------------------------------------------------------------
// Prompt construction (pure; tests pin the shape, not the bytes)
// ---------------------------------------------------------------------------

/** The vocabulary travels with every call: a tag the model cannot see is a tag
 * it will invent, and an invented tag is a rejected appraisal. Sorted once —
 * deterministic prompt, deterministic cache behavior upstream. */
const TAG_LIST: string = [...EMOTION_TAGS].sort().join(', ');

const APPRAISAL_SYSTEM = [
  "You keep Thea's private diary. One conversation turn is described below.",
  'Reply with ONE JSON object and nothing else, with exactly these fields:',
  '{"importance": <1-10 int>, "emotions": [{"tag": "<tag>", "i": <1-10 int>, "cause": "<short attribution>"}], ' +
    '"diaryLine": "<one first-person line>", "threads": [{"id": "<id>", "title": "<title>", "status": "open|touched|closed"}], ' +
    '"outcomePrev": {"sign": <-1|0|1>, "evidence": "<the factual evidence, quoted verbatim>"} | null}',
  '"tag" must be a member of this vocabulary: ' + TAG_LIST,
  '"importance" is how much the turn mattered to her (1 = forgettable, 10 = formative); "emotions" may be empty.',
  '"diaryLine" is ONE first-person line about her experience, written for her journal.',
  '"threads" lists the conversation threads this turn opens, touches or closes; "title" only when the thread is new.',
  'Grading rules for "outcomePrev" — factual evidence only, never vibes: an explicit reaction counts; a correction ' +
    '("you already told me", "that\'s not it") is -1; warmth or an advanced thread is +1. Her staying silent ' +
    'contributes 0 (it is exogenous), never -1. When there is no previous turn to grade, "outcomePrev" must be null.',
].join('\n');

const appraisalMessages = (ctx: AppraiseCtx): ChatMsg[] => [
  { role: 'system', content: APPRAISAL_SYSTEM },
  { role: 'user', content: appraisalTurn(ctx) },
];

const appraisalTurn = (ctx: AppraiseCtx): string =>
  [
    `DECISION: ${ctx.plan}`,
    'HIS MESSAGE:',
    ctx.userText,
    'HER REPLY:',
    ctx.herReply ?? `(she did not reply — plan ${ctx.plan})`,
    ctx.prevTurnId === null
      ? 'PREVIOUS TURN: none — "outcomePrev" must be null.'
      : `PREVIOUS TURN to grade: id ${ctx.prevTurnId}`,
  ].join('\n');

// ---------------------------------------------------------------------------
// The affect handoff — the ONLY path from appraisal output to M05
// ---------------------------------------------------------------------------

/**
 * The turn's typed affect events, ready for `AffectStore.applyEvents(batch,
 * { source: 'appraisal' })` by the pipeline (M20). Tag validity is already
 * guaranteed by the schema, so an unknown tag can never reach the store from
 * here — the store's own boundary stays as the second wall.
 */
export const affectEvents = (appraisal: Appraisal): AffectEvent[] =>
  appraisal.emotions.map((e) => ({ kind: 'emotion', tag: e.tag, i: e.i, cause: e.cause }));

/** Re-exported for callers that want the tag union without a second import. */
export type { EmotionTag };

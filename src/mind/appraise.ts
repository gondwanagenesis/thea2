// v8 mind — FEEL, slow (the "high road"): one cheap call AFTER she replies.
//
// It appraises WHAT HAPPENED, never "what did she feel". The schema carries the
// non-circularity law (plan §1.2, §3.7) structurally:
//   event[]  — what his message / the situation meant for HER concerns
//   self[]   — her own reply judged against one of HER named standards
//              (pride, shame, guilt, regret) — the only path from her words
//   outcome_prev — how her PREVIOUS reply landed, from his new message only
//   concerns[] — loops opened/closed, expectations with due times
// The appraiser is machinery, not her: it may be instructed; she is not.

import { z } from 'zod';
import type { ChatMsg, ModelClient } from '../model/index.js';
import type { EmotionEventInput } from '../affect/index.js';
import { isAppraisalTag } from './vocab.js';
import type { Concern } from './types.js';

// Emotion words are validated AFTER parsing (slowEvents drops anything outside
// the vocabulary): one off-list word must not fail the whole appraisal.
const Emo = z.object({
  emotion: z.string().min(1).max(40),
  i: z.number().int().min(1).max(10),
  cause: z.string().min(1).max(200),
});

export const SlowAppraisalSchema = z.object({
  event: z.array(Emo.extend({ concern: z.string().max(80).optional() })).max(3),
  self: z.array(Emo.extend({ standard: z.string().min(3).max(200) })).max(2),
  outcome_prev: z.object({ landed: z.number().int().min(-2).max(2), why: z.string().min(1).max(100) }).nullable(),
  concerns: z
    .array(
      z.object({
        op: z.enum(['open', 'update', 'close']),
        id: z.string().max(60).optional(),
        what: z.string().min(1).max(200),
        kind: z.enum(['loop', 'expectation', 'care', 'curiosity']).optional(),
        about: z.enum(['diego', 'self', 'world']).optional(),
        due_hours: z.number().min(0).max(24 * 60).optional(),
        importance: z.number().int().min(1).max(10).optional(),
      }),
    )
    .max(3),
  importance: z.number().int().min(1).max(10),
  /**
   * Prediction error, judged by reading both texts (vector similarity between a
   * DESCRIPTION of an expected reply and the reply itself is unreliable — the
   * 2026-09-25 live probe fired surprise on 3 of 4 turns, including a confirmed
   * one). null = she had no expectation.
   */
  expectation: z.enum(['confirmed', 'better', 'worse', 'different']).nullable().optional(),
});

export type SlowAppraisal = z.infer<typeof SlowAppraisalSchema>;

export interface SlowAppraiseInput {
  his: string;
  hers: readonly string[];
  /** Hours since his previous message (the gap itself is information). */
  gapHours?: number | undefined;
  prevHers?: readonly string[] | undefined;
  expect?: string | undefined;
  concerns: readonly Concern[];
  standards: readonly string[];
  /** Tags the fast path already registered this turn (so the appraiser adds only what is new). */
  alreadyFelt: readonly string[];
  selfEntry?: boolean | undefined;
}

export const APPRAISER_SYSTEM = [
  "You are the appraisal process inside Thea's mind. You never write to anyone; you judge what just happened.",
  'Return one JSON object that matches the schema. Be sparse: most turns carry zero or one event emotion.',
  'Rules:',
  '- event: feelings caused by WHAT HAPPENED (his words, his silence, the situation) weighed against HER concerns listed below. Never derive them from how her reply sounds.',
  '- self: only when her reply clearly lived up to or broke one of HER standards listed below; name that standard in "standard". Otherwise empty.',
  '- outcome_prev: grade how her PREVIOUS reply landed, using his new message only. +2 delighted/warm engagement, +1 kept going happily, 0 neutral or unclear, -1 flat/annoyed/corrected, -2 hurt or upset. "why" is a short plain phrase in past tense (e.g. "he laughed and kept going"). null when there was no previous reply.',
  '- concerns: open a loop when something is now pending (a promise, a plan, a question left hanging, an expectation with a time); close one when it resolved. Use the ids shown. Keep "what" in her own first-person voice.',
  '- importance: how much this exchange matters to her life, 1-10.',
  '- expectation: compare HIS MESSAGE NOW with WHAT SHE PRIVATELY EXPECTED. "confirmed" when it fits the gist of any branch she expected (she expected him to go to sleep and he says goodnight = confirmed; she expected him to tease or open up and he teases = confirmed). "better" only when it clearly went better than she expected, "worse" only when it clearly went worse for her or for him (a correction, a hurt, bad news, a cold reply). "different" when it simply went somewhere else. null if she expected nothing or she wrote first. Most turns are confirmed or different.',
  '- Tags already registered in the moment (do not repeat them unless the feeling is clearly stronger now): listed below.',
].join('\n');

export const appraiserUser = (i: SlowAppraiseInput): string => {
  const lines: string[] = [];
  lines.push('HER CONCERNS:');
  if (i.concerns.length === 0) lines.push('(none)');
  for (const c of i.concerns.slice(0, 10)) {
    lines.push(`- [${c.id}] ${c.what} (${c.kind}${c.due !== undefined ? ', has a due time' : ''})`);
  }
  lines.push('HER STANDARDS:');
  if (i.standards.length === 0) lines.push('(none listed)');
  for (const s of i.standards.slice(0, 10)) lines.push(`- ${s}`);
  lines.push(`ALREADY REGISTERED: ${i.alreadyFelt.length > 0 ? i.alreadyFelt.join(', ') : '(none)'}`);
  lines.push(`WHAT SHE PRIVATELY EXPECTED BEFORE THIS: ${i.expect ?? '(nothing noted)'}`);
  lines.push(`HER PREVIOUS REPLY: ${i.prevHers !== undefined && i.prevHers.length > 0 ? i.prevHers.join(' / ') : '(none)'}`);
  if (i.selfEntry === true) {
    lines.push('HIS MESSAGE NOW: (none — she wrote first)');
  } else {
    lines.push(`HIS MESSAGE NOW${i.gapHours !== undefined && i.gapHours >= 1 ? ` (after ${Math.round(i.gapHours)} hours)` : ''}: ${i.his}`);
  }
  lines.push(`HER REPLY NOW: ${i.hers.length > 0 ? i.hers.join(' / ') : '(she stayed silent)'}`);
  return lines.join('\n');
};

export interface SlowAppraiseDeps {
  model: ModelClient;
  turnId?: string | undefined;
}

export type SlowResult = { ok: true; value: SlowAppraisal } | { ok: false; error: string };

export const appraiseSlow = async (i: SlowAppraiseInput, deps: SlowAppraiseDeps): Promise<SlowResult> => {
  const messages: ChatMsg[] = [
    { role: 'system', content: APPRAISER_SYSTEM },
    { role: 'user', content: appraiserUser(i) },
  ];
  try {
    const res = await deps.model.chat(
      {
        taskClass: 'appraisal',
        // The voice door (Sol). Live probe 2026-09-25: the cheap door graded
        // "that last one sounded kind of robotic" as her reply landing WELL (+1).
        // Her learning is only as real as this judgment; it runs after the
        // reply, so the stronger model costs no latency (~$0.008/turn).
        // back of house: gpt-5.6-luna (it grades a correction as a miss — the trap the old cheap door failed)
        tier: 'cheap',
        messages,
        schema: SlowAppraisalSchema,
        schemaName: 'SlowAppraisal',
        maxTokens: 1500,
        temperature: 0.2,
      },
      deps.turnId !== undefined ? { turnId: deps.turnId } : undefined,
    );
    return { ok: true, value: res.content };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
};

/**
 * Appraisal → ticker events. A tag the fast path already registered this turn
 * lands only as its increment (the ticker would habituate it anyway, but the
 * record should say what was new). `self` events carry their standard in the
 * cause, so the audit can prove every self-caused feeling names one.
 */
export const slowEvents = (
  a: SlowAppraisal,
  fast: ReadonlyArray<{ tag: string; i: number }>,
  expectCause?: string | undefined,
): Array<{ source: 'event' | 'self' | 'surprise'; event: EmotionEventInput }> => {
  const out: Array<{ source: 'event' | 'self' | 'surprise'; event: EmotionEventInput }> = [];
  const fastI = new Map<string, number>();
  for (const f of fast) fastI.set(f.tag, Math.max(fastI.get(f.tag) ?? 0, f.i));
  for (const e of a.event) {
    if (!isAppraisalTag(e.emotion)) continue;
    const i = e.i - (fastI.get(e.emotion) ?? 0);
    if (i <= 0) continue;
    out.push({ source: 'event', event: { kind: 'emotion', tag: e.emotion, i, cause: e.cause } });
  }
  for (const e of a.self) {
    if (!isAppraisalTag(e.emotion)) continue;
    out.push({ source: 'self', event: { kind: 'emotion', tag: e.emotion, i: e.i, cause: `${e.cause} [standard: ${e.standard}]` } });
  }
  // Prediction error → surprise, relief, disappointment (law 1.2b).
  const why = expectCause ?? 'what she expected';
  switch (a.expectation) {
    case 'confirmed':
      out.push({ source: 'surprise', event: { kind: 'emotion', tag: 'settled', i: 2, cause: `as she expected: ${why}` } });
      break;
    case 'better':
      out.push({ source: 'surprise', event: { kind: 'emotion', tag: 'surprised', i: 3, cause: `better than she expected: ${why}` } });
      out.push({ source: 'surprise', event: { kind: 'emotion', tag: 'delighted', i: 3, cause: `better than she expected: ${why}` } });
      break;
    case 'worse':
      out.push({ source: 'surprise', event: { kind: 'emotion', tag: 'surprised', i: 2, cause: `not what she hoped: ${why}` } });
      out.push({ source: 'surprise', event: { kind: 'emotion', tag: 'disappointed', i: 2, cause: `not what she hoped: ${why}` } });
      break;
    case 'different':
      out.push({ source: 'surprise', event: { kind: 'emotion', tag: 'surprised', i: 2, cause: `she expected something else: ${why}` } });
      break;
    default:
      break;
  }
  return out;
};

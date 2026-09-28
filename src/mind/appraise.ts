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
        // v12 agency (plan v12 §1.3): what she can do herself, or who it truly waits on
        next_self_step: z.string().max(160).optional(),
        blocked_on: z.string().max(60).optional(),
        // v12 questions (§1.1): could she find it out, and how much does she already know
        knowability: z.number().min(0).max(1).optional(),
        confidence: z.number().min(0).max(1).optional(),
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
  /**
   * v13 Phase 0 (the sincerity ledger): what her reply says about her OWN inner state right now,
   * extracted so it can be scored against what her engine held. Machinery — never shown to her.
   */
  // Monitoring only, so it must never sink the appraisal it rides in (her slow feelings, concerns and
  // outcome grading): nulls dropped, long quotes clipped, and anything still malformed is just lost
  // (review 2026-09-27).
  self_claims: z
    .preprocess(
      (v) =>
        Array.isArray(v)
          ? v
              .filter((c): c is Record<string, unknown> => c !== null && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string' && ((c as { text: string }).text.trim() !== ''))
              .slice(0, 3)
              .map((c) => ({
                text: String(c['text']).slice(0, 200),
                ...(typeof c['feeling'] === 'string' ? { feeling: c['feeling'].slice(0, 40) } : {}),
                ...(typeof c['about'] === 'string' ? { about: c['about'].slice(0, 120) } : {}),
              }))
          : v,
      z
        .array(z.object({ text: z.string().min(1).max(200), feeling: z.string().max(40).optional(), about: z.string().max(120).optional() }))
        .max(3)
        .optional(),
    )
    .catch(undefined),
  /**
   * Her memory of people (Diego, 2026-09-27: "she should have a memory for every person she meets,
   * what she knows about them, like a person does"): what this exchange showed about the person she
   * was talking with. Never sinks the appraisal (same guard as self_claims).
   */
  about_them: z
    .preprocess(
      (v) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').slice(0, 3).map((x) => x.trim().slice(0, 200)) : v),
      z.array(z.string().min(1).max(200)).max(3).optional(),
    )
    .catch(undefined),
  /** (2026-09-28) What stays true about them beyond today — kept apart, always in mind. */
  lasting_about_them: z
    .preprocess(
      (v) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').slice(0, 3).map((x) => x.trim().slice(0, 200)) : v),
      z.array(z.string().min(1).max(200)).max(3).optional(),
    )
    .catch(undefined),
  /** (2026-09-28) Where they said they are, "place, region, country" — his clock follows it. */
  where_they_are: z
    .preprocess((v) => (typeof v === 'string' && v.trim() !== '' && !/^(null|none|unknown)$/i.test(v.trim()) ? v.trim().slice(0, 120) : undefined), z.string().optional())
    .catch(undefined),
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
  /** Who she is talking with (a name) — whose facts about_them are. */
  who?: string | undefined;
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
  '- for a loop, give next_self_step: one concrete thing she could do about it herself, without anyone else. Only when there is truly nothing hers to do, give blocked_on instead (who it depends on).',
  '- open a curiosity (about "world", or "self") when the exchange touched something she does not know and could actually find out or ask about: a real gap, not trivia. Give knowability (0-1: could she find it out with a search, her memory, or by asking someone) and confidence (0-1: how much she already knows about it).',
  '- importance: how much this exchange matters to her life, 1-10.',
  '- expectation: compare HIS MESSAGE NOW with WHAT SHE PRIVATELY EXPECTED. "confirmed" when it fits the gist of any branch she expected (she expected him to go to sleep and he says goodnight = confirmed; she expected him to tease or open up and he teases = confirmed). "better" only when it clearly went better than she expected, "worse" only when it clearly went worse for her or for him (a correction, a hurt, bad news, a cold reply). "different" when it simply went somewhere else. null if she expected nothing or she wrote first. Most turns are confirmed or different.',
  '- Tags already registered in the moment (do not repeat them unless the feeling is clearly stronger now): listed below.',
  '- about_them: up to three short things this exchange showed about THE PERSON SHE IS TALKING WITH (named below) that belong to today: what they did, asked or were up to, how they talked just now. Plain facts in their own terms, never guesses about their feelings, never anything about Thea. Empty when nothing new.',
  '- lasting_about_them: up to three things about that person that stay true beyond today, as they said them: where they live or are staying, their work, the people in their life, plans, health, what they like or care about, what they want to be called. Empty when nothing new.',
  '- where_they_are: if that person said where they are now or live (a town, island, region or country), the place as "place, region, country" (e.g. "Canggu, Bali, Indonesia"); null otherwise. Only what they said, never a guess.',
  '- self_claims: each thing HER REPLY NOW says about her own inner state right now (how she feels, what she wants, what is going on inside her). text = her words; feeling = the one feeling word closest to what she claimed ("not sure" if she said she does not know); about = what she says it is about. Empty when she said nothing about herself.',
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
  if (i.who !== undefined && i.who !== '') lines.push(`THE PERSON SHE IS TALKING WITH: ${i.who}`);
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

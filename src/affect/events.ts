// M05 affect — the only inputs to the engine. Schema-validated at the store
// boundary: a tag outside EMOTION_TAGS is a hard zod reject + incident event,
// never a silent no-op (the orphan-tag pathology dies here). Strict objects —
// anything the engine does not understand is rejected, not stripped.

import { z } from 'zod';
import { EMOTION_TAGS, type EmotionTag } from './vocab.js';

/**
 * The whole vocabulary as one enum — M09's appraisal schema mirrors this via
 * z.enum(EMOTION_TAGS). A second hand-written list is exactly the drift that
 * orphaned ten tags in Thea1.
 */
export const EmotionTagSchema = z.enum([...EMOTION_TAGS] as [EmotionTag, ...EmotionTag[]]);

export const EmotionEvent = z
  .object({
    kind: z.literal('emotion'),
    tag: EmotionTagSchema,
    /** Diary intensity, 0-10 (engine clamps; the appraisal schema issues 1-10). */
    i: z.number().min(0).max(10),
    /** Short causal attribution — stored verbatim in the per-primary cause slots. */
    cause: z.string().min(1),
    /** Attribution context, stored verbatim as given. */
    people: z.string().min(1).optional(),
  })
  .strict();

export const TagFeedEvent = z
  .object({
    kind: z.literal('tagFeed'),
    /** Diary-line tag: her own DONE work, a MOMENT, a GIFT received. */
    tag: z.enum(['DONE', 'MOMENT', 'GIFT'] as const),
  })
  .strict();

export const SilenceTickEvent = z.object({ kind: z.literal('silenceTick') }).strict();

export const AffectEventSchema = z.discriminatedUnion('kind', [
  EmotionEvent,
  TagFeedEvent,
  SilenceTickEvent,
]);

export type AffectEvent = z.infer<typeof AffectEventSchema>;
export type EmotionEventInput = z.infer<typeof EmotionEvent>;

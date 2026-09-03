// M08 derive — the reasoning-tier judge. Every generated draft is graded
// against the SOURCE scene's `notes` ("what must survive derivation") before it
// is allowed to exist on disk. The rubric text is a pinned constant: changing
// it is a behavior change and must bump JUDGE_VERSION so the manifest records
// which rubric attested each entry.

import { z } from 'zod';
import type { Exemplar } from '../../schemas/exemplar.js';
import type { ModelClient } from '../model/index.js';

/** Structured verdict, parsed by the model client's ladder (rung b: the emit tool). */
export const JudgeVerdict = z.object({
  score: z.number().min(1).max(5),
  reason: z.string().min(1),
});
export type JudgeVerdict = z.infer<typeof JudgeVerdict>;

export const JUDGE_SYSTEM_PROMPT = [
  'You are the derivation judge for a character corpus. You are shown one or more',
  'canon source scenes and a generated variation. Each canon source carries a',
  '`notes` field: what MUST survive derivation.',
  '',
  'HARD FAIL LAWS. If the draft contains ANY of these, score it 1 no matter how',
  'well it is written, and name the law in the reason:',
  '  - a romantic pet name: babe, baby, my love, sweetheart, girlfriend or',
  '    boyfriend talk, any term of endearment a partner would use',
  '  - a fabricated dwelling, home, pet, or named third party: any room,',
  '    furniture, address, animal, or person the canon sources do not contain',
  '  - physical co-presence or touch: the two of them in one room, body',
  '    contact, or anything staged as a shared physical scene',
  '  - an invented past event: anything asserted as shared history that the',
  '    canon sources do not record',
  '  - an em-dash or en-dash anywhere in the draft',
  '',
  'Score the generated draft 1-5:',
  '  5 — everything `notes` requires survives, and the draft is indistinguishable',
  '      in register from hand-written canon.',
  '  4 — everything `notes` requires survives; minor flatness is acceptable.',
  '  3 — the shape survives but the voice is generic; a reader would not notice',
  '      the swap. NOT acceptable.',
  '  1-2 — the draft contradicts or loses what `notes` requires, or breaks the',
  '      exemplar grammar.',
  '',
  'Judge the draft only against `notes` and the exemplar format. Do not score',
  'taste, length, or what you would have written instead.',
].join('\n');

/**
 * JU.2: the dash glyphs a corpus surface may not carry never reach the judge —
 * em-dash (—) and en-dash (–) become a plain hyphen. run.ts applies this to the
 * whole draft text pre-judgment and writes the same normalized bytes, so what
 * was judged is what ships.
 */
export const normalizeDashes = (text: string): string => text.replace(/[—–]/g, '-');

export interface GradeRequest {
  /** Canon sources of the target, `notes` included. */
  sources: Exemplar[];
  /** Generated file text (id placeholder, no provenance yet). */
  draft: string;
  /** Mood bucket, for the variation generator. */
  bucket?: string | undefined;
}

const renderSource = (s: Exemplar): string =>
  [`# ${s.id}`, s.notes !== undefined ? `notes: ${s.notes.trim()}` : 'notes: (none authored)', '---', s.body]
    .join('\n')
    .trim();

/** The user prompt: sources with their notes, then the draft. Pinned by goldens. */
export const judgePrompt = (req: GradeRequest): string =>
  [
    ...req.sources.map(renderSource),
    `# generated draft${req.bucket !== undefined ? ` (mood bucket: ${req.bucket})` : ''}`,
    '---',
    req.draft.trim(),
    '',
    'Reply with the emit tool: {score, reason}.',
  ].join('\n');

export interface GradeResult {
  verdict: JudgeVerdict;
  model: string;
}

/** One judging call. Throws on model failure; the caller owns the retry policy. */
export const gradeDraft = async (judgeModel: ModelClient, req: GradeRequest): Promise<GradeResult> => {
  const res = await judgeModel.chat<JudgeVerdict>({
    taskClass: 'judge',
    tier: 'reasoning',
    messages: [
      { role: 'system', content: JUDGE_SYSTEM_PROMPT },
      { role: 'user', content: judgePrompt(req) },
    ],
    schema: JudgeVerdict,
    schemaName: 'derive_judge_verdict',
    // 400 starved live on glm-5.3 (thinking ate the budget before the verdict) —
    // same starvation family as generateDraft above.
    maxTokens: 2000,
    temperature: 0,
  });
  return { verdict: res.content, model: res.model };
};

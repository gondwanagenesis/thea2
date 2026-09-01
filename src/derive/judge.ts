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
    maxTokens: 400,
    temperature: 0,
  });
  return { verdict: res.content, model: res.model };
};

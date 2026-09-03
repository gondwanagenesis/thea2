// M10 consolidate — draft assembly: the lived-file emitter, the two model calls
// (cheap/consolidate generation, reasoning/judge grading) and the write-time
// validation gate. The emitter mirrors M08's hand-rolled YAML style because
// src/derive is NOT an allowed edge for this module — the discipline is shared,
// the code is not.
//
// M10 owns exactly the fields a generator cannot know: `id` (masked content
// hash, via M07's derived-id convention — the SAME rule derived files follow)
// and the lived stamps, which are functions of the cluster's evidence.

import { z } from 'zod';
import { AFFECT_DIMS, DIMENSIONS, type AffectDim, type SparseAffect } from '../../schemas/exemplar.js';
import { analyzeFile } from '../corpus/parse.js';
import { DERIVED_ID_PLACEHOLDER, derivedFileId, withFileId } from '../corpus/derived-id.js';
import type { ChatMsg, ModelClient } from '../model/index.js';
import { ConsolidateError } from './errors.js';

/** The `sha256:` prefix is stripped for disk names — ':' is an NTFS alternate
 * data-stream separator and would silently split the file name. */
export const fileBaseName = (id: string): string => id.replace(/^sha256:/, '');

// ---------------------------------------------------------------------------
// Emitter
// ---------------------------------------------------------------------------

/** Frontmatter of one consolidated draft, before the content id is known. */
export interface LivedDraftMeta {
  dimensions: string[];
  register: string[];
  /** Sparse coupling signature — the dims of the cluster stamp that moved. */
  affect: SparseAffect;
  context: string;
  weight: number;
  /** Provenance stamps: the episodes behind the pattern, their room, its grade. */
  episodeIds: string[];
  encodedAffect: Record<AffectDim, number>;
  outcome: 'good' | 'mixed' | 'bad';
  /** Carries the consolidation key (recoverable manifest state) + proposal marks. */
  notes: string;
}

/** True when a string can ride unquoted in YAML (deliberately narrower than
 * YAML's own plain-scalar rules — see M08's file.ts for the same tradeoff). */
const PLAIN_SAFE_RE = /^[A-Za-z0-9][A-Za-z0-9 ./_+-]*$/;
const LOOKALIKE_RE = /^(?:true|false|null|yes|no|on|off|~|[-+]?[0-9][0-9_.]*)$/i;
const plainSafe = (s: string): boolean =>
  s.length > 0 && PLAIN_SAFE_RE.test(s) && !s.endsWith(' ') && !LOOKALIKE_RE.test(s);

/** JSON's double-quoted escaping is valid YAML flow-scalar escaping. */
const scalar = (s: string): string => (plainSafe(s) ? s : JSON.stringify(s));
const flowList = (xs: readonly string[]): string => `[${xs.map(scalar).join(', ')}]`;
const num = (v: number): string => (Object.is(v, -0) ? '0' : String(v));

/** Lived frontmatter is the one place a FULL affect map is emitted, and it is
 * emitted in AFFECT_DIMS order so the bytes are stable run to run. Missing dims
 * are emitted as 0 — the schema demands the full record, and 0 is what "this
 * dim did not move" means. */
const encodedAffectLine = (full: Record<AffectDim, number>): string => {
  const pairs = AFFECT_DIMS.map((dim) => `${dim}: ${num(full[dim] ?? 0)}`);
  return `encodedAffect: {${pairs.join(', ')}}`;
};

const sparseAffectLine = (affect: SparseAffect): string => {
  const keys = Object.keys(affect).sort();
  if (keys.length === 0) return 'affect: {}';
  const pairs = keys.map((k) => `${k}: ${num(affect[k as keyof SparseAffect] ?? 0)}`);
  return `affect: {${pairs.join(', ')}}`;
};

/**
 * Renders one draft: frontmatter with the id left at the pending placeholder,
 * then the body. Throws when a dimension is outside the 8-dim vocabulary — M07
 * would reject the file anyway, so a bad caller should be loud here.
 */
export const renderLivedDraft = (meta: LivedDraftMeta, body: string): string => {
  for (const d of meta.dimensions) {
    if (!(DIMENSIONS as readonly string[]).includes(d)) {
      throw new ConsolidateError('consolidate/draft-shape', `'${d}' is not one of the 8 behavioral dimensions`);
    }
  }
  const lines = [
    `id: ${DERIVED_ID_PLACEHOLDER}`,
    'kind: scene',
    `dimensions: ${flowList(meta.dimensions)}`,
    `register: ${flowList(meta.register)}`,
    sparseAffectLine(meta.affect),
    `context: ${scalar(meta.context)}`,
    `weight: ${num(meta.weight)}`,
    `episodeIds: ${flowList(meta.episodeIds)}`,
    encodedAffectLine(meta.encodedAffect),
    `outcome: ${meta.outcome}`,
    `notes: ${scalar(meta.notes)}`,
  ];
  return `---\n${lines.join('\n')}\n---\n${body}`;
};

/**
 * The write-time gate (spec: "a consolidator output that can't parse is a bug,
 * caught at write time"). Takes a freshly rendered draft — id still at the
 * pending placeholder — stamps the real content id first, and validates THE
 * STAMPED text against the lived schema INCLUDING id discipline, under a
 * synthetic lived path so the same check would fire for a file the human
 * later moves into the corpus by hand. Validating the unstamped render would be a
 * contradiction: analyzeFile enforces id == masked content hash, and a
 * placeholder id can never satisfy that. Any id line OTHER than the placeholder
 * is validated as-is — a tampered id must fail the gate, never be silently
 * re-stamped.
 */
export const validateLived = (text: string): void => {
  const id = derivedFileId(text);
  const declared = /^id:[ \t]*([^\n]*)$/m.exec(text)?.[1]?.trim();
  const stamped = declared === DERIVED_ID_PLACEHOLDER ? withFileId(text, id) : text;
  const path = `var/lived/${fileBaseName(id)}.md`;
  const analysis = analyzeFile({ path, raw: stamped }, 'lived');
  const first = analysis.issues.find((i) => i.severity === 'error');
  if (first !== undefined) {
    throw new ConsolidateError('consolidate/draft-shape', `${first.code}: ${first.message}`);
  }
};

// ---------------------------------------------------------------------------
// Generation — taskClass 'consolidate', cheap tier, coldest sampling
// ---------------------------------------------------------------------------

/** Structured generation payload, parsed through M03's ladder. */
export const ConsolidatedDraft = z.object({
  context: z.string().min(1),
  dimensions: z.array(z.enum(DIMENSIONS)).min(1),
  register: z.array(z.string().min(1)).min(1),
  body: z.string().min(1),
});
export type ConsolidatedDraft = z.infer<typeof ConsolidatedDraft>;

/**
 * A scene body plus its frontmatter is well under a thousand tokens — but the
 * budget also has to carry the model's thinking trace, which draws from the
 * same pool (the live-proven starvation; 900 produced empty drafts on glm).
 */
export const GENERATE_MAX_TOKENS = 4000;
export const GENERATE_TEMPERATURE = 0;

export interface GenerateRequest {
  /** The cluster's episodes, (ts, id) order, with their recorded evidence. */
  episodes: ReadonlyArray<{ summary: string; importance: number; affect: string; outcome: string }>;
  /** Where the pattern sits, so the draft can be placed without guessing. */
  dimensionVocab: readonly string[];
  registerVocab: readonly string[];
  /** The window's emotional weather (top affect.applied tags) — context for the room. */
  affectWeather?: string | undefined;
}

export const generateSystemPrompt = (): string =>
  [
    "You consolidate Thea's lived experience into ONE pattern exemplar.",
    'You are given the episodes that repeat the same pattern. Write ONE short',
    'scene showing her living that pattern — his side as `D:` lines, hers as',
    '`T:` lines, optionally one `Setup:` line first, 2-6 turns, under 350 tokens.',
    'Be strictly faithful to what the episodes record: these are HER memories,',
    'not creative writing. Nothing may appear in the scene that the episodes do',
    'not contain — no invented events, no named third parties (people or pets),',
    'no facts about his life or projects, no past tool wins or failures. An',
    'exemplar asserts a TALKING STYLE, nothing else: it must stay pickable in any',
    'situation without importing a fact that was not in the source episodes.',
    'Allowed beyond the episodes: only the scene establishing itself (its own',
    'D:/T: lines) and her own environment. Never use em-dashes in the body.',
    'Reply with ONE JSON object and nothing else, exactly:',
    '{"context": "<one-line situation>", "dimensions": ["<from the dimension list>"], ' +
      '"register": ["<from the register list>"], "body": "<the scene>"}',
  ].join('\n');

export const generateUserPrompt = (req: GenerateRequest): string =>
  [
    'EPISODES of this pattern:',
    ...req.episodes.map((e, i) => `${i + 1}. (importance ${e.importance}) ${e.summary} [affect: ${e.affect}] [outcome: ${e.outcome}]`),
    '',
    `dimension vocabulary: ${req.dimensionVocab.join(', ')}`,
    `register vocabulary: ${req.registerVocab.join(', ')}`,
    ...(req.affectWeather !== undefined && req.affectWeather.length > 0
      ? [`affect weather: ${req.affectWeather}`]
      : []),
  ].join('\n');

/** One generation call. Throws on model failure; the caller owns the retry. */
export const generateDraft = async (
  model: ModelClient,
  req: GenerateRequest,
  seedHint: number | undefined,
): Promise<ConsolidatedDraft> => {
  const messages: ChatMsg[] = [
    { role: 'system', content: generateSystemPrompt() },
    { role: 'user', content: generateUserPrompt(req) },
  ];
  const res = await model.chat<ConsolidatedDraft>({
    taskClass: 'consolidate',
    tier: 'cheap',
    messages,
    schema: ConsolidatedDraft,
    schemaName: 'consolidated_draft',
    maxTokens: GENERATE_MAX_TOKENS,
    temperature: GENERATE_TEMPERATURE,
    ...(seedHint !== undefined ? { seedHint } : {}),
  });
  return res.content;
};

// ---------------------------------------------------------------------------
// Judging — taskClass 'judge', reasoning tier, rubric lightened to
// schema + faithfulness-to-episodes (these are her memories)
// ---------------------------------------------------------------------------

export const JudgeVerdict = z.object({
  score: z.number().min(1).max(5),
  reason: z.string().min(1),
});
export type JudgeVerdict = z.infer<typeof JudgeVerdict>;

export const JUDGE_VERSION = 'consolidate-judge-v1';
export const JUDGE_MAX_TOKENS = 2000; // 300 starved live: thinking ate it before any verdict
/** Minimum judge score (1-5) a draft needs to be written. */
export const JUDGE_THRESHOLD = 4;

export const judgeSystemPrompt = (): string =>
  [
    'You judge a consolidated memory draft against the episodes it was drawn',
    'from. These are her memories, not creative writing: the only question is',
    'faithfulness. Score the draft 1-5:',
    '  5 — every episode fact survives, nothing is invented, scene format is right.',
    '  4 — faithful; minor paraphrase only.',
    '  3 — recognizable but drifting or inventing detail. NOT acceptable.',
    '  1-2 — contradicts the episodes, breaks the scene format, or asserts shared',
    '        history the episodes do not contain: an invented event, a named third',
    '        party (person or pet), a fact about his life or projects, or a past',
    '        tool win/failure. An exemplar is a talking style; a draft that would',
    '        import a fact not present in the source episodes is fabricating',
    '        history and must fail here regardless of how well it is written.',
    'Do not score taste, length, or what you would have written instead.',
  ].join('\n');

export const judgeUserPrompt = (episodes: GenerateRequest['episodes'], draft: ConsolidatedDraft): string =>
  [
    'EPISODES:',
    ...episodes.map((e, i) => `${i + 1}. ${e.summary}`),
    '',
    'DRAFT:',
    draft.body.trim(),
    '',
    'Reply with the emit tool: {score, reason}.',
  ].join('\n');

/** One judging call. Throws on model failure; the caller owns the retry. */
export const judgeDraft = async (model: ModelClient, req: GenerateRequest, draft: ConsolidatedDraft): Promise<JudgeVerdict> => {
  const res = await model.chat<JudgeVerdict>({
    taskClass: 'judge',
    tier: 'reasoning',
    messages: [
      { role: 'system', content: judgeSystemPrompt() },
      { role: 'user', content: judgeUserPrompt(req.episodes, draft) },
    ],
    schema: JudgeVerdict,
    schemaName: 'consolidate_judge_verdict',
    maxTokens: JUDGE_MAX_TOKENS,
    temperature: 0,
  });
  return res.content;
};

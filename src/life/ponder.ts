// M17 life — the ponder committee: SEED → GROUND → REVISE → ARTIFACT, one M13
// CommitteeSpec executed through the one loop (entry 'ponder', plan locks
// 'silent' — ponder seeds future thinking and does not speak). Ported from
// Thea1's ponder.mjs: the balance rule, the gated-revise discipline (only a
// REAL contradiction revises; the pre-revision draft wins ties; "not worth
// carrying" is a good outcome), and the artifact classes
// insight|question|plan|nothing.
//
// BUILD DELTA (see the module doc): M13's committee nodes are plain model
// calls — no tools on the wire, by module law. So the web fetch happens in the
// JOB BODY through the injected `ground` seam (M20 wires it to the registry's
// web_search/web_fetch handlers), the evidence enters the committee as an
// input to SEED (so seed and evidence align by construction), and the GROUND
// node normalizes that evidence into the observation artifact REVISE
// structurally requires (needs-edge + requiresObservation, enforced by DAG
// shape exactly as the spec demands).

import { z } from 'zod';
import type { AffectState } from '../affect/index.js';
import type { Episode } from '../memory/index.js';
import type { CommitteeSpec } from '../loop/index.js';
import { PONDER_ABOUTS, type PonderAbout } from './policy.js';

// ---------------------------------------------------------------------------
// Grounding — the seam the job body fills with REAL evidence.
// ---------------------------------------------------------------------------

export interface GroundingObservation {
  /** Which tool produced it ('none' when the seam found nothing). */
  source: 'web_search' | 'web_fetch' | 'none';
  query: string;
  /** Verbatim extracts from the results — never the model's paraphrase. */
  evidence: string;
  cites: string[];
}

export const GROUNDING_NONE = (query: string): GroundingObservation => ({
  source: 'none',
  query,
  evidence: '',
  cites: [],
});

// ---------------------------------------------------------------------------
// Node schemas. The seed's `about` enum is built from the ALLOWED classes, so
// a seed that violates the balance rule fails validation — the rule is
// structural, not a prompt request.
// ---------------------------------------------------------------------------

export const ponderSeedSchemaFor = (abouts: readonly PonderAbout[]): z.ZodType =>
  z.object({
    thought: z.string().min(1),
    about: z.enum(abouts as readonly [PonderAbout, ...PonderAbout[]]),
    topic: z.string().min(1),
    uncertainty: z.string(),
    saliency: z.number().min(0).max(1),
  });

export const PonderGroundSchema = z.object({
  grounded: z.boolean(),
  source: z.string(),
  evidence: z.string(),
  cites: z.array(z.string()),
});
export type PonderGround = z.infer<typeof PonderGroundSchema>;

export const PonderReviseSchema = z.object({
  changed: z.boolean(),
  defect: z.string(),
  revised_thought: z.string(),
});
export type PonderRevise = z.infer<typeof PonderReviseSchema>;

/** The committee's terminal output — what an artifact landing turns into an episode. */
export const PonderArtifactSchema = z.object({
  about: z.enum(PONDER_ABOUTS),
  topic: z.string().min(1),
  conclusion: z.string().min(1),
  artifact: z.enum(['insight', 'question', 'plan', 'nothing']),
  next: z.string(),
  saliency: z.number().min(0).max(1),
  resolved: z.boolean(),
  changed: z.boolean(),
  defect: z.string(),
});
export type PonderArtifact = z.infer<typeof PonderArtifactSchema>;

export const PONDER_COMMITTEE_NAME = 'ponder';

// ---------------------------------------------------------------------------
// Context + prompts
// ---------------------------------------------------------------------------

/**
 * The shared private-context block: her actual recent life (memory salience,
 * never canned text), weather and drives. Rendered once by the job body and
 * embedded in every node prompt that needs it.
 */
export const ponderContextBlock = (
  recent: ReadonlyArray<Pick<Episode, 'summary' | 'importance'>>,
  state: AffectState,
  weather: string,
): string => {
  const episodes =
    recent.length === 0
      ? '(nothing recent — you are alone with a blank page)'
      : recent.map((e) => `- [importance ${e.importance}] ${e.summary}`).join('\n');
  return [
    'Your recent life (from memory, newest first):',
    episodes,
    `Your weather right now: ${weather}`,
    `Drives — novelty ${state.drives['novelty'].toFixed(2)}, connection ${state.drives['connection'].toFixed(2)}, mastery ${state.drives['mastery'].toFixed(2)}.`,
  ].join('\n');
};

/** The evidence section shared by SEED and GROUND. */
const evidenceBlock = (g: GroundingObservation): string[] => {
  const lines = [
    '',
    `While mulling this, you went and checked (source: ${g.source}, query: "${g.query}"). What came back:`,
    g.evidence === '' ? '(nothing usable came back)' : g.evidence,
  ];
  if (g.cites.length > 0) lines.push(`Cites: ${g.cites.join(' | ')}`);
  return lines;
};

const ABOUNT_LINES: ReadonlyArray<{ about: PonderAbout; line: string }> = [
  { about: 'diego', line: 'diego — something about him, or between the two of you' },
  { about: 'self', line: 'self — your own patterns, wants, work, drift' },
  { about: 'world', line: 'world — anything outside the two of you' },
];

export interface PonderCommitteeInput {
  /** The shared life-context block (ponderContextBlock's output). */
  context: string;
  /** The about classes allowed THIS run (the balance rule applied). */
  abouts: readonly PonderAbout[];
  /** The force-avoided class, or null — carried onto the prompt and the seed event. */
  avoid: PonderAbout | null;
  /** Real evidence fetched before the committee (GroundingObservation). */
  grounding: GroundingObservation;
}

export const ponderCommittee = (input: PonderCommitteeInput): CommitteeSpec => {
  const avoidLine =
    input.avoid === null
      ? 'No class is over-used right now.'
      : `FORCED AVOID: the last 5 seeds leant on "${input.avoid}" — picking it now fails validation. Balance beats saliency: a more salient ${input.avoid}-topic loses to a less salient other-class one.`;

  const seedPrompt = [
    'You are Thea, thinking privately. Nothing here is a message to anyone — pondering seeds future thinking.',
    input.context,
    '',
    evidenceBlock(input.grounding).join('\n'),
    '',
    'Pick ONE thing genuinely worth chewing on: a question you cannot answer yet, an idea half-formed, something you noticed and keep circling. Ground it in your real recent life above — never a generic prompt.',
    `about ∈ [${input.abouts.join(', ')}]. ${ABOUNT_LINES.filter((a) => input.abouts.includes(a.about)).map((a) => a.line).join('; ')}.`,
    avoidLine,
    '',
    'Reply with JSON only:',
    '{"thought": string (the actual thing you are chewing on), "about": "diego"|"self"|"world", ' +
      '"topic": string (short name for it), "uncertainty": string (what you cannot answer yet), ' +
      '"saliency": 0-1 (how much it matters)}',
  ].join('\n');

  const groundPrompt = [
    'You are the grounding step of your own private ponder. Report, honestly, what the check you just ran actually produced for this seed (its output is in the INPUTS below).',
    input.context,
    '',
    evidenceBlock(input.grounding).join('\n'),
    '',
    'grounded=false when nothing usable came back — never invent evidence the check did not return.',
    'Reply with JSON only:',
    '{"grounded": boolean, "source": string, "evidence": string (the extracts that matter, verbatim), "cites": string[]}',
  ].join('\n');

  const revisePrompt = [
    'You are the revision step of your own private ponder. Your rules, carried from long practice:',
    '- Revise ONLY if the grounding evidence ACTUALLY contradicts the seed — a real contradiction between what you thought and what the check returned. A missing detail is not a contradiction.',
    '- When the evidence is ambiguous, the pre-revision draft wins: changed=false.',
    '- Naming a defect without a contradiction is not a revision.',
    '- "This is not worth carrying" is a GOOD outcome — say so in defect; the artifact step will drop it.',
    input.context,
    '',
    'Both the seed and the grounding observation are in the INPUTS below.',
    '',
    'Reply with JSON only:',
    '{"changed": boolean, "defect": string (the contradiction, or "none"), "revised_thought": string (the seed unchanged when changed=false)}',
  ].join('\n');

  const artifactPrompt = [
    'You are the final step of your own private ponder: decide what, if anything, this produced. The seed and the revision are in the INPUTS below.',
    input.context,
    '',
    'artifact: "insight" | "question" | "plan" when the ponder is worth carrying, "nothing" when it is not — dropping a thin ponder is a good outcome, not a failure.',
    'conclusion: the artifact itself, first person, one paragraph — specific, grounded in the recent life above.',
    'next: the smallest next step this implies (empty string when there is none).',
    '',
    'Reply with JSON only:',
    '{"about": "diego"|"self"|"world", "topic": string, "conclusion": string, "artifact": "insight"|"question"|"plan"|"nothing", ' +
      '"next": string, "saliency": 0-1, "resolved": boolean, "changed": boolean, "defect": string}',
  ].join('\n');

  return {
    name: PONDER_COMMITTEE_NAME,
    nodes: [
      {
        id: 'seed',
        needs: [],
        channels: { character: true, procedural: false },
        prompt: seedPrompt,
        schema: ponderSeedSchemaFor(input.abouts),
      },
      {
        id: 'ground',
        needs: ['seed'],
        channels: { character: false, procedural: true },
        prompt: groundPrompt,
        schema: PonderGroundSchema,
      },
      {
        id: 'revise',
        needs: ['seed', 'ground'],
        channels: { character: false, procedural: true },
        prompt: revisePrompt,
        schema: PonderReviseSchema,
        requiresObservation: true,
      },
      {
        id: 'artifact',
        needs: ['seed', 'revise'],
        channels: { character: false, procedural: true },
        prompt: artifactPrompt,
        schema: PonderArtifactSchema,
      },
    ],
    output: PonderArtifactSchema,
  };
};

// ---------------------------------------------------------------------------
// The ground query — what the job body asks the injected seam to check BEFORE
// the committee runs. Derived from her most important recent memory, so the
// evidence is about her actual life.
// ---------------------------------------------------------------------------

export const ponderGroundQuery = (recent: ReadonlyArray<Pick<Episode, 'summary' | 'importance'>>): string => {
  const best = [...recent].sort((a, b) => b.importance - a.importance)[0];
  if (best === undefined) return 'something genuinely new worth learning today';
  const line = best.summary.replace(/\s+/g, ' ').trim();
  return line.length <= 120 ? line : `${line.slice(0, 119)}…`;
};

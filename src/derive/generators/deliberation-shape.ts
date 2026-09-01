// M08 derive — generator 3 of 4: deliberation-shape.
//
// Traces of assess→decide reasoning: one target per canon exemplar carrying the
// 'reasoning' dimension (the spec gives this generator no fan-out rule, so the
// rule is "one per reasoning canon source" — deterministic, O(canon), and every
// source keeps a 1:1 provenance link for the judge to grade against).

import type { DerivedTarget, DeriveInputs, Generator, GenerateDeps } from '../types.js';
import { makeTarget, singleSource, sortedCanon, generateDraft } from './shared.js';
import { renderDraft } from '../file.js';
import { sourceOf } from './mood-variant.js';

export const DELIBERATION_SYSTEM = [
  'You write one deliberation-shape exemplar for a character corpus: the shape of',
  'her assessing a situation and deciding, as she would say it to herself.',
  'Rules:',
  '- Output ONLY the exemplar body as plain prose lines, one per beat.',
  '- No headers, no bullets, no labels like "assess" or "decide" — the shape must',
  '  be legible without being announced.',
  '- Name the thing she is weighing, the thing she is protecting, and the call.',
  '- If she decides not to act, that is still a decision; do not force a plan.',
].join('\n');

const userPrompt = (sourceId: string, notes: string | undefined, body: string): string =>
  [
    `# canon source ${sourceId} (the reasoning shape to reproduce)`,
    notes !== undefined ? `notes (must survive):\n${notes.trim()}` : 'notes: (none authored)',
    '---',
    body,
  ].join('\n');

export const deliberationShapeGenerator: Generator = {
  name: 'deliberation-shape',
  version: '1',

  targets: (inputs: DeriveInputs): DerivedTarget[] =>
    sortedCanon(inputs)
      .filter((e) => e.dimensions.includes('reasoning'))
      .map((e) => makeTarget({ name: 'deliberation-shape', version: '1' }, DELIBERATION_SYSTEM, singleSource(e))),

  generate: async (t: DerivedTarget, deps: GenerateDeps): Promise<string> => {
    const source = sourceOf(t, deps);
    const { body } = await generateDraft(
      { system: DELIBERATION_SYSTEM, user: userPrompt(source.id, source.notes, source.body) },
      deps,
    );
    return renderDraft(
      {
        kind: 'statement',
        dimensions: [...source.dimensions],
        register: [...source.register],
        affect: { ...source.affect },
        context: `deliberation shape — ${source.context}`,
        weight: source.weight,
      },
      // kind: statement is the only kind whose body may be prose.
      body,
    );
  },
};

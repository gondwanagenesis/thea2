// M08 derive — generator 2 of 4: procedural.
//
// One synthesized procedure exemplar per (tool × canon behavior pair): the
// ToolDefs M08 receives as input (M13 owns the registry) crossed with the canon
// scenes that demonstrate tool-use behavior. Output lands in the procedural
// channel (ADR-009) — kind: procedure with a machine-readable trace block.

import type { Exemplar } from '../../../schemas/exemplar.js';
import { canonicalJson, contentHash } from '../../kernel/index.js';
import { compareStrings } from '../../corpus/types.js';
import type { DerivedTarget, DeriveInputs, Generator, GenerateDeps } from '../types.js';
import { makeTarget, singleSource, sortedCanon, generateDraft } from './shared.js';
import { renderDraft } from '../file.js';
import { sourceOf } from './mood-variant.js';

export const PROCEDURAL_SYSTEM = [
  'You write one procedural exemplar for a character corpus: her using a real tool',
  'as a reflex, not an announced mode-switch.',
  'Rules:',
  '- Output ONLY the exemplar body.',
  '- Optional `Setup:` line, then a `D:` turn, then the trace, then her `T:` turns.',
  '- The trace is machine-readable and MUST use exactly this shape:',
  '  [tool] <tool-name> {json args} -> what came back',
  '  [outcome] good|mixed|bad — what happened because she checked',
  '- She never says "let me look that up". There is just the result of having looked.',
  "- The source's shape shows in her answer (\"their status page says\").",
].join('\n');

const toolBlock = (tool: { name: string; description: string; parameters: unknown }): string =>
  [`tool: ${tool.name}`, `description: ${tool.description}`, `parameters: ${canonicalJson(tool.parameters)}`].join('\n');

const userPrompt = (scene: Exemplar, tool: { name: string; description: string; parameters: unknown }): string =>
  [
    `# tool to use`,
    toolBlock(tool),
    '',
    `# canon scene ${scene.id} (the behavior to reproduce)`,
    `context: ${scene.context}`,
    scene.notes !== undefined ? `notes (must survive):\n${scene.notes.trim()}` : 'notes: (none authored)',
    '---',
    scene.body,
  ].join('\n');

export const proceduralGenerator: Generator = {
  name: 'procedural',
  version: '1',

  targets: (inputs: DeriveInputs): DerivedTarget[] => {
    const toolScenes = sortedCanon(inputs).filter((e) => e.dimensions.includes('tool-use'));
    const tools = [...inputs.toolDefs].sort((a, b) => compareStrings(a.name, b.name));
    const out: DerivedTarget[] = [];
    for (const tool of tools) {
      for (const scene of toolScenes) {
        out.push(
          makeTarget(
            { name: 'procedural', version: '1' },
            PROCEDURAL_SYSTEM,
            { ...singleSource(scene), toolDefsHash: contentHash(canonicalJson(tool)) },
          ),
        );
      }
    }
    return out;
  },

  generate: async (t: DerivedTarget, deps: GenerateDeps): Promise<string> => {
    const scene = sourceOf(t, deps);
    const toolName = t.inputs.toolDefsHash;
    const tool = deps.inputs.toolDefs.find((d) => contentHash(canonicalJson(d)) === toolName);
    if (tool === undefined) {
      throw new Error(`generate: tool with hash '${toolName ?? '(none)'}' is not in the run inputs`);
    }
    const { body } = await generateDraft(
      { system: PROCEDURAL_SYSTEM, user: userPrompt(scene, tool) },
      deps,
    );
    return renderDraft(
      {
        kind: 'procedure',
        dimensions: [...scene.dimensions],
        register: [...scene.register],
        affect: { ...scene.affect },
        context: `procedure — ${scene.context}`,
        weight: scene.weight,
      },
      body,
    );
  },
};

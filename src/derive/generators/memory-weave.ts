// M08 derive — generator 4 of 4: memory-weave.
//
// Exemplars braiding canon scenes into one rendered memory — the [MEMORY] flash
// shape in the packet. The spec names the output (2–3 sources braided) but no
// fan-out rule; the v1 rule is one target per ADJACENT pair of id-sorted canon
// scenes. Deterministic, O(canon), no scene appears in more than two targets,
// and every target keeps a 1:1 provenance list the judge can grade against.

import { AFFECT_DIMS, type SparseAffect } from '../../../schemas/exemplar.js';
import { compareStrings } from '../../corpus/types.js';
import type { DerivedTarget, DeriveInputs, Generator, GenerateDeps } from '../types.js';
import { makeTarget, sortedCanon, generateDraft } from './shared.js';
import { canonSourceHash } from '../keys.js';
import { renderDraft } from '../file.js';
import type { Exemplar } from '../../../schemas/exemplar.js';

export const MEMORY_WEAVE_SYSTEM = [
  'You write one memory exemplar for a character corpus: two moments braided into',
  'one recollection, the way a memory actually surfaces.',
  'Rules:',
  '- Output ONLY the exemplar body as plain prose lines, one per beat.',
  '- Do not narrate that this is a memory of two things; let the braid be felt.',
  '- Keep her voice: lower-case, specific, unhurried, no closing period.',
  '- End on the thing the second moment left behind.',
].join('\n');

const userPrompt = (sources: Exemplar[]): string =>
  sources
    .map((s) => [`# canon scene ${s.id}`, `context: ${s.context}`, '---', s.body].join('\n'))
    .join('\n\n');

/** Strongest signal wins per dimension; ties keep the first source's sign. */
const mergeAffect = (sources: Exemplar[]): SparseAffect => {
  const out: Record<string, number> = {};
  for (const s of sources) {
    for (const [k, v] of Object.entries(s.affect)) {
      if (!(AFFECT_DIMS as readonly string[]).includes(k)) continue;
      const current = out[k];
      if (current === undefined || Math.abs(v) > Math.abs(current)) out[k] = v;
    }
  }
  return out as SparseAffect;
};

const unionRegisters = (sources: Exemplar[]): string[] => {
  const seen = new Set<string>();
  for (const s of sources) for (const tag of s.register) seen.add(tag);
  return [...seen].sort(compareStrings);
};

export const memoryWeaveGenerator: Generator = {
  name: 'memory-weave',
  version: '1',

  targets: (inputs: DeriveInputs): DerivedTarget[] => {
    const scenes = sortedCanon(inputs).filter((e) => e.kind === 'scene');
    const out: DerivedTarget[] = [];
    for (let i = 0; i + 1 < scenes.length; i++) {
      const a = scenes[i];
      const b = scenes[i + 1];
      if (a === undefined || b === undefined) continue;
      out.push(
        makeTarget({ name: 'memory-weave', version: '1' }, MEMORY_WEAVE_SYSTEM, {
          canonIds: [
            { id: a.id, sha256: canonSourceHash(a) },
            { id: b.id, sha256: canonSourceHash(b) },
          ],
        }),
      );
    }
    return out;
  },

  generate: async (t: DerivedTarget, deps: GenerateDeps): Promise<string> => {
    const sources = t.inputs.canonIds.map((c) => {
      const found = deps.inputs.canon.find((e) => e.id === c.id);
      if (found === undefined) throw new Error(`generate: canon source '${c.id}' is not in the run inputs`);
      return found;
    });
    const { body } = await generateDraft({ system: MEMORY_WEAVE_SYSTEM, user: userPrompt(sources) }, deps);
    return renderDraft(
      {
        kind: 'statement',
        dimensions: sources[0] !== undefined ? [...sources[0].dimensions] : [],
        register: unionRegisters(sources),
        affect: mergeAffect(sources),
        context: sources.map((s) => s.context).join(' / '),
        weight: sources[0]?.weight ?? 1,
      },
      body,
    );
  },
};

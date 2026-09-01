// M08 derive — generator 1 of 4: mood-variant.
//
// One register/mood-conditioned variation per (canon scene × coarse mood
// bucket), at most MAX_VARIANTS_PER_SCENE per scene — the per-scene half of the
// fan-out caps, enforced here at enumeration (never post-hoc).

import type { Exemplar } from '../../../schemas/exemplar.js';
import type { DerivedTarget, DeriveInputs, Generator, GenerateDeps } from '../types.js';
import { MAX_VARIANTS_PER_SCENE } from '../types.js';
import { makeTarget, singleSource, sortedCanon, generateDraft, bucketsFor } from './shared.js';
import { renderDraft } from '../file.js';

/**
 * The template is pinned: it is half of every mood-variant deriveKey, so
 * rewording it dirties the generator's whole family (a full, reviewed
 * regeneration — ADR-007). The bucket directive is part of the template text
 * per bucket, which is what keeps two buckets of one scene from colliding on
 * a key.
 */
export const MOOD_VARIANT_SYSTEM = [
  'You write one variation of a canon scene for a character corpus.',
  'Rules:',
  '- Output ONLY the exemplar body: optional `Setup:` lines, then alternating `D:` / `T:` turns.',
  '- `D:` is the human, `T:` is the character. Start with a `D:` turn.',
  '- Preserve what the scene notes say must survive. Never explain, never add headers.',
  '- Keep the character lower-case, specific, and unhurried. No closing period on her lines.',
].join('\n');

const bucketDirective = (bucket: string): string =>
  `\n[mood bucket: ${bucket}] Recolor the scene into this register without changing its facts or its shape.`;

const ANGLES = [
  'come at it sideways — answer a question he did not quite ask',
  'let one concrete physical detail carry the mood',
  'keep it short; two turns, the second one doing the work',
  'give her one aside about her own day that he did not ask about',
];

/** The per-bucket prompt text — the other half of the template hash. */
export const moodVariantTemplate = (bucket: string): string =>
  `${MOOD_VARIANT_SYSTEM}\n${bucketDirective(bucket)}`;

const userPrompt = (scene: Exemplar, bucket: string, angle: string): string =>
  [
    `# canon scene ${scene.id}`,
    `context: ${scene.context}`,
    scene.notes !== undefined ? `notes (must survive):\n${scene.notes.trim()}` : 'notes: (none authored)',
    '---',
    scene.body,
    '---',
    `Write the ${bucket} variant.`,
    `Angle: ${angle}`,
  ].join('\n');

/** The canon scene behind a single-source target; a missing source is a caller bug. */
export const sourceOf = (t: DerivedTarget, deps: GenerateDeps): Exemplar => {
  const id = t.inputs.canonIds[0]?.id;
  const found = deps.inputs.canon.find((c) => c.id === id);
  if (found === undefined) {
    throw new Error(`generate: canon source '${id ?? '(none)'}' is not in the run inputs`);
  }
  return found;
};

export const moodVariantGenerator: Generator = {
  name: 'mood-variant',
  version: '1',

  targets: (inputs: DeriveInputs): DerivedTarget[] => {
    const scenes = sortedCanon(inputs).filter((e) => e.kind === 'scene');
    const buckets = bucketsFor(inputs).slice(0, MAX_VARIANTS_PER_SCENE);
    const out: DerivedTarget[] = [];
    for (const scene of scenes) {
      for (const bucket of buckets) {
        // Bucket uniqueness is per scene by construction: one pass, one entry per bucket.
        const template = moodVariantTemplate(bucket);
        out.push(makeTarget({ name: 'mood-variant', version: '1' }, template, singleSource(scene), bucket));
      }
    }
    return out;
  },

  generate: async (t: DerivedTarget, deps: GenerateDeps): Promise<string> => {
    const scene = sourceOf(t, deps);
    const bucket = t.bucket ?? 'flat';
    const { body } = await generateDraft(
      {
        system: moodVariantTemplate(bucket),
        user: userPrompt(scene, bucket, deps.rng.pick(ANGLES)),
      },
      deps,
    );
    return renderDraft(
      {
        kind: 'scene',
        dimensions: [...scene.dimensions],
        register: [...scene.register],
        affect: { ...scene.affect },
        context: `${bucket} variant — ${scene.context}`,
        weight: scene.weight,
      },
      body,
    );
  },
};

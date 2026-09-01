// M08 derive — the v1 generator set. Registration order is priority order under
// the global 8:1 cap: the first generator listed fills its quota first. M20 may
// compose a different set; nothing in the pipeline knows these four by name
// except the corpus:check per-scene cap, which reads the generator NAME.

import type { Generator } from '../types.js';
import { moodVariantGenerator } from './mood-variant.js';
import { proceduralGenerator } from './procedural.js';
import { deliberationShapeGenerator } from './deliberation-shape.js';
import { memoryWeaveGenerator } from './memory-weave.js';

export const V1_GENERATORS: readonly Generator[] = [
  moodVariantGenerator,
  proceduralGenerator,
  deliberationShapeGenerator,
  memoryWeaveGenerator,
];

export { moodVariantGenerator, proceduralGenerator, deliberationShapeGenerator, memoryWeaveGenerator };
export {
  MOOD_VARIANT_SYSTEM,
  moodVariantTemplate,
  sourceOf,
} from './mood-variant.js';
export { PROCEDURAL_SYSTEM } from './procedural.js';
export { DELIBERATION_SYSTEM } from './deliberation-shape.js';
export { MEMORY_WEAVE_SYSTEM } from './memory-weave.js';
export { makeTarget, singleSource, sortedCanon, bucketsFor } from './shared.js';

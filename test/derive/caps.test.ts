// M08 gate — fan-out caps at ENUMERATION. The per-scene cap with bucket
// uniqueness, the duplicate-bucket collapse, and the rule that a cap refuses
// proposals instead of ever deleting live output.

import { describe, expect, it } from 'vitest';
import {
  MAX_DERIVED_PER_CANON,
  MAX_VARIANTS_PER_SCENE,
  enumerateTargets,
  emptyManifest,
  moodVariantGenerator,
  orphanSet,
  V1_GENERATORS,
} from '../../src/derive/index.js';
import { baseInputs } from './helpers.js';
import type { DeriveInputs } from '../../src/derive/index.js';

const scenesOnly = (n: number): DeriveInputs => {
  const inputs = baseInputs();
  const first = inputs.canon[0]!;
  return {
    ...inputs,
    canon: Array.from({ length: n }, (_, i) => ({ ...first, id: `canon/voice/scene-${i}` })),
  };
};

describe('per-scene mood cap', () => {
  it('never proposes more than 6 variants for one scene', () => {
    const targets = moodVariantGenerator.targets(scenesOnly(1));
    expect(targets).toHaveLength(MAX_VARIANTS_PER_SCENE);
  });

  it('bucket uniqueness: duplicate buckets collapse, one variant per bucket', () => {
    const inputs: DeriveInputs = { ...scenesOnly(1), moodBuckets: ['bright', 'bright', 'low', 'bright'] };
    const targets = moodVariantGenerator.targets(inputs);
    expect(targets).toHaveLength(2);
    expect(new Set(targets.map((t) => t.bucket)).size).toBe(2);
  });

  it('each (scene, bucket) pair has a distinct deriveKey — buckets cannot collide', () => {
    const targets = moodVariantGenerator.targets(scenesOnly(1));
    expect(new Set(targets.map((t) => t.deriveKey)).size).toBe(targets.length);
    // the per-bucket template is what separates the keys
    expect(new Set(targets.map((t) => t.templateHash)).size).toBe(targets.length);
  });

  it('two scenes × six buckets: the cap is per scene, not global to the generator', () => {
    expect(moodVariantGenerator.targets(scenesOnly(2))).toHaveLength(2 * MAX_VARIANTS_PER_SCENE);
  });
});

describe('global derived:canon cap at enumeration', () => {
  it('MAX_DERIVED_PER_CANON is the documented 8', () => {
    expect(MAX_DERIVED_PER_CANON).toBe(8);
  });

  it('proposals beyond the budget are dropped, never post-hoc deleted', () => {
    // baseInputs ⇒ budget 24; full V1 fan-out is 16 → fits with room to spare
    const fits = enumerateTargets(baseInputs(), V1_GENERATORS, emptyManifest('e'));
    expect(fits.droppedByCap).toBe(0);
    expect(fits.targets).toHaveLength(16);

    // budget 6 = floor(2 × 3) < 16 proposals: the overflow is refused at enumeration
    const capped = enumerateTargets(baseInputs({ gravityCap: 2 }), V1_GENERATORS, emptyManifest('e'));
    expect(capped.maxDerived).toBe(6);
    expect(capped.targets).toHaveLength(6);
    expect(capped.droppedByCap).toBe(10);
  });

  it('priority is registration order: mood-variant fills the budget before later generators', () => {
    const capped = enumerateTargets(baseInputs({ gravityCap: 2 }), V1_GENERATORS, emptyManifest('e'));
    expect(capped.targets.every((t) => t.generator.name === 'mood-variant')).toBe(true);
  });

  it('a cap driven to zero proposes nothing and orphans nothing', () => {
    const inputs = baseInputs();
    const capped = enumerateTargets({ ...inputs, gravityCap: 0 }, V1_GENERATORS, emptyManifest('e'));
    expect(capped.targets).toHaveLength(0);
    expect(capped.droppedByCap).toBe(16);
    expect(orphanSet({ ...inputs, gravityCap: 0 }, emptyManifest('e'), V1_GENERATORS)).toEqual([]);
  });
});

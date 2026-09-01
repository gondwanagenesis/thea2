// M08 gate — the pure-function core. dirtySet/orphanSet must dirty exactly what
// an edit touches, orphan exactly what lost its key, and never lie or mutate.
//
// Fixture geometry (baseInputs): canon = sceneA (voice), sceneB (tool-use),
// reasoningC (statement, reasoning). Expected targets:
//   mood-variant 12 (2 scenes × 6 buckets) · procedural 2 (2 tools × 1 tool
//   scene) · deliberation-shape 1 · memory-weave 1 (the one adjacent scene pair)
//   — 16 total, all inside budget 24 = floor(8 × 3).

import { describe, expect, it } from 'vitest';
import {
  DeriveError,
  dirtySet,
  emptyManifest,
  enumerateTargets,
  orphanSet,
  V1_GENERATORS,
  type DeriveInputs,
  type Generator,
  type Manifest,
  type ManifestEntry,
} from '../../src/derive/index.js';
import { makeTarget, singleSource } from '../../src/derive/generators/shared.js';
import { PROCEDURAL_SYSTEM } from '../../src/derive/generators/procedural.js';
import { baseInputs, errorCodeOf, pristineTree, sceneA, sceneB, TOOL_DEFS } from './helpers.js';

const inputsOf = (over: Partial<DeriveInputs> = {}): DeriveInputs => baseInputs(over);

const manifestWith = (entries: ManifestEntry[]): Manifest => ({
  version: 1,
  embedderId: 'test-embedder',
  entries,
});

const entryFor = (t: { generator: { name: string; version: string }; target: { deriveKey: string; inputs: ManifestEntry['inputs'] } }, i: number): ManifestEntry => ({
  id: 'sha256:' + String(i).padStart(64, '0'),
  deriveKey: t.target.deriveKey,
  generator: t.generator.name,
  generatorVersion: t.generator.version,
  inputs: t.target.inputs,
  model: 'm',
  createdAt: 0,
  judge: { version: 'j', score: 5, pass: true },
});

describe('enumerateTargets: validation and caps', () => {
  it('rejects a generator whose target keys disagree with its declared parts', () => {
    const liar: Generator = { ...V1_GENERATORS[0]!, version: '2' }; // targets computed under version '1'
    expect(() => enumerateTargets(inputsOf(), [liar], emptyManifest('e'))).toThrowError(DeriveError);
    expect(errorCodeOf(() => enumerateTargets(inputsOf(), [liar], emptyManifest('e')))).toBe('derive/bad-derive-key');
  });

  it('rejects duplicate generator names and duplicate derive keys', () => {
    const first = V1_GENERATORS[0]!;
    expect(errorCodeOf(() => enumerateTargets(inputsOf(), [first, first], emptyManifest('e')))).toBe(
      'derive/duplicate-generator',
    );
    const clashing: Generator = {
      name: 'clashing',
      version: '1',
      // one legitimately-keyed target proposed twice — the only way two
      // different proposals can share a key
      targets: (i) => {
        const t = makeTarget({ name: 'clashing', version: '1' }, 'TEMPLATE', singleSource(i.canon[0]!));
        return [t, { ...t }];
      },
      generate: async () => '',
    };
    expect(errorCodeOf(() => enumerateTargets(inputsOf(), [clashing], emptyManifest('e')))).toBe(
      'derive/duplicate-derive-key',
    );
  });

  it('floor(gravityCap × canon) is the budget; a bad gravityCap throws', () => {
    expect(enumerateTargets(inputsOf({ gravityCap: 2.5 }), V1_GENERATORS, emptyManifest('e')).maxDerived).toBe(7);
    expect(errorCodeOf(() =>
      enumerateTargets(inputsOf({ gravityCap: Number.NaN }), V1_GENERATORS, emptyManifest('e')),
    )).toBe('derive/bad-gravity-cap');
    expect(errorCodeOf(() =>
      enumerateTargets(inputsOf({ gravityCap: -1 }), V1_GENERATORS, emptyManifest('e')),
    )).toBe('derive/bad-gravity-cap');
  });

  it('an over-budget generator STOPS PROPOSING (droppedByCap) in registration order', () => {
    const inputs = inputsOf();
    expect(enumerateTargets(inputs, V1_GENERATORS, emptyManifest('e')).droppedByCap).toBe(0);

    // budget 3 = floor(1 × 3): the three mood-variant proposals that come first survive
    const capped = enumerateTargets(inputsOf({ gravityCap: 1 }), V1_GENERATORS, emptyManifest('e'));
    expect(capped.maxDerived).toBe(3);
    expect(capped.droppedByCap).toBe(13); // 16 proposals − 3 kept
    expect(capped.targets).toHaveLength(3);
    expect(capped.targets.every((t) => t.generator.name === 'mood-variant')).toBe(true);
  });

  it('live manifest keys are never re-proposed, even past the budget', () => {
    const inputs = inputsOf();
    const full = enumerateTargets(inputs, V1_GENERATORS, emptyManifest('e'));
    const entries = full.targets.map(entryFor);
    // cap 0.5 ⇒ budget 1, but every proposal is already live: nothing asked for
    const shrunk = enumerateTargets(inputsOf({ gravityCap: 0.5 }), V1_GENERATORS, manifestWith(entries));
    expect(shrunk.droppedByCap).toBe(0);
    expect(shrunk.targets).toHaveLength(entries.length);
  });
});

describe('dirtySet (the unit-test core)', () => {
  it('a pristine corpus is clean', () => {
    const inputs = inputsOf();
    const { manifest } = pristineTree(inputs, V1_GENERATORS, 16);
    expect(dirtySet(inputs, manifest, V1_GENERATORS)).toEqual([]);
    expect(orphanSet(inputs, manifest, V1_GENERATORS)).toEqual([]);
  });

  it('a canon body edit dirties exactly the targets containing that scene', () => {
    const pristine = inputsOf();
    const { manifest } = pristineTree(pristine, V1_GENERATORS, 16);
    const edited = inputsOf({
      canon: [{ ...sceneA(), body: 'D: changed\nT: a different line\n' }, sceneB(), pristine.canon[2]!],
    });
    const dirty = dirtySet(edited, manifest, V1_GENERATORS);
    for (const target of dirty) {
      expect(target.inputs.canonIds.map((c) => c.id)).toContain('canon/voice/late-server');
    }
    // 6 mood variants + 1 weave pair; sceneA is neither tool-use nor reasoning
    expect(dirty).toHaveLength(7);
    expect(dirty.filter((t) => t.bucket !== undefined)).toHaveLength(6);
    expect(dirty.filter((t) => t.inputs.canonIds.length === 2)).toHaveLength(1);
  });

  it('a generatorVersion bump dirties that family and nothing else', () => {
    const inputs = inputsOf();
    const { manifest } = pristineTree(inputs, V1_GENERATORS, 16);
    // a real bump re-keys the family (spreading and only bumping `version`
    // would be a LIAR generator — enumerateTargets rejects that, tested above)
    const bumped: Generator[] = V1_GENERATORS.map((g) =>
      g.name !== 'procedural'
        ? g
        : {
            ...g,
            version: '2',
            targets: (i: DeriveInputs) =>
              g.targets(i).map((t) => makeTarget({ name: 'procedural', version: '2' }, PROCEDURAL_SYSTEM, t.inputs)),
          },
    );
    const dirty = dirtySet(inputs, manifest, bumped);
    expect(dirty).toHaveLength(2); // 2 tools × 1 tool scene
    expect(dirty.every((t) => t.inputs.toolDefsHash !== undefined)).toBe(true);
  });

  it('a template edit dirties the family even at the same generatorVersion', () => {
    const gen = (template: string): Generator => ({
      name: 'templated',
      version: '1',
      targets: (i) => i.canon.map((e) => makeTarget({ name: 'templated', version: '1' }, template, singleSource(e))),
      generate: async () => '',
    });
    const inputs = inputsOf();
    const { manifest } = pristineTree(inputs, [gen('template v1')], 3);
    const dirty = dirtySet(inputs, manifest, [gen('template v2 — reworded')]);
    expect(dirty).toHaveLength(3); // every target of the retuned generator
    expect(orphanSet(inputs, manifest, [gen('template v2 — reworded')])).toHaveLength(3);
  });

  it('an unrelated canon addition dirties only the new targets', () => {
    const inputs = inputsOf();
    const { manifest } = pristineTree(inputs, V1_GENERATORS, 16);
    const grown = inputsOf({
      canon: [...inputs.canon, { ...sceneB(), id: 'canon/tooluse/new-tool-scene' }],
    });
    const dirty = dirtySet(grown, manifest, V1_GENERATORS);
    for (const target of dirty) {
      expect(target.inputs.canonIds.map((c) => c.id)).toContain('canon/tooluse/new-tool-scene');
    }
    // 6 mood variants + 2 procedural (new scene is tool-use) + 1 weave pair
    // (the old status-check×late-server pair already exists, so only the pair
    // with the NEW scene is new)
    expect(dirty).toHaveLength(9);
  });

  it("a tool-def edit dirties exactly that tool's procedures", () => {
    const inputs = inputsOf();
    const { manifest } = pristineTree(inputs, V1_GENERATORS, 16);
    const editedTools = [{ ...TOOL_DEFS[0]!, description: 'reworded description' }, TOOL_DEFS[1]!];
    const dirty = dirtySet(inputsOf({ toolDefs: editedTools }), manifest, V1_GENERATORS);
    expect(dirty).toHaveLength(1);
    expect(dirty[0]!.inputs.toolDefsHash).toBeDefined();
  });

  it('widening the bucket list dirties only the added buckets', () => {
    const inputs = inputsOf({ moodBuckets: ['bright', 'low'] });
    const { manifest } = pristineTree(inputs, V1_GENERATORS, 16);
    const dirty = dirtySet(inputsOf({ moodBuckets: ['bright', 'low', 'tense'] }), manifest, V1_GENERATORS);
    expect(dirty.every((t) => t.bucket === 'tense')).toBe(true);
    expect(dirty).toHaveLength(2); // one per scene
  });
});

describe('orphanSet', () => {
  const built = (): { inputs: DeriveInputs; manifest: Manifest } => {
    const inputs = inputsOf();
    return { inputs, manifest: pristineTree(inputs, V1_GENERATORS, 16).manifest };
  };

  it('an entry whose deriveKey left the expected set is an orphan; nothing else is', () => {
    const { inputs, manifest } = built();
    const edited = inputsOf({
      canon: [{ ...sceneA(), body: 'D: rewrote\nT: this scene\n' }, sceneB(), inputs.canon[2]!],
    });
    const orphans = orphanSet(edited, manifest, V1_GENERATORS);
    expect(orphans).toHaveLength(7); // 6 mood + 1 weave pair, all containing sceneA
    const orphanIds = new Set(orphans.map((o) => o.id));
    for (const entry of manifest.entries) {
      expect(orphanIds.has(entry.id)).toBe(
        entry.inputs.canonIds.some((c) => c.id === 'canon/voice/late-server'),
      );
    }
    // every orphan is replaced by a dirty target with the new key
    expect(dirtySet(edited, manifest, V1_GENERATORS)).toHaveLength(orphans.length);
  });

  it('a removed generator orphans its whole family', () => {
    const { inputs, manifest } = built();
    const without = V1_GENERATORS.filter((g) => g.name !== 'memory-weave');
    const orphans = orphanSet(inputs, manifest, without);
    expect(orphans).toHaveLength(1);
    expect(orphans[0]!.generator).toBe('memory-weave');
  });

  it('a shrunken cap NEVER orphans live output (orphan-hood is decided uncapped)', () => {
    const { manifest } = built();
    const shrunk = inputsOf({ gravityCap: 0.25 });
    expect(orphanSet(shrunk, manifest, V1_GENERATORS)).toEqual([]);
    expect(dirtySet(shrunk, manifest, V1_GENERATORS)).toEqual([]);
  });
});

describe('purity', () => {
  it('same inputs ⇒ same outputs, fresh arrays, and no mutation of anything', () => {
    const inputs = inputsOf();
    const { manifest } = pristineTree(inputs, V1_GENERATORS, 16);
    const manifestCopy: Manifest = JSON.parse(JSON.stringify(manifest)) as Manifest;
    const inputsCopy: DeriveInputs = JSON.parse(JSON.stringify(inputs)) as DeriveInputs;

    const dirty1 = dirtySet(inputs, manifest, V1_GENERATORS);
    const orphans1 = orphanSet(inputs, manifest, V1_GENERATORS);
    dirty1.push(...dirty1); // the returned array is ours to wreck
    const dirty2 = dirtySet(inputs, manifest, V1_GENERATORS);
    const orphans2 = orphanSet(inputs, manifest, V1_GENERATORS);

    expect(dirty2).toEqual(dirty1.slice(0, dirty1.length / 2));
    expect(orphans2).toEqual(orphans1);
    // inputs and manifest untouched by the computation
    expect(manifest.entries).toEqual(manifestCopy.entries);
    expect(inputs).toEqual(inputsCopy);
    // and a rerun over deep copies agrees byte-for-byte
    expect(dirtySet(inputsCopy, manifestCopy, V1_GENERATORS)).toEqual(dirty2);
    expect(orphanSet(inputsCopy, manifestCopy, V1_GENERATORS)).toEqual(orphans2);
  });
});

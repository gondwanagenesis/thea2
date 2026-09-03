// M08 — the four v1 generators: enumeration shape, prompt construction, the
// rng draw, and the file text each one renders. The gate cares that fan-out
// rules and provenance inputs are right before any model is involved.

import { describe, expect, it } from 'vitest';
import {
  deliberationShapeGenerator,
  DELIBERATION_SYSTEM,
  makeTarget,
  memoryWeaveGenerator,
  MEMORY_WEAVE_SYSTEM,
  moodVariantGenerator,
  moodVariantTemplate,
  MOOD_VARIANT_SYSTEM,
  proceduralGenerator,
  PROCEDURAL_SYSTEM,
  singleSource,
} from '../../src/derive/index.js';
import { canonSourceHash, templateHashOf } from '../../src/derive/index.js';
import { withProvenance } from '../../src/derive/index.js';

/** A draft carries no provenance by design — inject the pending one, as run.ts does, to parse. */
const parseDraft = (draft: string): ReturnType<typeof parseExemplar> =>
  parseExemplar(
    withProvenance(draft, {
      generator: 'test',
      generatorVersion: '1',
      canonIds: ['canon/voice/late-server'],
      sourceHashes: ['sha256:' + 'a'.repeat(64)],
      model: 'test-gen',
      judge: { version: 'derive-judge-v1', score: 5, pass: true },
    }),
    'derived',
  );
import { canonicalJson, contentHash } from '../../src/kernel/index.js';
import { makeRng } from '../../src/kernel/rng.js';
import { TestClock } from '../../src/kernel/clock.js';
import { MockModel } from '../../src/model/mock.js';
import { parseExemplar } from '../../src/corpus/parse.js';
import type { GenerateDeps } from '../../src/derive/index.js';
import { baseInputs, reasoningC, sceneA, sceneB, TOOL_DEFS } from './helpers.js';

const scripted = (): MockModel => {
  const model = new MockModel({ clock: new TestClock() });
  model.onTask('derive', (req) => {
    const system = req.messages[0]?.content ?? '';
    if (system.includes('procedural exemplar')) {
      return {
        content: [
          'Setup: he wonders',
          'D: is it fine',
          'T: hold on',
          '[tool] splyce_status {"id":"box"} → their status page says green',
          '[outcome] good — he let it go',
          '',
        ].join('\n'),
      };
    }
    if (system.includes('deliberation') || system.includes('memory')) {
      return { content: 'one beat of deciding\nthen the shape it leaves\n' };
    }
    return { content: 'D: he asks\nT: she answers. lower case\n' };
  });
  return model;
};

describe('mood-variant', () => {
  it('fans out one target per (scene × bucket) with per-bucket templates', () => {
    const inputs = baseInputs({ moodBuckets: ['bright', 'low'] });
    const targets = moodVariantGenerator.targets(inputs);
    expect(targets).toHaveLength(4); // 2 scenes × 2 buckets
    expect(targets.every((t) => t.bucket !== undefined)).toBe(true);
    // the bucket lives in the template text, which is what keeps keys apart
    expect(moodVariantTemplate('bright')).toContain('[mood bucket: bright]');
    expect(moodVariantTemplate('bright')).toContain(MOOD_VARIANT_SYSTEM);
    expect(templateHashOf(moodVariantTemplate('bright'))).not.toBe(templateHashOf(moodVariantTemplate('low')));
  });

  it('generate renders a scene file recolored by the bucket, and draws an angle from the rng', async () => {
    const inputs = baseInputs({ moodBuckets: ['bright'] });
    const target = moodVariantGenerator.targets(inputs)[0]!;
    const model = scripted();
    const deps: GenerateDeps = { model, rng: makeRng(3), inputs };
    const draft = await moodVariantGenerator.generate(target, deps);

    // the model saw the pinned system prompt and the scene's notes
    const call = model.calls[0]!;
    expect(call.taskClass).toBe('derive');
    expect(call.tier).toBe('main');
    expect(call.messages[0]!.content).toBe(moodVariantTemplate(target.bucket!));
    expect(call.messages[1]!.content).toContain('canon/tooluse/status-check');
    expect(call.messages[1]!.content).toContain('notes (must survive)');
    expect(call.messages[1]!.content).toContain('Angle: '); // the draw

    // and the draft is a legal scene file with M08's two fields left open
    expect(draft).toContain('id: sha256:pending');
    expect(draft).not.toContain('provenance');
    expect(draft).toContain('kind: scene');
    // ' - ' not an em-dash (JU.1/JU.2): the plain value needs no YAML quoting
    expect(draft).toContain('context: bright variant - ');
    expect(draft).not.toMatch(/[—–]/);
    const parsed = parseDraft(draft);
    expect(parsed.context).toContain('bright variant');
  });
});

describe('procedural', () => {
  it('pairs every tool with every tool-use scene, hashing the exact tool def', () => {
    const inputs = baseInputs({ moodBuckets: ['bright'] });
    const targets = proceduralGenerator.targets(inputs);
    expect(targets).toHaveLength(2); // 2 tools × 1 tool-use scene
    expect(targets.every((t) => t.inputs.toolDefsHash !== undefined)).toBe(true);
    const first = targets[0]!;
    const tool = TOOL_DEFS.find((d) => contentHash(canonicalJson(d)) === first.inputs.toolDefsHash);
    expect(tool?.name).toBe('ledger_sum'); // tools sorted by name: ledger_sum first
    expect(targets.map((t) => t.inputs.canonIds[0]!.id)).toEqual([
      'canon/tooluse/status-check',
      'canon/tooluse/status-check',
    ]);
  });

  it('generate resolves the tool BY HASH from the run inputs and renders kind: procedure', async () => {
    const inputs = baseInputs({ moodBuckets: ['bright'] });
    const target = proceduralGenerator.targets(inputs)[0]!;
    const model = scripted();
    const draft = await proceduralGenerator.generate(target, { model, rng: makeRng(1), inputs });

    expect(model.calls[0]!.messages[1]!.content).toContain('tool: ledger_sum');
    expect(model.calls[0]!.messages[1]!.content).toContain('# canon scene canon/tooluse/status-check');
    expect(draft).toContain('kind: procedure');
    expect(draft).toContain('context: "procedure');
    const parsed = parseDraft(draft);
    expect(parsed.kind).toBe('procedure');
    expect(parsed.context).toContain('procedure');
  });
});

describe('deliberation-shape', () => {
  it('proposes exactly one target per reasoning canon source', () => {
    const targets = deliberationShapeGenerator.targets(baseInputs({ moodBuckets: ['bright'] }));
    expect(targets).toHaveLength(1);
    expect(targets[0]!.inputs.canonIds[0]!.id).toBe('canon/reasoning/triage-order');
    expect(targets[0]!.inputs.canonIds[0]!.sha256).toBe(canonSourceHash(reasoningC()));
  });

  it('generate renders a statement whose prompt carries the pinned system text', async () => {
    const inputs = baseInputs({ moodBuckets: ['bright'] });
    const target = deliberationShapeGenerator.targets(inputs)[0]!;
    const model = scripted();
    const draft = await deliberationShapeGenerator.generate(target, { model, rng: makeRng(1), inputs });

    expect(model.calls[0]!.messages[0]!.content).toBe(DELIBERATION_SYSTEM);
    expect(model.calls[0]!.messages[1]!.content).toContain('canon/reasoning/triage-order');
    expect(draft).toContain('kind: statement');
    expect(draft).toContain('context: "deliberation shape');
    expect(draft).toContain('one beat of deciding'); // the prose body rode through unharmed
  });
});

describe('memory-weave', () => {
  it('pairs ADJACENT id-sorted scenes; a statement canon never enters a pair', () => {
    const targets = memoryWeaveGenerator.targets(baseInputs({ moodBuckets: ['bright'] }));
    expect(targets).toHaveLength(1); // (status-check, late-server)
    expect(targets[0]!.inputs.canonIds.map((c) => c.id)).toEqual([
      'canon/tooluse/status-check',
      'canon/voice/late-server',
    ]);
    expect(targets[0]!.inputs.canonIds[1]!.sha256).toBe(canonSourceHash(sceneA()));
  });

  it('three scenes braid into two pairs, each scene in at most two targets', () => {
    const inputs = baseInputs({
      canon: [sceneA(), sceneB(), { ...sceneA(), id: 'canon/voice/another' }],
      moodBuckets: ['bright'],
    });
    const targets = memoryWeaveGenerator.targets(inputs);
    expect(targets).toHaveLength(2);
    const counts = new Map<string, number>();
    for (const t of targets) for (const c of t.inputs.canonIds) counts.set(c.id, (counts.get(c.id) ?? 0) + 1);
    expect([...counts.values()].every((n) => n <= 2)).toBe(true);
  });

  it('generate braids both scenes: registers union, strongest affect wins', async () => {
    const inputs = baseInputs({
      canon: [
        { ...sceneA(), register: ['play', 'quiet'], affect: { valence: 0.3, arousal: -0.3 } },
        { ...sceneB(), register: ['work'], affect: { valence: -0.6, dominance: 0.4 } },
      ],
      toolDefs: [],
      moodBuckets: ['bright'],
    });
    const target = memoryWeaveGenerator.targets(inputs)[0]!;
    const model = scripted();
    const draft = await memoryWeaveGenerator.generate(target, { model, rng: makeRng(1), inputs });

    expect(model.calls[0]!.messages[0]!.content).toBe(MEMORY_WEAVE_SYSTEM);
    expect(model.calls[0]!.messages[1]!.content).toContain('# canon scene canon/tooluse/status-check');
    expect(draft).toContain('register: [play, quiet, work]');
    expect(draft).toContain('valence: -0.6'); // strongest |value| across the braid
    expect(draft).toContain('dominance: 0.4');
  });
});

describe('makeTarget / singleSource (shared plumbing)', () => {
  it('keys are stable across call sites that declare the same parts', () => {
    const template = 'T';
    const source = sceneA();
    const a = makeTarget({ name: 'g', version: '1' }, template, singleSource(source));
    const b = makeTarget({ name: 'g', version: '1' }, template, singleSource({ ...source }));
    expect(a.deriveKey).toBe(b.deriveKey);
    expect(a.templateHash).toBe(b.templateHash);
    expect(PROCEDURAL_SYSTEM.length).toBeGreaterThan(0); // templates are pinned constants
  });
});

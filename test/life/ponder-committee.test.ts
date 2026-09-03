// M17 gate — the ponder committee spec and its context/query builders. Pins:
//   * the SEED -> GROUND -> REVISE -> ARTIFACT DAG shape, REVISE carrying
//     requiresObservation (structurally unreachable without upstream input —
//     M13's validateCommittee is the enforcement, asserted here too);
//   * the balance rule as STRUCTURE: the seed schema is built from the allowed
//     abouts, so a violating seed fails validation, never a prompt request —
//     and since PO.2 the same structure keys on TOPIC similarity (cosine >= 0.6
//     with any of the last 3 topics => avoid);
//   * PO.2: the seed context excludes her own artifacts ([ponder:*],
//     [heartbeat:*]) and telemetry (drive floats render as words);
//   * the build delta: real evidence enters through the injected ground seam as
//     SEED/GROUND prompt inputs, and REVISE gets the observation through the DAG
//     edge only — the evidence is pasted into no revise prompt;
//   * an end-to-end committee run over MockModel (taskClass ponder-seed, main
//     tier, graceful failure, artifact validation, 'nothing' as a good outcome),
//     every node call riding the structured ladder (PO.1).

import { describe, expect, it } from 'vitest';
import { TestClock } from '../../src/kernel/clock.js';
import { MockModel } from '../../src/model/mock.js';
import { runCommittee, topoOrder, validateCommittee } from '../../src/loop/committee.js';
import type { CommitteeSpec } from '../../src/loop/index.js';
import {
  GROUNDING_NONE,
  PONDER_COMMITTEE_NAME,
  PonderArtifactSchema,
  PonderGroundSchema,
  PonderReviseSchema,
  ponderCommittee,
  ponderContextBlock,
  ponderGroundQuery,
  ponderSeedSchemaFor,
} from '../../src/life/ponder.js';
import { repeatsTopic } from '../../src/life/policy.js';
import type { PonderAbout } from '../../src/life/policy.js';
import {
  T0,
  HOUR,
  affectState,
  committeeEnv,
  ponderModel,
  recentEpisodes,
  seedScript,
} from './helpers.js';

const context = 'Your recent life (from memory, newest first):\n- [importance 8] the crates';

const spec = (
  over: { abouts?: readonly PonderAbout[]; avoid?: PonderAbout | null; topics?: readonly string[] } = {},
): CommitteeSpec =>
  ponderCommittee({
    context,
    abouts: over.abouts ?? ['diego', 'self', 'world'],
    avoid: over.avoid !== undefined ? over.avoid : null,
    ...(over.topics !== undefined ? { recentTopics: over.topics } : {}),
    grounding: GROUNDING_NONE('something genuinely new worth learning today'),
  });

// ---------------------------------------------------------------------------
// The DAG shape
// ---------------------------------------------------------------------------

describe('ponderCommittee — the SEED -> GROUND -> REVISE -> ARTIFACT shape', () => {
  it('names itself ponder and validates as an executable DAG', () => {
    const s = spec();
    expect(s.name).toBe(PONDER_COMMITTEE_NAME);
    expect(() => validateCommittee(s)).not.toThrow();
    expect(topoOrder(s)).toEqual(['seed', 'ground', 'revise', 'artifact']);
  });

  it('the edges: seed starts alone, ground needs seed, revise needs both, artifact crowns them', () => {
    const [seed, ground, revise, artifact] = spec().nodes;
    expect(seed?.needs).toEqual([]);
    expect(ground?.needs).toEqual(['seed']);
    expect(revise?.needs).toEqual(['seed', 'ground']);
    expect(artifact?.needs).toEqual(['seed', 'revise']);
  });

  it('REVISE carries requiresObservation — and a spec that drops its needs edge is rejected', () => {
    const revise = spec().nodes[2];
    expect(revise?.requiresObservation).toBe(true);

    // M13's own test, asserted here too (spec: "REVISE-without-observation
    // impossible by construction ... asserted here too").
    const broken: CommitteeSpec = { ...spec(), nodes: spec().nodes.map((n) => (n.id === 'revise' ? { ...n, needs: [] } : n)) };
    expect(() => validateCommittee(broken)).toThrow(/requiresObservation but has no needs edge/);
  });

  it('the seed node is the only character-channelled node; the rest are procedural workers', () => {
    const [seed, ground, revise, artifact] = spec().nodes;
    expect(seed?.channels).toEqual({ character: true, procedural: false });
    expect(ground?.channels).toEqual({ character: false, procedural: true });
    expect(revise?.channels).toEqual({ character: false, procedural: true });
    expect(artifact?.channels).toEqual({ character: false, procedural: true });
  });

  it('the terminal output schema is the artifact schema', () => {
    expect(spec().output).toBe(PonderArtifactSchema);
    expect(spec().nodes[3]?.schema).toBe(PonderArtifactSchema);
  });
});

// ---------------------------------------------------------------------------
// The balance rule as structure, not a prompt request
// ---------------------------------------------------------------------------

describe('the balance rule is structural — the seed schema is built from the allowed abouts', () => {
  it('a forced-avoid run rejects a diego seed at validation time', () => {
    const schema = ponderSeedSchemaFor(['self', 'world']);
    expect(schema.safeParse({ ...seedScript(), about: 'self' }).success).toBe(true);
    expect(schema.safeParse({ ...seedScript(), about: 'world' }).success).toBe(true);
    expect(schema.safeParse({ ...seedScript(), about: 'diego' }).success).toBe(false); // balance beats saliency
  });

  it('an unbalanced run accepts all three classes', () => {
    const schema = ponderSeedSchemaFor(['diego', 'self', 'world']);
    expect(schema.safeParse(seedScript({ about: 'diego' })).success).toBe(true);
  });

  it('the seed schema still demands a real thought, topic and a 0..1 saliency', () => {
    const schema = ponderSeedSchemaFor(['diego', 'self', 'world']);
    expect(schema.safeParse({ ...seedScript(), thought: '' }).success).toBe(false);
    expect(schema.safeParse({ ...seedScript(), topic: '' }).success).toBe(false);
    expect(schema.safeParse({ ...seedScript(), saliency: 1.5 }).success).toBe(false);
  });

  it('the committee hands its seed node exactly the allowed-classes schema', () => {
    const balanced = spec({ abouts: ['diego', 'self', 'world'] });
    expect(balanced.nodes[0]?.schema?.safeParse(seedScript({ about: 'diego' })).success).toBe(true);
    const avoided = spec({ abouts: ['self', 'world'], avoid: 'diego' });
    expect(avoided.nodes[0]?.schema?.safeParse(seedScript({ about: 'diego' })).success).toBe(false);
  });

  it('the seed prompt carries the FORCED AVOID when a class is over-used, and drops its line', () => {
    const avoided = spec({ abouts: ['self', 'world'], avoid: 'diego' });
    const prompt = avoided.nodes[0]?.prompt ?? '';
    expect(prompt).toContain('FORCED AVOID');
    expect(prompt).toContain('Balance beats saliency');
    expect(prompt).toContain('about ∈ [self, world]');
    expect(prompt).not.toContain('diego — something about him'); // the class line is filtered, not just discouraged
    expect(prompt).toContain('self — your own patterns');
    expect(prompt).toContain('world — anything outside the two of you');
  });

  it('a clean history says so plainly instead of moralizing', () => {
    const prompt = spec({ abouts: ['diego', 'self', 'world'], avoid: null }).nodes[0]?.prompt ?? '';
    expect(prompt).toContain('No class is over-used right now.');
    expect(prompt).toContain('about ∈ [diego, self, world]');
  });
});

// ---------------------------------------------------------------------------
// PO.2 — the seed grounds outside itself: no own artifacts, no telemetry, no
// repeated topics
// ---------------------------------------------------------------------------

describe('PO.2 — the seed context excludes her own artifacts and telemetry', () => {
  it('seed context carries no ponder artifact', () => {
    const recent = [
      { summary: '[ponder:world] the cadence, not the calendar, is what drifts', importance: 7, ts: T0 - HOUR },
      { summary: '[heartbeat:followup] asked how the crates landed', importance: 6, ts: T0 - 2 * HOUR },
      { summary: 'he told me the crates shipped this morning', importance: 8, ts: T0 - 3 * HOUR },
    ];
    const block = ponderContextBlock(recent, affectState({ drives: { novelty: 0.2, connection: 0.2, mastery: 0.2 } }), 'calm');
    expect(block).not.toContain('[ponder:');
    expect(block).not.toContain('[heartbeat:');
    expect(block).toContain('he told me the crates shipped this morning');
  });

  it('a life that is all her own artifacts is a blank page, honestly named', () => {
    const recent = [
      { summary: '[ponder:self] a pattern in my own drift', importance: 5, ts: T0 - HOUR },
      { summary: '[heartbeat:miss] just missing him', importance: 4, ts: T0 - 2 * HOUR },
    ];
    const block = ponderContextBlock(recent, affectState(), 'calm');
    expect(block).toContain('(nothing recent — you are alone with a blank page)');
  });

  it('no drive number reaches the prompt — floats render as words (thresholds 0.4/0.6)', () => {
    const block = ponderContextBlock(
      recentEpisodes(),
      affectState({ drives: { novelty: 0.7, connection: 0.2, mastery: 0.5 } }),
      'calm',
    );
    expect(block).toContain('Drives — novelty hungry, connection fed, mastery settled.');
    // No float from the drives line can reach any prompt built on the block.
    const drivesLine = block.split('\n').find((l) => l.startsWith('Drives —')) ?? '';
    expect(drivesLine).not.toMatch(/\d/);

    const seedPrompt = ponderCommittee({
      context: block,
      abouts: ['diego', 'self', 'world'],
      avoid: null,
      grounding: GROUNDING_NONE('q'),
    }).nodes[0]?.prompt ?? '';
    expect(seedPrompt).toContain('Drives — novelty hungry, connection fed, mastery settled.');
    expect(seedPrompt).not.toMatch(/novelty \d/);
  });
});

describe('PO.2 — the topic-escape clause and the topic-similarity balance rule', () => {
  it('the seed prompt carries the topic-escape clause verbatim', () => {
    const prompt = spec().nodes[0]?.prompt ?? '';
    expect(prompt).toContain(
      "if your last three topics were about your own patterns or your feelings about Diego, pick something else: " +
        "a thing you noticed, a thing you'd like to make, a question about the world",
    );
  });

  it('the seed prompt names the recent topics it must not repeat', () => {
    const withTopics = spec({ topics: ['slot math', 'calendar drift'] });
    const prompt = withTopics.nodes[0]?.prompt ?? '';
    expect(prompt).toContain('slot math');
    expect(prompt).toContain('calendar drift');
    // And a clean history names nothing.
    expect(spec().nodes[0]?.prompt ?? '').not.toContain('recent topics');
  });

  it('a repeated topic is avoided', () => {
    // The rule itself (policy): cosine >= 0.6 with any of the last 3 topics.
    expect(repeatsTopic('slot math drift', ['slot math'])).toBe(true);
    expect(repeatsTopic('sea glass jar', ['slot math', 'calendar drift'])).toBe(false);

    // As structure: the seed schema is built WITH the recent topics, so a
    // repeating seed fails validation exactly like a balance-violating about.
    const schema = ponderSeedSchemaFor(['diego', 'self', 'world'], ['slot math']);
    expect(schema.safeParse({ ...seedScript(), topic: 'slot math' }).success).toBe(false); // identical topic
    expect(schema.safeParse({ ...seedScript(), topic: 'slot math drift' }).success).toBe(false); // cosine ~0.82
    expect(schema.safeParse({ ...seedScript(), topic: 'why the horizon drifts' }).success).toBe(true);
    // Without topics the same schema accepts the same shape.
    expect(ponderSeedSchemaFor(['diego', 'self', 'world']).safeParse(seedScript({ topic: 'slot math' })).success).toBe(true);
  });

  it('a seed that repeats a recent topic dies at validation in the run', async () => {
    const model = new MockModel({ clock: new TestClock(T0) });
    model.enqueue({ toolCalls: [{ name: 'emit', args: seedScript() as unknown as Record<string, unknown> }] }); // topic 'slot math'
    const res = await runCommittee(spec({ topics: ['calendar drift', 'slot math'] }), committeeEnv(model));
    expect(res.ok).toBe(false);
    expect(res.error).toContain("node 'seed' failed");
    expect(res.artifact).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The grounding seam and the revision discipline
// ---------------------------------------------------------------------------

describe('the grounding evidence enters as INPUT, the revision as DISCIPLINE', () => {
  it('the seed and ground prompts embed the real evidence, its source and the query', () => {
    const s = ponderCommittee({
      context,
      abouts: ['diego', 'self', 'world'],
      avoid: null,
      grounding: {
        source: 'web_search',
        query: 'does ISO 8601 have a week 53',
        evidence: 'week 53 occurs only in long years',
        cites: ['https://example.com/iso8601'],
      },
    });
    const seedPrompt = s.nodes[0]?.prompt ?? '';
    const groundPrompt = s.nodes[1]?.prompt ?? '';
    for (const p of [seedPrompt, groundPrompt]) {
      expect(p).toContain('you went and checked (source: web_search, query: "does ISO 8601 have a week 53")');
      expect(p).toContain('week 53 occurs only in long years');
      expect(p).toContain('Cites: https://example.com/iso8601');
    }
  });

  it('an empty seam says nothing usable came back — and the ground node is held to honesty', () => {
    const s = spec(); // GROUNDING_NONE
    const seedPrompt = s.nodes[0]?.prompt ?? '';
    const groundPrompt = s.nodes[1]?.prompt ?? '';
    expect(seedPrompt).toContain('(nothing usable came back)');
    expect(groundPrompt).toContain('(nothing usable came back)');
    expect(groundPrompt).toContain('grounded=false when nothing usable came back');
    expect(groundPrompt).toContain('never invent evidence');
  });

  it('the REVISE prompt carries the gated-revise rules and NOT the evidence — that rides the edge', () => {
    const s = ponderCommittee({
      context,
      abouts: ['diego', 'self', 'world'],
      avoid: null,
      grounding: { source: 'web_fetch', query: 'q', evidence: 'EVIDENCE-PAYLOAD', cites: [] },
    });
    const revisePrompt = s.nodes[2]?.prompt ?? '';
    expect(revisePrompt).toContain('Revise ONLY if the grounding evidence ACTUALLY contradicts the seed');
    expect(revisePrompt).toContain('the pre-revision draft wins: changed=false');
    expect(revisePrompt).toContain('not worth carrying');
    expect(revisePrompt).toContain('Both the seed and the grounding observation are in the INPUTS below');
    expect(revisePrompt).not.toContain('EVIDENCE-PAYLOAD'); // structurally delivered, never pasted
  });

  it('the ARTIFACT prompt offers nothing as a first-class outcome', () => {
    const prompt = spec().nodes[3]?.prompt ?? '';
    expect(prompt).toContain('"insight" | "question" | "plan"');
    expect(prompt).toContain('"nothing"');
    expect(prompt).toContain('dropping a thin ponder is a good outcome');
  });

  it('the node schemas are the three intermediate shapes', () => {
    expect(spec().nodes[1]?.schema).toBe(PonderGroundSchema);
    expect(spec().nodes[2]?.schema).toBe(PonderReviseSchema);
  });
});

// ---------------------------------------------------------------------------
// End to end through M13's committee machinery
// ---------------------------------------------------------------------------

describe('the ponder committee run over MockModel', () => {
  it('runs seed -> ground -> revise -> artifact and validates the artifact', async () => {
    const model = ponderModel();
    const res = await runCommittee(spec(), committeeEnv(model));

    expect(res.ok).toBe(true);
    expect(res.outputs.map((o) => o.id)).toEqual(['seed', 'ground', 'revise', 'artifact']);
    const artifact = PonderArtifactSchema.parse(res.artifact);
    expect(artifact).toMatchObject({
      about: 'world',
      topic: 'slot math',
      artifact: 'insight',
      resolved: true,
      changed: false,
      defect: 'none',
    });
  });

  it('every node call is a plain ponder-seed model call on the env tier, with no tools', async () => {
    const model = ponderModel();
    const s = spec();
    await runCommittee(s, committeeEnv(model));
    expect(model.calls).toHaveLength(4);
    const schemas = s.nodes.map((n) => n.schema);
    for (const [i, call] of model.calls.entries()) {
      expect(call.taskClass).toBe('ponder-seed');
      expect(call.tier).toBe('main');
      expect(call.maxTokens).toBe(500);
      expect(call.temperature).toBe(0.6);
      expect(call.tools).toBeUndefined(); // M13: committee nodes are tool-less
      // PO.1: the node's schema rides the request — the structured ladder runs,
      // the class default ('low', REASONING_BY_CLASS) is the reasoning control.
      expect(call.schema).toBe(schemas[i]);
      expect(call.reasoning).toBe('low');
    }
  });

  it('channels compose per node: the seed hears her identity, the workers do not', async () => {
    const model = ponderModel();
    await runCommittee(spec(), committeeEnv(model));
    expect(model.calls[0]?.messages[0]?.content).toContain('IDENTITY: you are Thea.');
    for (const later of model.calls.slice(1)) {
      expect(later.messages[0]?.content).toContain('[PROCEDURAL]');
      expect(later.messages[0]?.content).not.toContain('IDENTITY');
    }
  });

  it('REVISE consumes seed and ground through the edge, never through a pasted prompt', async () => {
    const model = ponderModel();
    await runCommittee(spec(), committeeEnv(model));
    const revise = model.calls[2]?.messages[1]?.content ?? '';
    expect(revise).toContain('INPUTS from earlier nodes:');
    expect(revise).toContain('- seed: {"thought"');
    expect(revise).toContain('- ground: {"grounded":true');
    expect(revise).toContain('ISO 8601 week 53 occurs only in long years'); // the observation itself
  });

  it('an unparseable node output fails gracefully — the committee never throws', async () => {
    const model = new MockModel({ clock: new TestClock(T0) });
    model.enqueue({ toolCalls: [{ name: 'emit', args: seedScript() as unknown as Record<string, unknown> }] }); // seed answers on the ladder
    model.enqueue({ content: 'prose where the JSON should be' }); // the ground node dies
    const res = await runCommittee(spec(), committeeEnv(model));

    expect(res.ok).toBe(false);
    expect(res.artifact).toBeNull();
    expect(res.error).toContain("node 'ground' failed");
    expect(res.outputs.map((o) => o.id)).toEqual(['seed']); // the work done so far survives in the report
  });

  it('a seed that violates the balance rule dies at validation — the structural rule bites in the run', async () => {
    const model = new MockModel({ clock: new TestClock(T0) });
    model.enqueue({ toolCalls: [{ name: 'emit', args: seedScript({ about: 'diego' }) as unknown as Record<string, unknown> }] }); // abouts here are self|world
    const res = await runCommittee(spec({ abouts: ['self', 'world'], avoid: 'diego' }), committeeEnv(model));

    expect(res.ok).toBe(false);
    expect(res.error).toContain("node 'seed' failed");
    expect(res.artifact).toBeNull();
    expect(model.calls).toHaveLength(2); // the node call + the ladder's one-shot repair — then the committee stops
  });

  it('a malformed terminal artifact is a loud ok:false — the artifact node validates its own output', async () => {
    // The artifact node's schema IS spec.output (pinned above), so a bad artifact
    // dies at the node (the ladder's one repair included) and the committee-level
    // re-check never sees a divergence.
    const model = ponderModel({ artifact: { saliency: 9 } });
    const res = await runCommittee(spec(), committeeEnv(model));
    expect(res.ok).toBe(false);
    expect(res.error).toContain("node 'artifact' failed");
    expect(res.artifact).toBeNull();
    expect(model.calls).toHaveLength(5); // 4 node calls + the artifact node's repair
  });

  it("'nothing' is a valid landing: a thin ponder ends the run ok, not failed", async () => {
    const model = ponderModel({
      artifact: { artifact: 'nothing', conclusion: 'dropped: too thin to carry.', next: '', resolved: false },
    });
    const res = await runCommittee(spec(), committeeEnv(model));
    expect(res.ok).toBe(true);
    const artifact = PonderArtifactSchema.parse(res.artifact);
    expect(artifact.artifact).toBe('nothing');
  });
});

// ---------------------------------------------------------------------------
// The context block and the ground query — what the job body renders
// ---------------------------------------------------------------------------

describe('ponderContextBlock', () => {
  it('renders her real recent life, weather and drives as words (PO.2: no floats)', () => {
    const block = ponderContextBlock(recentEpisodes(), affectState({ drives: { novelty: 0.25, connection: 0.34, mastery: 0.25 } }), 'warm, restless');
    const lines = block.split('\n');
    expect(lines[0]).toBe('Your recent life (from memory, newest first):');
    expect(block).toContain('- [importance 8] he told me the crates shipped this morning');
    expect(block).toContain('- [importance 3] quiet afternoon, I reread my own diary and cringed');
    expect(block).toContain('Your weather right now: warm, restless');
    expect(block).toContain('Drives — novelty fed, connection fed, mastery fed.');
  });

  it('an empty life is a blank page, honestly named', () => {
    const block = ponderContextBlock([], affectState({ drives: { novelty: 0, connection: 0, mastery: 0 } }), 'calm');
    expect(block).toContain('(nothing recent — you are alone with a blank page)');
    expect(block).toContain('Drives — novelty fed, connection fed, mastery fed.');
  });
});

describe('ponderGroundQuery — what the job body asks the seam to check', () => {
  it('asks about her most important recent memory', () => {
    expect(ponderGroundQuery(recentEpisodes())).toBe('he told me the crates shipped this morning');
  });

  it('collapses whitespace so a wrapped diary line stays one query', () => {
    const query = ponderGroundQuery([{ summary: 'he  said\n\tthe crates   shipped', importance: 9 }]);
    expect(query).toBe('he said the crates shipped');
  });

  it('truncates a long summary to 120 chars ending in an ellipsis', () => {
    const long = 'x'.repeat(300);
    const query = ponderGroundQuery([{ summary: long, importance: 10 }]);
    expect(query).toHaveLength(120);
    expect(query.endsWith('…')).toBe(true);
  });

  it('an empty life asks for something new rather than nothing', () => {
    expect(ponderGroundQuery([])).toBe('something genuinely new worth learning today');
  });

  it('breaks an importance tie by input order (sort is stable)', () => {
    const tie = [
      { summary: 'first of the tie', importance: 5, ts: T0 },
      { summary: 'second of the tie', importance: 5, ts: T0 },
    ];
    expect(ponderGroundQuery(tie)).toBe('first of the tie');
  });
});

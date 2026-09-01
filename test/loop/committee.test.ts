// M13 loop — the committee: DAG validation, execution order, artifact
// validation, and the ponder-shaped spec. Node calls are plain model calls.

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { makeRng, TestClock } from '../../src/kernel/index.js';
import { MockModel } from '../../src/model/index.js';
import { recordingLog, stubAssemble, stubPacket, stubWindow } from './helpers.js';
import { runCommittee, topoOrder, validateCommittee } from '../../src/loop/committee.js';
import { LoopError } from '../../src/loop/errors.js';
import type { CommitteeEnv, CommitteeSpec } from '../../src/loop/index.js';

const envFor = (model: MockModel): CommitteeEnv => ({
  name: 'spec',
  model,
  packet: stubPacket(true, true),
  query: { text: 'the question', channels: { character: true, procedural: true } },
  affect: new Float64Array(12),
  turnId: 'turn_c1',
  signal: new AbortController().signal,
  maxTokens: 256,
  temperature: 0.3,
  tier: 'main',
});

const diamond = (): CommitteeSpec => ({
  name: 'diamond',
  nodes: [
    { id: 'a', needs: [], channels: { character: false, procedural: true }, prompt: 'start' },
    { id: 'b', needs: ['a'], channels: { character: false, procedural: true }, prompt: 'left' },
    { id: 'c', needs: ['a'], channels: { character: false, procedural: true }, prompt: 'right' },
    { id: 'd', needs: ['b', 'c'], channels: { character: false, procedural: true }, prompt: 'finish' },
  ],
  output: z.string(),
});

describe('validateCommittee', () => {
  it('accepts a well-formed DAG', () => {
    expect(() => validateCommittee(diamond())).not.toThrow();
  });

  it('rejects empty, duplicate-id, unknown-edge and cyclic specs with the typed failure', () => {
    const empty: CommitteeSpec = { name: 'x', nodes: [], output: z.string() };
    expect(() => validateCommittee(empty)).toThrow(LoopError);
    expect(() => validateCommittee(empty)).toThrow(expect.objectContaining({ code: 'loop/bad-committee' }));

    const dup: CommitteeSpec = {
      name: 'x',
      nodes: [
        { id: 'a', needs: [], channels: { character: false, procedural: true }, prompt: 'p' },
        { id: 'a', needs: [], channels: { character: false, procedural: true }, prompt: 'p' },
      ],
      output: z.string(),
    };
    expect(() => validateCommittee(dup)).toThrow(/twice/);

    const dangling: CommitteeSpec = {
      name: 'x',
      nodes: [{ id: 'a', needs: ['ghost'], channels: { character: false, procedural: true }, prompt: 'p' }],
      output: z.string(),
    };
    expect(() => validateCommittee(dangling)).toThrow(/unknown node 'ghost'/);

    const cyclic: CommitteeSpec = {
      name: 'x',
      nodes: [
        { id: 'a', needs: ['b'], channels: { character: false, procedural: true }, prompt: 'p' },
        { id: 'b', needs: ['a'], channels: { character: false, procedural: true }, prompt: 'p' },
      ],
      output: z.string(),
    };
    expect(() => validateCommittee(cyclic)).toThrow(/cycle/);
  });

  it('rejects requiresObservation without a needs edge — unreachable observation input', () => {
    const spec: CommitteeSpec = {
      name: 'ponder-broken',
      nodes: [{ id: 'REVISE', needs: [], channels: { character: false, procedural: true }, prompt: 'revise', requiresObservation: true }],
      output: z.string(),
    };
    expect(() => validateCommittee(spec)).toThrow(/requiresObservation but has no needs edge/);
  });
});

describe('topoOrder', () => {
  it('orders the diamond a, b, c, d (declared order inside a level)', () => {
    expect(topoOrder(diamond())).toEqual(['a', 'b', 'c', 'd']);
  });

  it('returns null for a cycle', () => {
    expect(
      topoOrder({
        name: 'x',
        nodes: [
          { id: 'a', needs: ['b'], channels: { character: false, procedural: true }, prompt: 'p' },
          { id: 'b', needs: ['a'], channels: { character: false, procedural: true }, prompt: 'p' },
        ],
        output: z.string(),
      }),
    ).toBeNull();
  });
});

describe('runCommittee', () => {
  it('runs nodes in dependency order and validates the terminal artifact', async () => {
    const clock = new TestClock(0);
    const model = new MockModel({ clock });
    model.enqueue({ content: 'A seeded' });
    model.enqueue({ content: 'B from A' });
    model.enqueue({ content: 'C from A' });
    model.enqueue({ content: 'D final' });
    const spec = diamond();
    const res = await runCommittee(spec, envFor(model));
    expect(res.ok).toBe(true);
    expect(res.artifact).toBe('D final');
    expect(res.outputs.map((o) => o.id)).toEqual(['a', 'b', 'c', 'd']);
    // Upstream output travels down the edge: node d's prompt names b and c.
    const dReq = model.calls[3]!;
    expect(dReq.messages[1]?.content).toContain('b: B from A');
    expect(dReq.messages[1]?.content).toContain('c: C from A');
  });

  it('gives each node its declared channels', async () => {
    const clock = new TestClock(0);
    const model = new MockModel({ clock });
    model.enqueue({ content: 'with voice' });
    model.enqueue({ content: 'without voice' });
    const spec: CommitteeSpec = {
      name: 'ch',
      nodes: [
        { id: 'a', needs: [], channels: { character: true, procedural: true }, prompt: 'p' },
        { id: 'b', needs: ['a'], channels: { character: false, procedural: true }, prompt: 'p' },
      ],
      output: z.string(),
    };
    await runCommittee(spec, envFor(model));
    expect(model.calls[0]?.messages[0]?.content).toContain('IDENTITY');
    expect(model.calls[0]?.messages[0]?.content).toContain('[PROCEDURAL]');
    // node b: procedural only — no identity channel reaches it
    expect(model.calls[1]?.messages[0]?.content).not.toContain('IDENTITY');
    expect(model.calls[1]?.messages[0]?.content).toContain('[PROCEDURAL]');
  });

  it('fails gracefully when a node output misses the schema — the committee never kills the turn', async () => {
    const clock = new TestClock(0);
    const model = new MockModel({ clock });
    model.enqueue({ content: 'first' });
    model.enqueue({ content: 'not the json you wanted' });
    const spec: CommitteeSpec = {
      name: 'strict',
      nodes: [
        { id: 'a', needs: [], channels: { character: false, procedural: true }, prompt: 'p' },
        { id: 'b', needs: ['a'], channels: { character: false, procedural: true }, prompt: 'return json', schema: z.object({ verdict: z.string() }) },
      ],
      output: z.object({ verdict: z.string() }),
    };
    const res = await runCommittee(spec, envFor(model));
    expect(res.ok).toBe(false);
    expect(res.artifact).toBeNull();
    expect(res.error).toContain("node 'b'");
    expect(res.outputs.map((o) => o.id)).toEqual(['a']);
  });

  it('runs a ponder-shaped spec: SEED, GROUND, REVISE (requiresObservation), ARTIFACT', async () => {
    const clock = new TestClock(0);
    const model = new MockModel({ clock });
    model.enqueue({ content: 'seed hunch' });
    model.enqueue({ content: 'grounding evidence' });
    model.enqueue({ content: 'revised hunch' });
    model.enqueue({ content: 'final artifact' });
    const spec: CommitteeSpec = {
      name: 'ponder',
      nodes: [
        { id: 'SEED', needs: [], channels: { character: true, procedural: true }, prompt: 'hunch' },
        { id: 'GROUND', needs: ['SEED'], channels: { character: false, procedural: true }, prompt: 'evidence' },
        { id: 'REVISE', needs: ['SEED', 'GROUND'], channels: { character: false, procedural: true }, prompt: 'revise', requiresObservation: true },
        { id: 'ARTIFACT', needs: ['REVISE'], channels: { character: false, procedural: true }, prompt: 'write it' },
      ],
      output: z.string(),
    };
    const res = await runCommittee(spec, envFor(model));
    expect(res.ok).toBe(true);
    expect(res.artifact).toBe('final artifact');
    expect(res.outputs.map((o) => o.id)).toEqual(['SEED', 'GROUND', 'REVISE', 'ARTIFACT']);
    // REVISE consumed the grounding observation through the edge, never through a prompt promise.
    const reviseReq = model.calls[2]!;
    expect(reviseReq.messages[1]?.content).toContain('GROUND: grounding evidence');
  });

  it('uses the ponder-seed task class and the env tier for node calls', async () => {
    const clock = new TestClock(0);
    const model = new MockModel({ clock });
    model.enqueue({ content: 'one' });
    const solo: CommitteeSpec = {
      name: 'solo',
      nodes: [{ id: 'a', needs: [], channels: { character: false, procedural: true }, prompt: 'p' }],
      output: z.string(),
    };
    await runCommittee(solo, envFor(model));
    expect(model.calls[0]?.taskClass).toBe('ponder-seed');
    expect(model.calls[0]?.tier).toBe('main');
  });
});

describe('committee via the loop harness pieces', () => {
  it('builds a usable env from the loop module helpers (wiring smoke)', () => {
    const events = recordingLog();
    expect(events.rows).toEqual([]);
    expect(typeof stubAssemble({ queries: [] })).toBe('function');
    expect(stubWindow().earlier()).toBeNull();
    expect(makeRng('x').float()).toBe(makeRng('x').float());
  });
});

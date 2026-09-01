// M13 loop — the spawn primitives: fork/task/committee as registry tools, the
// channel-composition rule, delegation episodes, and the depth/concurrency caps.

import { describe, expect, it } from 'vitest';
import type { InboundMsg } from '../../src/loop/index.js';
import { DECISION_LOCKED_KIND, DELEGATION_KIND, SPAWN_REFUSED_INCIDENT } from '../../src/loop/schema.js';
import { enqueueDecision, enqueueToolRound, makeHarness, type LoopHarness } from './helpers.js';

const inbound = (text = 'look into this for me'): InboundMsg => ({
  updateId: 1,
  msgId: 11,
  chatId: 42,
  ts: 999,
  text,
  speaker: { person: 'diego', channel: 'telegram' },
});

const entry = (over: Partial<Parameters<LoopHarness['run']>[0]> = {}): Parameters<LoopHarness['run']>[0] => ({
  kind: 'user-turn',
  inbound: inbound(),
  ...over,
});

describe('channel composition (ADR-009)', () => {
  it('fork: the subprocess assembles with BOTH channels and answers on the cheap tier', async () => {
    const h = makeHarness();
    enqueueToolRound(h.model, [{ name: 'fork', args: { brief: 'quick check' } }]);
    h.model.enqueue({ content: 'fork answer' }); // the subprocess's only assess
    enqueueDecision(h.model, { bubbles: ['checked'] });
    const d = await h.run(entry());

    expect(h.assembleSpy.queries).toHaveLength(2); // main + subprocess
    const sub = h.assembleSpy.queries[1]!;
    expect(sub.text).toBe('quick check');
    expect(sub.channels).toEqual({ character: true, procedural: true });

    const subCall = h.model.calls[1]!;
    expect(subCall.tier).toBe('cheap');
    expect(subCall.messages[0]?.content).toContain('IDENTITY'); // it is her
    expect(subCall.messages[0]?.content).toContain('[PROCEDURAL]');

    const spawn = d.spawns[0];
    expect(spawn).toMatchObject({ kind: 'fork', brief: 'quick check', channels: { character: true, procedural: true } });
    expect(spawn?.outcome).toBe('fork answer');
    expect(d.toolTrace[0]?.tool).toBe('fork');
    expect(d.toolTrace[0]?.result).toBe('fork answer');
  });

  it('task: the worker sees procedural only — zero character sections', async () => {
    const h = makeHarness();
    enqueueToolRound(h.model, [{ name: 'task', args: { brief: 'cold research' } }]);
    h.model.enqueue({ content: 'worker answer' });
    enqueueDecision(h.model, {});
    const d = await h.run(entry());

    const sub = h.assembleSpy.queries[1]!;
    expect(sub.channels).toEqual({ character: false, procedural: true });
    const subCall = h.model.calls[1]!;
    expect(subCall.messages[0]?.content).not.toContain('IDENTITY');
    expect(subCall.messages[0]?.content).toContain('WORKER');
    expect(d.spawns[0]?.channels).toEqual({ character: false, procedural: true });
  });

  it('every spawn emits a delegation episode the procedural generator can eat', async () => {
    const h = makeHarness();
    enqueueToolRound(h.model, [{ name: 'task', args: { brief: 'cold research' } }]);
    h.model.enqueue({ content: 'worker answer' });
    enqueueDecision(h.model, {});
    const d = await h.run(entry());
    const episodes = h.events.kinds(DELEGATION_KIND);
    expect(episodes).toHaveLength(1);
    expect(episodes[0]?.payload).toMatchObject({
      kind: 'task',
      spawnId: d.spawns[0]?.id,
      situation: 'look into this for me',
      call: 'task',
      resultSummary: 'worker answer',
      outcome: 'good',
    });
  });

  it('committee-as-a-tool: nodes get per-node channels and the artifact lands in the trace', async () => {
    const h = makeHarness();
    enqueueToolRound(h.model, [
      {
        name: 'committee',
        args: {
          spec: {
            name: 'mini',
            nodes: [
              { id: 'SEED', needs: [], prompt: 'hunch', character: true },
              { id: 'ARTIFACT', needs: ['SEED'], prompt: 'write it' },
            ],
          },
        },
      },
    ]);
    h.model.enqueue({ content: 'node a says hi' }); // SEED node call
    h.model.enqueue({ content: 'artifact value' }); // ARTIFACT node call
    enqueueDecision(h.model, { bubbles: [' committee done '] }); // the main deliberation resumes
    const d = await h.run(entry());
    // the committee runs over the ENTRY's packet (main channel call), not a re-assembly
    expect(h.assembleSpy.queries).toHaveLength(1);
    // calls: main round (the committee call), SEED node, ARTIFACT node, main decision
    const seed = h.model.calls[1]!;
    expect(seed.messages[0]?.content).toContain('IDENTITY'); // SEED asked for the character channel
    const artifact = h.model.calls[2]!;
    expect(artifact.messages[1]?.content).toContain('SEED: node a says hi');
    expect(d.toolTrace[0]?.result).toBe('artifact value');
    expect(d.spawns[0]).toMatchObject({ kind: 'committee', brief: 'mini', outcome: 'artifact value' });
    // decision.locked still records the main decision (bubbles), not the committee's
    expect(h.events.kinds(DECISION_LOCKED_KIND)).toHaveLength(1);
  });
});

describe('spawn caps', () => {
  it('depth cap: a fork from inside a depth-2 subprocess is refused with an incident, loop continues', async () => {
    const h = makeHarness();
    enqueueToolRound(h.model, [{ name: 'fork', args: { brief: 'level1' } }]); // main -> depth 1
    h.model.enqueue({ toolCalls: [{ id: 'f2', name: 'fork', argsJson: JSON.stringify({ brief: 'level2' }) }] }); // depth 1 -> 2
    h.model.enqueue({ toolCalls: [{ id: 'f3', name: 'fork', argsJson: JSON.stringify({ brief: 'level3' }) }] }); // depth 2 -> REFUSED
    h.model.enqueue({ content: 'leaf answer' }); // depth-2 subprocess decides
    h.model.enqueue({ content: 'mid answer' }); // depth-1 subprocess decides
    enqueueDecision(h.model, { bubbles: ['main done'] }); // main decides

    const d = await h.run(entry());
    expect(h.events.kinds(SPAWN_REFUSED_INCIDENT)).toHaveLength(1);
    const refusals = d.spawns.filter((s) => s.outcome?.startsWith('refused:'));
    expect(refusals).toHaveLength(1);
    expect(refusals[0]?.outcome).toContain('spawn depth cap (2) reached');
    expect(d.spawns).toHaveLength(3);
    // the refusal is answered as a tool observation, and the turn still locks
    expect(d.plan).toBe('reply');
    expect(d.bubbles).toEqual(['main done']);
    // the refused episode is bad; the two executed ones carry their answers
    const episodes = h.events.kinds(DELEGATION_KIND);
    expect(episodes.some((e) => (e.payload as { outcome: string }).outcome === 'bad')).toBe(true);
  });

  it('concurrency cap: a 4-spawn round executes 3 and refuses the tail', async () => {
    const h = makeHarness();
    enqueueToolRound(h.model, [
      { name: 'task', args: { brief: 'a' } },
      { name: 'task', args: { brief: 'b' } },
      { name: 'task', args: { brief: 'c' } },
      { name: 'task', args: { brief: 'd' } },
    ]);
    for (let i = 0; i < 4; i++) h.model.enqueue({ content: 'sub answer' });
    enqueueDecision(h.model, { bubbles: ['all done'] });
    const d = await h.run(entry());

    expect(d.toolTrace).toHaveLength(4);
    expect(d.spawns).toHaveLength(4);
    const refused = d.spawns.filter((s) => s.outcome?.startsWith('refused:'));
    expect(refused).toHaveLength(1);
    expect(refused[0]?.outcome).toContain('spawn concurrency cap (3)');
    const executed = d.spawns.filter((s) => s.outcome === 'sub answer');
    expect(executed).toHaveLength(3);
    const incidents = h.events.kinds(SPAWN_REFUSED_INCIDENT);
    expect(incidents).toHaveLength(1);
    // the refused call is answered on the wire like every other call
    const refusalAnswer = h.model.calls.some((c) =>
      c.messages.some((m) => m.role === 'tool' && m.content.startsWith('[refused] spawn concurrency cap')),
    );
    expect(refusalAnswer).toBe(true);
    expect(d.plan).toBe('reply');
  });
});

describe('subprocess edges', () => {
  it('a subprocess inherits the gate: its blocked tool call is denied and re-injected too', async () => {
    const h = makeHarness();
    enqueueToolRound(h.model, [{ name: 'fork', args: { brief: 'go search' } }]);
    h.model.enqueue({ toolCalls: [{ id: 's1', name: 'web_search', args: { q: 'blocked' } }] }); // denied inside the fork
    h.model.enqueue({ content: 'gave up politely' }); // the fork answers after the hint
    enqueueDecision(h.model, { bubbles: ['main done'] });
    const d = await h.run(entry());
    const forkCall = h.model.calls[2]!; // the fork's second assess, after the denial
    expect(forkCall.messages.some((m) => m.role === 'tool' && m.content.includes('[INHIBITION:loop-no-search]'))).toBe(true);
    expect(d.spawns[0]?.outcome).toBe('gave up politely');
    expect(h.events.kinds(SPAWN_REFUSED_INCIDENT)).toHaveLength(0);
  });

  it('a subprocess answer of empty text is a mixed outcome, recorded', async () => {
    const h = makeHarness();
    enqueueToolRound(h.model, [{ name: 'task', args: { brief: 'nothing to say' } }]);
    h.model.enqueue({ content: '' });
    enqueueDecision(h.model, {});
    const d = await h.run(entry());
    const episodes = h.events.kinds(DELEGATION_KIND);
    expect(episodes[0]?.payload).toMatchObject({ outcome: 'mixed' });
    expect(d.spawns[0]?.outcome).toBe('(no result)');
  });
});

describe('committee tool surface', () => {
  it('a single-node committee passes its artifact through as the tool observation', async () => {
    const h = makeHarness();
    enqueueToolRound(h.model, [
      { name: 'committee', args: { spec: { name: 'dud', nodes: [{ id: 'a', needs: [], prompt: 'p' }] } } },
    ]);
    h.model.enqueue({ content: 'node a speaks alone' });
    enqueueDecision(h.model, { bubbles: ['carried on'] });
    const d = await h.run(entry());
    expect(d.toolTrace[0]?.result).toBe('node a speaks alone');
    expect(d.spawns[0]).toMatchObject({ kind: 'committee', brief: 'dud', outcome: 'node a speaks alone' });
    expect(d.plan).toBe('reply');
  });
});

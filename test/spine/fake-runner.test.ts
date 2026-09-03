// M21 spine — S1.1, the SpineRunner seam. FakeRunner replays scripted
// StreamEvent sequences from JSON fixtures; the native loop and the fake runner
// agree on the decide shape because BOTH parse through src/loop's own decision
// schema (read-only import — the migration target stays one contract).

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ModelDecisionSchema, type ModelDecision } from '../../src/loop/index.js';
import { FakeRunner, type SpineRunOpts, type StreamEvent, type StreamEventFixture } from '../../src/spine/index.js';
import type { ToolDef } from '../../src/model/index.js';
import { collect, diegoTurn, stubPacket } from './helpers.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const goldenFixture = JSON.parse(readFileSync(join(fixturesDir, 'golden-turn.json'), 'utf8')) as {
  events: StreamEventFixture[];
};

const packet = stubPacket(true, false);
const opts = (turnId: string): SpineRunOpts => ({ turnId });
const decideOf = (events: StreamEvent[]): ModelDecision => {
  const ev = events.find((e): e is Extract<StreamEvent, { type: 'decide-object' }> => e.type === 'decide-object');
  if (ev === undefined) throw new Error('no decide-object in the stream');
  return ev.decision;
};

describe('FakeRunner (S1.1: run(entry, packet, tools, opts) -> AsyncIterable<StreamEvent>)', () => {
  it('fake-runner-replays-golden-turn', async () => {
    const runner = FakeRunner.fromFixture(goldenFixture);
    const events = await collect(runner.run(diegoTurn(), packet, [], opts('t1')));

    // the whole scripted sequence, in order, as typed StreamEvents
    expect(events.map((e) => e.type)).toEqual(['tool-call', 'text-delta', 'text-delta', 'usage', 'decide-object', 'stop-reason']);
    const [toolCall, ...rest] = events;
    expect(toolCall).toEqual({ type: 'tool-call', call: { id: 'call_1', name: 'memory_search', args: { query: 'deploy' } } });
    expect(rest[0]).toEqual({ type: 'text-delta', text: 'on it' });
    expect(rest[1]).toEqual({ type: 'text-delta', text: ' - checking the logs.' });
    if (rest[2]?.type !== 'usage') throw new Error('expected usage');
    expect(rest[2].usage.inputTokens).toBe(311);
    expect(rest[2].usage.outputTokens).toBe(42);
    expect(rest[2].usage.costUsd).toBe(0.0021);
    if (rest[4]?.type !== 'stop-reason') throw new Error('expected stop-reason');
    expect(rest[4].stopReason).toBe('tool_use');

    // the runner saw the whole turn surface (the loop-side seam contract)
    expect(runner.requests).toHaveLength(1);
    expect(runner.requests[0]?.entry.kind).toBe('user-turn');
    expect(runner.requests[0]?.systemText).toBe(packet.systemText());
    expect(runner.requests[0]?.trailerText).toBe(packet.trailerText());
  });

  it('validates a fixture decision through the loop schema at load — a bad fixture fails loud', () => {
    expect(() =>
      FakeRunner.fromFixture({ events: [{ type: 'decide-object', decision: { plan: 'reply', bubbles: [] } }] }),
    ).toThrow(/plan|confidence|required/i);
  });

  it('a run with no script left fails loud — no silent empty turns', async () => {
    const runner = new FakeRunner([]);
    await expect(collect(runner.run(diegoTurn(), packet, [], opts('t2')))).rejects.toThrow(/no scripted turn/i);
  });
});

describe('native loop and fake runner agree on the decide shape (S1.1)', () => {
  it('native-loop-and-fake-runner-agree-on-decide-shape', async () => {
    const { makeHarness } = await import('../loop/helpers.js');
    const decideArgs = {
      plan: 'reply' as const,
      bubbles: ['bad env var. pinning it.'],
      confidence: 0.9,
      weight: 0.8,
      reluctance: 0.2,
      completeness: 1,
    };

    // Native side: the real deliberation loop on a MockModel scripted with a
    // native `decide` tool call — the decision shape it locks is the contract.
    const harness = makeHarness({ strictModel: true });
    harness.model.enqueue({ toolCalls: [{ id: 'call_decide', name: 'decide', args: decideArgs }] });
    const locked = await harness.run(diegoTurn());
    expect(locked.decidedBy).toBe('model');

    // Spine side: FakeRunner replays the SAME decision through the seam.
    const runner = new FakeRunner([[{ type: 'decide-object', decision: decideArgs }]]);
    const streamed = decideOf(await collect(runner.run(diegoTurn(), packet, [], opts('t3'))));

    // Both parse through src/loop's own ModelDecisionSchema — one contract.
    const fromLoop = ModelDecisionSchema.safeParse(locked);
    expect(fromLoop.success).toBe(true);
    expect(ModelDecisionSchema.safeParse(streamed).success).toBe(true);
    expect(streamed).toEqual(fromLoop.success ? fromLoop.data : streamed);
  });
});

// The tools parameter is readonly ToolDef[] on the seam; keep one typing proof
// so a signature drift breaks here first.
export const _seamToolsType = (tools: readonly ToolDef[]): AsyncIterable<StreamEvent> =>
  new FakeRunner([]).run(diegoTurn(), packet, tools, opts('types'));

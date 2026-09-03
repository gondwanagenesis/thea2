// M13 loop — P-LOOP seam: when TurnState.runner is set, assess rides the spine
// (M21's SpineRunner) and the StreamEvents fold into the SAME ChatResponse the
// native door returns, so settleReply, the gate ladder and realize are
// transport-blind. Hermetic by law: FakeRunner only — no test ever launches
// the opencode binary (D.7-3).

import { describe, expect, it } from 'vitest';
import { DECISION_PROSE_FOLDED, decideToolDef, createToolRegistry } from '../../src/loop/index.js';
import type { DecisionObject, InboundMsg } from '../../src/loop/index.js';
import { FakeRunner, type StreamEventFixture } from '../../src/spine/index.js';
import { enqueueDecision, makeHarness, type LoopHarness } from './helpers.js';

const inbound = (text = 'hello there, what did you read today?'): InboundMsg => ({
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

const decideArgs = {
  plan: 'reply' as const,
  bubbles: ['spine says hi'],
  confidence: 0.9,
  weight: 0.8,
  reluctance: 0.2,
  completeness: 1,
};

const bareRegistry = (): ReturnType<typeof createToolRegistry> => createToolRegistry();

describe('P-LOOP seam: runner-present turns ride the spine', () => {
  it('a runner-present turn yields the decide object through the normal decision path', async () => {
    const spine = new FakeRunner([
      [
        { type: 'usage', inputTokens: 311, outputTokens: 42, costUsd: 0.0021, latencyMs: 120 },
        { type: 'decide-object', decision: decideArgs },
        { type: 'stop-reason', stopReason: 'end_turn' },
      ] satisfies StreamEventFixture[],
    ]);
    const h = makeHarness({ runner: spine });
    const d = await h.run(entry());

    // The SAME downstream path locked it: decidedBy 'model', the plan gate's
    // allow verdict recorded, everything the native decide call produces.
    expect(d.plan).toBe('reply');
    expect(d.decidedBy).toBe('model');
    expect(d.bubbles).toEqual(['spine says hi']);
    expect(d.confidence).toBe(0.9);
    expect(d.toolTrace).toEqual([]);
    expect(d.inhibitions).toEqual([{ allow: true }]);
    expect(h.events.kinds('decision.locked')).toHaveLength(1);
    // the native door never rang — the whole turn rode the spine
    expect(h.model.calls).toHaveLength(0);
    expect(spine.requests).toHaveLength(1);
    expect(spine.requests[0]?.entry.kind).toBe('user-turn');

    // and the twin native turn locks the identical object (the decision
    // contract is ONE contract, two transports — S1.1)
    const native = makeHarness({ strictModel: true });
    native.model.enqueue({ toolCalls: [{ id: 'call_decide', name: 'decide', args: decideArgs }] });
    const lockedNative: DecisionObject = await native.run(entry());
    const strip = (x: DecisionObject): Omit<DecisionObject, 'turnId'> => {
      const { turnId: _turnId, ...rest } = x;
      return rest;
    };
    expect(strip(d)).toEqual(strip(lockedNative));
  });

  it('a runner-present turn passes tool defs to the spine', async () => {
    const spine = new FakeRunner([[{ type: 'decide-object', decision: decideArgs }]]);
    const h = makeHarness({ runner: spine }); // default registry: echo + wedged
    const d = await h.run(entry());
    const req = spine.requests[0];
    expect(req).toBeDefined();
    // decide travels first, then the registry's defs, in order
    expect(req?.tools.map((t) => t.name)).toEqual(['decide', 'echo', 'wedged']);
    // the decide contract rides as the structured-output schema (S1.3)
    expect(req?.opts.decide?.schema).toEqual(decideToolDef.parameters);
    // the loop's own handles cross the seam: turn id, task class, wall-clock cut
    expect(req?.opts.turnId).toBe(d.turnId);
    expect(req?.opts.taskClass).toBe('turn');
    expect(req?.opts.signal).toBeInstanceOf(AbortSignal);
    // DR.7 parity: the offered registry tools' validators travel, decide never does
    expect(Object.keys(req?.opts.toolInput ?? {}).sort()).toEqual(['echo', 'wedged']);

    // a bare registry's user turn offers `decide` alone (FA.3), no validators
    const bare = new FakeRunner([[{ type: 'decide-object', decision: decideArgs }]]);
    await makeHarness({ runner: bare, tools: bareRegistry() }).run(entry());
    expect(bare.requests[0]?.tools.map((t) => t.name)).toEqual(['decide']);
    expect(bare.requests[0]?.opts.toolInput).toBeUndefined();
  });

  it('a spine tool round mediates through the gate and re-assesses', async () => {
    const spine = new FakeRunner([
      [
        { type: 'tool-call', id: 'call_1', name: 'echo', args: { text: 'ping' } },
        { type: 'stop-reason', stopReason: 'tool_use' },
      ],
      [{ type: 'decide-object', decision: decideArgs }],
    ]);
    const h = makeHarness({ runner: spine });
    const d = await h.run(entry());
    // the native mediation machinery ran the streamed call, unchanged
    expect(d.toolTrace).toHaveLength(1);
    expect(d.toolTrace[0]?.result).toBe('echo:ping');
    expect(h.echoSeen).toEqual([{ text: 'ping', depth: 0, turnId: d.turnId, entry: 'user-turn' }]);
    expect(d.plan).toBe('reply');
    expect(h.model.calls).toHaveLength(0);
    // one runner script consumed per assess call
    expect(spine.requests).toHaveLength(2);
  });

  it('text-delta events fold to content prose path', async () => {
    const spine = new FakeRunner([
      [
        { type: 'text-delta', text: 'I think ' },
        { type: 'text-delta', text: 'I will just say it in prose.' },
        { type: 'usage', inputTokens: 3, outputTokens: 9, latencyMs: 40 },
        { type: 'stop-reason', stopReason: 'end_turn' },
      ] satisfies StreamEventFixture[],
    ]);
    const h = makeHarness({ runner: spine });
    const d = await h.run(entry());
    // the folded prose IS the reply: deterministic fold, no repair call
    expect(d.plan).toBe('reply');
    expect(d.bubbles).toEqual(['I think I will just say it in prose.']);
    expect(d.decidedBy).toBe('model');
    expect(h.events.kinds(DECISION_PROSE_FOLDED)).toHaveLength(1);
    expect(h.model.calls).toHaveLength(0); // the repair ladder never fired
  });

  it('runner-absent turns keep the native path', async () => {
    const h = makeHarness(); // no runner wired — the default
    enqueueDecision(h.model, { bubbles: ['the native way'] });
    const d = await h.run(entry());
    expect(d.plan).toBe('reply');
    expect(d.bubbles).toEqual(['the native way']);
    expect(h.model.calls).toHaveLength(1); // the door served the turn
    expect(h.model.calls[0]?.tools?.map((t) => t.name)).toEqual(['decide', 'echo', 'wedged']);
  });
});

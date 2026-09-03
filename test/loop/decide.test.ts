// M13 loop — the decision contract on the wire (Phase 1, 2026-09-02). Before
// this, the assess call carried no schema: every live turn was prose plus a
// repair call that invented the cadence fields. Now `decide` is a native tool
// offered first, the packet carries the [OUTPUT] contract, prose folds
// deterministically, and every silence names who decided it.

import { describe, expect, it } from 'vitest';
import type { InboundMsg, LoopEntry } from '../../src/loop/index.js';
import {
  ASSEMBLE_FAILED_INCIDENT,
  DECIDE_TOOL_NAME,
  DECISION_LOCKED_KIND,
  DECISION_PARSE_INCIDENT,
  DECISION_PROSE_FOLDED,
  OUTPUT_CONTRACT,
  PROSE_FOLD_DEFAULTS,
  looksJsonShaped,
  proseToDecision,
} from '../../src/loop/index.js';
import { enqueueDecision, enqueueToolRound, makeHarness } from './helpers.js';

const inbound = (text = 'hey'): InboundMsg => ({
  updateId: 1,
  msgId: 1,
  chatId: 7,
  ts: 1_000_000,
  text,
  speaker: { person: 'diego', channel: 'telegram' },
});
const entry = (): LoopEntry => ({ kind: 'user-turn', inbound: inbound() });

const decideCall = (args: unknown, id = 'd0'): { id: string; name: string; args: unknown } => ({ id, name: DECIDE_TOOL_NAME, args });

describe('the wire carries the contract', () => {
  it('`decide` is the first tool def on every main assess call and [OUTPUT] rides the head system message', async () => {
    const h = makeHarness();
    enqueueDecision(h.model, { bubbles: ['hi'] });
    await h.run(entry());
    const call = h.model.calls[0]!;
    expect(call.tools?.[0]?.name).toBe(DECIDE_TOOL_NAME);
    // FA.3: a user turn offers no spawn primitives — the base registry only
    expect(call.tools?.map((t) => t.name)).toEqual(expect.arrayContaining(['echo', 'wedged']));
    expect(call.tools?.map((t) => t.name)).not.toContain('fork');
    const head = call.messages[0]!;
    expect(head.role).toBe('system');
    expect(head.content).toContain(OUTPUT_CONTRACT);
  });

  it('a subprocess worker never sees `decide` — it answers in content', async () => {
    const h = makeHarness();
    // FA.3: spawns ride ponder/heartbeat entries, so the delegation runs there
    enqueueToolRound(h.model, [{ name: 'task', args: { brief: 'count to three' } }]);
    h.model.enqueue({ content: 'one two three' }); // the worker's answer
    enqueueDecision(h.model, { bubbles: ['three'] });
    await h.run({ kind: 'ponder', goal: 'counting' });
    const worker = h.model.calls[1]!;
    expect(worker.tools?.map((t) => t.name)).not.toContain(DECIDE_TOOL_NAME);
    expect(worker.messages[0]?.content).not.toContain('[OUTPUT]');
  });
});

describe('a native `decide` call locks the decision — no repair, no second call', () => {
  it('well-formed args lock with decidedBy model and the cadence fields the model authored', async () => {
    const h = makeHarness();
    h.model.enqueue({
      toolCalls: [decideCall({ plan: 'reply', bubbles: ['ok', 'sending'], confidence: 0.4, weight: 0.9, reluctance: 0.6, completeness: 0.3 })],
    });
    const d = await h.run(entry());
    expect(d.plan).toBe('reply');
    expect(d.decidedBy).toBe('model');
    expect(d.bubbles).toEqual(['ok', 'sending']);
    expect(d.reluctance).toBe(0.6);
    expect(d.completeness).toBe(0.3);
    expect(h.model.calls).toHaveLength(1);
    expect(h.events.kinds(DECISION_PARSE_INCIDENT)).toHaveLength(0);
    expect(h.events.kinds(DECISION_LOCKED_KIND)[0]?.payload).toMatchObject({ decidedBy: 'model', plan: 'reply' });
  });

  it('a `decide` silence is her own: decidedBy model, plan silent', async () => {
    const h = makeHarness();
    h.model.enqueue({ toolCalls: [decideCall({ plan: 'silent', bubbles: [], confidence: 0.8, weight: 0.2, reluctance: 0.9, completeness: 1 })] });
    const d = await h.run(entry());
    expect(d.plan).toBe('silent');
    expect(d.decidedBy).toBe('model');
  });

  it('a `decide` call with args off the schema gets exactly one repair, then locks', async () => {
    const h = makeHarness();
    h.model.enqueue({ toolCalls: [decideCall({ plan: 'maybe', bubbles: 'not-an-array' })] });
    enqueueDecision(h.model, { bubbles: ['repaired'] });
    const d = await h.run(entry());
    expect(d.bubbles).toEqual(['repaired']);
    expect(d.decidedBy).toBe('model');
    expect(h.model.calls).toHaveLength(2);
    // FA.4: the repair rides the voice door, same as assess
    expect(h.model.calls[1]?.tier).toBe('main');
  });

  it('`decide` after a tool round: the round is mediated, then the decision locks', async () => {
    const h = makeHarness();
    enqueueToolRound(h.model, [{ name: 'echo', args: { text: 'x' } }]);
    h.model.enqueue({ toolCalls: [decideCall({ plan: 'reply', bubbles: ['echoed'], confidence: 1, weight: 1, reluctance: 0, completeness: 1 })] });
    const d = await h.run(entry());
    expect(d.toolTrace.map((s) => s.tool)).toEqual(['echo']);
    expect(d.bubbles).toEqual(['echoed']);
    expect(d.decidedBy).toBe('model');
  });
});

describe('prose folds deterministically — the repair rung is exceptional', () => {
  it('plain prose becomes bubbles at the blank lines, with the documented defaults, and no second call', async () => {
    const h = makeHarness();
    h.model.enqueue({ content: 'ok so\n\nT: the box is fine\n\n  what are you up to  ' });
    const d = await h.run(entry());
    expect(d.plan).toBe('reply');
    expect(d.decidedBy).toBe('model');
    expect(d.bubbles).toEqual(['ok so', 'the box is fine', 'what are you up to']);
    expect(d.confidence).toBe(PROSE_FOLD_DEFAULTS.confidence);
    expect(d.reluctance).toBe(PROSE_FOLD_DEFAULTS.reluctance);
    expect(h.model.calls).toHaveLength(1);
    expect(h.events.kinds(DECISION_PROSE_FOLDED)).toHaveLength(1);
    expect(h.events.kinds(DECISION_PROSE_FOLDED)[0]?.payload).toMatchObject({ bubbles: 3 });
  });

  it('JSON-shaped-but-broken content still goes to the one repair', async () => {
    const h = makeHarness();
    h.model.enqueue({ content: '{"plan": "reply", "bubbles": [' });
    enqueueDecision(h.model, { bubbles: ['fixed'] });
    const d = await h.run(entry());
    expect(d.bubbles).toEqual(['fixed']);
    expect(h.model.calls).toHaveLength(2);
    expect(h.events.kinds(DECISION_PROSE_FOLDED)).toHaveLength(0);
  });

  it('pure functions: looksJsonShaped and proseToDecision', () => {
    expect(looksJsonShaped('  {"a":1}')).toBe(true);
    expect(looksJsonShaped('```json\n{}')).toBe(true);
    expect(looksJsonShaped('hi there')).toBe(false);
    expect(proseToDecision('   \n\n  ')).toBeNull();
    expect(proseToDecision('Thea: one\n\nT: two')?.bubbles).toEqual(['one', 'two']);
  });
});

describe('silence names who decided it', () => {
  it('empty content twice (assess + repair) is a FAILURE silence, not a decision', async () => {
    const h = makeHarness();
    h.model.enqueue({ content: '' });
    h.model.enqueue({ content: '' });
    const d = await h.run(entry());
    expect(d.plan).toBe('silent');
    expect(d.decidedBy).toBe('failure');
    expect(h.events.kinds(DECISION_PARSE_INCIDENT)).toHaveLength(1);
  });

  it('the hard plan rule forced past the cap is a GATE silence', async () => {
    const h = makeHarness();
    for (let i = 0; i < 4; i++) enqueueDecision(h.model, { bubbles: ['⟦leak⟧'] });
    const d = await h.run(entry());
    expect(d.plan).toBe('silent');
    expect(d.decidedBy).toBe('gate');
  });

  it('budget exhaustion without a decision is a FAILURE silence', async () => {
    const h = makeHarness({ cfg: { maxToolHops: 1 } });
    enqueueToolRound(h.model, [{ name: 'echo', args: { text: 'a' } }]);
    enqueueToolRound(h.model, [{ name: 'echo', args: { text: 'b' } }]);
    const d = await h.run(entry());
    expect(d.plan).toBe('silent');
    expect(d.decidedBy).toBe('failure');
  });

  it('an assembler throw is loud (incident.assemble_failed) and a FAILURE silence', async () => {
    const h = makeHarness();
    const deps = { ...h.deps, assemble: async () => { throw new Error('corpus index broke'); } };
    const { runLoop } = await import('../../src/loop/index.js');
    const d = await runLoop(entry(), deps);
    expect(d.plan).toBe('silent');
    expect(d.decidedBy).toBe('failure');
    const inc = h.events.kinds(ASSEMBLE_FAILED_INCIDENT);
    expect(inc).toHaveLength(1);
    expect(inc[0]?.payload).toMatchObject({ error: 'corpus index broke' });
    expect(h.model.calls).toHaveLength(0);
  });
});

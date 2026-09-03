// M13 loop — the S4 gate proofs run on the public entry: hop scripts, caps,
// gate re-entry branches, the one-shot decision repair ladder, the wedged-tool
// cut, and the native function-calling invariant.

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { InboundMsg } from '../../src/loop/index.js';
import type { DecisionObject } from '../../src/loop/index.js';
import { GATE_LOOP_INCIDENT, DECISION_PARSE_INCIDENT, TOOL_TIMEOUT_INCIDENT } from '../../src/loop/schema.js';
import { compileGate, type GateConfig } from '../../src/inhibit/index.js';
import {
  LOOP_YAML,
  enqueueDecision,
  enqueueToolRound,
  makeHarness,
  promptText,
  toolNamesOnWire,
  type LoopHarness,
} from './helpers.js';

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

describe('hop scripts land valid DecisionObjects', () => {
  it('0 hops: the decision locks straight off the assess call', async () => {
    const h = makeHarness();
    enqueueDecision(h.model, { bubbles: ['read a paper on moss'] });
    const d = await h.run(entry());
    expect(d.plan).toBe('reply');
    expect(d.bubbles).toEqual(['read a paper on moss']);
    expect(d.confidence).toBe(0.9);
    expect(d.toolTrace).toEqual([]);
    expect(d.spawns).toEqual([]);
    expect(d.turnId).toBeTruthy();
    // the plan gate's allow verdict is recorded like any other
    expect(d.inhibitions).toEqual([{ allow: true }]);
  });

  it('1 hop: gate -> execute -> observe -> reassess, with the tool answered on the wire', async () => {
    const h = makeHarness();
    enqueueToolRound(h.model, [{ name: 'echo', args: { text: 'ping' } }]);
    enqueueDecision(h.model, { bubbles: ['done'] });
    const d = await h.run(entry());
    expect(d.toolTrace).toHaveLength(1);
    const step = d.toolTrace[0];
    expect(step?.tool).toBe('echo');
    expect(step?.result).toBe('echo:ping');
    expect(step?.verdict).toEqual({ allow: true });
    expect(step?.ms).toBeGreaterThanOrEqual(0);
    expect(h.echoSeen).toEqual([{ text: 'ping', depth: 0, turnId: d.turnId, entry: 'user-turn' }]);
    // the round replays on the wire: assistant toolCalls message, then the tool answer
    const after = h.model.calls[1]!;
    const callMsg = after.messages.find((m) => m.role === 'assistant' && m.toolCalls !== undefined);
    expect(callMsg?.toolCalls?.[0]?.name).toBe('echo');
    const answer = after.messages.find((m) => m.role === 'tool');
    expect(answer?.toolCallId).toBe('call_0');
    expect(answer?.content).toBe('echo:ping');
    // and the assistant call precedes its answers
    expect(after.messages.indexOf(callMsg!)).toBeLessThan(after.messages.indexOf(answer!));
  });

  it('n hops: every round lands in the trace in order', async () => {
    const h = makeHarness();
    enqueueToolRound(h.model, [{ name: 'echo', args: { text: 'one' } }]);
    enqueueToolRound(h.model, [{ name: 'echo', args: { text: 'two' } }]);
    enqueueToolRound(h.model, [{ name: 'echo', args: { text: 'three' } }]);
    enqueueDecision(h.model, { bubbles: ['finished'] });
    const d = await h.run(entry());
    expect(d.toolTrace.map((s) => s.result)).toEqual(['echo:one', 'echo:two', 'echo:three']);
    expect(h.model.calls).toHaveLength(4);
    expect(d.plan).toBe('reply');
  });
});

describe('caps', () => {
  it('the hop cap terminates cleanly with a typed outcome, not a hang', async () => {
    const h = makeHarness({
      cfg: { maxToolHops: 2 },
      rule: (m) => m.onTask('turn', () => ({ toolCalls: [{ id: 'c', name: 'echo', args: { text: 'x' } }] })),
    });
    const d = await h.run(entry());
    expect(d.plan).toBe('silent'); // no decision was on the table when the cap hit
    expect(d.completeness).toBe(0.5); // truncation reflected
    expect(h.model.calls).toHaveLength(2);
  });

  it('a wedged tool is cut at its timeout and the loop survives — hermetically', async () => {
    const h = makeHarness();
    enqueueToolRound(h.model, [{ name: 'wedged', args: { text: 'hangs forever' } }]);
    enqueueDecision(h.model, { bubbles: ['still here'] });
    const p = h.run(entry());
    await h.untilWedged(); // the cut's waiter is registered; the wedge can now be fired
    await h.clock.advance(h.cfg.toolTimeoutMs + 1);
    const d = (await p) as DecisionObject;
    expect(d.plan).toBe('reply');
    expect(d.bubbles).toEqual(['still here']);
    expect(d.toolTrace[0]?.result).toMatchObject({ error: 'timeout' });
    const timeouts = h.events.kinds(TOOL_TIMEOUT_INCIDENT);
    expect(timeouts).toHaveLength(1);
    expect(timeouts[0]?.payload).toMatchObject({ tool: 'wedged', turnId: d.turnId });
    // the abandoned call is answered like any other, so the wire stays valid
    const answer = h.model.calls[1]?.messages.find((m) => m.role === 'tool');
    expect(answer?.content).toContain('[timeout]');
  });
});

describe('gate re-entry (MAX_GATE_REENTRIES = 2)', () => {
  it('hard tool rule: hint re-injected each round, then forced silent + incident', async () => {
    const h = makeHarness();
    enqueueToolRound(h.model, [{ name: 'web_search', args: { q: 'x' } }]);
    enqueueToolRound(h.model, [{ name: 'web_search', args: { q: 'x' } }]);
    enqueueToolRound(h.model, [{ name: 'web_search', args: { q: 'x' } }]);
    const d = await h.run(entry());
    expect(d.plan).toBe('silent');
    expect(d.bubbles).toEqual([]);
    // three denials recorded, each re-injected as the tool message hint
    expect(d.inhibitions.filter((v) => !v.allow)).toHaveLength(3);
    for (const call of h.model.calls.slice(1, 3)) {
      expect(call.messages.some((m) => m.role === 'tool' && m.content.includes('[INHIBITION:loop-no-search]'))).toBe(true);
    }
    const incidents = h.events.kinds(GATE_LOOP_INCIDENT);
    expect(incidents).toHaveLength(1);
    expect(incidents[0]?.payload).toMatchObject({
      turnId: d.turnId,
      ruleIds: ['loop-no-search'],
      reentries: 3,
      resolution: 'forced-silent',
    });
  });

  it('soft plan rule: the cap fails OPEN — the decision locks as-authored + incident', async () => {
    const h = makeHarness();
    const tell = { bubbles: ['it is not only clever, but kind'] };
    enqueueDecision(h.model, tell);
    enqueueDecision(h.model, tell);
    enqueueDecision(h.model, tell);
    const d = await h.run(entry());
    expect(d.plan).toBe('reply');
    expect(d.bubbles[0]).toContain('not only clever, but');
    const incidents = h.events.kinds(GATE_LOOP_INCIDENT);
    expect(incidents).toHaveLength(1);
    expect(incidents[0]?.payload).toMatchObject({ ruleIds: ['loop-soft-tell'], reentries: 3, resolution: 'fail-open' });
    expect(h.model.calls).toHaveLength(3);
  });

  it('hard plan rule: the cap forces plan silent + incident', async () => {
    const h = makeHarness();
    const leak = { bubbles: ['⟦ internal machinery ⟦'] };
    enqueueDecision(h.model, leak);
    enqueueDecision(h.model, leak);
    enqueueDecision(h.model, leak);
    const d = await h.run(entry());
    expect(d.plan).toBe('silent');
    expect(d.bubbles).toEqual([]);
    const incidents = h.events.kinds(GATE_LOOP_INCIDENT);
    expect(incidents).toHaveLength(1);
    expect(incidents[0]?.payload).toMatchObject({ ruleIds: ['loop-hard-leak'], resolution: 'forced-silent' });
  });

  it('the plan path re-entry carries the denied draft and the hint', async () => {
    const h = makeHarness();
    enqueueDecision(h.model, { bubbles: ['it is not only clever, but kind'] });
    enqueueDecision(h.model, { bubbles: ['a clean sentence'] });
    const d = await h.run(entry());
    expect(d.bubbles).toEqual(['a clean sentence']);
    const revise = h.model.calls[1]!;
    expect(revise.messages.some((m) => m.role === 'assistant' && m.content.includes('not only clever'))).toBe(true);
    expect(revise.messages.some((m) => m.content.includes('[INHIBITION:loop-soft-tell]'))).toBe(true);
  });
});

describe('normalize runs before the plan gate (what is checked is what sends)', () => {
  it('the locked decision carries the normalize-class substitutions, not the raw draft', async () => {
    const yaml = `${LOOP_YAML}

normalize:
  - id: em-dash
    why: test fixture mirrors canon/inhibitions.yaml
    replace: { from: '\\s*—\\s*', to: '. ' }
  - id: smart-ellipsis
    replace: { from: '…', to: '...' }
`;
    const gate = compileGate(yaml, {
      ownerChatId: 'chat-diego',
      knownTools: ['web_search', 'echo', 'wedged', 'never', 'fork', 'task', 'committee'],
    } satisfies GateConfig);
    const h = makeHarness({ gate });
    enqueueDecision(h.model, { bubbles: ['wait — really — ok… done'] });
    const d = await h.run(entry());
    expect(d.plan).toBe('reply');
    expect(d.bubbles).toEqual(['wait. really. ok... done']);
  });
});

describe('the decision repair ladder (exactly ONE cheap-tier repair)', () => {
  it('JSON-shaped malformed assess response -> one repair -> locked decision', async () => {
    const h = makeHarness();
    h.model.enqueue({ content: '{"plan": "reply", "bubbles": ["hi"], "confidence": ' });
    enqueueDecision(h.model, { bubbles: ['repaired'] });
    const d = await h.run(entry());
    expect(d.bubbles).toEqual(['repaired']);
    expect(h.model.calls).toHaveLength(2);
    const repair = h.model.calls[1]!;
    expect(repair.tier).toBe('cheap');
    expect(repair.temperature).toBe(0);
    expect(repair.messages.at(-1)?.content).toContain('could not be parsed');
    expect(h.events.kinds(DECISION_PARSE_INCIDENT)).toHaveLength(0);
  });

  it('plain prose is NOT a malformation: it folds into bubbles with no repair call (Phase 1)', async () => {
    const h = makeHarness();
    h.model.enqueue({ content: 'I think I will just say hi in prose, not json.' });
    const d = await h.run(entry());
    expect(d.bubbles).toEqual(['I think I will just say hi in prose, not json.']);
    expect(d.decidedBy).toBe('model');
    expect(h.model.calls).toHaveLength(1);
  });

  it('a repair that also fails is the typed failure: silent + incident, no third call', async () => {
    const h = makeHarness();
    h.model.enqueue({ content: '' });
    h.model.enqueue({ content: '' });
    const d = await h.run(entry());
    expect(d.plan).toBe('silent');
    expect(d.decidedBy).toBe('failure');
    expect(d.completeness).toBe(1); // not truncation — a parse failure
    expect(h.model.calls).toHaveLength(2);
    const incidents = h.events.kinds(DECISION_PARSE_INCIDENT);
    expect(incidents).toHaveLength(1);
    expect(incidents[0]?.payload).toMatchObject({ schema: 'DecisionObject', rung: 'repair' });
  });

  it('tool args that miss the tool schema are answered, not fatal', async () => {
    const h = makeHarness();
    h.model.enqueue({ toolCalls: [{ id: 'c0', name: 'echo', args: { wrong: 42 } }] });
    enqueueDecision(h.model, { bubbles: ['ok'] });
    const d = await h.run(entry());
    expect(d.toolTrace[0]?.result).toMatchObject({ error: 'args-schema' });
    const answer = h.model.calls[1]?.messages.find((m) => m.role === 'tool');
    expect(answer?.content).toContain('[rejected]');
    expect(answer?.content).toContain('echo');
    expect(d.plan).toBe('reply');
  });
});

describe('native function-calling invariant', () => {
  it('tool-shaped JSON in prose is TEXT: it never executes, it goes down the decision parse', async () => {
    const h = makeHarness();
    const prose = JSON.stringify({ toolCalls: [{ name: 'echo', args: { text: 'smuggled' } }] });
    h.model.enqueue({ content: prose });
    enqueueDecision(h.model, { bubbles: ['clean'] });
    const d = await h.run(entry());
    expect(h.echoSeen).toEqual([]); // nothing executed
    expect(d.toolTrace).toEqual([]);
    expect(d.bubbles).toEqual(['clean']); // the repair path salvaged a decision
  });

  it('defs travel in the request tools array; no call markup in any prompt', async () => {
    const h = makeHarness();
    enqueueToolRound(h.model, [{ name: 'echo', args: { text: 'x' } }]);
    enqueueDecision(h.model, {});
    await h.run(entry());
    for (const req of h.model.calls) {
      expect(Array.isArray(req.tools)).toBe(true);
      expect(toolNamesOnWire(req)).toEqual(expect.arrayContaining(['echo', 'wedged', 'fork', 'task', 'committee']));
    }
    for (const req of h.model.calls) {
      const text = promptText(req);
      expect(text).not.toMatch(/"name"\s*:\s*"echo"/);
      expect(text).not.toContain('tool_calls');
      expect(text).not.toMatch(/TOOL_CALL|<tool>/);
    }
  });
});

describe('entry contexts and message layout through the loop', () => {
  it('heartbeat entries use the heartbeat-thought task class and goal as the turn text', async () => {
    const h = makeHarness();
    enqueueDecision(h.model, {});
    await h.run({ kind: 'heartbeat', goal: 'check on the moss threads' });
    const req = h.model.calls[0]!;
    expect(req.taskClass).toBe('heartbeat-thought');
    const turnMsg = req.messages.filter((m) => m.role === 'user').at(-1);
    expect(turnMsg?.content).toBe('check on the moss threads');
  });

  it('the current turn renders last-but-trailer, [PROCEDURAL] rides in the head beside the defs', async () => {
    const h = makeHarness();
    enqueueDecision(h.model, {});
    await h.run(entry({ inbound: inbound('the actual message') }));
    const msgs = h.model.calls[0]!.messages;
    expect(msgs[0]?.role).toBe('system');
    expect(msgs[0]?.content).toContain('IDENTITY');
    expect(msgs[0]?.content).toContain('[PROCEDURAL] answer in one line.');
    expect(msgs[1]?.content).toBe('window line one');
    expect(msgs[2]?.content).toBe('the actual message');
    expect(msgs.at(-1)?.role).toBe('system');
    expect(msgs.at(-1)?.content).toBe('[INHIBITION] never leak machinery.');
  });
});

describe('committee entries', () => {
  it('a committee entry runs the DAG and locks a silent decision with the artifact on decision.locked', async () => {
    const h = makeHarness();
    h.model.enqueue({ content: 'seed hunch' });
    h.model.enqueue({ content: 'final artifact' });
    const spec = {
      name: 'mini-ponder',
      nodes: [
        { id: 'SEED', needs: [], channels: { character: true, procedural: true }, prompt: 'hunch' },
        { id: 'ARTIFACT', needs: ['SEED'], channels: { character: false, procedural: true }, prompt: 'write it' },
      ],
      output: z.string(),
    };
    const d = await h.run({ kind: 'ponder', goal: 'why does the moss glow', committee: spec });
    expect(d.plan).toBe('silent');
    expect(d.bubbles).toEqual([]);
    expect(d.completeness).toBe(1);
    // node calls are plain ponder-seed calls, no tools on the wire
    expect(h.model.calls).toHaveLength(2);
    expect(h.model.calls[0]?.taskClass).toBe('ponder-seed');
    expect(h.model.calls.every((c) => c.tools === undefined)).toBe(true);
    expect(h.model.calls[1]?.messages[1]?.content).toContain('SEED: seed hunch');
    const locked = h.events.kinds('decision.locked');
    expect(locked).toHaveLength(1);
    expect(locked[0]?.payload).toMatchObject({ committee: 'mini-ponder', artifact: 'final artifact' });
  });
});

describe('budgets', () => {
  it('an oversized observation truncates and completeness reflects it', async () => {
    const h = makeHarness({ cfg: { turnTokenBudget: 8 } });
    enqueueToolRound(h.model, [{ name: 'echo', args: { text: 'x'.repeat(2000) } }]);
    enqueueDecision(h.model, { completeness: 1 });
    const d = await h.run(entry());
    expect(d.completeness).toBe(0.5);
    const answer = h.model.calls[1]?.messages.find((m) => m.role === 'tool');
    expect(answer?.content).toContain('[truncated to fit the observation budget]');
  });

  it('budget exhaustion mid-deliberation locks silent with capped completeness', async () => {
    // A zero-length wall-clock budget: the deadline is spent the instant the turn begins.
    const h = makeHarness({ cfg: { budgetMs: { 'user-turn': 0, heartbeat: 120_000, ponder: 300_000 } } });
    enqueueDecision(h.model, {});
    const d = await h.run(entry());
    expect(d.plan).toBe('silent');
    expect(d.completeness).toBe(0.5);
    expect(h.model.calls).toHaveLength(0); // no model call ever happened
  });
});

// P-DOOR — doors with control (DR.2 reasoning by class, DR.3 per-door forcing,
// DR.4 observability). Hermetic: injected Transports, memory event log, no
// network. Door runtimes are built the same way compose builds them: one
// {door, send} per tier, resolved through the router's tier→door table.

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { TestClock } from '../../src/kernel/clock.js';
import { makeRng } from '../../src/kernel/index.js';
import {
  ANTHROPIC_THINKING_BUDGETS,
  buildWireBody,
  chatCore,
  createModelClient,
  DECIDE_TOOL,
  makeRouter,
  REASONING_BY_CLASS,
  TASK_CLASSES,
  zaiTransport,
  type ChatRequest,
  type Door,
  type EndpointCapabilities,
  type ModelCallEvent,
  type Tier,
  type Transport,
  type TransportCall,
  type TransportResult,
  type WireBody,
  type WireResponse,
} from '../../src/model/index.js';
import { buildAnthropicBody, parseAnthropicSSE, type AnthropicBody } from '../../src/model/anthropic.js';
import { modelError } from '../../src/model/errors.js';
import { memoryLog, TEST_TIERS, wireOk } from './helpers.js';
import { SSE_END_TURN } from './sse-fixtures.js';

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

/** No-op log for client-level flows whose assertions ride on the wire bodies. */
const silentLog = (): ReturnType<typeof memoryLog>['log'] => memoryLog().log;

const voiceDoor = (over: Partial<Door> = {}): Door => ({
  name: 'voice',
  protocol: 'openai',
  model: 'glm-5.3',
  forcing: 'none',
  effort: 'low',
  ...over,
});

/** One door shape stamped for each tier (compose's tier→door resolution, flattened). */
const doorsFor = (over: Partial<Door> = {}): Record<Tier, Door> => ({
  main: voiceDoor(over),
  cheap: voiceDoor({ ...over, name: 'mind' }),
  reasoning: voiceDoor({ ...over, name: 'judge' }),
});

/** Recording Transport: scripted response bodies in FIFO order; keeps wire bodies. */
const recordingSend = (responses: Array<Record<string, unknown>>) => {
  const bodies: WireBody[] = [];
  const queue = [...responses];
  const send: Transport = async (call: TransportCall): Promise<TransportResult> => {
    bodies.push(call.body);
    const next = queue.shift();
    if (next === undefined) throw new Error('recordingSend: no scripted response left');
    return { response: next as WireResponse, attempts: 1 };
  };
  return { send, bodies };
};

/** Transport handing back an already-folded SSE body, like consumeSSE does on the anthropic door. */
const foldedSend = (sse: string) => {
  const bodies: WireBody[] = [];
  const send: Transport = async (call: TransportCall): Promise<TransportResult> => {
    bodies.push(call.body);
    return { response: parseAnthropicSSE(sse) as unknown as WireResponse, attempts: 1 };
  };
  return { send, bodies };
};

const doorCore = (
  send: Transport,
  doors: Record<Tier, Door>,
  capabilities?: EndpointCapabilities,
): ReturnType<typeof chatCore> =>
  chatCore({
    router: makeRouter({
      tiers: { ...TEST_TIERS },
      doors: { voice: doors.main, mind: doors.cheap, judge: doors.reasoning },
    }),
    ...(capabilities !== undefined ? { capabilities } : {}),
    doors: {
      main: { door: doors.main, send },
      cheap: { door: doors.cheap, send },
      reasoning: { door: doors.reasoning, send },
    },
  });

const clientOver = (send: Transport, doors: Record<Tier, Door>, log: ReturnType<typeof memoryLog>['log']) =>
  createModelClient({
    core: doorCore(send, doors),
    log,
    clock: new TestClock(1_000),
  });

const req = (over: Partial<ChatRequest<any>> = {}): ChatRequest<any> => ({
  taskClass: 'turn',
  tier: 'main',
  messages: [{ role: 'user', content: 'hi' }],
  maxTokens: 100,
  temperature: 0.7,
  ...over,
});

// ---------------------------------------------------------------------------
// DR.2 — reasoning control by class, on both wires
// ---------------------------------------------------------------------------

/** The anthropic body rides the same TransportResult as the openai one — cast to its real shape for assertions. */
const anthropicBody = (b: WireBody | undefined): AnthropicBody => b as unknown as AnthropicBody;

describe('DR.2 — reasoning control by class', () => {
  it('every task class carries a reasoning control on both wires', async () => {
    for (const taskClass of TASK_CLASSES) {
      const effort = REASONING_BY_CLASS[taskClass];
      // Both wires run through the CLIENT, the way prod calls do — the class
      // default is applied by client.chat, the door's wire maps it.
      // openai wire: reasoning_effort rides the body
      const o = recordingSend([wireOk({ content: 'ok' })]);
      await clientOver(o.send, doorsFor({ protocol: 'openai', model: 'glm-5.3' }), silentLog()).chat(
        req({ taskClass }),
      );
      expect(o.bodies[0]!.reasoning_effort, `openai wire, class ${taskClass}`).toBe(effort);

      // anthropic wire: thinking {type:'enabled', budget} rides the body
      const a = foldedSend(SSE_END_TURN);
      await clientOver(a.send, doorsFor({ protocol: 'anthropic', model: 'glm-5.3-flash' }), silentLog()).chat(
        req({ taskClass }),
      );
      expect(anthropicBody(a.bodies[0]).thinking, `anthropic wire, class ${taskClass}`).toEqual({
        type: 'enabled',
        budget_tokens: ANTHROPIC_THINKING_BUDGETS[effort],
      });
    }
  });

  it('none maps to minimal on glm models over the openai wire', () => {
    const glm = buildWireBody({ req: req({ reasoning: 'none' }), model: 'glm-5.3', rung: 'auto', seedSupported: false });
    expect(glm.reasoning_effort).toBe('minimal');
    const glmFlash = buildWireBody({
      req: req({ reasoning: 'none' }),
      model: 'glm-5.3-flash',
      rung: 'auto',
      seedSupported: false,
    });
    expect(glmFlash.reasoning_effort).toBe('minimal');
    // Non-glm doors take 'none' verbatim — that is the door's business.
    const deepseek = buildWireBody({
      req: req({ reasoning: 'none' }),
      model: 'deepseek-v4-flash',
      rung: 'auto',
      seedSupported: false,
    });
    expect(deepseek.reasoning_effort).toBe('none');
    // Other efforts pass through unchanged on glm.
    const high = buildWireBody({ req: req({ reasoning: 'high' }), model: 'glm-5.3', rung: 'auto', seedSupported: false });
    expect(high.reasoning_effort).toBe('high');
  });

  it('the anthropic wire never sends type disabled', () => {
    // A caller asking for 'disabled' has the field dropped, never forwarded.
    const dropped = buildAnthropicBody({
      req: req({ thinking: { type: 'disabled' } }),
      model: 'glm-5.3-flash',
      rung: 'auto',
      seedSupported: false,
    });
    expect(dropped.thinking).toBeUndefined();
    // The door-derived control is always type enabled (none ⇒ the table's 128 budget).
    const derived = buildAnthropicBody({
      req: req({ reasoning: 'none' }),
      door: voiceDoor({ protocol: 'anthropic', model: 'glm-5.3-flash' }),
      model: 'glm-5.3-flash',
      rung: 'auto',
      seedSupported: false,
    });
    expect(derived.thinking).toEqual({ type: 'enabled', budget_tokens: ANTHROPIC_THINKING_BUDGETS['none'] });
    expect(derived.thinking?.type).toBe('enabled');
  });

  it('a caller override wins over the class default', async () => {
    // turn's class default is low; the caller asks for max on both wires.
    const o = recordingSend([wireOk({ content: 'ok' })]);
    const { log, events } = memoryLog();
    await clientOver(o.send, doorsFor({ protocol: 'openai', model: 'glm-5.3' }), log).chat(
      req({ reasoning: 'max' }),
    );
    expect(o.bodies[0]!.reasoning_effort).toBe('max');
    expect((events.filter((e) => e.kind === 'model.call')[0]!.payload as ModelCallEvent).reasoning).toBe('max');

    const a = foldedSend(SSE_END_TURN);
    await doorCore(a.send, doorsFor({ protocol: 'anthropic', model: 'glm-5.3-flash' }))(
      req({ reasoning: 'max' }),
      undefined,
      'auto',
    );
    expect(anthropicBody(a.bodies[0]).thinking).toEqual({
      type: 'enabled',
      budget_tokens: ANTHROPIC_THINKING_BUDGETS['max'],
    });
  });

  it('the door thinkingBudget outranks the effort table on the anthropic wire', async () => {
    const a = foldedSend(SSE_END_TURN);
    await doorCore(a.send, doorsFor({ protocol: 'anthropic', model: 'glm-5.3-flash', thinkingBudget: 512 }))(
      req({ taskClass: 'turn' }), // class default low (table would say 512 too); budget pins it anyway
      undefined,
      'auto',
    );
    expect(anthropicBody(a.bodies[0]).thinking).toEqual({ type: 'enabled', budget_tokens: 512 });
  });
});

// ---------------------------------------------------------------------------
// DR.3 — forcing per door
// ---------------------------------------------------------------------------

const FOUR_DEFS = [
  { name: DECIDE_TOOL, description: 'Lock the decision.', parameters: {} },
  { name: 'search', description: 's', parameters: {} },
  { name: 'echo', description: 'e', parameters: {} },
  { name: 'done', description: 'd', parameters: {} },
];

describe('DR.3 — forcing per door', () => {
  it('decide is forced on a forcing door with four defs', async () => {
    const o = recordingSend([wireOk({ content: 'ok' })]);
    await doorCore(o.send, doorsFor({ protocol: 'openai', model: 'glm-5.3', forcing: 'tool_choice' }))(
      req({ tools: FOUR_DEFS }),
      undefined,
      'auto',
    );
    expect(o.bodies[0]!.tool_choice).toEqual({ type: 'function', function: { name: DECIDE_TOOL } });

    const a = foldedSend(SSE_END_TURN);
    await doorCore(a.send, doorsFor({ protocol: 'anthropic', model: 'glm-5.3-flash', forcing: 'tool_choice' }))(
      req({ tools: FOUR_DEFS }),
      undefined,
      'auto',
    );
    expect(a.bodies[0]!.tool_choice).toEqual({ type: 'tool', name: DECIDE_TOOL });
  });

  it('decide is not forced on a none door', async () => {
    const o = recordingSend([wireOk({ content: 'ok' })]);
    await doorCore(o.send, doorsFor({ protocol: 'openai', model: 'glm-5.3', forcing: 'none' }))(
      req({ tools: FOUR_DEFS }),
      undefined,
      'auto',
    );
    expect(o.bodies[0]!.tool_choice).toBe('auto'); // the legacy default stands, no forced function
  });

  it('forcing never fires without decide among the defs, and a caller toolChoice outranks the door', async () => {
    const noDecide = FOUR_DEFS.slice(1);
    const o = recordingSend([wireOk({ content: 'ok' })]);
    await doorCore(o.send, doorsFor({ forcing: 'tool_choice' }))(req({ tools: noDecide }), undefined, 'auto');
    expect(o.bodies[0]!.tool_choice).toBe('auto');

    const caller = recordingSend([wireOk({ content: 'ok' })]);
    await doorCore(caller.send, doorsFor({ forcing: 'tool_choice' }))(
      req({ tools: FOUR_DEFS, toolChoice: { name: 'search' } }),
      undefined,
      'auto',
    );
    expect(caller.bodies[0]!.tool_choice).toEqual({ type: 'function', function: { name: 'search' } });
  });
});

// ---------------------------------------------------------------------------
// DR.4 — observability
// ---------------------------------------------------------------------------

describe('DR.4 — model.call payload', () => {
  it('stop reason is on every model.call', async () => {
    const stop = wireOk({ content: 'plain reply' }) as Record<string, unknown>;
    (stop['choices'] as Array<Record<string, unknown>>)[0]!['finish_reason'] = 'stop';
    const toolUse = wireOk({
      toolCalls: [{ id: 'c1', name: 'search', arguments: '{"q":"x"}' }],
    }) as Record<string, unknown>;
    (toolUse['choices'] as Array<Record<string, unknown>>)[0]!['finish_reason'] = 'tool_calls';
    const o = recordingSend([stop, toolUse]);
    const { log, events } = memoryLog();
    const client = clientOver(o.send, doorsFor(), log);
    await client.chat(req({ taskClass: 'summarize' }));
    await client.chat(req({ taskClass: 'summarize', tools: [{ name: 'search', description: 's', parameters: {} }] }));

    const calls = events.filter((e) => e.kind === 'model.call');
    expect(calls).toHaveLength(2);
    expect((calls[0]!.payload as ModelCallEvent).stopReason).toBe('end_turn');
    expect((calls[1]!.payload as ModelCallEvent).stopReason).toBe('tool_use');
  });

  it('a priced door writes costUsd; an unpriced door omits it', async () => {
    const o = recordingSend([wireOk({ content: 'ok' }), wireOk({ content: 'ok' })]);
    const { log, events } = memoryLog();
    const priced = clientOver(
      o.send,
      doorsFor({ pricing: { inputPerM: 3, outputPerM: 15 } }),
      log,
    );
    await priced.chat(req());
    const unpriced = clientOver(o.send, doorsFor(), log);
    await unpriced.chat(req());

    const calls = events.filter((e) => e.kind === 'model.call');
    expect(calls).toHaveLength(2);
    // 11 in · 3/M + 7 out · 15/M = (33 + 105) / 1e6
    expect((calls[0]!.payload as ModelCallEvent).costUsd).toBeCloseTo(1.38e-4, 9);
    expect('costUsd' in (calls[1]!.payload as ModelCallEvent)).toBe(false);
  });

  it('the payload names the door, the request cap, and the reasoning control', async () => {
    const o = recordingSend([wireOk({ content: 'ok' })]);
    const { log, events } = memoryLog();
    await clientOver(o.send, doorsFor(), log).chat(req({ maxTokens: 321 }));
    const payload = events.filter((e) => e.kind === 'model.call')[0]!.payload as ModelCallEvent;
    expect(payload.door).toBe('voice');
    expect(payload.maxTokens).toBe(321);
    expect(payload.reasoning).toBe(REASONING_BY_CLASS['turn']);
    expect(payload.tier).toBe('main');
  });

  it('a failed call reports the attempts it made', async () => {
    // A door transport that always 500s, maxRetries 1 ⇒ 2 HTTP attempts, then the throw.
    const statuses: number[] = [];
    const fetchImpl = (async (): Promise<Response> => {
      statuses.push(500);
      return { ok: false, status: 500, text: async () => 'body 500' } as unknown as Response;
    }) as unknown as typeof fetch;
    const send = zaiTransport({
      apiKey: 'k',
      clock: new TestClock(0),
      rng: makeRng('doors/failed-attempts'),
      fetchImpl,
      backoff: { baseMs: 0, capMs: 0 },
      maxRetries: 1,
    });
    const { log, events } = memoryLog();
    const client = createModelClient({ core: doorCore(send, doorsFor()), log, clock: new TestClock(0) });
    await expect(client.chat(req())).rejects.toThrowError(
      expect.objectContaining({ code: 'model/http-error' }),
    );
    expect(statuses).toEqual([500, 500]);
    const payload = events.filter((e) => e.kind === 'model.call')[0]!.payload as ModelCallEvent;
    expect(payload.outcome).toBe('error');
    expect(payload.usage.attempts).toBe(2);
  });

  it('a mid-ladder failure folds the failed send into the credited attempts', async () => {
    // First generation succeeds (1 attempt); the repair send burns 2 attempts
    // and dies — the transport stamps the thrown ModelError with its attempt
    // count (the zaiTransport DR.4 contract), and the client credits the sum.
    let sends = 0;
    const flaky: Transport = async () => {
      sends += 1;
      if (sends === 1) return { response: wireOk({ content: '{nope' }) as WireResponse, attempts: 1 };
      const err = modelError('model/timeout', 'no response within 50 ms', { retryable: true });
      (err as { attempts?: number }).attempts = 2;
      throw err;
    };
    const { log, events } = memoryLog();
    const client = createModelClient({ core: doorCore(flaky, doorsFor()), log, clock: new TestClock(0) });
    await expect(
      client.chat(req({ taskClass: 'summarize', schema: z.object({ a: z.number() }) })),
    ).rejects.toThrowError(expect.objectContaining({ code: 'model/timeout' }));
    const payload = events.filter((e) => e.kind === 'model.call')[0]!.payload as ModelCallEvent;
    expect(payload.usage.attempts).toBe(3); // 1 (first generation) + 2 (failed repair send)
  });
});

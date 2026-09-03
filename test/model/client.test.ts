// M03 model — the shared client: one model.call per chat, the structured-output
// ladder over a recording Transport, the one-shot repair ladder, usage math.

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { TestClock } from '../../src/kernel/clock.js';
import type { EventLog } from '../../src/events/index.js';
import {
  chatCore,
  createModelClient,
  makeRouter,
  type CoreChat,
  type ModelCallEvent,
  type ParseFailedEvent,
  type Transport,
  type TransportCall,
  type TransportResult,
  type WireBody,
  type WireResponse,
} from '../../src/model/index.js';
import { MockModel } from '../../src/model/mock.js';
import { baseReq, memoryLog, TEST_TIERS, wireOk } from './helpers.js';

const router = makeRouter({ tiers: { ...TEST_TIERS } });
const silent = (): EventLog => memoryLog().log;

/** Recording Transport: scripted response bodies in FIFO order; counts sends, keeps wire bodies. */
const fakeSend = (responses: Array<{ body?: Record<string, unknown>; attempts?: number }>) => {
  const bodies: WireBody[] = [];
  const queue = [...responses];
  const send: Transport = async (call: TransportCall): Promise<TransportResult> => {
    bodies.push(call.body);
    const next = queue.shift();
    if (next === undefined) throw new Error('fakeSend: no scripted response left');
    return { response: (next.body ?? wireOk({ content: 'ok' })) as WireResponse, attempts: next.attempts ?? 1 };
  };
  return { send, bodies, count: (): number => bodies.length };
};

const clientOver = (send: Transport, log: EventLog, capabilities?: { jsonSchema?: boolean; seed?: boolean }) =>
  createModelClient({
    core: chatCore({ router, ...(capabilities !== undefined ? { capabilities } : {}), send }),
    log,
    clock: new TestClock(1_000),
    ...(capabilities !== undefined ? { capabilities } : {}),
  });

/** A scripted CoreChat for client-level tests that bypass the wire entirely. */
const scriptedCore = (
  outcomes: Array<Partial<{ content: string; inputTokens: number; outputTokens: number; attempts: number }>>,
  impl?: () => void,
): CoreChat => {
  const queue = [...outcomes];
  return async () => {
    if (impl) impl();
    const next = queue.shift();
    if (next === undefined) throw new Error('scriptedCore: no scripted outcome');
    return {
      content: next.content ?? '',
      toolCalls: [],
      malformedToolCalls: [],
      inputTokens: next.inputTokens ?? 1,
      outputTokens: next.outputTokens ?? 1,
      attempts: next.attempts ?? 1,
      model: 'scripted',
      tier: 'main',
    };
  };
};

describe('one chat ⇒ exactly one model.call, usage populated', () => {
  it('plain chat emits model.call(ok) with tokens and clock-measured latency', async () => {
    const { log, events } = memoryLog();
    const client = createModelClient({
      core: scriptedCore([{ content: 'hello', inputTokens: 3, outputTokens: 4, attempts: 1 }]),
      log,
      clock: new TestClock(5_000),
    });
    const res = await client.chat({ ...baseReq(), taskClass: 'summarize' });
    expect(res.content).toBe('hello');
    expect(res.usage).toEqual({ inputTokens: 3, outputTokens: 4, latencyMs: 0, attempts: 1 });

    const calls = events.filter((e) => e.kind === 'model.call');
    expect(calls).toHaveLength(1);
    const payload = calls[0]!.payload as ModelCallEvent;
    expect(payload.outcome).toBe('ok');
    expect(payload.usage.inputTokens).toBe(3);
    expect(payload.usage.attempts).toBe(1);
    expect(payload.taskClass).toBe('summarize');
  });

  it('a thrown model error still emits exactly one model.call with outcome=error, then rethrows', async () => {
    const { log, events } = memoryLog();
    const client = createModelClient({
      core: scriptedCore([], () => {
        throw new Error('boom');
      }),
      log,
      clock: new TestClock(0),
    });
    await expect(client.chat(baseReq())).rejects.toThrow();
    const calls = events.filter((e) => e.kind === 'model.call');
    expect(calls).toHaveLength(1);
    // 'boom' is not a ModelError ⇒ generic 'error' outcome.
    expect((calls[0]!.payload as ModelCallEvent).outcome).toBe('error');
  });

  it('MockModel delayMs moves the injected clock into usage.latencyMs deterministically', async () => {
    const clock = new TestClock(10_000);
    const model = new MockModel({ clock });
    model.enqueue({ content: 'slow', delayMs: 250 });
    const pending = model.chat({ ...baseReq(), taskClass: 'turn', tier: 'main' });
    const res = await clock.advance(250).then(() => pending);
    expect(res.usage.latencyMs).toBe(250);
  });
});

describe('structured-output ladder — rung matrix over real wire bodies', () => {
  const SCHEMA = z.object({ a: z.number() });

  it('rung (a) json_schema when the capability flag says supported', async () => {
    const { send, bodies } = fakeSend([{ body: wireOk({ content: '{"a":1}' }) }]);
    const client = clientOver(send, silent(), { jsonSchema: true });
    const res = await client.chat({ ...baseReq(), schema: SCHEMA });
    expect(res.content).toEqual({ a: 1 });
    expect(bodies[0]!.response_format?.type).toBe('json_schema');
  });

  it('rung (b) forced emit tool when json_schema is unsupported and no tools are set', async () => {
    const { send, bodies } = fakeSend([
      { body: wireOk({ toolCalls: [{ id: 'e1', name: 'emit', arguments: '{"a":2}' }] }) },
    ]);
    const client = clientOver(send, silent());
    const res = await client.chat({ ...baseReq(), schema: SCHEMA });
    expect(res.content).toEqual({ a: 2 });
    expect(bodies[0]!.tools).toHaveLength(1);
    expect(bodies[0]!.tools![0]!.function.name).toBe('emit');
    // The synthetic emit is the channel, not a visible tool call.
    expect(res.toolCalls).toBeUndefined();
  });

  it('AC: rung (b) is never used when tools are non-empty — rung (c) rides instead', async () => {
    const { send, bodies } = fakeSend([{ body: wireOk({ content: '{"a":3}' }) }]);
    const client = clientOver(send, silent());
    const req = {
      ...baseReq(),
      schema: SCHEMA,
      tools: [{ name: 'user_tool', description: 'd', parameters: {} }],
    };
    const res = await client.chat(req);
    expect(res.content).toEqual({ a: 3 });
    const body = bodies[0]!;
    expect(body.tools!.map((t) => t.function.name)).toEqual(['user_tool']); // no synthetic emit
    expect(body.tool_choice).toBe('auto');
    expect(body.response_format).toBeUndefined();
    expect(body.messages.at(-1)!.role).toBe('system'); // prompted-JSON instruction
  });

  it('no schema ⇒ plain path, no ladder extras on the wire', async () => {
    const { send, bodies } = fakeSend([{ body: wireOk({ content: 'plain' }) }]);
    const client = clientOver(send, silent());
    await client.chat(baseReq());
    expect(bodies[0]!.response_format).toBeUndefined();
    expect(bodies[0]!.tools).toBeUndefined();
    expect(bodies[0]!.messages).toHaveLength(1);
  });
});

describe('one-shot repair ladder', () => {
  it('AC: malformed JSON at rung (c) triggers exactly one repair on the requesting tier and succeeds', async () => {
    const { send, bodies, count } = fakeSend([
      { body: wireOk({ content: '{nope' }) },
      { body: wireOk({ content: '{"a":9}' }) },
    ]);
    const { log, events } = memoryLog();
    const client = clientOver(send, log);
    const res = await client.chat({ ...baseReq(), schema: z.object({ a: z.number() }) });
    expect(res.content).toEqual({ a: 9 });
    expect(count()).toBe(2);
    // P-DOOR DR.6: the repair keeps the REQUESTING tier (never downgrades)…
    expect(bodies[1]!.model).toBe(TEST_TIERS.main);
    // …and doubles the token budget (DR.6).
    expect(bodies[1]!.max_tokens).toBe(200);
    // The correction turn carries the parse failure; a trailing [OUTPUT FORMAT]
    // system message may sit after it depending on the rung the repair rides.
    expect(bodies[1]!.messages.some((m) => (m.content ?? '').includes('could not be parsed'))).toBe(true);
    // No parse_failed: the repair succeeded.
    expect(events.filter((e) => e.kind === 'model.parse_failed')).toHaveLength(0);
  });

  it('AC: a second failure is a typed model/parse-failed + model.parse_failed(rung=repair)', async () => {
    const { send } = fakeSend([
      { body: wireOk({ content: '{nope' }) },
      { body: wireOk({ content: 'still bad' }) },
    ]);
    const { log, events } = memoryLog();
    const client = clientOver(send, log);
    await expect(client.chat({ ...baseReq(), schema: z.object({ a: z.number() }), schemaName: 'Appraisal' })).rejects.toThrowError(
      expect.objectContaining({ code: 'model/parse-failed' }),
    );
    const failed = events.filter((e) => e.kind === 'model.parse_failed');
    expect(failed).toHaveLength(1);
    const payload = failed[0]!.payload as ParseFailedEvent;
    expect(payload.rung).toBe('repair');
    expect(payload.schema).toBe('Appraisal');
  });

  it('malformed tool-call arguments get their own cheap repair keyed by call id', async () => {
    const { send } = fakeSend([
      { body: wireOk({ toolCalls: [{ id: 't1', name: 'search', arguments: '{bad' }] }) },
      { body: wireOk({ content: '{"t1":{"q":"hi"}}' }) },
    ]);
    const client = clientOver(send, silent());
    const res = await client.chat({
      ...baseReq(),
      tools: [{ name: 'search', description: 'd', parameters: {} }],
    });
    expect(res.toolCalls).toEqual([{ id: 't1', name: 'search', args: { q: 'hi' } }]);
  });

  it('unrepairable tool arguments are model/tool-call-failed + a parse_failed naming the tool', async () => {
    const { send } = fakeSend([
      { body: wireOk({ toolCalls: [{ id: 't1', name: 'search', arguments: '{bad' }] }) },
      { body: wireOk({ content: 'not an object map' }) },
    ]);
    const { log, events } = memoryLog();
    const client = clientOver(send, log);
    await expect(
      client.chat({ ...baseReq(), tools: [{ name: 'search', description: 'd', parameters: {} }] }),
    ).rejects.toThrowError(expect.objectContaining({ code: 'model/tool-call-failed' }));
    const payload = events.filter((e) => e.kind === 'model.parse_failed')[0]!.payload as ParseFailedEvent;
    expect(payload.schema).toBe('tool-args(search)');
  });
});

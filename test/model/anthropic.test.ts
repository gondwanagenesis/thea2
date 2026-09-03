// M03 model — the Anthropic-protocol wire (z.ai coding-plan door): body
// building (system hoist, tool_result grouping, forced-emit rung), response
// parsing (thinking blocks dropped, tool_use decoded), SSE folding, and the
// transport's protocol switch (URL, headers, stream:true, SSE consumed).
// Hermetic: injected fetchImpl + TestClock, same idiom as transport.test.ts.

import { describe, expect, it } from 'vitest';
import { TestClock } from '../../src/kernel/clock.js';
import { makeRng } from '../../src/kernel/index.js';
import {
  buildAnthropicBody,
  parseAnthropicResponse,
  parseAnthropicSSE,
} from '../../src/model/anthropic.js';
import {
  chatCore,
  createModelClient,
  makeRouter,
  zaiTransport,
  type ModelCallEvent,
  type Transport,
  type WireResponse,
} from '../../src/model/index.js';
import { z } from 'zod';
import type { ChatRequest } from '../../src/model/types.js';
import { memoryLog, TEST_TIERS } from './helpers.js';
import {
  SSE_END_TURN,
  SSE_ERROR_INVALID_REQUEST,
  SSE_ERROR_OVERLOADED,
  SSE_MAX_TOKENS_EMPTY,
  SSE_MAX_TOKENS_WITH_CONTENT,
  sseResponse,
} from './sse-fixtures.js';

// `any` mirrors BuildBodyInput: the body builder shapes requests it never parses.
const req = (over: Partial<ChatRequest<any>> = {}): ChatRequest<any> => ({
  taskClass: 'turn',
  tier: 'main',
  messages: [{ role: 'user', content: 'hi' }],
  maxTokens: 100,
  temperature: 0.5,
  ...over,
});

// ---------------------------------------------------------------------------
// buildAnthropicBody
// ---------------------------------------------------------------------------

describe('buildAnthropicBody', () => {
  it('hoists system messages into the top-level system string', () => {
    const body = buildAnthropicBody({
      req: req({
        messages: [
          { role: 'system', content: 'IDENTITY: you are Thea.' },
          { role: 'user', content: 'hey' },
          { role: 'system', content: '[INHIBITION] never leak machinery.' },
        ],
      }),
      model: 'glm-5.3-flash',
      rung: 'auto',
      seedSupported: false,
    });
    expect(body.system).toBe('IDENTITY: you are Thea.\n\n[INHIBITION] never leak machinery.');
    expect(body.messages).toEqual([{ role: 'user', content: 'hey' }]);
  });

  it('maps the forced-emit rung: schema becomes the emit tool, tool_choice pinned', () => {
    const body = buildAnthropicBody({
      req: req({ schema: z.object({ answer: z.number() }) }),
      model: 'glm-5.3-flash',
      rung: 'tool_call',
      seedSupported: false,
    });
    expect(body.tools).toHaveLength(1);
    expect(body.tools?.[0]?.name).toBe('emit');
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'emit' });
  });

  it('appends the schema prose to system on the prompted rung', () => {
    const body = buildAnthropicBody({
      req: req({ schema: z.object({ answer: z.number() }), messages: [{ role: 'user', content: 'q' }] }),
      model: 'glm-5.3-flash',
      rung: 'prompted_json',
      seedSupported: false,
    });
    expect(body.tool_choice).toBeUndefined();
    expect(body.system).toContain('JSON');
  });

  it('groups consecutive tool rows into one user message of tool_result blocks', () => {
    const body = buildAnthropicBody({
      req: req({
        messages: [
          { role: 'user', content: 'search' },
          {
            role: 'assistant',
            content: '',
            toolCalls: [
              { id: 'c1', name: 'web_search', args: { q: 'x' } },
              { id: 'c2', name: 'web_search', args: { q: 'y' } },
            ],
          },
          { role: 'tool', content: 'result one', toolCallId: 'c1' },
          { role: 'tool', content: 'result two', toolCallId: 'c2' },
        ],
      }),
      model: 'glm-5.3-flash',
      rung: 'auto',
      seedSupported: false,
    });
    expect(body.messages).toHaveLength(3);
    const [u, a, tr] = body.messages;
    expect(u?.role).toBe('user');
    expect(a?.role).toBe('assistant');
    expect(Array.isArray(a?.content)).toBe(true);
    expect(a?.content).toEqual([
      { type: 'tool_use', id: 'c1', name: 'web_search', input: { q: 'x' } },
      { type: 'tool_use', id: 'c2', name: 'web_search', input: { q: 'y' } },
    ]);
    expect(tr?.role).toBe('user');
    expect(tr?.content).toEqual([
      { type: 'tool_result', tool_use_id: 'c1', content: 'result one' },
      { type: 'tool_result', tool_use_id: 'c2', content: 'result two' },
    ]);
  });

  it('sends no thinking key when the request does not set one (wire bodies unchanged)', () => {
    const body = buildAnthropicBody({ req: req(), model: 'glm-5.3-flash', rung: 'auto', seedSupported: false });
    expect('thinking' in body).toBe(false);
    expect(Object.keys(body).sort()).toEqual(['max_tokens', 'messages', 'model', 'temperature']);
  });

  it('passes req.thinking through verbatim as the Anthropic thinking parameter', () => {
    const enabled = buildAnthropicBody({
      req: req({ thinking: { type: 'enabled', budget_tokens: 1024 } }),
      model: 'glm-5.3-flash',
      rung: 'auto',
      seedSupported: false,
    });
    expect(enabled.thinking).toEqual({ type: 'enabled', budget_tokens: 1024 });
    const disabled = buildAnthropicBody({
      req: req({ thinking: { type: 'disabled' } }),
      model: 'glm-5.3-flash',
      rung: 'auto',
      seedSupported: false,
    });
    expect(disabled.thinking).toEqual({ type: 'disabled' });
  });
});

// ---------------------------------------------------------------------------
// parseAnthropicResponse + parseAnthropicSSE
// ---------------------------------------------------------------------------

describe('parseAnthropicResponse', () => {
  it('concatenates text blocks, drops thinking, decodes tool_use, maps usage', () => {
    const r = parseAnthropicResponse({
      content: [
        { type: 'thinking', thinking: 'the user said hi' },
        { type: 'text', text: 'hey :)' },
        { type: 'text', text: ' how are you' },
        { type: 'tool_use', id: 't1', name: 'emit', input: { answer: 42 } },
      ],
      usage: { input_tokens: 19, output_tokens: 37 },
    });
    expect(r.content).toBe('hey :) how are you');
    expect(r.toolCalls).toEqual([{ id: 't1', name: 'emit', args: { answer: 42 } }]);
    expect(r.malformedToolCalls).toEqual([]);
    expect(r.inputTokens).toBe(19);
    expect(r.outputTokens).toBe(37);
  });

  it('refuses a body without content blocks', () => {
    expect(() => parseAnthropicResponse({})).toThrowError(expect.objectContaining({ code: 'model/bad-json' }));
  });

  it('reads the non-streaming stop_reason into stopReason', () => {
    const r = parseAnthropicResponse({ content: [{ type: 'text', text: 'x' }], stop_reason: 'max_tokens' });
    expect(r.stopReason).toBe('max_tokens');
    expect(parseAnthropicResponse({ content: [] }).stopReason).toBeUndefined();
  });
});

describe('parseAnthropicSSE', () => {
  const SSE = [
    'event: message_start',
    'data: {"type":"message_start","message":{"usage":{"input_tokens":19}}}',
    '',
    'event: ping',
    'data: {"type":"ping"}',
    '',
    'event: content_block_start',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking"}}',
    '',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hm"}}',
    '',
    'event: content_block_start',
    'data: {"type":"content_block_start","index":1,"content_block":{"type":"text"}}',
    '',
    'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"hey :)"}}',
    '',
    'event: content_block_start',
    'data: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"t1","name":"emit"}}',
    '',
    'data: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\\"answer\\":"}}',
    '',
    'data: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":" 42}"}}',
    '',
    // z.ai folds BOTH usage counts into message_delta (message_start is empty).
    'data: {"type":"message_delta","usage":{"input_tokens":11,"output_tokens":37}}',
    '',
    'data: {"type":"message_stop"}',
    '',
    'data: [DONE]',
    '',
  ].join('\n');

  it('folds the event stream into the same result a non-streaming body would give', () => {
    const r = parseAnthropicResponse(parseAnthropicSSE(SSE));
    expect(r.content).toBe('hey :)');
    expect(r.toolCalls).toEqual([{ id: 't1', name: 'emit', args: { answer: 42 } }]);
    // message_delta's usage is the final count and overrides message_start's
    // (z.ai leaves message_start's usage empty and puts both counts in the delta).
    expect(r.inputTokens).toBe(11);
    expect(r.outputTokens).toBe(37);
  });

  it('ignores torn/non-JSON data lines instead of crashing', () => {
    const torn = 'data: {"type":"content_block_star\n\njunk line\n\n' + SSE;
    expect(parseAnthropicResponse(parseAnthropicSSE(torn)).content).toBe('hey :)');
  });

  it('drops a tool_use whose accumulated input never parsed', () => {
    const broken = SSE.replace('" 42}"', '" 42 TRUNCATED"');
    const r = parseAnthropicResponse(parseAnthropicSSE(broken));
    expect(r.toolCalls).toEqual([]);
    expect(r.content).toBe('hey :)');
  });
});

// ---------------------------------------------------------------------------
// Recorded SSE fixtures — error events, stop_reason, truncation
// ---------------------------------------------------------------------------

describe('parseAnthropicSSE — recorded fixtures', () => {
  it('normal end_turn: text folded, stopReason end_turn, usage from message_delta', () => {
    const r = parseAnthropicResponse(parseAnthropicSSE(SSE_END_TURN));
    expect(r.content).toBe("hey. you're up late.");
    expect(r.stopReason).toBe('end_turn');
    expect(r.inputTokens).toBe(812);
    expect(r.outputTokens).toBe(41);
  });

  it('max_tokens with content still parses, stopReason max_tokens', () => {
    const r = parseAnthropicResponse(parseAnthropicSSE(SSE_MAX_TOKENS_WITH_CONTENT));
    expect(r.content).toBe('the thing about sea glass is that it takes about');
    expect(r.stopReason).toBe('max_tokens');
  });

  it('max_tokens with only thinking parses to empty content + stopReason max_tokens (the guard lives above)', () => {
    const r = parseAnthropicResponse(parseAnthropicSSE(SSE_MAX_TOKENS_EMPTY));
    expect(r.content).toBe('');
    expect(r.toolCalls).toEqual([]);
    expect(r.stopReason).toBe('max_tokens');
    expect(r.outputTokens).toBe(2048);
  });

  it('an overloaded `error` event is a retryable model/http-error carrying the door\'s type + message', () => {
    const err = (() => {
      try {
        parseAnthropicSSE(SSE_ERROR_OVERLOADED);
        return undefined;
      } catch (e) {
        return e as { code?: string; retryable?: boolean; message?: string; cause?: unknown };
      }
    })();
    expect(err?.code).toBe('model/http-error');
    expect(err?.retryable).toBe(true);
    expect(err?.message).toContain('overloaded_error');
    expect(err?.message).toContain('Overloaded');
    expect(err?.cause).toEqual({ sseError: { type: 'overloaded_error', message: 'Overloaded' } });
  });

  it('rate_limit_error and api_error events are retryable; invalid_request_error is not', () => {
    const event = (type: string): string =>
      `data: {"type":"error","error":{"type":"${type}","message":"m"}}\n\n`;
    for (const t of ['rate_limit_error', 'api_error']) {
      expect(() => parseAnthropicSSE(event(t))).toThrowError(
        expect.objectContaining({ code: 'model/http-error', retryable: true }),
      );
    }
    expect(() => parseAnthropicSSE(SSE_ERROR_INVALID_REQUEST)).toThrowError(
      expect.objectContaining({ code: 'model/http-error', retryable: false }),
    );
  });
});

// ---------------------------------------------------------------------------
// The truncation guard: an empty max_tokens reply is never a decision
// ---------------------------------------------------------------------------

const router = makeRouter({ tiers: { ...TEST_TIERS } });

/** Transport double handing back an already-folded SSE body, like consumeSSE does. */
const foldedSend = (sse: string): Transport => async () => ({
  response: parseAnthropicSSE(sse) as unknown as WireResponse,
  attempts: 1,
});

describe('chatCore — anthropic stop_reason handling', () => {
  it('throws model/truncated (non-retryable, names the budget) for max_tokens with nothing visible', async () => {
    const core = chatCore({ router, protocol: 'anthropic', send: foldedSend(SSE_MAX_TOKENS_EMPTY) });
    const err = (await core(req({ maxTokens: 2048 }), undefined, 'auto').catch((e: unknown) => e)) as {
      code?: string;
      retryable?: boolean;
      message?: string;
    };
    expect(err.code).toBe('model/truncated');
    expect(err.retryable).toBe(false);
    expect(err.message).toContain('2048');
    expect(err.message).toContain('max_tokens');
  });

  it('returns a max_tokens reply that has visible content, with stopReason set', async () => {
    const core = chatCore({ router, protocol: 'anthropic', send: foldedSend(SSE_MAX_TOKENS_WITH_CONTENT) });
    const r = await core(req(), undefined, 'auto');
    expect(r.content).toBe('the thing about sea glass is that it takes about');
    expect(r.stopReason).toBe('max_tokens');
  });

  it('a normal end_turn reply carries stopReason end_turn', async () => {
    const core = chatCore({ router, protocol: 'anthropic', send: foldedSend(SSE_END_TURN) });
    const r = await core(req(), undefined, 'auto');
    expect(r.stopReason).toBe('end_turn');
  });

  it('max_tokens with a tool call but no text is NOT a truncation (the call is the decision)', async () => {
    const withTool = SSE_MAX_TOKENS_EMPTY.replace(
      'event: message_delta',
      [
        'event: content_block_start',
        'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"t1","name":"emit","input":{}}}',
        '',
        'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"a\\":1}"}}',
        '',
        'event: message_delta',
      ].join('\n'),
    );
    const core = chatCore({ router, protocol: 'anthropic', send: foldedSend(withTool) });
    const r = await core(req(), undefined, 'auto');
    expect(r.toolCalls).toEqual([{ id: 't1', name: 'emit', args: { a: 1 } }]);
    expect(r.stopReason).toBe('max_tokens');
  });
});

describe('createModelClient — truncation is loud', () => {
  it('emits model.call outcome=error and rethrows model/truncated; stopReason rides ChatResponse otherwise', async () => {
    const { log, events } = memoryLog();
    const starved = createModelClient({
      core: chatCore({ router, protocol: 'anthropic', send: foldedSend(SSE_MAX_TOKENS_EMPTY) }),
      log,
      clock: new TestClock(0),
    });
    await expect(starved.chat(req())).rejects.toThrowError(expect.objectContaining({ code: 'model/truncated' }));
    const calls = events.filter((e) => e.kind === 'model.call');
    expect(calls).toHaveLength(1);
    expect((calls[0]!.payload as ModelCallEvent).outcome).toBe('error');

    const fine = createModelClient({
      core: chatCore({ router, protocol: 'anthropic', send: foldedSend(SSE_END_TURN) }),
      log,
      clock: new TestClock(0),
    });
    const res = await fine.chat(req());
    expect(res.stopReason).toBe('end_turn');
    expect(res.content).toBe("hey. you're up late.");
  });
});

describe('zaiTransport — SSE error events ride the retry policy', () => {
  it('an overloaded error event is retried; the next clean stream wins with attempts=2', async () => {
    const queue = [SSE_ERROR_OVERLOADED, SSE_END_TURN];
    const fetchImpl = (async (): Promise<Response> => sseResponse(queue.shift() ?? '')) as unknown as typeof fetch;
    const transport = zaiTransport({
      apiKey: 'k',
      clock: new TestClock(0),
      rng: makeRng('t'),
      fetchImpl,
      protocol: 'anthropic',
      backoff: { baseMs: 0, capMs: 0 },
    });
    const result = await transport({ body: { model: 'm', messages: [], temperature: 0, max_tokens: 10 } });
    expect(result.attempts).toBe(2);
    expect(parseAnthropicResponse(result.response as unknown).stopReason).toBe('end_turn');
  });

  it('an invalid_request error event fails fast', async () => {
    let calls = 0;
    const fetchImpl = (async (): Promise<Response> => {
      calls += 1;
      return sseResponse(SSE_ERROR_INVALID_REQUEST);
    }) as unknown as typeof fetch;
    const transport = zaiTransport({
      apiKey: 'k',
      clock: new TestClock(0),
      rng: makeRng('t'),
      fetchImpl,
      protocol: 'anthropic',
      backoff: { baseMs: 0, capMs: 0 },
    });
    await expect(transport({ body: { model: 'm', messages: [], temperature: 0, max_tokens: 10 } })).rejects.toThrowError(
      expect.objectContaining({ code: 'model/http-error', retryable: false }),
    );
    expect(calls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Transport protocol switch
// ---------------------------------------------------------------------------

const SSE_BODY = [
  'data: {"type":"message_start","message":{"usage":{"input_tokens":5}}}',
  '',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}',
  '',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}',
  '',
  'data: {"type":"message_delta","usage":{"output_tokens":1}}',
  '',
].join('\n');

describe('zaiTransport — anthropic protocol', () => {
  it('posts to /v1/messages with x-api-key headers and stream:true, parses the SSE', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string | URL, init: RequestInit = {}): Promise<Response> => {
      calls.push({ url: String(url), init });
      return sseResponse(SSE_BODY);
    }) as unknown as typeof fetch;
    const transport = zaiTransport({
      apiKey: 'k',
      clock: new TestClock(0),
      rng: makeRng('t'),
      fetchImpl,
      protocol: 'anthropic',
    });
    const result = await transport({ body: { model: 'glm-5.3-flash', messages: [], temperature: 0, max_tokens: 10 } });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://api.z.ai/api/anthropic/v1/messages');
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('k');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(headers['authorization']).toBeUndefined();
    const sent = JSON.parse(String(calls[0]?.init.body)) as { stream?: boolean };
    expect(sent.stream).toBe(true);
    // The folded SSE body rides back and parses exactly like a non-streaming 200.
    expect(parseAnthropicResponse(result.response as unknown).content).toBe('ok');
    expect(parseAnthropicResponse(result.response as unknown).inputTokens).toBe(5);
    expect(parseAnthropicResponse(result.response as unknown).outputTokens).toBe(1);
  });

  it('a base URL that already names /v1/messages is used verbatim', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL): Promise<Response> => {
      calls.push(String(url));
      return sseResponse(SSE_BODY);
    }) as unknown as typeof fetch;
    const transport = zaiTransport({
      apiKey: 'k',
      clock: new TestClock(0),
      rng: makeRng('t'),
      fetchImpl,
      endpoint: 'https://proxy.example/anthropic/v1/messages',
      protocol: 'anthropic',
    });
    await transport({ body: { model: 'm', messages: [], temperature: 0, max_tokens: 5 } });
    expect(calls[0]).toBe('https://proxy.example/anthropic/v1/messages');
  });

  it('a wedged stream that keeps dribbling dies at the total cap, not retryable', async () => {
    // The live-proven hang: keepalive-sized chunks keep resetting the idle
    // deadline while the model never actually produces. The total cap is the
    // bound. The dribble is paced on the same TestClock the transport races
    // against: every 20 simulated ms a keepalive lands, the idle deadline
    // (1000) never trips, the total cap (250) does.
    const clock = new TestClock(0);
    let keepalives = 0;
    const dribble = (): Response => {
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          return clock.waitUntil(clock.epochMs() + 20).then(() => {
            keepalives += 1;
            controller.enqueue(new TextEncoder().encode(': keepalive\n\n'));
          });
        },
      });
      return { ok: true, status: 200, body: stream, text: async () => '' } as unknown as Response;
    };
    const fetchImpl = (async (): Promise<Response> => dribble()) as unknown as typeof fetch;
    const transport = zaiTransport({
      apiKey: 'k',
      clock,
      rng: makeRng('t'),
      fetchImpl,
      protocol: 'anthropic',
      timeoutMs: 1_000, // dribbles every 20ms never trip the idle deadline
      streamTotalMs: 250,
      maxRetries: 2,
    });
    const pending = transport({ body: { model: 'm', messages: [], temperature: 0, max_tokens: 5 } }).catch(
      (e: unknown) => e,
    );
    // Step the clock in dribble-sized increments, draining the stream's
    // microtask chain between steps so each keepalive really resets the idle race.
    // The total cap arms when the RESPONSE lands — t=20, after the first
    // advance's microtask drain — so it fires at t=270 and the loop must step
    // past that, not merely past the nominal 250.
    for (let i = 0; i < 16; i += 1) {
      await clock.advance(20);
      await new Promise((resolve) => setImmediate(resolve));
    }
    const err = (await pending) as { code?: string; retryable?: boolean; message?: string };
    expect(keepalives).toBeGreaterThanOrEqual(10); // the idle deadline was fed the whole way
    expect(err.code).toBe('model/timeout');
    expect(err.retryable).toBe(false);
    expect(err.message).toContain('total cap');
  });
});

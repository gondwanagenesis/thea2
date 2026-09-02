// M03 model — the Anthropic-protocol wire (z.ai coding-plan door): body
// building (system hoist, tool_result grouping, forced-emit rung), response
// parsing (thinking blocks dropped, tool_use decoded), SSE folding, and the
// transport's protocol switch (URL, headers, stream:true, SSE consumed).
// Hermetic: injected fetchImpl + TestClock, same idiom as transport.test.ts.

import { describe, expect, it } from 'vitest';
import { TestClock } from '../../src/kernel/clock.js';
import { SystemClock } from '../../src/kernel/clock.js';
import { makeRng } from '../../src/kernel/index.js';
import {
  buildAnthropicBody,
  parseAnthropicResponse,
  parseAnthropicSSE,
} from '../../src/model/anthropic.js';
import { zaiTransport } from '../../src/model/index.js';
import { z } from 'zod';
import type { ChatRequest } from '../../src/model/types.js';

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

const sseResponse = (sse: string): Response => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(sse));
      controller.close();
    },
  });
  return {
    ok: true,
    status: 200,
    body: stream,
    text: async () => sse,
  } as unknown as Response;
};

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
    // bound. Real SystemClock — the dribble is real-time, the TestClock cannot
    // express "time passes while chunks keep arriving".
    const dribble = (): Response => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          timer = setTimeout(() => {
            controller.enqueue(new TextEncoder().encode(': keepalive\n\n'));
          }, 20);
        },
        cancel() {
          if (timer !== undefined) clearTimeout(timer);
        },
      });
      return { ok: true, status: 200, body: stream, text: async () => '' } as unknown as Response;
    };
    const fetchImpl = (async (): Promise<Response> => dribble()) as unknown as typeof fetch;
    const transport = zaiTransport({
      apiKey: 'k',
      clock: new SystemClock(),
      rng: makeRng('t'),
      fetchImpl,
      protocol: 'anthropic',
      timeoutMs: 1_000, // dribbles every 20ms never trip the idle deadline
      streamTotalMs: 250,
      maxRetries: 2,
    });
    const err = (await transport({ body: { model: 'm', messages: [], temperature: 0, max_tokens: 5 } }).catch(
      (e: unknown) => e,
    )) as { code?: string; retryable?: boolean; message?: string };
    expect(err.code).toBe('model/timeout');
    expect(err.retryable).toBe(false);
    expect(err.message).toContain('total cap');
  });
});

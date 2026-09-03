// P-DOOR — DR.5 truncation guard + DR.6 repair on tier. The one-shot repair no
// longer downgrades: it keeps the requesting tier and doubles maxTokens; a
// reply at the cap with nothing usable is model/truncated, never a parse
// failure. Hermetic: scripted Transport over chatCore, like client.test.ts.

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { TestClock } from '../../src/kernel/clock.js';
import {
  chatCore,
  createModelClient,
  makeRouter,
  type ChatRequest,
  type Transport,
  type TransportCall,
  type TransportResult,
  type WireBody,
  type WireResponse,
} from '../../src/model/index.js';
import { baseReq, memoryLog, TEST_TIERS, wireOk } from './helpers.js';

const router = makeRouter({ tiers: { ...TEST_TIERS } });

/** Recording Transport: scripted response bodies in FIFO order; keeps wire bodies. */
const fakeSend = (responses: Array<Record<string, unknown>>) => {
  const bodies: WireBody[] = [];
  const queue = [...responses];
  const send: Transport = async (call: TransportCall): Promise<TransportResult> => {
    bodies.push(call.body);
    const next = queue.shift();
    if (next === undefined) throw new Error('fakeSend: no scripted response left');
    return { response: next as WireResponse, attempts: 1 };
  };
  return { send, bodies };
};

const clientOver = (send: Transport) =>
  createModelClient({ core: chatCore({ router, send }), log: memoryLog().log, clock: new TestClock(0) });

const req = (over: Partial<ChatRequest<any>> = {}): ChatRequest<any> => ({
  ...baseReq(),
  ...over,
});

// ---------------------------------------------------------------------------
// DR.6 — repair on tier
// ---------------------------------------------------------------------------

describe('DR.6 — repair keeps the requesting tier and doubles the budget', () => {
  it('repair stays on the requesting tier', async () => {
    const { send, bodies } = fakeSend([
      wireOk({ content: '{nope' }),
      wireOk({ content: '{"a":9}' }),
    ]);
    const client = clientOver(send);
    const res = await client.chat(req({ tier: 'main', schema: z.object({ a: z.number() }) }));
    expect(res.content).toEqual({ a: 9 });
    expect(bodies).toHaveLength(2);
    expect(bodies[1]!.model).toBe(TEST_TIERS.main); // the requesting tier, never cheap

    // Same law for the tool-args repair path.
    const { send: send2, bodies: bodies2 } = fakeSend([
      wireOk({ toolCalls: [{ id: 't1', name: 'search', arguments: '{bad' }] }),
      wireOk({ content: '{"t1":{"q":"hi"}}' }),
    ]);
    const client2 = clientOver(send2);
    await client2.chat(req({ tier: 'reasoning', tools: [{ name: 'search', description: 'd', parameters: {} }] }));
    expect(bodies2[1]!.model).toBe(TEST_TIERS.reasoning);
  });

  it('repair budget is doubled', async () => {
    const { send, bodies } = fakeSend([
      wireOk({ content: '{nope' }),
      wireOk({ content: '{"a":9}' }),
    ]);
    const client = clientOver(send);
    await client.chat(req({ maxTokens: 512, schema: z.object({ a: z.number() }) }));
    expect(bodies[1]!.max_tokens).toBe(1024);

    const { send: send2, bodies: bodies2 } = fakeSend([
      wireOk({ toolCalls: [{ id: 't1', name: 'search', arguments: '{bad' }] }),
      wireOk({ content: '{"t1":{"q":"hi"}}' }),
    ]);
    const client2 = clientOver(send2);
    await client2.chat(
      req({ maxTokens: 300, tools: [{ name: 'search', description: 'd', parameters: {} }] }),
    );
    expect(bodies2[1]!.max_tokens).toBe(600);
  });
});

// ---------------------------------------------------------------------------
// DR.5 — the truncation guard
// ---------------------------------------------------------------------------

describe('DR.5 — truncation guard', () => {
  it('output at the cap with empty content is truncated not parse-failed', async () => {
    // No finish_reason, the completion burned the whole budget, a schema was
    // expected and nothing usable came back — the old path would rung-c parse
    // '' and die model/parse-failed after a pointless repair; the guard fires
    // model/truncated immediately.
    const { send } = fakeSend([
      { choices: [{ message: { role: 'assistant', content: '' } }], usage: { prompt_tokens: 10, completion_tokens: 100 } },
    ]);
    const client = clientOver(send);
    const err = (await client
      .chat(req({ maxTokens: 100, schema: z.object({ a: z.number() }) }))
      .catch((e: unknown) => e)) as { code?: string; retryable?: boolean; message?: string };
    expect(err.code).toBe('model/truncated');
    expect(err.retryable).toBe(false);
    expect(err.message).toContain('100');
  });

  it('an explicit max_tokens stop reason fires the guard even with content', async () => {
    const { send } = fakeSend([
      { choices: [{ message: { role: 'assistant', content: 'half a thought' }, finish_reason: 'length' }], usage: { prompt_tokens: 10, completion_tokens: 50 } },
    ]);
    const client = clientOver(send);
    await expect(client.chat(req({ maxTokens: 100 }))).rejects.toThrowError(
      expect.objectContaining({ code: 'model/truncated' }),
    );
  });

  it('output at the cap without a tool call fires the guard even without a stop reason', async () => {
    const { send } = fakeSend([
      { choices: [{ message: { role: 'assistant', content: 'prose that is not JSON' } }], usage: { prompt_tokens: 10, completion_tokens: 100 } },
    ]);
    const client = clientOver(send);
    await expect(client.chat(req({ maxTokens: 100 }))).rejects.toThrowError(
      expect.objectContaining({ code: 'model/truncated' }),
    );
  });

  it('a reply under the cap with content still passes (no truncation)', async () => {
    const { send } = fakeSend([wireOk({ content: 'a complete short reply' })]);
    const client = clientOver(send);
    const res = await client.chat(req({ maxTokens: 100 }));
    expect(res.content).toBe('a complete short reply');
  });
});

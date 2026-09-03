// P-DOOR — DR.7 tool-arg validation. Tool calls come back with coerced,
// validated input: `decide.bubbles` arrives as one string or newline-joined
// text and is coerced to a clean string array; when the request carries a
// zod validator for a tool (the loop passes its registry entries — model never
// imports loop, the validator rides the REQUEST), failing input takes the
// existing one-shot repair rung. Hermetic: MockModel + scripted Transport.

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { TestClock } from '../../src/kernel/clock.js';
import {
  chatCore,
  createModelClient,
  DECIDE_TOOL,
  makeRouter,
  MockModel,
  type Transport,
  type TransportCall,
  type TransportResult,
  type WireBody,
  type WireResponse,
} from '../../src/model/index.js';
import { baseReq, TEST_TIERS, wireOk } from './helpers.js';

const decideArgs = (bubbles: unknown): Record<string, unknown> => ({
  plan: 'reply',
  bubbles,
  confidence: 1,
  weight: 1,
  reluctance: 0,
  completeness: 1,
});

describe('DR.7 — decide.bubbles coercion', () => {
  it('a string bubbles field becomes a one-element array', async () => {
    const model = new MockModel({ clock: new TestClock(0) });
    model.enqueue({ toolCalls: [{ id: 'd0', name: DECIDE_TOOL, args: decideArgs('a single bubble') }] });
    const res = await model.chat({ ...baseReq(), tools: [{ name: DECIDE_TOOL, description: 'd', parameters: {} }] });
    expect(res.toolCalls).toEqual([
      { id: 'd0', name: DECIDE_TOOL, args: { ...decideArgs(['a single bubble']) } },
    ]);
  });

  it('a newline in a bubble splits it', async () => {
    const model = new MockModel({ clock: new TestClock(0) });
    model.enqueue({
      toolCalls: [{ id: 'd0', name: DECIDE_TOOL, args: decideArgs('first bubble\nsecond bubble\n\nthird bubble\n') }],
    });
    const res = await model.chat({ ...baseReq(), tools: [{ name: DECIDE_TOOL, description: 'd', parameters: {} }] });
    const args = res.toolCalls?.[0]?.args as { bubbles: string[] };
    expect(args.bubbles).toEqual(['first bubble', 'second bubble', 'third bubble']);
  });

  it('a proper array passes through untouched; non-decide tools are not coerced', async () => {
    const model = new MockModel({ clock: new TestClock(0) });
    model.enqueue({
      toolCalls: [
        { id: 'd0', name: DECIDE_TOOL, args: decideArgs(['already', 'fine']) },
        { id: 't1', name: 'search', args: { q: 'a\nb' } },
      ],
    });
    const res = await model.chat({
      ...baseReq(),
      tools: [
        { name: DECIDE_TOOL, description: 'd', parameters: {} },
        { name: 'search', description: 's', parameters: {} },
      ],
    });
    expect((res.toolCalls?.[0]?.args as { bubbles: string[] }).bubbles).toEqual(['already', 'fine']);
    expect((res.toolCalls?.[1]?.args as { q: string }).q).toBe('a\nb');
  });
});

// ---------------------------------------------------------------------------
// Request-carried zod validation (the DAG-compliant half of DR.7)
// ---------------------------------------------------------------------------

const router = makeRouter({ tiers: { ...TEST_TIERS } });

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

const DECIDE_SCHEMA = z.object({
  plan: z.enum(['reply', 'silent']),
  bubbles: z.array(z.string()),
  confidence: z.number(),
  weight: z.number(),
  reluctance: z.number(),
  completeness: z.number(),
});

describe('DR.7 — tool input is zod-parsed against the request-carried validator', () => {
  it('input failing the validator takes the one-shot repair rung and the repaired call is revalidated', async () => {
    // First send: decide with a STRING bubbles field that even coercion cannot
    // save (plan is wrong) — schema-invalid. Repair send: a valid object.
    const { send, bodies } = fakeSend([
      wireOk({ toolCalls: [{ id: 'd0', name: DECIDE_TOOL, arguments: JSON.stringify({ ...decideArgs('x'), plan: 'nonsense' }) }] }),
      wireOk({ content: JSON.stringify({ d0: decideArgs(['fixed']) }) }),
    ]);
    const client = createModelClient({
      core: chatCore({ router, send }),
      log: { emit: async () => {}, async *replay() {} },
      clock: new TestClock(0),
    });
    const res = await client.chat({
      ...baseReq(),
      tools: [{ name: DECIDE_TOOL, description: 'd', parameters: {} }],
      toolInput: { [DECIDE_TOOL]: DECIDE_SCHEMA },
    });
    expect(bodies).toHaveLength(2); // the repair re-ask happened
    expect(bodies[1]!.messages.some((m) => (m.content ?? '').includes('arguments were not valid JSON'))).toBe(true);
    const args = res.toolCalls?.[0]?.args as { plan: string; bubbles: string[] };
    expect(args.plan).toBe('reply');
    expect(args.bubbles).toEqual(['fixed']);
  });

  it('input failing the validator with an unrepairable reply fails model/tool-call-failed', async () => {
    const { send } = fakeSend([
      wireOk({ toolCalls: [{ id: 'd0', name: DECIDE_TOOL, arguments: JSON.stringify({ ...decideArgs('x'), plan: 42 }) }] }),
      wireOk({ content: 'not an object map' }),
    ]);
    const client = createModelClient({
      core: chatCore({ router, send }),
      log: { emit: async () => {}, async *replay() {} },
      clock: new TestClock(0),
    });
    await expect(
      client.chat({
        ...baseReq(),
        tools: [{ name: DECIDE_TOOL, description: 'd', parameters: {} }],
        toolInput: { [DECIDE_TOOL]: DECIDE_SCHEMA },
      }),
    ).rejects.toThrowError(expect.objectContaining({ code: 'model/tool-call-failed' }));
  });

  it('valid input passes untouched and no validator means no validation', async () => {
    const { send } = fakeSend([
      wireOk({ toolCalls: [{ id: 'd0', name: DECIDE_TOOL, arguments: JSON.stringify(decideArgs(['fine'])) }] }),
    ]);
    const client = createModelClient({
      core: chatCore({ router, send }),
      log: { emit: async () => {}, async *replay() {} },
      clock: new TestClock(0),
    });
    const res = await client.chat({
      ...baseReq(),
      tools: [{ name: DECIDE_TOOL, description: 'd', parameters: {} }],
    });
    expect(res.toolCalls?.[0]?.args).toEqual(decideArgs(['fine']));
  });
});

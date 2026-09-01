// M03 model — the shared conformance suite. MockModel and the real parsing
// layer (chatCore over a scripted Transport) must produce IDENTICAL observable
// outcomes for the same logical responses — that is the property that lets
// every later module test against MockModel and mean the real thing.

import { describe, expect, it } from 'vitest';
import { z, type ZodType } from 'zod';
import { canonicalJson } from '../../src/kernel/index.js';
import { TestClock } from '../../src/kernel/clock.js';
import {
  chatCore,
  createModelClient,
  makeRouter,
  type ChatRequest,
  type ModelClient,
  type ToolDef,
  type Transport,
  type TransportResult,
  type WireResponse,
} from '../../src/model/index.js';
import { MockModel, type ScriptedResponse } from '../../src/model/mock.js';
import { baseReq, memoryLog, wireOk } from './helpers.js';

const router = makeRouter();

interface Case {
  name: string;
  schema?: ZodType;
  tools?: ToolDef[];
  /** FIFO scripts — the same logical responses, in both doubles' idioms. */
  mock: ScriptedResponse[];
  wire: Array<Record<string, unknown>>;
  expect: { content: unknown; toolCalls?: Array<{ id: string; name: string; args: unknown }> };
}

const CASES: Case[] = [
  {
    name: 'plain chat content',
    mock: [{ content: 'hello there' }],
    wire: [wireOk({ content: 'hello there', promptTokens: 5, completionTokens: 2 })],
    expect: { content: 'hello there' },
  },
  {
    name: 'clean tool_calls decode arguments to objects',
    tools: [{ name: 'search', description: 'd', parameters: {} }],
    mock: [{ toolCalls: [{ id: 'c1', name: 'search', args: { q: 'x' } }] }],
    wire: [wireOk({ toolCalls: [{ id: 'c1', name: 'search', arguments: '{"q":"x"}' }] })],
    expect: { content: '', toolCalls: [{ id: 'c1', name: 'search', args: { q: 'x' } }] },
  },
  {
    name: 'rung (b): the emit tool is the payload channel, hidden from visible calls',
    schema: z.object({ answer: z.string() }),
    mock: [{ toolCalls: [{ id: 'e1', name: 'emit', args: { answer: 'yes' } }] }],
    wire: [wireOk({ toolCalls: [{ id: 'e1', name: 'emit', arguments: '{"answer":"yes"}' }] })],
    expect: { content: { answer: 'yes' } },
  },
  {
    // Rung (c) is only reachable with a schema AND non-empty tools (else rung (b));
    // the tool here is the constraint that forces the prompted-JSON path.
    name: 'rung (c): prompted JSON parses the content',
    schema: z.object({ n: z.number() }),
    tools: [{ name: 'constrain', description: 'forces rung (c)', parameters: {} }],
    mock: [{ content: '{"n":4}' }],
    wire: [wireOk({ content: '{"n":4}' })],
    expect: { content: { n: 4 } },
  },
  {
    name: 'malformed JSON recovers via the one-shot repair — identical parse either way',
    schema: z.object({ n: z.number() }),
    tools: [{ name: 'constrain', description: 'forces rung (c)', parameters: {} }],
    mock: [{ content: '```json\n{"n":5}\n```' }],
    wire: [wireOk({ content: '```json\n{"n":5}\n```' })],
    expect: { content: { n: 5 } },
  },
];

// `any` mirrors CoreChat: the suite passes heterogeneous scripted schemas and
// asserts on decoded content, never on the static output type.
const reqFor = (c: Case): ChatRequest<any> => ({
  ...baseReq(),
  ...(c.schema !== undefined ? { schema: c.schema } : {}),
  ...(c.tools !== undefined ? { tools: c.tools } : {}),
});

const realClient = (wire: Array<Record<string, unknown>>): ModelClient => {
  const queue = [...wire];
  const send: Transport = async (): Promise<TransportResult> => {
    const next = queue.shift();
    if (next === undefined) throw new Error('conformance: wire script exhausted');
    return { response: next as WireResponse, attempts: 1 };
  };
  return createModelClient({
    core: chatCore({ router, send }),
    log: memoryLog().log,
    clock: new TestClock(0),
  });
};

describe('MockModel ⇔ real parsing layer conformance', () => {
  for (const c of CASES) {
    it(`case: ${c.name}`, async () => {
      const mock = new MockModel({ clock: new TestClock(0) });
      for (const s of c.mock) mock.enqueue(s);
      const real = realClient(c.wire);
      const req = reqFor(c);

      const fromMock = await mock.chat(req);
      const fromReal = await real.chat(req);

      expect(fromReal.content).toEqual(c.expect.content);
      expect(fromMock.content).toEqual(c.expect.content);
      if (c.expect.toolCalls !== undefined) {
        expect(fromMock.toolCalls).toEqual(c.expect.toolCalls);
        expect(fromReal.toolCalls).toEqual(c.expect.toolCalls);
      }
    });
  }

  it('both doubles agree on the canonical tool-call args serialization', () => {
    // The mock serializes scripted args with canonicalJson — the exact bytes the
    // real layer pins in its goldens. If these drift, conformance above is fake.
    expect(canonicalJson({ q: 'x' })).toBe('{"q":"x"}');
  });
});

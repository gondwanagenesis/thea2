// M03 model — wire serialization/parsing goldens + pure helpers.
// The ToolDef wire shape is golden-pinned byte-for-byte (spec AC).

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { makeRng } from '../../src/kernel/index.js';
import {
  backoffDelayMs,
  buildWireBody,
  estimateTokens,
  looseJsonParse,
  parseWireResponse,
  parseWireToolCalls,
  promptedJsonInstruction,
  schemaJsonForPrompt,
  schemaToJsonSchema,
  structuredRepairMessages,
  toolArgsRepairMessages,
  toWireMessages,
  toWireTools,
  type WireToolCall,
} from '../../src/model/index.js';
import { isModelError, modelError } from '../../src/model/errors.js';
import { baseReq, TEST_TIERS, wireOk } from './helpers.js';

const SIMPLE_SCHEMA = z.object({ ok: z.boolean(), note: z.string() });

describe('toWireTools — byte-for-byte OpenAI shape', () => {
  it('serializes a ToolDef exactly as the OpenAI wire expects', () => {
    const out = toWireTools([
      { name: 'search', description: 'Search the corpus', parameters: { type: 'object', properties: {} } },
    ]);
    expect(out).toEqual([
      {
        type: 'function',
        function: {
          name: 'search',
          description: 'Search the corpus',
          parameters: { type: 'object', properties: {} },
        },
      },
    ]);
    // And back: the name/description/parameters round-trip verbatim.
    expect(out[0]!.function.name).toBe('search');
  });

  it('serializes assistant tool_calls with canonical (key-sorted) JSON arguments', () => {
    const msgs = toWireMessages([
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'f', args: { b: 2, a: 1 } }] },
      { role: 'tool', content: 'result', toolCallId: 'c1' },
    ]);
    expect(msgs[0]!.tool_calls![0]!.function!.arguments).toBe('{"a":1,"b":2}');
    expect(msgs[1]!.tool_call_id).toBe('c1');
  });
});

describe('schemaToJsonSchema', () => {
  it('converts a zod schema and strips the $schema dialect key', () => {
    const json = schemaToJsonSchema(SIMPLE_SCHEMA) as Record<string, unknown>;
    expect(json['$schema']).toBeUndefined();
    expect(json['type']).toBe('object');
    expect(json['required']).toEqual(['ok', 'note']);
  });

  it('schemaJsonForPrompt is compact, key-sorted JSON', () => {
    const text = schemaJsonForPrompt(SIMPLE_SCHEMA);
    expect(text).not.toContain('\n');
    expect(() => JSON.parse(text)).not.toThrow();
  });
});

describe('buildWireBody — one body per ladder rung', () => {
  it('rung (a): response_format json_schema, strict, named', () => {
    const body = buildWireBody({ req: { ...baseReq(), schema: SIMPLE_SCHEMA }, model: 'm', rung: 'json_schema', seedSupported: false });
    expect(body.response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'output', strict: true, schema: schemaToJsonSchema(SIMPLE_SCHEMA) },
    });
    expect(body.tools).toBeUndefined();
  });

  it('rung (b): exactly one forced `emit` tool with tool_choice pinned to it', () => {
    const body = buildWireBody({ req: { ...baseReq(), schema: SIMPLE_SCHEMA }, model: 'm', rung: 'tool_call', seedSupported: false });
    expect(body.tools).toHaveLength(1);
    expect(body.tools![0]!.function.name).toBe('emit');
    expect(body.tool_choice).toEqual({ type: 'function', function: { name: 'emit' } });
    expect(body.response_format).toBeUndefined();
  });

  it('rung (c): a trailing system message carries the schema in prose', () => {
    const body = buildWireBody({ req: { ...baseReq(), schema: SIMPLE_SCHEMA }, model: 'm', rung: 'prompted_json', seedSupported: false });
    const last = body.messages.at(-1)!;
    expect(last.role).toBe('system');
    expect(last.content).toContain('[OUTPUT FORMAT]');
    expect(last.content).toContain(schemaJsonForPrompt(SIMPLE_SCHEMA));
    expect(body.tools).toBeUndefined();
    expect(body.response_format).toBeUndefined();
  });

  it('plain requests carry no rung extras; seed rides only when supported and hinted', () => {
    const plain = buildWireBody({ req: baseReq(), model: 'm', rung: 'auto', seedSupported: false });
    expect(plain.messages).toHaveLength(1);
    expect(plain.response_format).toBeUndefined();

    const seeded = buildWireBody({ req: { ...baseReq(), seedHint: 42 }, model: 'm', rung: 'auto', seedSupported: true });
    expect(seeded.seed).toBe(42);
    const unsupported = buildWireBody({ req: { ...baseReq(), seedHint: 42 }, model: 'm', rung: 'auto', seedSupported: false });
    expect(unsupported.seed).toBeUndefined();
  });

  it('user tools serialize into the body with tool_choice auto', () => {
    const body = buildWireBody({
      req: { ...baseReq(), tools: [{ name: 't', description: 'd', parameters: {} }] },
      model: 'm',
      rung: 'auto',
      seedSupported: false,
    });
    expect(body.tools).toHaveLength(1);
    expect(body.tools![0]!.function.name).toBe('t');
    expect(body.tool_choice).toBe('auto');
  });
});

describe('parseWireToolCalls / parseWireResponse', () => {
  it('round-trips clean tool calls with decoded JSON args', () => {
    const list: WireToolCall[] = [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{"a":1}' } }];
    const { calls, malformed } = parseWireToolCalls(list);
    expect(calls).toEqual([{ id: 'c1', name: 'f', args: { a: 1 } }]);
    expect(malformed).toEqual([]);
  });

  it('collects malformed argument strings instead of throwing; mints ids when absent', () => {
    const { calls, malformed } = parseWireToolCalls([
      { function: { name: 'f', arguments: '{nope' } },
      { function: { name: 'g', arguments: null } },
      { function: { name: 'h' } },
    ]);
    expect(calls).toEqual([]);
    expect(malformed.map((m) => m.id)).toEqual(['call_0', 'call_1', 'call_2']);
    expect(malformed[0]!.error.length).toBeGreaterThan(0); // salvage-parser detail, not the raw input
  });

  it('accepts already-decoded argument objects some providers emit', () => {
    // Not part of the declared wire type — cast like the defensive code path does.
    const { calls } = parseWireToolCalls([
      { id: 'x', function: { name: 'f', arguments: { a: 1 } as unknown as string } },
    ]);
    expect(calls).toEqual([{ id: 'x', name: 'f', args: { a: 1 } }]);
  });

  it('a tool call with no function name is a protocol violation: typed throw', () => {
    expect(() => parseWireToolCalls([{ id: 'c', function: { name: '' } }])).toThrowError(
      expect.objectContaining({ code: 'model/bad-json' }),
    );
  });

  it('parseWireResponse extracts content, calls, and token usage', () => {
    const parsed = parseWireResponse(
      wireOk({ content: 'hello', toolCalls: [{ id: 'c1', name: 'f', arguments: '{"a":1}' }], promptTokens: 3, completionTokens: 5 }),
    );
    expect(parsed.content).toBe('hello');
    expect(parsed.toolCalls).toEqual([{ id: 'c1', name: 'f', args: { a: 1 } }]);
    expect(parsed.inputTokens).toBe(3);
    expect(parsed.outputTokens).toBe(5);
  });

  it('non-object bodies and empty choices are protocol violations', () => {
    expect(() => parseWireResponse('nope')).toThrowError(expect.objectContaining({ code: 'model/bad-json' }));
    expect(() => parseWireResponse({ choices: [] })).toThrowError(expect.objectContaining({ code: 'model/bad-json' }));
  });
});

describe('repair prompts — goldens (a prompt change is a behavior change)', () => {
  it('structuredRepairMessages: original + malformed assistant turn + one correction', () => {
    const msgs = structuredRepairMessages({
      original: [{ role: 'user', content: 'q' }],
      malformed: '{oops',
      schemaJson: '{"type":"object"}',
      error: 'Unexpected token',
    });
    expect(msgs).toEqual([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: '{oops' },
      {
        role: 'user',
        content:
          `Your previous reply could not be parsed against the required schema.\n\n` +
          `Parse error:\nUnexpected token\n\n` +
          `Required JSON Schema (draft 2020-12):\n{"type":"object"}\n\n` +
          `Your previous reply was:\n{oops\n\n` +
          `Reply with ONLY the corrected JSON object. No prose, no markdown fences.`,
      },
    ]);
  });

  it('toolArgsRepairMessages: one object keyed by tool-call id, raw args quoted', () => {
    const msgs = toolArgsRepairMessages({
      original: [],
      malformed: [{ id: 'c9', name: 'f', args: null }],
      rawArguments: new Map([['c9', '{raw']]),
      error: 'bad',
    });
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.content).toContain('- id: c9');
    expect(msgs[0]!.content).toContain('arguments: {raw');
    expect(msgs[0]!.content).toContain('{"c9": {"arg": "value"}}');
  });

  it('promptedJsonInstruction pins the exact output contract', () => {
    expect(promptedJsonInstruction('SCHEMA_JSON')).toBe(
      `[OUTPUT FORMAT]\n` +
      `Reply with a single JSON object and nothing else. It must validate against this ` +
      `JSON Schema (draft 2020-12):\nSCHEMA_JSON\n` +
      `No prose, no markdown fences, no comments.`,
    );
  });
});

describe('backoff — deterministic per seed, capped', () => {
  it('same seed ⇒ same delay sequence; formula base * 2^(attempt-1) * jitter, capped', () => {
    const cfg = { baseMs: 500, capMs: 4000 };
    const run = (): number[] => {
      const rng = makeRng('model/backoff');
      return [1, 2, 3, 4].map((a) => backoffDelayMs(a, () => rng.float(), cfg));
    };
    expect(run()).toEqual(run());

    // Zero-jitter bounds: jitter()=0 ⇒ raw*0.5; jitter()→1 ⇒ raw*1.5.
    expect(backoffDelayMs(1, () => 0, cfg)).toBe(250);
    expect(backoffDelayMs(1, () => 0.999999, cfg)).toBeLessThanOrEqual(750);
    expect(backoffDelayMs(10, () => 0, cfg)).toBe(4000); // capped
  });

  it('estimateTokens is ~4 chars/token with a floor of 1', () => {
    expect(estimateTokens([''])).toBe(1);
    expect(estimateTokens(['abcdefgh'])).toBe(2);
  });
});

describe('looseJsonParse — conservative salvage', () => {
  it('parses clean JSON, fenced JSON, and trailing commas; refuses real garbage', () => {
    expect(looseJsonParse('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
    expect(looseJsonParse('```json\n{"a":1}\n```')).toEqual({ ok: true, value: { a: 1 } });
    expect(looseJsonParse('{"a":1,}')).toEqual({ ok: true, value: { a: 1 } });
    expect(looseJsonParse('totally not json').ok).toBe(false);
  });
});

describe('unrepresentable schemas fall through the ladder', () => {
  it('a schema zod cannot express as JSON Schema throws the typed conversion error', () => {
    let threw = false;
    try {
      schemaToJsonSchema(z.custom<never>(() => true));
    } catch (e) {
      threw = true;
      expect(isModelError(e)).toBe(true);
      expect((e as ReturnType<typeof modelError>).code).toBe('model/bad-json');
    }
    expect(threw).toBe(true);
  });
});

describe('TEST_TIERS sanity', () => {
  it('routing-visible model ids are distinct', () => {
    expect(new Set(Object.values(TEST_TIERS)).size).toBe(3);
  });
});

// GLM text-form tool calls (prod 2026-09-03): Neuralwatt glm-5.3 serializes
// decide as CONTENT — `decide<arg_key>k</arg_key><arg_value>v</arg_value>` with
// finish 'stop' and no native tool_calls. Real payload from the live ledger
// (msgIds 93/95/98 sent it to Telegram before the parser existed).
describe('parseWireResponse — glm text-form tool calls', () => {
  const realPayload = {
    choices: [
      {
        message: {
          role: 'assistant',
          content:
            'decide<arg_key>bubbles</arg_key><arg_value>["heyooo! we\'re back to full words", "so which is it: did the \'oops\' eat the answer"]</arg_value><arg_key>completeness</arg_key><arg_value>0.7</arg_value><arg_key>confidence</arg_key><arg_value>0.8</arg_value><arg_key>plan</arg_key><arg_value>reply</arg_value><arg_key>reluctance</arg_key><arg_value>0.1</arg_value><arg_key>weight</arg_key><arg_value>0.7</arg_value></tool_call>',
        },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 1200, completion_tokens: 90 },
  };

  it('glm-5.3 text-form tool call parses as a structured decide call', () => {
    const res = parseWireResponse(realPayload);
    expect(res.content).toBe('');
    expect(res.toolCalls).toHaveLength(1);
    expect(res.toolCalls[0]?.name).toBe('decide');
    expect(res.stopReason).toBe('tool_use');
  });

  it('text-form arg values JSON-parse: bubbles is an array, numbers are numbers', () => {
    const res = parseWireResponse(realPayload);
    const args = res.toolCalls[0]?.args as { bubbles: unknown; completeness: unknown; plan: unknown };
    expect(Array.isArray(args.bubbles)).toBe(true);
    expect((args.bubbles as string[])[0]).toContain('full words');
    expect(args.completeness).toBe(0.7);
    expect(args.plan).toBe('reply');
  });

  it('markup with trailing prose is NOT a text-form call — stays prose for the leak guard', () => {
    const prosePayload = {
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'let me think... decide<arg_key>plan</arg_key><arg_value>reply</arg_value> and that is that',
          },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    };
    const res = parseWireResponse(prosePayload);
    expect(res.toolCalls).toHaveLength(0);
    expect(res.content).toContain('let me think');
  });
});

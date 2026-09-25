// v8 door options (measured 2026-09-25 on gpt-5.6-sol /chat/completions):
// function tools are accepted ONLY with reasoning_effort 'none', and the token
// cap must ride as max_completion_tokens. A locked door must outrank the class
// default the client injects; an unlocked door keeps v7 behavior byte-for-byte.

import { describe, expect, it } from 'vitest';
import { buildWireBody, reasoningEffortFor } from '../../src/model/wire.js';
import type { ChatRequest, Door } from '../../src/model/index.js';

const req = (over: Partial<ChatRequest> = {}): ChatRequest => ({
  taskClass: 'turn',
  tier: 'main',
  messages: [{ role: 'user', content: 'ok' }],
  maxTokens: 900,
  temperature: 0.8,
  reasoning: 'low', // what the client's class default injects for a turn
  ...over,
});

const sol: Door = { name: 'voice', protocol: 'openai', model: 'gpt-5.6-sol', forcing: 'tool_choice', effortLock: 'none', outputCapParam: 'max_completion_tokens' };
const glm: Door = { name: 'voice', protocol: 'openai', model: 'glm-5.3', forcing: 'tool_choice', effort: 'low' };

describe('v8 door options', () => {
  it('effortLock outranks the class default and any caller override', () => {
    expect(reasoningEffortFor(req(), 'gpt-5.6-sol', sol)).toBe('none');
    expect(reasoningEffortFor(req({ reasoning: 'high' }), 'gpt-5.6-sol', sol)).toBe('none');
  });

  it('an unlocked door keeps v7 semantics (caller/class wins; glm never sees none)', () => {
    expect(reasoningEffortFor(req(), 'glm-5.3', glm)).toBe('low');
    expect(reasoningEffortFor(req({ reasoning: 'none' }), 'glm-5.3', glm)).toBe('minimal');
  });

  it('outputCapParam puts the cap in max_completion_tokens and never sends max_tokens', () => {
    const body = buildWireBody({ req: req(), model: 'gpt-5.6-sol', rung: 'auto', seedSupported: false, door: sol } as never) as unknown as Record<string, unknown>;
    expect(body['max_completion_tokens']).toBe(900);
    expect('max_tokens' in body).toBe(false);
    expect(body['reasoning_effort']).toBe('none');
    expect(body['temperature']).toBe(0.8); // no door temperature → the metabolism's value rides
  });

  it('a door without the option keeps max_tokens (v7 goldens unchanged)', () => {
    const body = buildWireBody({ req: req(), model: 'glm-5.3', rung: 'auto', seedSupported: false, door: glm } as never) as unknown as Record<string, unknown>;
    expect(body['max_tokens']).toBe(900);
    expect('max_completion_tokens' in body).toBe(false);
  });
});

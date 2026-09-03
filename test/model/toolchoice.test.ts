// M03 model — ChatRequest.toolChoice (Phase 1, 2026-09-02). The loop's assess
// path forces `decide` on the wire when it is the ONLY tool offered (a decision
// is mandatory, not a menu option — the fail-open branch's final call lives on
// this), and the two protocol builders map the request field per door. Mirrors
// the emit-tool tool_choice test shapes in wire.test.ts / anthropic.test.ts.
// Absent toolChoice must leave every body byte-identical to the pre-Phase-1
// bytes — the goldens in the sibling files are the guard for that.

import { describe, expect, it } from 'vitest';
import { TestClock } from '../../src/kernel/clock.js';
import { MockModel } from '../../src/model/mock.js';
import type { ChatRequest, ToolDef } from '../../src/model/types.js';
import { buildAnthropicBody } from '../../src/model/anthropic.js';
import { buildWireBody } from '../../src/model/wire.js';
import { DECIDE_TOOL_NAME, decideToolDef } from '../../src/loop/decide.js';
import { assess, type TurnState } from '../../src/loop/turn.js';
import { resolveLoopConfig } from '../../src/loop/config.js';

// ---------------------------------------------------------------------------
// The assess path (src/loop/turn.ts) — where {name:'decide'} is minted
// ---------------------------------------------------------------------------

const decideCall = (args: unknown): { id: string; name: string; args: unknown } => ({
  id: 'd0',
  name: DECIDE_TOOL_NAME,
  args,
});

/** A TurnState carrying only what `assess` actually reads; the rest is inert for
 * this call and cast away explicitly (the wire.test.ts cast precedent). */
const assessState = (model: MockModel, defs: ToolDef[]): TurnState =>
  ({
    model,
    cfg: resolveLoopConfig(),
    turnId: 'turn_tc_1',
    signal: new AbortController().signal,
    defs,
  }) as unknown as TurnState;

const baseMsgs = [{ role: 'user' as const, content: 'decide something' }];

describe('assess — the forced-decide path', () => {
  it('decide is forced via toolChoice when it is the only tool', async () => {
    const model = new MockModel({ clock: new TestClock(0) });
    model.enqueue({
      toolCalls: [decideCall({ plan: 'silent', bubbles: [], confidence: 1, weight: 1, reluctance: 0, completeness: 1 })],
    });
    await assess(assessState(model, [decideToolDef]), baseMsgs, { tier: 'main', taskClass: 'turn' }, [decideToolDef]);

    const req = model.calls[0] as ChatRequest | undefined;
    expect(req?.toolChoice).toEqual({ name: DECIDE_TOOL_NAME }); // the decision is mandatory
    expect(req?.tools?.map((t) => t.name)).toEqual([DECIDE_TOOL_NAME]);
  });

  it('any wider def set leaves toolChoice unset (decide + registry tools, and workers without decide)', async () => {
    const model = new MockModel({ clock: new TestClock(0) });
    const registryTool: ToolDef = { name: 'echo', description: 'echo', parameters: {} };
    const workerDefs = [registryTool];

    await assess(assessState(model, [decideToolDef, registryTool]), baseMsgs, { tier: 'main', taskClass: 'turn' }, [
      decideToolDef,
      registryTool,
    ]);
    await assess(assessState(model, workerDefs), baseMsgs, { tier: 'cheap', taskClass: 'ponder-seed' }, workerDefs);
    await assess(assessState(model, []), baseMsgs, { tier: 'cheap', taskClass: 'ponder-seed' }, []);

    expect(model.calls).toHaveLength(3);
    for (const req of model.calls) {
      expect(req.toolChoice).toBeUndefined(); // the field is not even present
      expect('toolChoice' in req).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// The wire mappings — one request field, two protocol shapes
// ---------------------------------------------------------------------------

const TOOL_CHOICE_REQ = (toolChoice: ChatRequest['toolChoice']): ChatRequest => ({
  taskClass: 'turn',
  tier: 'main',
  messages: [{ role: 'user', content: 'hi' }],
  tools: [{ name: 'decide', description: 'Lock the decision.', parameters: {} }],
  ...(toolChoice !== undefined ? { toolChoice } : {}),
  maxTokens: 100,
  temperature: 0.5,
});

/** The same request with the tools key removed (exactOptionalPropertyTypes-safe). */
const withoutTools = (r: ChatRequest): ChatRequest => {
  const { tools: _dropped, ...rest } = r;
  return rest;
};

describe('toolChoice on the openai wire (buildWireBody)', () => {
  it('decide is forced via toolChoice when it is the only tool: {name} maps to the forced-function shape', () => {
    const body = buildWireBody({ req: TOOL_CHOICE_REQ({ name: 'decide' }), model: 'm', rung: 'auto', seedSupported: false });
    expect(body.tool_choice).toEqual({ type: 'function', function: { name: 'decide' } });
    expect(body.tools).toHaveLength(1);
  });

  it("'auto' and 'required' pass through verbatim; the forced-emit rung still wins over the request field", () => {
    const auto = buildWireBody({ req: TOOL_CHOICE_REQ('auto'), model: 'm', rung: 'auto', seedSupported: false });
    expect(auto.tool_choice).toBe('auto');
    const required = buildWireBody({ req: TOOL_CHOICE_REQ('required'), model: 'm', rung: 'auto', seedSupported: false });
    expect(required.tool_choice).toBe('required');
  });
});

describe('toolChoice on the anthropic wire (buildAnthropicBody)', () => {
  it('decide is forced via toolChoice when it is the only tool: {name} maps to tool_choice {type:tool,name}', () => {
    const body = buildAnthropicBody({
      req: TOOL_CHOICE_REQ({ name: 'decide' }),
      model: 'glm-5.3-flash',
      rung: 'auto',
      seedSupported: false,
    });
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'decide' });
  });

  it("'auto' maps to {type:'auto'}, 'required' to {type:'any'} (some tool must be called)", () => {
    const auto = buildAnthropicBody({ req: TOOL_CHOICE_REQ('auto'), model: 'm', rung: 'auto', seedSupported: false });
    expect(auto.tool_choice).toEqual({ type: 'auto' });
    const required = buildAnthropicBody({ req: TOOL_CHOICE_REQ('required'), model: 'm', rung: 'auto', seedSupported: false });
    expect(required.tool_choice).toEqual({ type: 'any' });
  });

  it('a toolChoice naming a tool that is not on the request is dropped, not sent bare', () => {
    const body = buildAnthropicBody({
      req: withoutTools(TOOL_CHOICE_REQ({ name: 'decide' })),
      model: 'm',
      rung: 'auto',
      seedSupported: false,
    });
    expect(body.tool_choice).toBeUndefined();
    expect(body.tools).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The absence law — existing bytes untouched
// ---------------------------------------------------------------------------

describe('toolChoice absent leaves the wire body unchanged', () => {
  it('openai: absent field keeps the legacy defaults — auto with tools, omitted without', () => {
    const withTools = buildWireBody({ req: TOOL_CHOICE_REQ(undefined), model: 'm', rung: 'auto', seedSupported: false });
    expect(withTools.tool_choice).toBe('auto');

    const toolLess = buildWireBody({
      req: withoutTools(TOOL_CHOICE_REQ(undefined)),
      model: 'm',
      rung: 'auto',
      seedSupported: false,
    });
    expect('tool_choice' in toolLess).toBe(false); // omitted from the body entirely
  });

  it('anthropic: absent field keeps the body byte-identical to the pre-Phase-1 shape', () => {
    const withTools = buildAnthropicBody({
      req: TOOL_CHOICE_REQ(undefined),
      model: 'glm-5.3-flash',
      rung: 'auto',
      seedSupported: false,
    });
    expect(withTools.tool_choice).toBeUndefined();
    expect(withTools).toEqual({
      model: 'glm-5.3-flash',
      max_tokens: 100,
      temperature: 0.5,
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'decide', description: 'Lock the decision.', input_schema: {} }],
    });
  });

  it('assess with decide-plus-tools puts no toolChoice key on the recorded request at all', async () => {
    const model = new MockModel({ clock: new TestClock(0) });
    const registryTool: ToolDef = { name: 'echo', description: 'echo', parameters: {} };
    await assess(assessState(model, [decideToolDef, registryTool]), baseMsgs, { tier: 'main', taskClass: 'turn' });
    const req = model.calls[0] as ChatRequest | undefined;
    expect('toolChoice' in (req ?? {})).toBe(false);
  });
});

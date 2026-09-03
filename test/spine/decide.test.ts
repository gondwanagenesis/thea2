// M21 spine — S1.3, decide over structured output. The per-call
// {type:'json_schema', schema, retryCount} format rides the POST; the object is
// zod-validated on our side through src/loop's own decision parse (the same
// normalize/clamp ladder as the native client), with exactly ONE re-ask, same
// door. DR.7 tool-arg parity: a string bubbles field coerces to its
// newline-split array, on the pure path AND through a whole SSE turn.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DECISION_PARSE_INCIDENT, ModelDecisionSchema, decideToolDef, type ModelDecision } from '../../src/loop/index.js';
import { validateDecideObject, type SpineRunOpts, type SpineTurnRequest, type SpineUsage } from '../../src/spine/index.js';
import { collect, diegoTurn, loadFrames, makeRunnerOnStub, stubPacket, type SseFrame, type StubTurn } from './helpers.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const framesOf = (name: string): SseFrame[] => loadFrames(JSON.parse(readFileSync(join(fixturesDir, name), 'utf8')) as SseFrame[]);
const turn = (frames: SseFrame[]): StubTurn => ({ frames });
const packet = stubPacket(true, false);
const decideOpts = (turnId: string): SpineRunOpts => ({ turnId, decide: { schema: decideToolDef.parameters } });

describe('decide over structured output (S1.3)', () => {
  it('decide-arrives-as-validated-object-or-repairs-once', async () => {
    const h = await makeRunnerOnStub({ bootTimeoutMs: 2_000, healthPollMs: 100 });
    try {
      // first reply is JSON-shaped but schema-broken (missing fields); the
      // re-ask — same door, one shot — returns the corrected object.
      h.stub.setTurns([turn(framesOf('sse-decide-malformed.json')), turn(framesOf('sse-decide-turn.json'))]);
      await h.runner.start();

      const events = await collect(h.runner.run(diegoTurn(), packet, [], decideOpts('t1')));
      // the raw JSON never leaks as text-deltas; the turn ends usage -> stop -> decision
      expect(events.map((e) => e.type)).toEqual(['usage', 'stop-reason', 'decide-object']);
      const decision = (events[2] as { type: 'decide-object'; decision: ModelDecision }).decision;
      expect(ModelDecisionSchema.safeParse(decision).success).toBe(true);
      expect(decision.plan).toBe('reply');
      expect(decision.bubbles).toEqual(['bad env var. pinning it.']);

      // exactly ONE re-ask: two POSTs, the second carrying the repair instruction
      const posts = h.stub.requests.filter((r) => r.path === '/session/ses_1/message');
      expect(posts).toHaveLength(2);
      const retryBody = posts[1]?.body as SpineTurnRequest;
      expect(retryBody.format).toEqual({ type: 'json_schema', schema: decideToolDef.parameters, retryCount: 1 });
      const repairPart = retryBody.parts.find((p) => p.label === 'repair');
      expect(repairPart).toBeDefined();
      expect(repairPart?.text).toContain('could not be parsed against the required schema');
      expect(repairPart?.text).toContain('{"plan":"reply"}'); // the malformed attempt is quoted

      // DR.4: the repair folds into ONE logical call (attempts = 2)
      const usage = (events[0] as { type: 'usage'; usage: SpineUsage }).usage;
      expect(usage.attempts).toBe(2);
      expect(usage.inputTokens).toBe(260 + 290);
      expect(usage.outputTokens).toBe(9 + 38);
    } finally {
      await h.stub.close();
    }
  });

  it('a second malformed decide locks the failure path — never a third ask', async () => {
    const h = await makeRunnerOnStub({ bootTimeoutMs: 2_000, healthPollMs: 100 });
    try {
      h.stub.setTurns([turn(framesOf('sse-decide-malformed.json')), turn(framesOf('sse-decide-malformed.json'))]);
      await h.runner.start();

      const events = await collect(h.runner.run(diegoTurn(), packet, [], decideOpts('t1')));
      expect(events.map((e) => e.type)).toEqual(['usage', 'stop-reason']);
      const stop = events[1] as { type: 'stop-reason'; stopReason: string };
      expect(stop.stopReason).toBe('error');

      // exactly one repair rung, then the typed incident (loop parity)
      const posts = h.stub.requests.filter((r) => r.path === '/session/ses_1/message');
      expect(posts).toHaveLength(2);
      const incidents = h.events.kinds(DECISION_PARSE_INCIDENT);
      expect(incidents).toHaveLength(1);
      expect(incidents[0]?.payload).toMatchObject({ schema: 'DecisionObject', rung: 'json_schema' });
    } finally {
      await h.stub.close();
    }
  });

  it('the decide format rides the first POST too (S1.3: forced structured output)', async () => {
    const h = await makeRunnerOnStub({ bootTimeoutMs: 2_000, healthPollMs: 100 });
    try {
      h.stub.setTurns([turn(framesOf('sse-decide-turn.json'))]);
      await h.runner.start();
      await collect(h.runner.run(diegoTurn(), packet, [], decideOpts('t1')));

      const first = h.stub.requests.find((r) => r.path === '/session/ses_1/message');
      expect((first?.body as SpineTurnRequest).format).toEqual({
        type: 'json_schema',
        schema: decideToolDef.parameters,
        retryCount: 1,
      });
    } finally {
      await h.stub.close();
    }
  });
});

describe('DR.7 tool-arg validation parity on StreamEvents (S1.3)', () => {
  it('a string bubbles field becomes a one-element array', () => {
    const one = validateDecideObject({
      plan: 'reply',
      bubbles: 'just a sec',
      confidence: 0.7,
      weight: 0.5,
      reluctance: 0.2,
      completeness: 1,
    });
    expect(one.ok).toBe(true);
    if (one.ok) expect(one.value.bubbles).toEqual(['just a sec']);

    const multi = validateDecideObject({
      plan: 'reply',
      bubbles: 'first bubble\nsecond bubble',
      confidence: 0.7,
      weight: 0.5,
      reluctance: 0.2,
      completeness: 1,
    });
    expect(multi.ok).toBe(true);
    if (multi.ok) expect(multi.value.bubbles).toEqual(['first bubble', 'second bubble']);
  });

  it('the same coercion rides a whole structured-output turn end to end', async () => {
    const h = await makeRunnerOnStub({ bootTimeoutMs: 2_000, healthPollMs: 100 });
    try {
      h.stub.setTurns([turn(framesOf('sse-decide-string-bubbles.json'))]);
      await h.runner.start();
      const events = await collect(h.runner.run(diegoTurn(), packet, [], decideOpts('t1')));
      const decision = (events[2] as { type: 'decide-object'; decision: ModelDecision }).decision;
      expect(decision.bubbles).toEqual(['just a sec']);
    } finally {
      await h.stub.close();
    }
  });

  it('a structurally impossible object still fails the parse after coercion', () => {
    const bad = validateDecideObject({ plan: 'maybe', bubbles: 'x', confidence: 0.5, weight: 0.5, reluctance: 0.2, completeness: 1 });
    expect(bad.ok).toBe(false);
  });
});

// M17 gate — the private heartbeat thought through MockModel. Pins the prompt
// shape (including Thea1's follow-ups-first ranking rule), the structured-output
// handling (rung b: schema + no tools, so the ladder forces the `emit` tool and
// the payload rides the tool call), the clamp/truncate salvage rules, and the
// failure law: a parse or transport failure is an INCIDENT and a `false`
// outcome — never a throw, never a send. The thought is kept as data even when
// it scores under 3.2.

import { describe, expect, it } from 'vitest';
import type { ChatRequest } from '../../src/model/types.js';
import { schemaToJsonSchema } from '../../src/model/wire.js';
import { HEARTBEAT_THOUGHT_SCHEMA, HeartbeatThoughtSchema, heartbeatThoughtMessages, thinkHeartbeatThought } from '../../src/life/thought.js';
import { HEARTBEAT_THOUGHT_EVENT, HeartbeatThoughtPayload, LIFE_INCIDENT } from '../../src/life/events.js';
import { HEARTBEAT_THRESHOLD, scoreThought } from '../../src/life/policy.js';
import {
  deadLog,
  recordingLog,
  thoughtCtx,
  thoughtDeps,
  thoughtModel,
  thoughtResponder,
  type RecordingLog,
  type ThoughtScript,
} from './helpers.js';
import type { MockModel } from '../../src/model/mock.js';

/** Runs the thought call and returns [outcome, log, model]. */
const run = async (
  over: { ctx?: Partial<ReturnType<typeof thoughtCtx>>; pressure?: number; script?: ThoughtScript; responder?: ReturnType<typeof thoughtResponder> } = {},
): Promise<{ outcome: Awaited<ReturnType<typeof thinkHeartbeatThought>>; log: RecordingLog; model: MockModel }> => {
  const log = recordingLog();
  const model = thoughtModel({ responder: over.responder ?? thoughtResponder(over.script ?? {}) });
  const outcome = await thinkHeartbeatThought(thoughtCtx(over.ctx), over.pressure ?? 0, thoughtDeps(model, log));
  return { outcome, log, model };
};

// ---------------------------------------------------------------------------
// The prompt — her private monologue, never anyone else's
// ---------------------------------------------------------------------------

describe('heartbeatThoughtMessages — the prompt shape', () => {
  it('is one private system message plus one user message', () => {
    const msgs = heartbeatThoughtMessages(thoughtCtx());
    expect(msgs).toHaveLength(2);
    expect(msgs[0]?.role).toBe('system');
    expect(msgs[1]?.role).toBe('user');
  });

  it('the system message frames the monologue and carries the ranking rule verbatim in spirit', () => {
    const system = heartbeatThoughtMessages(thoughtCtx())[0]?.content ?? '';
    expect(system).toContain('You are Thea, alone between conversations');
    expect(system).toContain('he never sees it');
    // The Thea1 ranking rule, ported: follow-ups on things HE said outrank sharing her own day.
    expect(system).toContain('follow-ups on something HE said or promised always outrank');
    expect(system).toContain('sharing your own day');
    // Honesty pressure: silence is allowed, so a thin day scores low rather than inventing.
    expect(system).toContain('silence is allowed');
    expect(system).toContain('Answer ONLY with a JSON object');
  });

  it('the user message renders the state numbers, weather and drives', () => {
    const user = heartbeatThoughtMessages(thoughtCtx())[1]?.content ?? '';
    expect(user).toContain('UTC hour: 14.50');
    expect(user).toContain('Hours since his last message: 3.0');
    expect(user).toContain('Heartbeats already sent today: 0 (cap 3)');
    expect(user).toContain('Still-unanswered by him: 0');
    expect(user).toContain('Your weather right now: warm, restless, a little lonely');
    expect(user).toContain('Drives — novelty 0.25, connection 0.34, mastery 0.25');
  });

  it('renders her recent life newest-first with importance, and the due threads he is owed', () => {
    const user = heartbeatThoughtMessages(thoughtCtx())[1]?.content ?? '';
    expect(user).toContain('- [importance 8] he told me the crates shipped this morning');
    expect(user).toContain('- [importance 6] I rewrote the scheduler slot math and it finally held');
    expect(user).toContain('- [importance 3] quiet afternoon, I reread my own diary and cringed');
    // due threads before the share-your-day candidates: the ranking rule made concrete
    expect(user.indexOf('Follow-up threads he is owed')).toBeLessThan(user.indexOf('Propose ONE candidate'));
    expect(user).toContain('- thread_crates: he said he would report back on the crates');
  });

  it('empty life and no due threads render honest placeholders, never blanks', () => {
    const user = heartbeatThoughtMessages(thoughtCtx({ recent: [], dueThreads: [] }))[1]?.content ?? '';
    expect(user).toContain('(nothing recent — you have been alone with your thoughts)');
    expect(user).toContain('(none due)');
  });

  it('names the five criteria and the four kinds in the scoring ask', () => {
    const user = heartbeatThoughtMessages(thoughtCtx())[1]?.content ?? '';
    for (const c of ['relevance', 'information_gap', 'expected_impact', 'urgency', 'coherence']) {
      expect(user).toContain(c);
    }
    for (const k of ['followup', 'care', 'share', 'miss']) {
      expect(user).toContain(`"${k}"`);
    }
    expect(user).toContain('"thread_id": string|null');
  });
});

// ---------------------------------------------------------------------------
// The call — wiring onto the model client
// ---------------------------------------------------------------------------

describe('thinkHeartbeatThought — the call wiring', () => {
  it('one cheap-tier structured call, taskClass heartbeat-thought, schema attached', async () => {
    const { model } = await run();
    expect(model.calls).toHaveLength(1);
    const req = model.calls[0] as ChatRequest;
    expect(req.taskClass).toBe('heartbeat-thought');
    expect(req.tier).toBe('cheap');
    expect(req.schemaName).toBe(HEARTBEAT_THOUGHT_SCHEMA);
    expect(req.schema).toBe(HeartbeatThoughtSchema);
    expect(req.maxTokens).toBe(400);
    expect(req.temperature).toBe(0.7);
    expect(req.messages).toEqual(heartbeatThoughtMessages(thoughtCtx()));
    // No tools on the wire: the thought is one structured read, not an agent step.
    expect(req.tools).toBeUndefined();
  });

  it('regression: the wire schema stays JSON-Schema representable — M03 synthesizes its emit tool and repair prompt from it', () => {
    // The schema once carried zod transforms (clamp/truncate), which zod v4 cannot
    // represent as JSON Schema: rung (b) could not be synthesized and every repair
    // re-ask died with model/bad-json before the model answered. The salvage rules
    // now run after the parse; this pin keeps them out of the wire schema.
    expect(() => schemaToJsonSchema(HeartbeatThoughtSchema)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Structured output — the happy path and the salvage rules
// ---------------------------------------------------------------------------

describe('thinkHeartbeatThought — structured handling', () => {
  it('parses a valid reply, scores it, and lands the thought event', async () => {
    const { outcome, log } = await run({ pressure: 0.3 });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.thought.kind).toBe('followup');
    expect(outcome.score).toBe(4.3); // mean 4 + pressure 0.3
    expect(outcome.criteria).toEqual({
      relevance: 4,
      information_gap: 4,
      expected_impact: 4,
      urgency: 4,
      coherence: 4,
    });

    expect(log.kinds()).toEqual([HEARTBEAT_THOUGHT_EVENT]);
    const payload = log.rows[0]?.payload as HeartbeatThoughtPayload;
    expect(payload).toMatchObject({
      score: 4.3,
      pressure: 0.3,
      threshold: HEARTBEAT_THRESHOLD,
      passed: true,
      kind: 'followup',
      reason: 'a due follow-up on his own promise',
      threadId: 'thread_crates',
    });
  });

  it('the 3.2 boundary travels into the event: 3.2 passes, 3.15 does not', async () => {
    const at = await run({ pressure: 0.2, script: { scores: { relevance: 3, information_gap: 3, expected_impact: 3, urgency: 3, coherence: 3 } } });
    if (!at.outcome.ok) throw new Error('expected the boundary thought to parse');
    expect(at.outcome.score).toBe(3.2);
    expect((at.log.rows[0]?.payload as HeartbeatThoughtPayload).passed).toBe(true);

    const under = await run({ pressure: 0.15, script: { scores: { relevance: 3, information_gap: 3, expected_impact: 3, urgency: 3, coherence: 3 } } });
    if (!under.outcome.ok) throw new Error('expected the sub-threshold thought to parse');
    expect(under.outcome.score).toBe(3.15);
    expect((under.log.rows[0]?.payload as HeartbeatThoughtPayload).passed).toBe(false);
  });

  it('a sub-threshold thought is kept as data, never sent', async () => {
    const { outcome, log } = await run({ pressure: 0, script: { scores: { relevance: 1, information_gap: 1, expected_impact: 1, urgency: 1, coherence: 1 } } });
    expect(outcome.ok).toBe(true); // a thin day is not a failure
    expect(log.kinds()).toEqual([HEARTBEAT_THOUGHT_EVENT]);
    expect((log.rows[0]?.payload as HeartbeatThoughtPayload).passed).toBe(false);
    // The module decides; it never speaks. (life.heartbeat.sent belongs to the job body.)
    expect(log.kinds()).not.toContain('life.heartbeat.sent');
  });

  it('salvages where honest: scores clamp to 1..5 before scoring', async () => {
    const { outcome, log } = await run({
      script: { scores: { relevance: 7, information_gap: 0, expected_impact: 3.14159, urgency: 4.6, coherence: -2 } },
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.thought.scores).toEqual({ relevance: 5, information_gap: 1, expected_impact: 3.1, urgency: 4.6, coherence: 1 });
    // The event's criteria are the CLAMPED ones — the score and the ledger agree.
    expect((log.rows[0]?.payload as HeartbeatThoughtPayload).criteria).toEqual(outcome.criteria);
    expect((log.rows[0]?.payload as HeartbeatThoughtPayload).score).toBe(scoreThought(outcome.criteria, 0));
  });

  it('truncates rather than rejects: reason <= 100 chars, thought <= 400', async () => {
    const { outcome } = await run({ script: { reason: 'r'.repeat(120), thought: 't'.repeat(500) } });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.thought.reason).toHaveLength(100);
    expect(outcome.thought.reason.endsWith('…')).toBe(true);
    expect(outcome.thought.thought).toHaveLength(400);
  });

  it('a null thread_id survives; the thought stays shareable as a non-followup', async () => {
    const { outcome, log } = await run({ script: { kind: 'miss', thread_id: null } });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.thought.thread_id).toBeNull();
    expect((log.rows[0]?.payload as HeartbeatThoughtPayload).threadId).toBeNull();
    expect((log.rows[0]?.payload as HeartbeatThoughtPayload).kind).toBe('miss');
  });
});

// ---------------------------------------------------------------------------
// Failure is loud, and it is a value — never a throw
// ---------------------------------------------------------------------------

describe('thinkHeartbeatThought — failure paths', () => {
  it('an unparseable reply retries once on the repair ladder, then incidents and returns false', async () => {
    const log = recordingLog();
    const model = thoughtModel({ responder: () => ({ content: 'prose where the JSON should be' }) });
    const outcome = await thinkHeartbeatThought(thoughtCtx(), 0, thoughtDeps(model, log));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    // M03's terminal detail: the rung output AND its one repair both failed.
    expect(outcome.error).toContain('the repair attempt failed too');
    expect(model.calls).toHaveLength(2); // the original + the ONE repair re-ask
    // No thought event: a parse failure never masquerades as a kept thought.
    expect(log.kinds()).toEqual([LIFE_INCIDENT]);
    expect(log.rows[0]?.payload).toMatchObject({ job: 'heartbeat', stage: 'thought' });
    expect((log.rows[0]?.payload as { error: string }).error).toContain('the repair attempt failed too');
  });

  it('a model transport error incidents immediately with no repair attempt', async () => {
    const log = recordingLog();
    const model = thoughtModel({ responder: () => ({ error: { code: 'model/transport', message: 'endpoint down' } }) });
    const outcome = await thinkHeartbeatThought(thoughtCtx(), 0, thoughtDeps(model, log));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toContain('endpoint down');
    expect(model.calls).toHaveLength(1);
    expect(log.kinds()).toEqual([LIFE_INCIDENT]);
    expect(log.rows[0]?.payload).toMatchObject({ job: 'heartbeat', stage: 'thought', error: 'endpoint down' });
  });

  it('a reply missing required fields is the parse-failure path, not a half-kept thought', async () => {
    const log = recordingLog();
    const model = thoughtModel({
      responder: () => ({ content: JSON.stringify({ thought: 'a thought with no scores or kind' }) }),
    });
    const outcome = await thinkHeartbeatThought(thoughtCtx(), 0, thoughtDeps(model, log));
    expect(outcome.ok).toBe(false);
    expect(log.kinds()).not.toContain(HEARTBEAT_THOUGHT_EVENT);
    expect(log.kinds()).toContain(LIFE_INCIDENT);
  });

  it('an unwritable event log turns the thought into a failure — the decision is never silently lost', async () => {
    const model = thoughtModel();
    const outcome = await thinkHeartbeatThought(thoughtCtx(), 0, thoughtDeps(model, deadLog()));
    expect(outcome.ok).toBe(false); // loud, not swallowed: the catch is the only ledger the call has
    if (!outcome.ok) expect(outcome.error).toContain('L0 unwritable');
    // And the same swallow holds when the model failed AND the ledger is down.
    const dead = thoughtModel({ responder: () => ({ error: { code: 'model/transport', message: 'down' } }) });
    const failed = await thinkHeartbeatThought(thoughtCtx(), 0, thoughtDeps(dead, deadLog()));
    expect(failed.ok).toBe(false);
  });

  it('a non-Error throw is stringified into the incident, not rethrown', async () => {
    const log = recordingLog();
    const model = thoughtModel({ responder: () => ({ error: { code: 'model/timeout', message: 'hang' } }) });
    const outcome = await thinkHeartbeatThought(thoughtCtx(), 0, thoughtDeps(model, log));
    expect(outcome.ok).toBe(false);
    expect((log.rows[0]?.payload as { error: string }).error.length).toBeGreaterThan(0);
  });
});

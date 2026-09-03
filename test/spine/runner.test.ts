// M21 spine — S1.2, OpenCodeRunner supervision + session lifecycle + the
// SSE->StreamEvent bridge. Every test runs against a local node:http stub that
// speaks the documented v1.18.x API shape from recorded fixtures; the spawn
// seam is injected, so the real `opencode` binary is never launched, looked at,
// or downloaded (hermetic law, plan v7 D.7-3).

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SPINE_SESSION_BREAK_MS, type SpineTurnRequest } from '../../src/spine/index.js';
import { diegoTurn, collect, loadFrames, makeRunnerOnStub, pumpClock, stubPacket, type SseFrame, type StubTurn } from './helpers.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const framesOf = (name: string): SseFrame[] =>
  loadFrames(JSON.parse(readFileSync(join(fixturesDir, name), 'utf8')) as SseFrame[]);
const turn = (frames: SseFrame[]): StubTurn => ({ frames });
const packet = stubPacket(true, false);

describe('OpenCodeRunner supervision (S1.2)', () => {
  it('runner-supervises-and-restarts-a-dead-spine', async () => {
    const h = await makeRunnerOnStub({ bootTimeoutMs: 2_000, healthPollMs: 100, restartBackoffBaseMs: 100 });
    try {
      h.stub.setTurns([turn(framesOf('sse-golden-turn.json'))]);

      await h.runner.start();
      expect(h.runner.state).toBe('ready');
      // pinned spawn shape: opencode serve on 127.0.0.1, the config port, auth env set
      expect(h.spawnCalls).toHaveLength(1);
      expect(h.spawnCalls[0]?.cmd).toBe('opencode');
      expect(h.spawnCalls[0]?.args).toEqual(['serve', '--hostname', '127.0.0.1', '--port', String(h.stub.port)]);
      expect(h.spawnCalls[0]?.env['THEA2_SPINE_TOKEN']).toBe('test-token');
      expect(h.events.kinds('spine.boot')).toHaveLength(1);

      // the pinned child dies under us: supervised restart with backoff
      h.children[0]?.emitExit(1, null);
      expect(h.runner.state).toBe('booting');
      await pumpClock(h.clock, () => h.runner.state === 'ready' && h.spawnCalls.length >= 2);
      expect(h.children[0]?.killed).toBe(false); // it crashed; it was not cut
      expect(h.events.kinds('spine.restart')).toHaveLength(1);

      // the restarted child serves a real turn through the SSE bridge
      const events = await collect(h.runner.run(diegoTurn(), packet, [], { turnId: 't1' }));
      expect(events.some((e) => e.type === 'text-delta')).toBe(true);
      expect(h.stub.requests.some((r) => r.path === '/app')).toBe(true);

      await h.runner.stop();
      expect(h.children[1]?.killed).toBe(true); // stop() reaps the child — no orphaned harness
    } finally {
      await h.stub.close();
    }
  });

  it('a wedged spine is abandoned after the boot attempts with incident.spine_failed', async () => {
    const h = await makeRunnerOnStub({
      bootTimeoutMs: 200,
      healthPollMs: 50,
      restartBackoffBaseMs: 50,
      maxBootAttempts: 2,
    });
    try {
      h.stub.setHealth(503); // the child never becomes healthy — a wedge
      const starting = h.runner.start();
      await pumpClock(h.clock, () => h.runner.state === 'abandoned');
      await starting;

      expect(h.spawnCalls).toHaveLength(2); // maxBootAttempts, then give up
      expect(h.children.every((c) => c.killed)).toBe(true); // wedged children are cut
      const incidents = h.events.kinds('incident.spine_failed');
      expect(incidents).toHaveLength(1);
      expect(incidents[0]?.payload).toMatchObject({ reason: 'boot-timeout' });

      // abandon is loud, not silent: every later turn refuses
      await expect(collect(h.runner.run(diegoTurn(), packet, [], { turnId: 't1' }))).rejects.toThrow(/abandoned/i);
    } finally {
      await h.stub.close();
    }
  });

  it('an idle spine aborts the turn: incident.spine_failed + stop-reason error (FA.1 path)', async () => {
    const h = await makeRunnerOnStub({ bootTimeoutMs: 2_000, healthPollMs: 100, turnIdleTimeoutMs: 200 });
    try {
      h.stub.setTurns([]); // the POST fails; nothing ever streams back
      await h.runner.start();
      const events = await collect(h.runner.run(diegoTurn(), packet, [], { turnId: 't1' }));
      expect(events.map((e) => e.type)).toEqual(['stop-reason']);
      if (events[0]?.type !== 'stop-reason') throw new Error('expected stop-reason');
      expect(events[0].stopReason).toBe('error');
      expect(h.events.kinds('incident.spine_failed')).toHaveLength(1);
    } finally {
      await h.stub.close();
    }
  });
});

describe('session lifecycle (S1.2: our 4h session-break drives fork/new)', () => {
  it('session-break-forks-a-new-session', async () => {
    const h = await makeRunnerOnStub({ bootTimeoutMs: 2_000, healthPollMs: 100 });
    try {
      const frames = framesOf('sse-golden-turn.json');
      h.stub.setTurns([turn(frames), turn(frames), turn(frames)]);
      await h.runner.start();

      await collect(h.runner.run(diegoTurn(), packet, [], { turnId: 't1' }));
      // well inside the break: same session
      await h.clock.advance(SPINE_SESSION_BREAK_MS - 60_000);
      await collect(h.runner.run(diegoTurn(), packet, [], { turnId: 't2' }));
      // the turn refreshed the session's clock — go a FULL break past it
      await h.clock.advance(SPINE_SESSION_BREAK_MS + 1_000);
      await collect(h.runner.run(diegoTurn(), packet, [], { turnId: 't3' }));

      const sessionPosts = h.stub.requests.filter((r) => r.path === '/session');
      expect(sessionPosts).toHaveLength(2);
      const messagePaths = h.stub.requests
        .filter((r) => r.path.endsWith('/message'))
        .map((r) => r.path);
      expect(messagePaths).toEqual(['/session/ses_1/message', '/session/ses_1/message', '/session/ses_2/message']);
    } finally {
      await h.stub.close();
    }
  });
});

describe('SSE -> L0 bridge (S1.2: DR.4 parity on cost/tokens/stop-reason)', () => {
  it('sse-events-map-to-l0-model-call-events', async () => {
    const h = await makeRunnerOnStub({ bootTimeoutMs: 2_000, healthPollMs: 100 });
    try {
      h.stub.setTurns([turn(framesOf('sse-golden-turn.json'))]);
      await h.runner.start();

      const events = await collect(h.runner.run(diegoTurn(), packet, [], { turnId: 't1', taskClass: 'turn' }));
      expect(events.map((e) => e.type)).toEqual(['text-delta', 'text-delta', 'tool-call', 'usage', 'stop-reason']);

      const [d1, d2, toolCall, usage, stop] = events as [
        { type: 'text-delta'; text: string },
        { type: 'text-delta'; text: string },
        { type: 'tool-call'; call: { id: string; name: string; args: unknown } },
        { type: 'usage'; usage: { inputTokens: number; outputTokens: number; costUsd?: number; attempts: number } },
        { type: 'stop-reason'; stopReason: string },
      ];
      expect(d1.text).toBe('on it');
      expect(d2.text).toBe(' - checking the logs.');
      expect(toolCall.call).toEqual({ id: 'call_1', name: 'memory_search', args: { query: 'deploy' } });
      expect(usage.usage.inputTokens).toBe(311);
      expect(usage.usage.outputTokens).toBe(42);
      expect(usage.usage.costUsd).toBe(0.0021);
      expect(stop.stopReason).toBe('end_turn'); // 'stop' mapped onto the DR.4 vocabulary

      // the L0 model.call carries the DR.4 field names, verbatim
      const calls = h.events.kinds('model.call');
      expect(calls).toHaveLength(1);
      const payload = calls[0]?.payload as Record<string, unknown>;
      const usagePayload = payload['usage'] as Record<string, unknown>;
      expect(usagePayload['inputTokens']).toBe(311);
      expect(usagePayload['outputTokens']).toBe(42);
      expect(usagePayload['costUsd']).toBe(0.0021);
      expect(usagePayload['attempts']).toBe(1);
      expect(payload['stopReason']).toBe('end_turn');
      expect(payload['outcome']).toBe('ok');
      expect(payload['door']).toBe('voice');
      expect(payload['tier']).toBe('main');
      expect(payload['model']).toBe('voice/glm-5.3');
      expect(payload['taskClass']).toBe('turn');
    } finally {
      await h.stub.close();
    }
  });

  it('the POST body speaks the documented per-turn shape (agent/model/parts)', async () => {
    const h = await makeRunnerOnStub({ bootTimeoutMs: 2_000, healthPollMs: 100 });
    try {
      h.stub.setTurns([turn(framesOf('sse-golden-turn.json'))]);
      await h.runner.start();
      await collect(h.runner.run(diegoTurn(), packet, [], { turnId: 't1' }));

      const post = h.stub.requests.find((r) => r.path === '/session/ses_1/message');
      expect(post).toBeDefined();
      const body = post?.body as SpineTurnRequest;
      expect(body.agent).toBe('thea');
      expect(body.model).toEqual({ providerID: 'voice', modelID: 'glm-5.3' });
      expect(body.system).toBe(packet.systemText());
      expect(body.parts.at(-1)?.text).toBe(packet.trailerText()); // the inhibition rides last
      expect(body.format).toBeUndefined(); // no decide contract on a plain turn
    } finally {
      await h.stub.close();
    }
  });
});

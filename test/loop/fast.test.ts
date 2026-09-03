// M13 loop — P-FAST: the turn locks a decision fast and never throws (v6 FA.1–FA.4).
// FA.1 a throw from assess/mediate/repair/gate is a VALUE (incident.turn_aborted +
// forced-silent failure), never a rejected runLoop; FA.2 the budgets and the
// turn-class transport dial; FA.3 spawns off user turns; FA.4 repair is
// exceptional and stays on the voice door.

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Clock } from '../../src/kernel/index.js';
import { DEFAULT_BACKOFF, modelError, type ChatRequest, type ChatContext, type ModelClient } from '../../src/model/index.js';
import {
  GATE_LOOP_INCIDENT,
  DECISION_PROSE_FOLDED,
  TURN_ABORTED_INCIDENT,
  createToolRegistry,
  runLoop,
  resolveLoopConfig,
} from '../../src/loop/index.js';
import type { InboundMsg } from '../../src/loop/index.js';
import {
  enqueueDecision,
  enqueueToolRound,
  loopGate,
  makeHarness,
  toolNamesOnWire,
  type LoopHarness,
} from './helpers.js';

const inbound = (text = 'hello there, what did you read today?'): InboundMsg => ({
  updateId: 1,
  msgId: 11,
  chatId: 42,
  ts: 999,
  text,
  speaker: { person: 'diego', channel: 'telegram' },
});

const entry = (over: Partial<Parameters<LoopHarness['run']>[0]> = {}): Parameters<LoopHarness['run']>[0] => ({
  kind: 'user-turn',
  inbound: inbound(),
  ...over,
});

const bareRegistry = (): ReturnType<typeof createToolRegistry> => createToolRegistry();

/** Drains pending microtask rounds — the hermetic substitute for a macrotask
 * wait (bare setTimeout is a determinism violation in test files). */
const pumpMicrotasks = async (rounds = 25): Promise<void> => {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
};

/** A ModelClient that never settles on its own — only the turn's deadline abort ends it. */
const hangingModel = (): ModelClient => ({
  chat: <T>(_req: ChatRequest<T>, ctx?: ChatContext): Promise<never> =>
    new Promise<never>((_resolve, reject) => {
      ctx?.signal?.addEventListener(
        'abort',
        () => reject(modelError('model/aborted', 'chat aborted by caller signal')),
        { once: true },
      );
    }),
});

describe('FA.1 — the turn never throws', () => {
  it('a model error during assess is a failure silence not a throw', async () => {
    const h = makeHarness();
    h.model.onTask('turn', () => ({ error: { code: 'model/timeout', message: 'voice door died mid-turn' } }));
    const d = await h.run(entry()); // resolves — a value, not a rejection
    expect(d.plan).toBe('silent');
    expect(d.decidedBy).toBe('failure');
    expect(d.bubbles).toEqual([]);
    const aborted = h.events.kinds(TURN_ABORTED_INCIDENT);
    expect(aborted).toHaveLength(1);
    expect(aborted[0]?.payload).toMatchObject({ turnId: d.turnId, code: 'model/timeout', stage: 'loop' });
  });

  it('a gate that throws mid-plan is also a failure silence (incident, no escape)', async () => {
    const base = loopGate();
    const h = makeHarness({
      gate: {
        ...base,
        checkPlan: () => {
          throw new Error('compiled gate lost its rules');
        },
      },
    });
    enqueueDecision(h.model, { bubbles: ['a clean draft'] });
    const d = await h.run(entry());
    expect(d.plan).toBe('silent');
    expect(d.decidedBy).toBe('failure');
    expect(h.events.kinds(TURN_ABORTED_INCIDENT)).toHaveLength(1);
  });

  it('a structural loop error still escapes (the pipeline cannot recover by continuing)', async () => {
    const h = makeHarness();
    // A committee spec that is not a DAG is a structural sin (errors.ts law):
    // it must reject, not masquerade as a silence.
    const bad = {
      name: 'broken',
      nodes: [{ id: 'A', needs: ['GHOST'], channels: { character: true, procedural: true }, prompt: 'x' }],
      output: z.string(),
    };
    await expect(h.run({ kind: 'ponder', goal: 'wander', committee: bad })).rejects.toMatchObject({
      code: 'loop/bad-committee',
    });
    expect(h.events.kinds(TURN_ABORTED_INCIDENT)).toHaveLength(0);
  });

  it('a model error mid-mediation is a failure silence, not a throw', async () => {
    const h = makeHarness();
    enqueueToolRound(h.model, [{ name: 'echo', args: { text: 'round one' } }]);
    h.model.onTask('turn', () => ({ error: { code: 'model/rate-limit', message: '429 past the ladder' } }));
    const d = await h.run(entry());
    expect(d.decidedBy).toBe('failure');
    expect(d.toolTrace).toHaveLength(1); // the round that did run is still on the record
    expect(h.events.kinds(TURN_ABORTED_INCIDENT)).toHaveLength(1);
  });
});

describe('FA.2 — the budgets fit the voice door', () => {
  it('the retry ladder fits inside the turn budget', () => {
    const cfg = resolveLoopConfig();
    expect(cfg.budgetMs['user-turn']).toBe(30_000);
    expect(cfg.budgetMs.heartbeat).toBe(60_000);
    expect(cfg.budgetMs.ponder).toBe(180_000);
    expect(cfg.assessMaxTokens).toBe(1536);
    // the turn-class transport dial (wired into the voice door by M20's compose)
    expect(cfg.turnTransport).toEqual({ timeoutMs: 20_000, maxRetries: 1 });
    // one idle window plus the worst retry backoff fits inside the budget, so
    // the deadline signal — never a second full attempt — bounds a user turn
    expect(cfg.turnTransport.timeoutMs + DEFAULT_BACKOFF.capMs).toBeLessThanOrEqual(cfg.budgetMs['user-turn']);
  });

  it('the deadline timer is cleared when the turn ends', async () => {
    const h = makeHarness();
    // Track every clock waiter the loop registers through deps.clock: after the
    // turn resolves, none may remain pending — the deadline timer is cancelled
    // in finally, not left armed on the clock (a real process would otherwise
    // hold one live timer per turn forever).
    const inner = h.clock;
    const pending = new Set<Promise<unknown>>();
    let seenDuringTurn = 0;
    const tracked: Clock = {
      epochMs: () => inner.epochMs(),
      now: () => inner.now(),
      waitUntil: (t, signal) => {
        const orig = inner.waitUntil(t, signal);
        const w: Promise<void> = orig.then(
          () => {
            pending.delete(w);
          },
          () => {
            pending.delete(w);
          },
        );
        pending.add(w);
        return orig;
      },
    };
    h.deps.clock = tracked;
    h.model.onTask('turn', () => {
      seenDuringTurn = pending.size;
      return {
        content: '{"plan":"reply","bubbles":["quick"],"confidence":0.9,"weight":0.8,"reluctance":0.2,"completeness":1}',
      };
    });
    const d = await h.run(entry());
    expect(d.plan).toBe('reply');
    expect(seenDuringTurn).toBeGreaterThan(0); // the deadline WAS armed during the turn
    await pumpMicrotasks(); // let the cancel rejection settle its handlers
    expect(pending.size).toBe(0);
  });

  it('a turn that outlives its budget is aborted into a failure silence (the deadline fires)', async () => {
    const h = makeHarness({ cfg: { budgetMs: { 'user-turn': 1_000, heartbeat: 60_000, ponder: 180_000 } } });
    const deps: typeof h.deps = { ...h.deps, model: hangingModel() };
    const p = runLoop(entry(), deps);
    await pumpMicrotasks(); // the assess call is now parked inside the model
    await h.clock.advance(2_000); // past the budget: the deadline aborts the hung call
    const d = await p;
    expect(d.plan).toBe('silent');
    expect(d.decidedBy).toBe('failure');
    expect(d.completeness).toBe(0.5); // the budget cut the turn short — completeness says so
    const aborted = h.events.kinds(TURN_ABORTED_INCIDENT);
    expect(aborted).toHaveLength(1);
    expect(aborted[0]?.payload).toMatchObject({ code: 'model/aborted' });
  });
});

describe('FA.3 — spawns off user turns', () => {
  it('a user turn offers only decide', async () => {
    const h = makeHarness({ tools: bareRegistry() });
    enqueueDecision(h.model, { bubbles: ['just the decision'] });
    await h.run(entry());
    expect(toolNamesOnWire(h.model.calls[0]!)).toEqual(['decide']);
  });

  it('a ponder entry offers spawns', async () => {
    const h = makeHarness({ tools: bareRegistry() });
    enqueueDecision(h.model, {});
    await h.run({ kind: 'ponder', goal: 'something to chew on' });
    const names = toolNamesOnWire(h.model.calls[0]!);
    expect(names).toEqual(expect.arrayContaining(['fork', 'task', 'committee']));
    expect(names[0]).toBe('decide'); // the contract still travels first
  });

  it('spawns: auto keeps them off user turns even when the base registry is full', async () => {
    const h = makeHarness(); // echo + wedged registered; fork/task/committee are loop-owned
    enqueueDecision(h.model, {});
    await h.run(entry());
    expect(toolNamesOnWire(h.model.calls[0]!)).not.toContain('fork');
    expect(toolNamesOnWire(h.model.calls[0]!)).not.toContain('task');
    expect(toolNamesOnWire(h.model.calls[0]!)).not.toContain('committee');
  });
});

describe('FA.4 — repair is exceptional, and on the voice door', () => {
  it('a prose reply folds without a second call', async () => {
    const h = makeHarness();
    h.model.enqueue({ content: 'I will just say it plainly, in one breath.' });
    const d = await h.run(entry());
    expect(d.decidedBy).toBe('model');
    expect(d.bubbles).toEqual(['I will just say it plainly, in one breath.']);
    expect(h.model.calls).toHaveLength(1); // no repair call — the fold is deterministic
    // the fold is reported so the prose rate is measurable in L0
    const folds = h.events.kinds(DECISION_PROSE_FOLDED);
    expect(folds).toHaveLength(1);
    expect(folds[0]?.payload).toMatchObject({ turnId: d.turnId, bubbles: 1 });
  });

  it('the repair rung runs on the voice door (no routing_ignored spam)', async () => {
    const h = makeHarness();
    h.model.enqueue({ content: '{"plan": "reply", "bubbles": [' }); // JSON-shaped → repair
    enqueueDecision(h.model, { bubbles: ['repaired on the same door'] });
    const d = await h.run(entry());
    expect(d.bubbles).toEqual(['repaired on the same door']);
    expect(h.model.calls[1]?.tier).toBe('main'); // the voice door, same as assess — never a downgrade
    expect(h.events.kinds('model.routing_ignored')).toHaveLength(0);
  });

  it('a shape rejection rephrases once with the neutral reason and locks clean', async () => {
    const h = makeHarness();
    enqueueDecision(h.model, { bubbles: ['y'.repeat(300)] });
    enqueueDecision(h.model, { bubbles: ['short and done'] });
    const d = await h.run(entry());
    expect(d.bubbles).toEqual(['short and done']);
    expect(d.decidedBy).toBe('model');
    // the re-entry carried the shape hint, not an argument
    const revise = h.model.calls[1]!;
    expect(revise.messages.some((m) => m.content.includes('[INHIBITION:bubble-shape] split shorter'))).toBe(true);
    // a clean pass emits no gate-loop incident
    expect(h.events.kinds(GATE_LOOP_INCIDENT)).toHaveLength(0);
  });

  it('a misshapen draft past the cap fails OPEN — the shape gate never hard-fails a turn', async () => {
    const h = makeHarness();
    const bloated = { bubbles: ['x'.repeat(300)] }; // one bubble over the 220-char glance
    enqueueDecision(h.model, bloated);
    enqueueDecision(h.model, bloated);
    enqueueDecision(h.model, bloated);
    const d = await h.run(entry());
    // at the cap the soft shape rule fails open: the draft she authored locks
    expect(d.plan).toBe('reply');
    expect(d.decidedBy).toBe('model');
    expect(d.bubbles[0]).toHaveLength(300);
    const loops = h.events.kinds(GATE_LOOP_INCIDENT);
    expect(loops).toHaveLength(1);
    expect(loops[0]?.payload).toMatchObject({ ruleIds: ['bubble-shape'], resolution: 'fail-open' });
  });
});

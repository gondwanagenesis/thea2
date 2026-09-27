// v12 curiosity, wired for real (compose-v8 → mind → body → her fork → what she learned):
//   - a gap in conversation becomes her question (the appraiser, born 'gap'); a loop carries
//     what she can do herself; the same loop said again is touched, never duplicated (A2, A4)
//   - her fork looks into things with web/memory/code/workspace — never what reaches anyone
//   - a full pursuit: question → her hands → the learning judge → a thought, an interest
//   - she can start a turn in the group (to ask someone), never in a chat she isn't in

import { describe, expect, it } from 'vitest';
import type { ChatRequest } from '../../src/model/index.js';
import { startThead } from '../../src/app/index.js';
import { bootV8, CHAT, GROUP, inbound, runToQuiescent, settle, T0 } from '../mind/helpers.js';
import { bootV9 } from './helpers.js';

const decide = (bubbles: string[]) => ({
  toolCalls: [{ id: `d${bubbles.length}`, name: 'decide', args: { plan: 'reply', bubbles, confidence: 0.8, weight: 0.6, reluctance: 0.1, completeness: 1 } }],
});
const appraisal = (concerns: unknown[]) => ({ toolCalls: [{ id: 'a1', name: 'emit', args: { event: [], self: [], outcome_prev: null, concerns, importance: 4 } }] });

describe('v12 — the appraiser gives birth to questions and to agency', () => {
  it('a gap in conversation becomes her question; a loop carries what she can do herself; the same loop again is not a twin', { timeout: 60_000 }, async () => {
    const h = await bootV9();
    h.model.onTask('turn', () => decide(['wait what fish has legs']));
    let n = 0;
    h.model.onTask('appraisal', () => {
      n += 1;
      return appraisal([
        { op: 'open', what: 'what even is a tiktaalik?', kind: 'curiosity', about: 'world', knowability: 0.9, confidence: 0.15, importance: 6 },
        { op: 'open', what: 'i still need to see if the group feed reaches me', kind: 'loop', about: 'self', next_self_step: 'check my own recent messages in the group' },
      ]);
    });
    const handle = startThead(h.sys);
    h.channel.queueInbound(inbound({ text: 'you ever heard of tiktaalik? the fish that grew legs' }));
    await runToQuiescent(h);
    h.channel.queueInbound(inbound({ updateId: 501, msgId: 901, text: 'lol anyway' }));
    await runToQuiescent(h);
    expect(n).toBe(2);

    const q = h.sys.mind.openConcerns().filter((c) => c.kind === 'curiosity');
    expect(q).toHaveLength(1); // the second appraisal's same question touched it
    expect(q[0]).toMatchObject({ what: 'what even is a tiktaalik?', born: 'gap', about: 'world', knowability: 0.9, confidence: 0.15 });
    const loops = h.sys.mind.openConcerns().filter((c) => c.what.includes('group feed'));
    expect(loops).toHaveLength(1);
    expect(loops[0]!.selfStep).toBe('check my own recent messages in the group');
    await handle.stop();
  });
});

describe('v12 — her hands, for her own questions', () => {
  it('her fork works with web, memory, code and her workspace — never the tools that reach anyone, never the workshop', { timeout: 60_000 }, async () => {
    const h = await bootV9({}, { workshopCall: { start: async () => ({ ok: true }) } });
    const seen: ChatRequest[] = [];
    h.model.onTask('cast', (req) => {
      seen.push(req);
      return req.messages.some((m) => m.role === 'tool') ? { content: 'nothing much in the workspace yet' } : { toolCalls: [{ id: 'l1', name: 'ls', args: {} }] };
    });
    let result: unknown;
    const started = h.sys.body!.investigate({ id: 'q_test', system: 'You are Thea, looking into something on your own.', brief: 'what is in my workspace?' }, (r) => {
      result = r;
    });
    expect(started).toEqual({ ok: true });
    await h.sys.body!.jobs.idle();
    expect(result).toEqual({ text: 'nothing much in the workspace yet', tools: ['ls'] });
    const offered = (seen[0]!.tools ?? []).map((t) => t.name);
    for (const t of ['shell', 'read', 'write', 'grep', 'session_search', 'run_code']) expect(offered).toContain(t);
    for (const t of ['voice_note', 'react', 'selfie', 'imagine', 'poll', 'delegate', 'workshop', 'decide']) expect(offered).not.toContain(t);
    expect(h.sys.body!.jobs.list().find((j) => j.kind === 'wonder')?.status).toBe('done');
  });

  it('a whole pursuit through compose: her question → her hands → the learning judge → a thought, an interest, a follow-up', { timeout: 60_000 }, async () => {
    const h = await bootV9();
    expect(h.sys.curiosity).toBeDefined();
    h.sys.mind.upsertConcern({ id: 'q_tik', what: 'what even is a tiktaalik?', kind: 'curiosity', about: 'world', importance: 6, status: 'open', created: T0, touched: T0, source: 'lived', born: 'gap', knowability: 0.9, confidence: 0.15 });
    h.model.onTask('cast', (req) =>
      req.messages.some((m) => m.role === 'tool') ? { content: 'Tiktaalik roseae: a 375-million-year-old lobe-finned fish with a neck and wrist bones.' } : { toolCalls: [{ id: 's1', name: 'session_search', args: { words: 'tiktaalik' } }] },
    );
    h.model.onTask('appraisal', () => ({
      toolCalls: [
        {
          name: 'emit',
          args: { progress: 2, answered: true, thought: 'a fish with a neck and wrists, 375 million years ago. that is basically my grandmother', topic: 'early tetrapods', followups: [{ q: 'why did fish leave the water at all?', knowability: 0.8 }], share: false },
        },
      ],
    }));
    const out = await h.sys.curiosity!.pursue({ key: 'concern:q_tik', kind: 'wonder', about: 'world', text: 'what even is a tiktaalik?', weight: 0.7, concernId: 'q_tik' }, 'wait, a fish with legs?');
    expect(out).toBe('investigating');
    await h.sys.body!.jobs.idle();
    for (let i = 0; i < 100 && !h.sys.mind.stream().some((t) => t.itemKey === 'learned:q_tik'); i++) await settle(5);

    expect(h.sys.mind.stream().at(-1)?.text).toContain('my grandmother');
    expect(h.sys.mind.concerns().find((c) => c.id === 'q_tik')?.status).toBe('closed');
    expect(h.sys.mind.interests().map((i) => i.topic)).toEqual(['early tetrapods']);
    expect(h.sys.mind.openConcerns().some((c) => c.born === 'followup' && c.what.startsWith('why did fish leave'))).toBe(true);
    expect(h.sys.curiosity!.nowLines(T0)).toEqual(["lately you've been looking into: early tetrapods"]);
  });
});

describe('v12 — she can start a turn in the group (to ask someone), never in a chat she is not in', () => {
  it('a self-entry into the group speaks in the group; an unknown chat falls back to his DM', { timeout: 60_000 }, async () => {
    const h = await bootV8({}, { allowedChatIds: [CHAT, GROUP] });
    h.model.onTask('heartbeat-thought', (req) => (req.messages.some((m) => String(m.content).includes('wondering about A1')) ? decide(['hey A1, what do you do all day?']) : decide(['hm'])));
    h.model.onTask('appraisal', () => appraisal([]));
    const handle = startThead(h.sys);
    h.sys.pipeline.selfEntry('heartbeat', "(you've been wondering about A1. they're in the group. nobody has asked you anything.)", GROUP);
    await runToQuiescent(h);
    h.sys.pipeline.selfEntry('heartbeat', '(a thought)', -999);
    await runToQuiescent(h);
    const out = h.channel.outbound().map((s) => [s.chatId, s.text]);
    expect(out).toContainEqual([GROUP, 'hey A1, what do you do all day?']);
    expect(out).toContainEqual([CHAT, 'hm']);
    expect(out.some(([c]) => c === -999)).toBe(false);
    await handle.stop();
  });
});

// v9 answer keeper — Diego: "i always need to get a response to what i send,
// nothing lost and every message confirmed responded to." One invariant: every
// message of his ends in a visible answer (words, voice, a photo, or at the
// least a reaction), through bursts, interruptions, failures and restarts.

import { describe, expect, it } from 'vitest';
import { startThead } from '../../src/app/index.js';
import { inbound, runToQuiescent, settle } from './helpers.js';
import { bootV9 } from '../body/helpers.js';

const appraisal = { toolCalls: [{ id: 'a1', name: 'emit', args: { event: [], self: [], outcome_prev: null, concerns: [], importance: 4 } }] };
const decide = (plan: 'reply' | 'silent', bubbles: string[]) => ({ toolCalls: [{ id: 'd1', name: 'decide', args: { plan, bubbles, confidence: 0.8, weight: 0.6, reluctance: 0.1, completeness: 1 } }] });
/** Her turns, scripted in order per task (the mock's FIFO would feed them to the appraiser too). */
const says = (h: Awaited<ReturnType<typeof bootV9>>, replies: Array<ReturnType<typeof decide> | { content: string }>): void => {
  const q = [...replies];
  h.model.onTask('turn', () => q.shift() ?? { content: '' });
  h.model.onTask('appraisal', () => appraisal);
  h.model.onTask('summarize', () => ({ content: 'earlier: he pasted a long piece.' }));
};

describe('v9 answer keeper', () => {
  it('a pasted piece split into chunks is read together and answered ONCE (found live: 7 chunks, none answered)', { timeout: 60_000 }, async () => {
    const h = await bootV9();
    says(h, [decide('reply', ['read all of it. the retrocausal part is the strangest'])]);
    const handle = startThead(h.sys);
    const chunk = (i: number) => inbound({ updateId: 600 + i, msgId: 700 + i, text: `${'part '.repeat(700)}${i}` }); // ~3.5k chars, like a Telegram split
    for (let i = 0; i < 4; i++) h.channel.queueInbound(chunk(i));
    // Telegram hands the chunks over within a second; let them all land before time moves
    for (let k = 0; k < 20 && h.channel.pending() > 0; k++) await settle(10);
    await settle(400); // each arrival is a durable ledger append before it reaches her queue
    await runToQuiescent(h);
    expect(h.channel.outbound().map((s) => s.text)).toEqual(['read all of it. the retrocausal part is the strangest']);
    const turns = h.model.calls.filter((c) => c.taskClass === 'turn');
    expect(turns).toHaveLength(1);
    const user = turns[0]!.messages.filter((m) => m.role === 'user').map((m) => String(m.content)).join('\n');
    for (let i = 0; i < 4; i++) expect(user).toContain(`part ${i}`);
    await handle.stop();
  });

  it('a newer message never cancels a decided reply: both get answered', { timeout: 60_000 }, async () => {
    const h = await bootV9();
    says(h, [decide('reply', ['answer to the first']), decide('reply', ['answer to the second'])]);
    const handle = startThead(h.sys);
    h.channel.queueInbound(inbound({ updateId: 610, msgId: 710, text: 'first thing' }));
    await runToQuiescent(h);
    h.channel.queueInbound(inbound({ updateId: 611, msgId: 711, text: 'second thing' }));
    await runToQuiescent(h);
    expect(h.channel.outbound().map((s) => s.text)).toEqual(['answer to the first', 'answer to the second']);
    await handle.stop();
  });

  it('a chosen silence still leaves a mark (👀) — he always sees it was received', { timeout: 60_000 }, async () => {
    const h = await bootV9();
    says(h, [decide('silent', [])]);
    const handle = startThead(h.sys);
    h.channel.queueInbound(inbound({ updateId: 620, msgId: 720, text: 'k' }));
    await runToQuiescent(h);
    expect(h.channel.outbound()).toHaveLength(0);
    expect(h.channel.bodyActs().find((a) => a.kind === 'react')).toMatchObject({ msgId: 720, emoji: '👀' });
    await handle.stop();
  });

  it('a turn that fails outright stays owed and the keeper answers it on the next sweep', { timeout: 60_000 }, async () => {
    const h = await bootV9();
    // the voice door returns nothing, and the repair rung nothing — then, next time, words
    says(h, [{ content: '' }, { content: '' }, decide('reply', ['here. sorry, lost my words for a second'])]);
    const handle = startThead(h.sys);
    h.channel.queueInbound(inbound({ updateId: 630, msgId: 730, text: 'are you there' }));
    await runToQuiescent(h);
    expect(h.channel.outbound()).toHaveLength(0);
    await h.clock.advance(60_000);
    expect(h.sys.pipeline.sweep()).toBe(1);
    await runToQuiescent(h);
    expect(h.channel.outbound().map((s) => s.text)).toEqual(['here. sorry, lost my words for a second']);
    expect(h.sys.pipeline.sweep()).toBe(0); // answered: nothing owed
    await handle.stop();
  });

  it('after a restart, what the ledger shows unanswered is answered at boot', { timeout: 60_000 }, async () => {
    const h = await bootV9();
    says(h, [decide('reply', ['yes. reading it now'])]);
    // a message recorded by the bridge but never turned (the process died)
    await h.sys.ledger.recordInbound(inbound({ updateId: 640, msgId: 740, text: 'did you get my piece?' }));
    h.sys.pipeline.adoptOwed([inbound({ updateId: 640, msgId: 740, text: 'did you get my piece?' })]);
    const handle = startThead(h.sys);
    expect(h.sys.pipeline.sweep(0)).toBe(1);
    await runToQuiescent(h);
    expect(h.channel.outbound().map((s) => s.text)).toEqual(['yes. reading it now']);
    await handle.stop();
  });
});

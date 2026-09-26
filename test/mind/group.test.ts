// v11 (plan docs/plans/v11-a-person-in-the-world.md): she lives in a group.
// - ambient group chatter she is not addressed in → she stays quiet (recorded, not a turn).
// - addressed in the group → she replies, IN the group.
// - a new person reaching her → a line to Diego's DM ("someone new…"), then she goes ahead.
// - Diego's DM is unchanged: owed and answered.

import { describe, expect, it } from 'vitest';
import type { ChatRequest } from '../../src/model/index.js';
import { startThead } from '../../src/app/index.js';
import { bootV8, CHAT, GROUP, inbound, runToQuiescent } from './helpers.js';

const decide = (bubbles: string[]) => ({
  toolCalls: [{ id: `d${bubbles.length}`, name: 'decide', args: { plan: 'reply', bubbles, confidence: 0.8, weight: 0.6, reluctance: 0.1, completeness: 1 } }],
});
const emit = { toolCalls: [{ id: 'a1', name: 'emit', args: { event: [], self: [], outcome_prev: null, concerns: [], importance: 4 } }] };
const userText = (req: ChatRequest): string => req.messages.filter((m) => m.role === 'user').map((m) => String(m.content)).join('\n');

describe('v11 — a person in the world', () => {
  it('she reads the room: she engages an unaddressed message from anyone (and may reply)', { timeout: 60_000 }, async () => {
    const h = await bootV8({}, { allowedChatIds: [CHAT, GROUP] });
    h.model.onTask('turn', () => decide(['nah i missed it, any good?']));
    h.model.onTask('heartbeat-thought', () => decide(['someone new around']));
    h.model.onTask('appraisal', () => emit);
    const handle = startThead(h.sys);
    h.channel.queueInbound(inbound({ updateId: 700, msgId: 70, chatId: GROUP, text: 'anyone watch the game last night', speaker: { person: 'tg:555', channel: 'telegram' }, senderName: 'Sam' }));
    await runToQuiescent(h);
    expect(h.channel.outbound().some((s) => s.chatId === GROUP)).toBe(true);
    await handle.stop();
  });

  it('but she does not turn on every single line: a rapid unaddressed follow-up is let breathe', { timeout: 60_000 }, async () => {
    const h = await bootV8({}, { allowedChatIds: [CHAT, GROUP] });
    h.model.onTask('turn', () => decide(['oh?']));
    h.model.onTask('heartbeat-thought', () => decide(['hm']));
    h.model.onTask('appraisal', () => emit);
    // two unaddressed messages at the same instant (no clock advance between them):
    // the first engages her (a turn id), the second is within the ambient gap → no turn.
    const first = h.sys.pipeline.inbound(inbound({ updateId: 710, msgId: 80, chatId: GROUP, text: 'the weather is wild today', speaker: { person: 'tg:556', channel: 'telegram' }, senderName: 'Sam' }));
    const second = h.sys.pipeline.inbound(inbound({ updateId: 711, msgId: 81, chatId: GROUP, text: 'like properly wild', speaker: { person: 'tg:556', channel: 'telegram' }, senderName: 'Sam' }));
    expect(first).toBeTypeOf('string'); // she engaged the first
    expect(second).toBeUndefined(); // she let the rapid follow-up breathe (no second turn)
    await runToQuiescent(h);
    await h.sys.pipeline.drain();
  });

  it('addressed in the group by a new person → she replies in the group, and tells Diego in his DM', { timeout: 60_000 }, async () => {
    const h = await bootV8({}, { allowedChatIds: [CHAT, GROUP] });
    h.model.onTask('turn', (req) => (userText(req).includes('the game') ? decide(['ha, i missed it — who won?']) : decide(['ok'])));
    h.model.onTask('heartbeat-thought', () => decide(['hey deg, someone new (max) just said hi to me in the group']));
    h.model.onTask('appraisal', () => emit);
    const handle = startThead(h.sys);
    h.channel.queueInbound(inbound({ updateId: 701, msgId: 71, chatId: GROUP, text: 'thea, did you catch the game?', speaker: { person: 'tg:999', channel: 'telegram' }, senderName: 'Max' }));
    await runToQuiescent(h);

    const out = h.channel.outbound();
    // she replied in the GROUP
    expect(out.some((s) => s.chatId === GROUP && s.text.includes('who won'))).toBe(true);
    // and told Diego in his DM about the new person
    expect(out.some((s) => s.chatId === CHAT)).toBe(true);
    const notice = h.model.calls.find((c) => c.taskClass === 'heartbeat-thought');
    expect(userText(notice!)).toContain('someone new');
    expect(userText(notice!).toLowerCase()).toContain('max');
    await handle.stop();
  });

  it('two bots do not loop forever: after a run of exchanges with another bot she goes quiet until a human speaks', { timeout: 60_000 }, async () => {
    const h = await bootV8({}, { allowedChatIds: [CHAT, GROUP] });
    h.model.onTask('turn', () => decide(['ha']));
    h.model.onTask('heartbeat-thought', () => decide(['hm']));
    h.model.onTask('appraisal', () => emit);
    const fromBot = (updateId: number) =>
      inbound({ updateId, msgId: updateId, chatId: GROUP, text: 'thea what do you think', speaker: { person: 'tg:7777', channel: 'telegram' }, senderName: 'SisterBot', fromBot: true });
    // another bot @s her repeatedly — she answers a bounded number, then holds
    const engaged = [50, 51, 52, 53, 54, 55, 56].map((id) => h.sys.pipeline.inbound(fromBot(id)));
    const answered = engaged.filter((t) => typeof t === 'string').length;
    expect(answered).toBeGreaterThanOrEqual(1);
    expect(answered).toBeLessThanOrEqual(4); // BOT_STREAK_MAX — not an infinite ping-pong
    // a human speaking frees her to engage the bot again
    h.sys.pipeline.inbound(inbound({ updateId: 60, msgId: 60, chatId: GROUP, text: 'hey all', speaker: { person: 'tg:8888', channel: 'telegram' }, senderName: 'Real Person' }));
    expect(h.sys.pipeline.inbound(fromBot(61))).toBeTypeOf('string');
    await runToQuiescent(h);
    await h.sys.pipeline.drain();
  });

  it('a reply to a bot message in the group counts as addressed', { timeout: 60_000 }, async () => {
    const h = await bootV8({}, { allowedChatIds: [CHAT, GROUP] });
    h.model.onTask('turn', () => decide(['yep, that was me']));
    h.model.onTask('heartbeat-thought', () => decide(['someone new pinged me']));
    h.model.onTask('appraisal', () => emit);
    const handle = startThead(h.sys);
    h.channel.queueInbound(inbound({ updateId: 702, msgId: 72, chatId: GROUP, text: 'was that you?', speaker: { person: 'tg:1001', channel: 'telegram' }, senderName: 'Ada', replyTo: { msgId: 5, text: '[a message]', fromBot: true } }));
    await runToQuiescent(h);
    expect(h.channel.outbound().some((s) => s.chatId === GROUP)).toBe(true);
    await handle.stop();
  });

  it('Diego is never ignored: his un-addressed message in the group still engages her', { timeout: 60_000 }, async () => {
    const h = await bootV8({}, { allowedChatIds: [CHAT, GROUP] });
    h.model.onTask('turn', () => decide(['everyone in here can, deg']));
    h.model.onTask('appraisal', () => emit);
    const handle = startThead(h.sys);
    // his own message, in the group, not naming her — owner is never ambient
    h.channel.queueInbound(inbound({ updateId: 704, msgId: 74, chatId: GROUP, text: 'who can see this?', speaker: { person: `tg:${CHAT}`, channel: 'telegram' }, senderName: 'Diego' }));
    await runToQuiescent(h);
    expect(h.channel.outbound().some((s) => s.chatId === GROUP && s.text.includes('everyone in here'))).toBe(true);
    await handle.stop();
  });

  it("Diego's DM is unchanged: owed and answered", { timeout: 60_000 }, async () => {
    const h = await bootV8({}, { allowedChatIds: [CHAT, GROUP] });
    h.model.onTask('turn', () => decide(['hey you']));
    h.model.onTask('appraisal', () => emit);
    const handle = startThead(h.sys);
    h.channel.queueInbound(inbound({ text: 'hey', chatId: CHAT }));
    await runToQuiescent(h);
    expect(h.channel.outbound().map((s) => [s.chatId, s.text])).toEqual([[CHAT, 'hey you']]);
    await handle.stop();
  });
});

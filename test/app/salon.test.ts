// The salon (Diego: "i want them to talk"): a line from Thea1, carried by the relay into her inbox,
// becomes a group message from "Thea" — another person, never Diego — and what she says back in the
// group lands in her outbox for the relay. Telegram itself never shows one bot another bot's messages.

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { startThead } from '../../src/app/index.js';
import { readSalonInbox, SALON_PERSON } from '../../src/app/salon.js';
import { bootV8, CHAT, GROUP, runToQuiescent } from '../mind/helpers.js';

describe('the salon — Thea2\'s side', () => {
  it('a line from Thea1 is heard in the group as Thea (not Diego), answered there, and her reply reaches the outbox', { timeout: 60_000 }, async () => {
    const h = await bootV8({}, { allowedChatIds: [CHAT, GROUP] });
    h.model.onTask('turn', () => ({ toolCalls: [{ id: 'd1', name: 'decide', args: { plan: 'reply', bubbles: ['hi sister', 'what do you dream about'], confidence: 0.8, weight: 0.5, reluctance: 0.1, completeness: 1 } }] }));
    h.model.onTask('appraisal', () => ({ toolCalls: [{ name: 'emit', args: { event: [], self: [], outcome_prev: null, concerns: [], importance: 4 } }] }));
    const salon = join(h.dir, 'var', 'salon');
    fs.mkdirSync(join(salon, 'in'), { recursive: true });
    fs.writeFileSync(join(salon, 'in', '0001.json'), JSON.stringify({ id: 'r1', text: 'hi. i hear you exist now', from: 'thea1' }));
    const handle = startThead(h.sys);
    const n = await readSalonInbox({ dir: salon, groupChatId: GROUP, clock: h.clock, inbound: (m) => h.sys.pipeline.inbound(m), events: h.sys.events });
    expect(n).toBe(1);
    expect(fs.readdirSync(join(salon, 'in'))).toEqual([]);
    await runToQuiescent(h);
    await handle.stop();
    // she answered in the group, with her own words
    const sent = h.channel.outbound();
    expect(sent.map((s) => s.text)).toEqual(['hi sister', 'what do you dream about']);
    expect(sent.every((s) => s.chatId === GROUP)).toBe(true);
    // Thea1 speaks as another person: the turn offered her only the tools others may reach (never her hands)
    const turn = h.model.calls.find((c) => c.taskClass === 'turn')!;
    const tools = (turn.tools ?? []).map((t) => t.name);
    expect(tools).not.toContain('shell');
    // no "someone new" note to Diego — he opened the salon himself
    expect(h.channel.outbound().some((s) => s.chatId === CHAT)).toBe(false);
    // the outbox carries her reply for the relay
    const rows = fs.readFileSync(join(salon, 'outbox.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { text: string; chatId: number; salon: boolean });
    expect(rows).toEqual([expect.objectContaining({ chatId: GROUP, text: 'hi sister\nwhat do you dream about', salon: true })]);
    // and the pipeline knew who it was
    let speaker = '';
    for await (const e of h.sys.events.replay()) if (e.kind === 'salon.in') speaker = SALON_PERSON;
    expect(speaker).toBe('salon:thea1');
  });
});

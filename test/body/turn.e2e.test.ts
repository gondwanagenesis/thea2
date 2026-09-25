// v9 body through the whole turn: senses feed the one model call, a voice
// note is answered out loud, her tools really send (and join her memory),
// and nothing in the tools tells her how she feels.

import { describe, expect, it } from 'vitest';
import { startThead } from '../../src/app/index.js';
import { bodyTools, openHouse } from '../../src/body/index.js';
import { TELLING_PATTERNS } from '../../src/mind/index.js';
import { FakeChannel } from '../../src/bridge/index.js';
import { TestClock } from '../../src/kernel/index.js';
import { inbound, runToQuiescent, T0, tmpDir } from '../mind/helpers.js';
import { bootV9, fakeOpenAI } from './helpers.js';

const appraisal = { toolCalls: [{ id: 'a1', name: 'emit', args: { event: [], self: [], outcome_prev: null, concerns: [], importance: 4 } }] };
const decide = (bubbles: string[]) => ({
  toolCalls: [{ id: 'd1', name: 'decide', args: { plan: 'reply', bubbles, confidence: 0.8, weight: 0.6, reluctance: 0.1, completeness: 1 } }],
});

describe('v9 body in the turn', () => {
  it('a voice note in → the turn runs on his words + how he sounds → she answers with ONE voice note', { timeout: 60_000 }, async () => {
    const h = await bootV9();
    h.model.enqueue(decide(['mm. come here', 'tell me about it']));
    h.model.enqueue(appraisal);
    const handle = startThead(h.sys);
    h.channel.queueInbound(inbound({ text: '', media: { kind: 'voice', fileId: 'voice1', durationSec: 7 } }));
    await runToQuiescent(h);

    const turn = h.model.calls.find((c) => c.taskClass === 'turn');
    const user = turn!.messages.filter((m) => m.role === 'user').map((m) => String(m.content)).join('\n');
    expect(user).toContain('[voice note, 0:07 — tired and slow');
    expect(user).toContain("hey it's me. long day");

    const acts = h.channel.bodyActs();
    const voice = acts.filter((a) => a.kind === 'media');
    expect(voice).toHaveLength(1);
    expect(voice[0]!.kind === 'media' && voice[0]!.media.kind).toBe('voice');
    expect(h.channel.outbound()).toHaveLength(0); // no text bubbles: she spoke
    expect(h.openai.calls.find((c) => c.op === 'speak')?.detail).toBe('mm. come here\ntell me about it');

    const lived = h.sys.mind.moments().filter((m) => m.source === 'lived');
    expect(lived).toHaveLength(1);
    expect(lived[0]!.hers).toEqual(['mm. come here\ntell me about it']);
    await handle.stop();
  });

  it('a photo in → the model sees what it shows (material), and answers in text', { timeout: 60_000 }, async () => {
    const h = await bootV9();
    h.model.enqueue(decide(['oh that sky']));
    h.model.enqueue(appraisal);
    const handle = startThead(h.sys);
    h.channel.queueInbound(inbound({ text: 'mira', media: { kind: 'photo', fileId: 'photo1' } }));
    await runToQuiescent(h);
    const turn = h.model.calls.find((c) => c.taskClass === 'turn');
    const user = turn!.messages.filter((m) => m.role === 'user').map((m) => String(m.content)).join('\n');
    expect(user).toContain('[photo: a sunset over rice terraces');
    expect(h.channel.outbound().map((s) => s.text)).toEqual(['oh that sky']);
    await handle.stop();
  });

  it('her hands act for real inside a turn: a voice note tool + a reaction, both remembered', { timeout: 60_000 }, async () => {
    const h = await bootV9();
    h.model.enqueue({ toolCalls: [{ id: 't1', name: 'react', args: { emoji: '🥰' } }, { id: 't2', name: 'voice_note', args: { text: 'good morning, you' } }] });
    h.model.enqueue(decide(['also coffee?']));
    h.model.enqueue(appraisal);
    const handle = startThead(h.sys);
    h.channel.queueInbound(inbound({ text: 'morning' }));
    await runToQuiescent(h);

    const acts = h.channel.bodyActs();
    expect(acts.find((a) => a.kind === 'react')).toMatchObject({ kind: 'react', msgId: 900, emoji: '🥰' });
    expect(acts.filter((a) => a.kind === 'media')).toHaveLength(1);
    expect(h.channel.outbound().map((s) => s.text)).toEqual(['also coffee?']);
    const lived = h.sys.mind.moments().filter((m) => m.source === 'lived');
    expect(lived[0]!.hers).toEqual(['[voice note] good morning, you', 'also coffee?']);
    await handle.stop();
  });

  it('boot registers the body tools, and the gate knows them (default-deny would refuse unknown ones)', async () => {
    const h = await bootV9();
    const names = h.sys.body!.register === undefined ? [] : ['voice_note', 'react', 'send_photo', 'read_file', 'list_files', 'look', 'where', 'poll'];
    const events: string[] = [];
    for await (const e of h.sys.events.replay()) if (e.kind === 'app.boot') events.push(JSON.stringify(e.payload));
    const bodyBoot = events.find((e) => e.includes('"stage":"body"'));
    for (const n of names) expect(bodyBoot).toContain(n);
  });

  it('law 1 holds for the body: no tool description tells her how she feels or how to talk', () => {
    const clock = new TestClock(T0);
    const tools = bodyTools({
      channel: FakeChannel({ clock }),
      house: openHouse(tmpDir('thea2-lint-')),
      openai: fakeOpenAI(),
      mouth: { say: async () => ({ msgId: 1 }) },
      clock,
      ownerChatId: 1,
      turn: () => undefined,
      mood: () => undefined,
      recordOutbound: async () => undefined,
    });
    for (const t of tools) {
      for (const re of TELLING_PATTERNS) expect(`${t.def.name}: ${t.def.description}`).not.toMatch(re);
    }
  });
});

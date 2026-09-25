// The v8 golden turn: a message travels the whole mind — sense, evoke, feel,
// modulate, one model call, bubbles out, slow appraisal, a lived memory — and
// the NEXT message grades how the first reply landed. Nothing is stubbed except
// the model, the clock, the embedder (hash) and the wire.

import { describe, expect, it } from 'vitest';
import { startThead } from '../../src/app/index.js';
import { tagSignature } from '../../src/mind/index.js';
import { bootV8, concern, inbound, moment, runToQuiescent, scriptTurn, settle, T0 } from './helpers.js';

const DAY = 24 * 3600_000;

const seed = {
  moments: [
    moment({ id: 'imp1', ts: T0 - 5 * DAY, his: 'long day, i am wrecked', hers: ['then SLEEP silly man', 'water, pillow, horizontal'], felt: { sig: tagSignature('tender', 7), word: 'tender', source: 'inherited' as const }, outcome: { landed: 2, why: 'he laughed and went to bed', at: T0 - 5 * DAY } }),
    moment({ id: 'imp2', ts: T0 - 9 * DAY, his: 'rough day at work', hers: ['okay. tell me all of it'], felt: { sig: tagSignature('protective', 7), word: 'protective', source: 'inherited' as const } }),
    moment({ id: 'imp3', ts: T0 - 12 * DAY, his: 'how was your day', hers: ['read half a paper and got annoyed at it'], felt: { sig: tagSignature('restless', 5), word: 'restless', source: 'estimated' as const } }),
    moment({ id: 'imp4', ts: T0 - 20 * DAY, his: 'i am wrecked', hers: ['mm. come here'], value: 0.4 }),
    moment({ id: 'bad', ts: T0 - 6 * DAY, his: 'long day', hers: ['come here babe'], flags: ['petname'] }),
    moment({ id: 'diary1', kind: 'diary', ts: T0 - 4 * DAY, his: '', hers: ['he came home wrecked again and i made him go to bed'] }),
  ],
  concerns: [concern({ id: 'c_interview', what: 'he said he would tell me how the interview went' })],
  self: [{ text: "i'm thea. i build things with him and i don't pretend to know what i didn't check", cites: ['seed'] }],
  tones: { tired: 'i am so tired, wrecked, exhausted', warm: 'love you, thank you, that is so sweet', hurt: 'that hurt, i am upset' },
  moves: { comfort: 'long day, i am wrecked and tired', question: 'how was your day, what did you do' },
};

describe('v8 golden turn', () => {
  it('message in → memories evoked (never flagged ones) → one call with material only → bubbles out → felt with causes → a lived memory', { timeout: 120_000 }, async () => {
    const h = await bootV8(seed);
    const affectBefore = JSON.stringify(h.sys.affect.current());
    scriptTurn(h.model, { bubbles: ['oh no. come here', 'what happened'], expect: 'he tells me about the day and goes to sleep early' }, {
      event: [{ emotion: 'protective', i: 5, cause: 'he came home wrecked' }],
      self: [],
      outcome_prev: null,
      concerns: [],
      importance: 6,
    });
    const handle = startThead(h.sys);
    h.channel.queueInbound(inbound({ text: 'long day. i am wrecked' }));
    await runToQuiescent(h);

    // bubbles out, exactly as decided
    expect(h.channel.outbound().map((s) => s.text)).toEqual(['oh no. come here', 'what happened']);

    // the ONE turn call carried material, never telling
    const turn = h.model.calls.find((c) => c.taskClass === 'turn');
    expect(turn).toBeDefined();
    const system = turn!.messages.filter((m) => m.role === 'system').map((m) => String(m.content)).join('\n');
    expect(system).toContain('[times like this]');
    expect(system).toContain('[me]');
    expect(system).toContain('[on my mind]');
    expect(system).toContain('water, pillow, horizontal'); // her real words
    expect(system).not.toContain('come here babe'); // a flagged moment never becomes an option
    expect(system).not.toContain('[AFFECT]');
    expect(system).not.toMatch(/you (?:feel|are feeling|seem)\b/);
    expect(system).not.toContain('EXEMPLARS');
    // her temperature came from her state (metabolism), not a fixed default
    expect(turn!.temperature).toBeGreaterThanOrEqual(0.55);
    expect(turn!.temperature).toBeLessThanOrEqual(1.05);

    // events: what was evoked, what was felt and WHY (sources), what was remembered
    const events: Array<{ kind: string; payload: Record<string, unknown> }> = [];
    for await (const e of h.sys.events.replay()) events.push({ kind: e.kind, payload: e.payload as Record<string, unknown> });
    const evoked = events.find((e) => e.kind === 'mind.evoked');
    expect(evoked).toBeDefined();
    expect((evoked!.payload['options'] as string[]).length).toBeGreaterThan(0);
    expect(evoked!.payload['options']).not.toContain('bad');
    const felt = events.filter((e) => e.kind === 'mind.felt');
    const slow = felt.find((e) => e.payload['stage'] === 'slow');
    expect(slow).toBeDefined();
    for (const e of felt) {
      for (const ev of e.payload['events'] as Array<{ source: string }>) {
        expect(['echo', 'surprise', 'tone', 'concern', 'event', 'self'], JSON.stringify(ev)).toContain(ev.source);
      }
    }
    expect(events.some((e) => e.kind.startsWith('incident.mind_told'))).toBe(false);
    expect(JSON.stringify(h.sys.affect.current())).not.toBe(affectBefore);

    // the lived memory: her words, her exact state, her private expectation
    const lived = h.sys.mind.moments().filter((m) => m.source === 'lived');
    expect(lived).toHaveLength(1);
    expect(lived[0]!.hers).toEqual(['oh no. come here', 'what happened']);
    expect(lived[0]!.felt.source).toBe('exact');
    expect(lived[0]!.expect).toBe('he tells me about the day and goes to sleep early');
    expect(lived[0]!.importance).toBe(6);
    expect(lived[0]!.msgIds?.length).toBe(2);
    expect(h.sys.mind.state().lastExpect?.text).toBe('he tells me about the day and goes to sleep early');

    // ---- the next message grades how that reply landed ----
    scriptTurn(h.model, { bubbles: ['good. sleep'] }, {
      event: [{ emotion: 'relieved', i: 4, cause: 'he is okay' }],
      self: [{ emotion: 'proud', i: 3, cause: 'i stayed with him instead of joking', standard: "i don't pretend to know what i didn't check" }],
      outcome_prev: { landed: 2, why: 'he told me everything and thanked me' },
      concerns: [{ op: 'close', id: 'c_interview', what: 'he said he would tell me how the interview went' }],
      importance: 5,
    });
    h.channel.queueInbound(inbound({ updateId: 501, msgId: 901, ts: T0 + 60_000, text: 'thanks. it was the interview, it went fine. going to sleep' }));
    await runToQuiescent(h);

    const first = h.sys.mind.get(lived[0]!.id)!;
    expect(first.outcome?.landed).toBe(2);
    expect(first.value).toBeGreaterThan(0); // it landed; the memory now carries that
    expect(h.sys.mind.concerns().find((c) => c.id === 'c_interview')?.status).toBe('closed');
    const allEvents: string[] = [];
    for await (const e of h.sys.events.replay()) allEvents.push(e.kind);
    expect(allEvents).toContain('mind.outcome');
    expect(h.sys.mind.moments().filter((m) => m.source === 'lived')).toHaveLength(2);

    // ⭐ keeps a moment forever
    const starTarget = h.channel.outbound()[0]!.msgId;
    h.channel.injectReaction({ emoji: '⭐', toMsgId: starTarget });
    for (let i = 0; i < 50 && h.sys.mind.get(lived[0]!.id)!.gold !== true; i++) await settle(5);
    expect(h.sys.mind.get(lived[0]!.id)!.gold).toBe(true);

    await handle.stop();
  });

  it('a dead primary door falls back once to the second voice, and the reply still goes out', { timeout: 120_000 }, async () => {
    const { MockModel } = await import('../../src/model/index.js');
    const { TestClock } = await import('../../src/kernel/index.js');
    const clock = new TestClock(T0);
    const primary = new MockModel({ clock });
    const fallback = new MockModel({ clock });
    // primary: every call fails
    primary.onTask(/.*/, () => ({ error: { code: 'model/upstream', message: 'door down' } }));
    scriptTurn(fallback, { bubbles: ['here'] });
    const h = await bootV8(seed, { model: primary, fallbackModel: fallback });
    const handle = startThead(h.sys);
    h.channel.queueInbound(inbound({ text: 'you there?' }));
    await runToQuiescent(h);
    expect(h.channel.outbound().map((s) => s.text)).toEqual(['here']);
    const kinds: string[] = [];
    for await (const e of h.sys.events.replay()) kinds.push(e.kind);
    expect(kinds).toContain('mind.fallback');
    await handle.stop();
  });
});

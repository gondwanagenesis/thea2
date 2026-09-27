// v12.1 felt memory (Diego, 2026-09-27: "shouldn't emotions be attached to memory? isn't
// that why we have emotions, to give memories weights and see what's important?").
// Emotion does three jobs for memory — it makes a memory stick (intensity), says whether it
// was good or bad (value), and pulls up memories that match the mood. She had the last two.
//   reactions — his reaction is his signal: any emoji but 👎 = it landed and it's kept;
//               👎 = never again; in a group only HIS reactions count
//   intensity — strongly felt memories come back more readily (capped, softened by recall)
//   fading    — strongly felt memories fade slower at night
//   the night — the diary and self-rewrite lead with what she felt most, and the diary
//               carries the day's feeling instead of a blank

import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { makeHashEmbedder } from '../../src/embed/index.js';
import { TestClock } from '../../src/kernel/index.js';
import { MockModel } from '../../src/model/index.js';
import { openEventLog } from '../../src/events/index.js';
import { diaryOnce } from '../../src/body/index.js';
import { EVOKE_WEIGHTS, intensityTerm, openMindStore, sigNorm, sleepOnce, tagSignature, type Moment } from '../../src/mind/index.js';
import { addMoments, bootV8, CHAT, GROUP, inbound, moment, T0, tmpDir } from './helpers.js';

const H = 3600_000;
const DAY = 24 * H;
const blank = (): Moment['felt'] => ({ sig: new Array<number>(12).fill(0), source: 'estimated' });

describe('his reactions are his signal (any but 👎 = it landed; 👎 = never again)', () => {
  const seed = [moment({ id: 'm_r', source: 'lived', ts: T0 - DAY, msgIds: [4242], value: 0 })];
  const react = (emoji: string, over: Record<string, unknown> = {}) =>
    inbound({ updateId: 800, msgId: 0, text: '', reaction: { emoji, toMsgId: 4242 }, ...over });

  it('a heart (or any reaction that is not 👎) keeps the memory and counts as landing well', async () => {
    const h = await bootV8({ moments: seed });
    h.sys.pipeline.inbound(react('❤'));
    const m = h.sys.mind.get('m_r')!;
    expect(m.gold).toBe(true);
    expect(m.value).toBeGreaterThan(0);
    expect(m.never).not.toBe(true);
  });

  it('a laugh or a fire counts the same — he reacted, so it mattered', async () => {
    for (const emoji of ['😂', '🔥', '👍']) {
      const h = await bootV8({ moments: seed });
      h.sys.pipeline.inbound(react(emoji));
      expect(h.sys.mind.get('m_r')!.gold, emoji).toBe(true);
    }
  });

  it('👎 is the one bad sign: never again, and never kept', async () => {
    const h = await bootV8({ moments: seed });
    h.sys.pipeline.inbound(react('👎'));
    const m = h.sys.mind.get('m_r')!;
    expect(m.never).toBe(true);
    expect(m.gold).not.toBe(true);
    expect(m.value).toBeLessThan(0);
  });

  it('in a group only HIS reactions count — someone else cannot bury or crown her memory', async () => {
    const h = await bootV8({ moments: seed }, { allowedChatIds: [CHAT, GROUP] });
    h.sys.pipeline.inbound(react('👎', { chatId: GROUP, speaker: { person: 'tg:555', channel: 'telegram' } }));
    expect(h.sys.mind.get('m_r')!.never).not.toBe(true);
    h.sys.pipeline.inbound(react('❤', { updateId: 801, chatId: GROUP, speaker: { person: `tg:${CHAT}`, channel: 'telegram' } }));
    expect(h.sys.mind.get('m_r')!.gold).toBe(true);
  });
});

describe('intensity: what she felt strongly comes back more readily', () => {
  it('a strongly felt memory outweighs a mildly felt one, bounded by its weight', () => {
    const strong = moment({ felt: { sig: tagSignature('delighted', 10), word: 'delighted', source: 'exact' } });
    const mild = moment({ felt: { sig: tagSignature('content', 2), word: 'content', source: 'exact' } });
    expect(intensityTerm(strong)).toBeGreaterThan(intensityTerm(mild));
    expect(intensityTerm(strong)).toBeLessThanOrEqual(EVOKE_WEIGHTS.intensity + 1e-12);
    expect(intensityTerm(moment({ felt: blank() }))).toBe(0);
  });

  it('inherited feelings count three quarters (they are estimates, not nothing)', () => {
    const sig = tagSignature('delighted', 8);
    const exact = intensityTerm(moment({ felt: { sig, source: 'exact' } }));
    expect(intensityTerm(moment({ felt: { sig, source: 'estimated' } }))).toBeCloseTo(exact * 0.75, 9);
    expect(intensityTerm(moment({ felt: { sig, source: 'inherited' } }))).toBeCloseTo(exact * 0.75, 9);
  });

  it('against rumination: the more a memory has come up, the less its charge pulls', () => {
    const felt = { sig: tagSignature('hurt', 9), word: 'hurt', source: 'exact' as const };
    expect(intensityTerm(moment({ felt, shown: 20 }))).toBeLessThan(intensityTerm(moment({ felt, shown: 0 })) / 2);
  });
});

describe('the night: strong feelings fade slower, and the day is told by what she felt', () => {
  it('an old strongly felt memory keeps more of its value than a bland one', async () => {
    const dir = tmpDir();
    const clock = new TestClock(T0);
    const emb = makeHashEmbedder();
    const mind = openMindStore(join(dir, 'mind'), emb.dim);
    await addMoments(mind, emb, [
      moment({ id: 'intense', ts: T0 - 10 * DAY, value: 0.8, felt: { sig: tagSignature('delighted', 10), word: 'delighted', source: 'exact' } }),
      moment({ id: 'bland', ts: T0 - 10 * DAY, value: 0.8, felt: blank() }),
    ]);
    const events = openEventLog(join(dir, 'events'), { clock });
    await sleepOnce({ mind, model: new MockModel({ clock }), events, clock, timeZone: 'Europe/Madrid' });
    expect(mind.get('bland')!.value).toBeCloseTo(0.776, 3); // the old ×0.97
    expect(mind.get('intense')!.value).toBeGreaterThan(mind.get('bland')!.value);
    expect(mind.get('intense')!.value).toBeLessThan(0.8); // slower, not frozen
  });

  it("the self-rewrite sees the day's most felt moments when the day is long", async () => {
    const dir = tmpDir();
    const clock = new TestClock(T0);
    const emb = makeHashEmbedder();
    const mind = openMindStore(join(dir, 'mind'), emb.dim);
    const day = Array.from({ length: 45 }, (_, k) => moment({ id: `d${k}`, source: 'lived', ts: T0 - 20 * H + k * 60_000, hers: [`line ${k}`], felt: { sig: tagSignature('content', 2), word: 'content', source: 'exact' } }));
    // the most felt moment of the day happened early — the old "last 40" would have dropped it
    day[0] = moment({ id: 'd0', source: 'lived', ts: T0 - 20 * H, hers: ['he told me about his dad'], felt: { sig: tagSignature('moved', 10), word: 'moved', source: 'exact' } });
    await addMoments(mind, emb, day);
    await mind.setSelf([{ text: 'i build things with him', cites: ['seed'] }]);
    const model = new MockModel({ clock });
    model.onTask('consolidate', () => ({ toolCalls: [{ name: 'emit', args: { lines: [{ text: 'i build things with him', cites: ['seed'] }] } }] }));
    await sleepOnce({ mind, model, events: openEventLog(join(dir, 'events'), { clock }), clock, timeZone: 'Europe/Madrid' });
    const user = String(model.calls.find((c) => c.taskClass === 'consolidate')!.messages.at(-1)!.content);
    expect(user).toContain('he told me about his dad');
  });

  it("the diary carries the day's feeling, and each moment says how she felt then", async () => {
    const dir = tmpDir();
    const clock = new TestClock(T0);
    const emb = makeHashEmbedder();
    const mind = openMindStore(join(dir, 'mind'), emb.dim);
    await addMoments(mind, emb, [
      moment({ id: 'a', source: 'lived', ts: T0 - 5 * H, his: 'i got the job', hers: ['WAIT', 'i knew it'], felt: { sig: tagSignature('delighted', 9), word: 'delighted', source: 'exact' } }),
      moment({ id: 'b', source: 'lived', ts: T0 - 3 * H, his: 'ok night', hers: ['night degs'], felt: { sig: tagSignature('content', 2), word: 'content', source: 'exact' } }),
    ]);
    const model = new MockModel({ clock });
    model.onTask('consolidate', () => ({ toolCalls: [{ name: 'emit', args: { entry: 'he got the job today and i was loud about it' } }] }));
    expect(await diaryOnce({ mind, model, clock, events: openEventLog(join(dir, 'events'), { clock }), timeZone: 'Europe/Madrid', embedder: emb })).toBe('written');
    const user = String(model.calls[0]!.messages.at(-1)!.content);
    expect(user).toContain('you felt delighted');
    const diary = mind.moments().find((m) => m.kind === 'diary')!;
    expect(sigNorm(diary.felt.sig)).toBeGreaterThan(0.3);
    expect(diary.felt.word).toBe('delighted'); // the day leans the way she felt most
    expect(diary.felt.source).toBe('exact');
  });
});

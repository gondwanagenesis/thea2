// v9 senses: every kind of arrival becomes material the turn can run on —
// what a photo shows, his words and how he sounds, how a file opens, where he
// is — and every sense fails open into a sentence, never a dead turn.

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { TestClock } from '../../src/kernel/index.js';
import { FakeChannel, type InboundMsg } from '../../src/bridge/index.js';
import { howItSounds, makeSenses, openHouse, FILE_OPENING_CHARS } from '../../src/body/index.js';
import { CHAT, T0, tmpDir } from '../mind/helpers.js';
import { FILES, fakeExec, fakeOpenAI, whereFetch } from './helpers.js';

const setup = (opts: { files?: Record<string, Uint8Array>; fetchImpl?: typeof fetch } = {}) => {
  const clock = new TestClock(T0);
  const house = openHouse(join(tmpDir('thea2-house-'), 'house'));
  const openai = fakeOpenAI();
  const exec = fakeExec();
  const channel = FakeChannel({ clock, chatId: CHAT, files: opts.files ?? FILES });
  const senses = makeSenses({ openai, exec, house, channel, clock, fetchImpl: opts.fetchImpl ?? whereFetch });
  return { senses, house, openai, exec, clock };
};

const msg = (over: Partial<InboundMsg>): InboundMsg => ({
  updateId: 1,
  msgId: 50,
  chatId: CHAT,
  ts: T0,
  text: '',
  speaker: { person: 'diego', channel: 'telegram' },
  ...over,
});

describe('v9 senses', () => {
  it('a photo is looked at: what it shows, then his caption', async () => {
    const { senses, house, openai } = setup();
    const p = await senses.perceive(msg({ text: 'mira esto', media: { kind: 'photo', fileId: 'photo1' } }));
    expect(p.text).toBe('[photo: a sunset over rice terraces, the sky orange and pink, a scooter parked in front]\nmira esto');
    expect(p.voice).toBe(false);
    expect(p.saved).toMatch(/^incoming\/\d+-photo\.jpg$/);
    expect(fs.existsSync(house.resolve(p.saved!)!)).toBe(true);
    expect(openai.calls.map((c) => c.op)).toEqual(['vision']);
  });

  it('a voice note is heard: how he sounds, then his words — and she answers out loud', async () => {
    const { senses, openai } = setup();
    const p = await senses.perceive(msg({ media: { kind: 'voice', fileId: 'voice1', durationSec: 7 } }));
    expect(p.text).toBe("[voice note, 0:07 — tired and slow, a scooter passing in the background]\nhey it's me. long day, i'm finally home");
    expect(p.voice).toBe(true);
    expect(openai.calls.map((c) => c.op).sort()).toEqual(['listen', 'transcribe']);
  });

  it('a document is read: its size, its opening, and where the rest lives', async () => {
    const { senses, house } = setup();
    const p = await senses.perceive(msg({ text: 'read this', media: { kind: 'document', fileId: 'doc1', fileName: 'codex.txt', mime: 'text/plain' } }));
    expect(p.text).toContain('[file: codex.txt — ');
    expect(p.text).toContain('read_file "reading/');
    expect(p.text).toContain('[it opens:]\nthe codex, draft 3');
    expect(p.text.endsWith('read this')).toBe(true);
    const txt = fs.readdirSync(join(house.root, 'reading'));
    expect(txt).toHaveLength(1);
    expect(fs.readFileSync(join(house.root, 'reading', txt[0]!), 'utf8').length).toBeGreaterThan(FILE_OPENING_CHARS);
  });

  it('a pdf is read through pdftotext, pages counted', async () => {
    const { senses } = setup();
    const p = await senses.perceive(msg({ media: { kind: 'document', fileId: 'pdf1', fileName: 'codex.pdf', mime: 'application/pdf' } }));
    expect(p.text).toContain('[file: codex.pdf — 2 pages, ');
    expect(p.text).toContain('Chapter one');
  });

  it('a shared location becomes where he is: place, his local time, the sky — and is kept', async () => {
    const { senses, house } = setup();
    const p = await senses.perceive(msg({ media: { kind: 'location', lat: -8.5069, lon: 115.2625, live: false } }));
    expect(p.text).toMatch(/^\[he shared his location: Ubud, Bali, Indonesia — \d\d:\d\d there, 27°, light rain\]$/);
    expect(house.readJson<{ place: string }>('where.json', { place: '' }).place).toBe('Ubud, Bali, Indonesia');
  });

  it('a live-location ping updates where he is without a turn', async () => {
    const { senses, house } = setup();
    const w = await senses.whereUpdate(msg({ skipped: { reason: 'live_location' }, media: { kind: 'location', lat: -8.5, lon: 115.26, live: true } }));
    expect(w?.place).toBe('Ubud, Bali, Indonesia');
    expect(house.readJson<{ live: boolean }>('where.json', { live: false }).live).toBe(true);
  });

  it('a video is watched (stills) and listened to (its sound)', async () => {
    const { senses, openai } = setup();
    const p = await senses.perceive(msg({ media: { kind: 'video', fileId: 'video1', durationSec: 12 } }));
    expect(p.text).toMatch(/^\[video, 0:12: a sunset over rice terraces.* — he says: "hey it's me/);
    expect(openai.calls.find((c) => c.op === 'vision')?.detail).toMatch(/^3 image\(s\)/);
  });

  it('a sticker says its emoji; replies and edits carry what they answer', async () => {
    const { senses } = setup();
    expect((await senses.perceive(msg({ media: { kind: 'sticker', fileId: 's', emoji: '😭', animated: false } }))).text).toBe('[sticker 😭]');
    const r = await senses.perceive(msg({ text: 'this', replyTo: { msgId: 40, text: 'what should we cook', fromBot: true } }));
    expect(r.text).toBe('(replying to your message: «what should we cook»)\nthis');
    const e = await senses.perceive(msg({ text: 'wait, three am', edited: true }));
    expect(e.text).toBe('(he edited his earlier message; it now says:)\nwait, three am');
  });

  it('fails open: a photo that will not download is a sentence, not a dead turn', async () => {
    const { senses } = setup({ files: {} });
    const p = await senses.perceive(msg({ media: { kind: 'photo', fileId: 'missing' } }));
    expect(p.text).toBe("[he sent a photo — it didn't come through: it failed to load]");
    expect(p.trace[0]?.ok).toBe(false);
  });
});

describe('how he sounds', () => {
  it('a listener that answers in JSON still gives a phrase; empty backgrounds are dropped', () => {
    expect(howItSounds('{"tone": "warm and relaxed", "energy": "low-key", "pace": "steady", "background": "no noticeable noise"}')).toBe('warm and relaxed, low-key energy, steady pace');
    expect(howItSounds('tired and quiet, traffic behind him.')).toBe('tired and quiet, traffic behind him');
  });
});

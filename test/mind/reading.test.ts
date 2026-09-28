// v14 Phase 2.2 — her long read: a book she picks, a chapter a day, her own take on it.
import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { initialAffectState, type AffectStore, type EmotionEventInput } from '../../src/affect/index.js';
import { makeHashEmbedder } from '../../src/embed/index.js';
import type { EventLog } from '../../src/events/index.js';
import { makeRng, TestClock } from '../../src/kernel/index.js';
import { MockModel } from '../../src/model/index.js';
import { librarySeam, openHouse, splitChapters, stripGutenberg } from '../../src/body/index.js';
import { makeReading, openMindStore, READ_GAP_MS } from '../../src/mind/index.js';
import { T0, tmpDir } from './helpers.js';

const para = (n: number, w = 'sea'): string => Array.from({ length: n }, (_, i) => `${w}${i}`).join(' ');
const BOOK = [
  'The Project Gutenberg eBook of Moby-Dick',
  '*** START OF THE PROJECT GUTENBERG EBOOK MOBY-DICK ***',
  'CONTENTS',
  'CHAPTER 1. Loomings.',
  'CHAPTER 2. The Carpet-Bag.',
  'CHAPTER 3. The Spouter-Inn.',
  '',
  'CHAPTER 1. Loomings.',
  '',
  `Call me Ishmael. ${para(600)}`,
  '',
  'CHAPTER 2. The Carpet-Bag.',
  '',
  para(500, 'bag'),
  '',
  'CHAPTER 3. The Spouter-Inn.',
  '',
  `${para(2500, 'inn')}\n\n${para(2500, 'inn2')}`,
  '',
  'CHAPTER 4. The Counterpane.',
  '',
  para(400, 'quilt'),
  '',
  'CHAPTER 5. Breakfast.',
  '',
  para(400, 'eggs'),
  '*** END OF THE PROJECT GUTENBERG EBOOK MOBY-DICK ***',
  'licence text',
].join('\n');
const gutenberg = (async () => new Response(BOOK, { status: 200 })) as unknown as typeof fetch;

describe('her library', () => {
  it('the book without its licence wrapper, cut where a reader meets chapters (a contents list joins the first; a long chapter is cut at a paragraph)', () => {
    const text = stripGutenberg(BOOK);
    expect(text.startsWith('CONTENTS')).toBe(true);
    expect(text).not.toContain('licence text');
    const ch = splitChapters(text);
    expect(ch[0]).toContain('Call me Ishmael');
    expect(ch[0]).toContain('CONTENTS'); // the contents list is not a chapter of its own
    expect(ch.some((c) => c.includes('inn0') && !c.includes('inn20'))).toBe(false);
    expect(ch.length).toBeGreaterThanOrEqual(6); // the long chapter 3 became two
    expect(splitChapters(Array.from({ length: 60 }, (_, i) => para(100, `p${i}w`)).join('\n\n')).length).toBe(3); // no headings: parts of ~2,500 words
  });

  it('start downloads and shelves it, chapter n reads, advance moves on and the last one finishes the book', async () => {
    const house = openHouse(join(tmpDir('thea2-lib-'), 'house'));
    const lib = librarySeam(house, gutenberg);
    const r = (await lib.start(2701, T0, 'the sea, obviously'))!;
    expect(r).toMatchObject({ title: 'Moby-Dick', next: 0, why: 'the sea, obviously' });
    expect(lib.chapter(0)).toContain('Call me Ishmael');
    for (let i = 0; i < r.chapters - 1; i++) lib.advance(T0 + i);
    expect(lib.current()!.next).toBe(r.chapters - 1);
    expect(lib.advance(T0 + 99)).toBeUndefined();
    expect(lib.current()).toBeUndefined();
    expect(lib.finished().map((f) => f.title)).toEqual(['Moby-Dick']);
    expect(lib.shelf().map((b) => b.id)).not.toContain(2701);
  });
});

describe('her long read', () => {
  const rig = () => {
    const clock = new TestClock(T0);
    const emb = makeHashEmbedder();
    const mind = openMindStore(join(tmpDir('thea2-read-'), 'mind'), emb.dim);
    const model = new MockModel({ clock });
    model.onTask('appraisal', (req) =>
      req.schemaName === 'ChooseBook'
        ? { toolCalls: [{ name: 'emit', args: { id: 2701, why: 'the sea, obviously' } }] }
        : { toolCalls: [{ name: 'emit', args: { thought: 'ishmael goes to sea instead of knocking hats off people. same, honestly', line: 'Call me Ishmael.', feeling: 'amused', topic: 'the sea and obsession' } }] },
    );
    const state = initialAffectState(T0);
    const felt: EmotionEventInput[] = [];
    const affect = { current: () => state, applyEvents: async (evs: EmotionEventInput[]) => void felt.push(...evs) } as unknown as AffectStore;
    const events: Array<{ kind: string; p: Record<string, unknown> }> = [];
    const log = { emit: async (kind: string, p: unknown) => void events.push({ kind, p: p as Record<string, unknown> }), replay: async function* () {} } as unknown as EventLog;
    const reading = makeReading({ mind, affect, model, embedder: emb, events: log, clock, rng: makeRng('r'), reading: librarySeam(openHouse(join(tmpDir('thea2-read-h-'), 'house')), gutenberg) });
    return { reading, mind, state, felt, events, clock };
  };

  it('with nothing on the nightstand she picks off the shelf herself; then a chapter a day, her own take, the line she liked (only if it is really there), the feeling it left, an interest', async () => {
    const r = rig();
    expect(r.reading.candidate(r.state, T0)).toMatchObject({ key: 'reading:choose', kind: 'reading' });
    expect(await r.reading.read(T0)).toEqual({ chose: 'Moby-Dick' });
    expect(r.mind.stream().at(-1)!.text).toBe('picked a new book: Moby-Dick. the sea, obviously');
    const c = r.reading.candidate(r.state, T0 + 60_000)!;
    expect(c.text).toMatch(/your book, Moby-Dick by Herman Melville: chapter 1 of \d+ is next/);
    expect(await r.reading.read(T0 + 60_000)).toEqual({ read: { title: 'Moby-Dick', chapter: 1 } });
    expect(r.mind.stream().at(-1)!.text).toBe('Moby-Dick, chapter 1: ishmael goes to sea instead of knocking hats off people. same, honestly ("Call me Ishmael.")');
    expect(r.mind.moments().some((m) => m.hers[0]!.startsWith('Moby-Dick, chapter 1'))).toBe(true);
    expect(r.felt.map((f) => f.tag)).toContain('amused');
    expect(r.mind.interests().map((i) => i.topic)).toContain('the sea and obsession');
    // a chapter a day
    expect(r.reading.candidate(r.state, T0 + 2 * 3600_000)).toBeUndefined();
    expect(r.reading.candidate(r.state, T0 + 60_000 + READ_GAP_MS + 1)?.text).toMatch(/chapter 2 of/);
    expect(r.reading.nowLines(T0 + 3600_000)).toEqual([expect.stringMatching(/^your book: Moby-Dick, 1 of \d+ chapters read$/)]);
  });
});

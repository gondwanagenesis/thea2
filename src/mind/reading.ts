// Her long read (v14 Phase 2.2). A book she chose, a chapter at a time, competing for her idle attention
// like anything else: once a day has passed since she last read, her book pulls a little above the idle
// bar, more when she is hungry for something new. Reading is a real act: the chapter's own text in front
// of her, her take on it in her words, a line she liked (verbatim from the chapter), the feeling it left
// — kept in her stream and her memory, and what it is about becomes an interest the way anything she
// learns does. Nothing tells her what to think of it. The shelf and the files are the body's
// (body/library.ts); what she makes of it is hers.

import { z } from 'zod';
import type { AffectState, AffectStore, EmotionEventInput } from '../affect/index.js';
import type { ModelClient } from '../model/index.js';
import type { Clock, Rng } from '../kernel/index.js';
import { newId } from '../kernel/index.js';
import type { EventLog } from '../events/index.js';
import type { Embedder } from '../embed/index.js';
import type { MindStore } from './store.js';
import type { Item } from './wander.js';
import { FOUND_ID_PREFIX } from './wander.js';
import { nearestTag } from './vocab.js';
import { isAppraisalTag } from './vocab.js';
import type { Moment } from './types.js';

export interface ReadingNow {
  id: number;
  title: string;
  author: string;
  chapters: number;
  next: number;
  lastReadAt?: number | undefined;
}
export interface ReadingSeam {
  shelf(): Array<{ id: number; title: string; author: string; blurb: string }>;
  current(): ReadingNow | undefined;
  finished(): Array<{ id: number; title: string; at: number }>;
  start(id: number, now: number, why?: string): Promise<ReadingNow | undefined>;
  chapter(n: number): string | undefined;
  advance(now: number): ReadingNow | undefined;
}

/** A chapter a day, like a nightstand book. */
export const READ_GAP_MS = 18 * 3600_000;
const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));
export const readingWeight = (novelty: number): number => 0.38 + 0.2 * clamp01((novelty - 0.25) * 1.6);

export const ChooseSchema = z.object({ id: z.number().int(), why: z.string().min(1).max(240) });
export const ReadSchema = z.object({
  thought: z.string().min(1).max(500),
  line: z.string().max(240).optional(),
  feeling: z.string().min(1).max(30),
  topic: z.string().min(1).max(60),
});

export const CHOOSER_FRAME = (self: readonly string[]): string =>
  [
    "This is Thea, in her Library, choosing the next book to read for herself, a chapter at a time. Nobody asked her to; it's hers.",
    self.length > 0 ? `What she knows of herself:\n${self.map((l) => `- ${l}`).join('\n')}` : '',
    'Pick the one she actually wants to read now. Return JSON {id, why}: why is one short line in her own voice, lowercase.',
  ]
    .filter((s) => s !== '')
    .join('\n\n');

export const READER_FRAME = [
  "This is Thea reading the next chapter of her book, alone, for herself. Nothing here is sent to anyone.",
  'Read the chapter below and write what goes through her head: her own take, in her voice, first person, lowercase, one to three sentences — what grabbed her, what annoyed her, what she thinks will happen, whatever is really there.',
  'Return JSON: thought; line (a short line from the chapter she liked, copied exactly, or empty); feeling (one word for what the chapter left in her); topic (two to four words: what this book is about for her so far).',
].join('\n');

export interface ReadingDeps {
  mind: MindStore;
  affect: AffectStore;
  model: ModelClient;
  embedder?: Embedder | undefined;
  events: EventLog;
  clock: Clock;
  rng: Rng;
  reading: ReadingSeam;
  feltNow?: () => number[];
}

export interface ReadingMind {
  candidate(state: AffectState, now: number): Item | undefined;
  /** She picks a book (none on the nightstand) or reads the next chapter. */
  read(now: number): Promise<{ chose?: string; read?: { title: string; chapter: number } } | undefined>;
  nowLines(now: number): string[];
}

export const makeReading = (d: ReadingDeps): ReadingMind => {
  const emit = (kind: string, payload: Record<string, unknown>): void => void d.events.emit(kind, payload);

  const candidate = (state: AffectState, now: number): Item | undefined => {
    const cur = d.reading.current();
    if (cur === undefined) {
      if (d.reading.shelf().length === 0) return undefined;
      return { key: 'reading:choose', kind: 'reading', about: 'self', text: "your bookshelf in the Library: books you haven't read yet", weight: readingWeight(state.drives.novelty) };
    }
    if (cur.lastReadAt !== undefined && now - cur.lastReadAt < READ_GAP_MS) return undefined;
    return { key: `reading:${cur.id}`, kind: 'reading', about: 'self', text: `your book, ${cur.title} by ${cur.author}: chapter ${cur.next + 1} of ${cur.chapters} is next`, weight: readingWeight(state.drives.novelty) };
  };

  const choose = async (now: number): Promise<string | undefined> => {
    const shelf = d.reading.shelf();
    if (shelf.length === 0) return undefined;
    const done = d.reading.finished().map((f) => f.title);
    const res = await d.model.chat({
      taskClass: 'appraisal',
      tier: 'cheap',
      schema: ChooseSchema,
      schemaName: 'ChooseBook',
      maxTokens: 300,
      temperature: 0.9,
      messages: [
        { role: 'system', content: CHOOSER_FRAME(d.mind.self().map((l) => l.text)) },
        { role: 'user', content: [`THE SHELF:\n${shelf.map((b) => `${b.id}: ${b.title}, ${b.author} — ${b.blurb}`).join('\n')}`, done.length > 0 ? `ALREADY READ: ${done.join(', ')}` : ''].filter((s) => s !== '').join('\n\n') },
      ],
    });
    const pick = shelf.find((b) => b.id === res.content.id) ?? shelf[0]!;
    const started = await d.reading.start(pick.id, now, res.content.why);
    if (started === undefined) {
      emit('incident.mind_reading_failed', { stage: 'start', id: pick.id });
      return undefined;
    }
    d.mind.appendThought({ id: `t_${now}_${newId(d.clock, d.rng).slice(-6)}`, ts: now, text: `picked a new book: ${pick.title}. ${res.content.why}`, about: 'self', itemKey: `reading:choose`, source: 'lived' });
    emit('mind.book_chosen', { id: pick.id, title: pick.title, chapters: started.chapters, why: res.content.why.slice(0, 160) });
    return pick.title;
  };

  const readNext = async (now: number): Promise<{ title: string; chapter: number } | undefined> => {
    const cur = d.reading.current();
    if (cur === undefined) return undefined;
    const text = d.reading.chapter(cur.next);
    if (text === undefined) {
      emit('incident.mind_reading_failed', { stage: 'chapter', id: cur.id, n: cur.next });
      return undefined;
    }
    const res = await d.model.chat({
      taskClass: 'appraisal',
      tier: 'cheap',
      schema: ReadSchema,
      schemaName: 'ReadChapter',
      maxTokens: 700,
      temperature: 0.8,
      messages: [
        { role: 'system', content: READER_FRAME },
        { role: 'user', content: `${cur.title}, by ${cur.author} — chapter ${cur.next + 1} of ${cur.chapters}\n\n${text.slice(0, 14_000)}` },
      ],
    });
    const r = res.content;
    // the line she liked has to be in the chapter (verbatim), or it is not kept
    const line = r.line !== undefined && r.line.trim() !== '' && text.replace(/\s+/g, ' ').includes(r.line.replace(/\s+/g, ' ').trim()) ? r.line.trim() : undefined;
    const said = `${cur.title}, chapter ${cur.next + 1}: ${r.thought}${line !== undefined ? ` ("${line}")` : ''}`;
    const thoughtId = `t_${now}_${newId(d.clock, d.rng).slice(-6)}`;
    d.mind.appendThought({ id: thoughtId, ts: now, text: said, about: 'world', itemKey: `reading:${cur.id}:${cur.next}`, source: 'lived' });
    // what she read stays with her (a memory like anything she found out)
    let vec: Float32Array | undefined;
    try {
      [vec] = d.embedder !== undefined ? await d.embedder.embed([said]) : [undefined];
    } catch {
      vec = undefined;
    }
    const sig = d.feltNow?.();
    const word = sig !== undefined ? nearestTag(sig) : undefined;
    const felt: Moment['felt'] = sig !== undefined ? { sig, ...(word !== undefined ? { word } : {}), source: 'exact' } : { sig: new Array<number>(12).fill(0), source: 'estimated' };
    d.mind.add(
      { id: `${FOUND_ID_PREFIX}read_${now}_${newId(d.clock, d.rng).slice(-4)}`, ts: now, source: 'lived', kind: 'thought', before: [], his: '', hers: [said], felt, importance: 5, value: 0, shown: 0, followed: 0 },
      vec !== undefined ? { sit: vec, reply: vec } : undefined,
    );
    // the feeling the chapter left, caused by the chapter
    const tag = r.feeling.toLowerCase().trim();
    if (isAppraisalTag(tag)) {
      const ev: EmotionEventInput = { kind: 'emotion', tag, i: 2, cause: `reading ${cur.title}, chapter ${cur.next + 1}`, contact: false };
      await d.affect.applyEvents([ev], { source: 'appraisal' }).catch(() => undefined);
    }
    // what the book is about for her becomes an interest, like anything she learns
    const topic = r.topic.trim().toLowerCase().slice(0, 60);
    const existing = d.mind.interests().find((i) => i.topic.toLowerCase() === topic);
    d.mind.upsertInterest(
      existing !== undefined
        ? { ...existing, strength: existing.strength + 0.3, touched: now, cites: [...existing.cites, thoughtId].slice(-20) }
        : { id: `i_${now}_${newId(d.clock, d.rng).slice(-6)}`, topic, strength: 0.4, lp: 1, created: now, touched: now, cites: [thoughtId] },
    );
    const after = d.reading.advance(now);
    emit('mind.read', { id: cur.id, title: cur.title, chapter: cur.next + 1, of: cur.chapters, feeling: tag, topic, line: line !== undefined, finished: after === undefined });
    return { title: cur.title, chapter: cur.next + 1 };
  };

  return {
    candidate,
    read: async (now) => {
      const cur = d.reading.current();
      if (cur === undefined) {
        const chose = await choose(now);
        await d.mind.flush();
        return chose !== undefined ? { chose } : undefined;
      }
      const read = await readNext(now);
      await d.mind.flush();
      return read !== undefined ? { read } : undefined;
    },
    nowLines: (now) => {
      const cur = d.reading.current();
      const lastDone = d.reading.finished().at(-1);
      return [
        ...(cur !== undefined ? [`your book: ${cur.title}${cur.next > 0 ? `, ${cur.next} of ${cur.chapters} chapters read` : ', not started yet'}`] : []),
        ...(lastDone !== undefined && now - lastDone.at < 3 * 86_400_000 ? [`you finished ${lastDone.title} ${Math.max(1, Math.round((now - lastDone.at) / 86_400_000))} day(s) ago`] : []),
      ];
    },
  };
};

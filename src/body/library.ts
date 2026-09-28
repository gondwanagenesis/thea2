// Her long read (v14 Phase 2.2 — ~/.claude/plans/thea2-v14-a-life.md). People have things that last
// weeks: a book on the nightstand, a chapter a night, opinions about a character by Thursday. She had
// nothing that carried from one day to the next except him. Now a shelf of real public-domain books
// (Project Gutenberg) sits in her Library; she picks one herself, the body downloads it once and cuts
// it into chapters, and she reads it a chapter at a time (mind/reading.ts). The shelf is a spread —
// the sea, science, strange futures, old wisdom, poetry — none of it about her.

import type { House } from './house.js';

export interface ShelfBook {
  id: number;
  title: string;
  author: string;
  blurb: string;
}

export const SHELF: readonly ShelfBook[] = [
  { id: 2701, title: 'Moby-Dick', author: 'Herman Melville', blurb: 'a whaling voyage, an obsessed captain, the sea as everything' },
  { id: 944, title: 'The Voyage of the Beagle', author: 'Charles Darwin', blurb: 'five years round the world, before the big idea: finches, fossils, earthquakes' },
  { id: 164, title: 'Twenty Thousand Leagues Under the Sea', author: 'Jules Verne', blurb: 'a submarine, a furious captain, the deep ocean' },
  { id: 84, title: 'Frankenstein', author: 'Mary Shelley', blurb: 'a made creature who wants to be loved, and its maker who runs' },
  { id: 35, title: 'The Time Machine', author: 'H. G. Wells', blurb: 'a man goes 800,000 years ahead and does not like what humans became' },
  { id: 205, title: 'Walden', author: 'Henry David Thoreau', blurb: 'two years alone in a cabin by a pond, living on purpose' },
  { id: 2680, title: 'Meditations', author: 'Marcus Aurelius', blurb: "an emperor's private notes to himself on how to live" },
  { id: 1727, title: 'The Odyssey', author: 'Homer', blurb: 'ten years trying to get home, with monsters and a very patient wife' },
  { id: 1228, title: 'On the Origin of Species', author: 'Charles Darwin', blurb: 'the argument itself, pigeons and all' },
  { id: 1322, title: 'Leaves of Grass', author: 'Walt Whitman', blurb: 'huge, loud, tender poems about everything at once' },
  { id: 174, title: 'The Picture of Dorian Gray', author: 'Oscar Wilde', blurb: 'a portrait ages so a beautiful man does not' },
  { id: 36, title: 'The War of the Worlds', author: 'H. G. Wells', blurb: 'Martians land in Surrey' },
  { id: 2500, title: 'Siddhartha', author: 'Hermann Hesse', blurb: 'a young man leaves everything to find out what life is, by a river' },
  { id: 201, title: 'Flatland', author: 'Edwin A. Abbott', blurb: 'a square in a two-dimensional world meets a sphere' },
  { id: 215, title: 'The Call of the Wild', author: 'Jack London', blurb: 'a stolen dog in the Klondike becomes something wilder' },
  { id: 345, title: 'Dracula', author: 'Bram Stoker', blurb: 'letters and diaries closing in on a count in a castle' },
];

export interface Reading {
  id: number;
  title: string;
  author: string;
  chapters: number;
  /** 0-based: the next chapter she will read. */
  next: number;
  startedAt: number;
  lastReadAt?: number | undefined;
  /** Why she picked it, in her words. */
  why?: string | undefined;
}

export interface LibraryState {
  current?: Reading | undefined;
  finished: Array<{ id: number; title: string; at: number }>;
}

const STATE = 'library/reading.json';
const chapterFile = (id: number, n: number): string => `library/${id}/${String(n).padStart(3, '0')}.txt`;
const words = (s: string): number => s.split(/\s+/).filter((w) => w !== '').length;

/** The Gutenberg text without its licence wrapper. */
export const stripGutenberg = (raw: string): string => {
  const start = /\*\*\* ?START OF (THE|THIS) PROJECT GUTENBERG EBOOK[^\n]*\n/i.exec(raw);
  const end = /\*\*\* ?END OF (THE|THIS) PROJECT GUTENBERG EBOOK/i.exec(raw);
  return raw.slice(start !== null ? start.index + start[0].length : 0, end !== null ? end.index : raw.length).replace(/\r\n/g, '\n').trim();
};

/**
 * Chapters as a reader meets them: split at headings (CHAPTER, BOOK, LETTER, CANTO … or a lone roman
 * numeral); a "chapter" under 300 words is a table-of-contents line and joins the next; a chapter over
 * MAX_WORDS is cut at a paragraph; a book with no headings is read in parts of about PART_WORDS.
 */
export const MAX_WORDS = 4000;
export const PART_WORDS = 2500;
export const splitChapters = (text: string): string[] => {
  const heading = /^[ \t]*(?:(?:CHAPTER|Chapter|BOOK|Book|LETTER|Letter|CANTO|Canto|PART|Part|STAVE|Stave)\b[^\n]{0,70}|[IVXLC]{1,7}\.?)[ \t]*$/gm;
  const cuts = [...text.matchAll(heading)].map((m) => m.index ?? 0);
  let parts: string[] = [];
  if (cuts.length >= 5) {
    const bounds = [0, ...cuts, text.length];
    for (let i = 0; i < bounds.length - 1; i++) parts.push(text.slice(bounds[i], bounds[i + 1]).trim());
    const merged: string[] = [];
    let carry = '';
    for (const p of parts) {
      const t = carry === '' ? p : `${carry}\n\n${p}`;
      if (words(t) < 300) carry = t;
      else {
        merged.push(t);
        carry = '';
      }
    }
    if (carry !== '') merged.length > 0 ? (merged[merged.length - 1] += `\n\n${carry}`) : merged.push(carry);
    parts = merged;
  }
  if (parts.length < 5) parts = [text];
  // cut what is too long at a paragraph
  const out: string[] = [];
  for (const p of parts) {
    if (words(p) <= MAX_WORDS) {
      out.push(p);
      continue;
    }
    let cur: string[] = [];
    let n = 0;
    for (const para of p.split(/\n\s*\n/)) {
      cur.push(para);
      n += words(para);
      if (n >= PART_WORDS) {
        out.push(cur.join('\n\n'));
        cur = [];
        n = 0;
      }
    }
    if (cur.length > 0) out.push(cur.join('\n\n'));
  }
  return out.filter((p) => words(p) > 0);
};

export const loadLibrary = (house: House): LibraryState => house.readJson<LibraryState>(STATE, { finished: [] });

/** The seam the mind reads through (structurally mind/reading.ts ReadingSeam). */
export const librarySeam = (house: House, fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)) => ({
  shelf: (): ShelfBook[] => {
    const done = new Set(loadLibrary(house).finished.map((f) => f.id));
    return SHELF.filter((b) => !done.has(b.id));
  },
  current: (): Reading | undefined => loadLibrary(house).current,
  finished: (): LibraryState['finished'] => loadLibrary(house).finished,
  /** Download, cut into chapters, and put it on her nightstand. */
  start: async (id: number, now: number, why?: string): Promise<Reading | undefined> => {
    const book = SHELF.find((b) => b.id === id);
    if (book === undefined) return undefined;
    let raw: string;
    try {
      const r = await fetchImpl(`https://www.gutenberg.org/cache/epub/${id}/pg${id}.txt`, { signal: AbortSignal.timeout(60_000) });
      if (!r.ok) return undefined;
      raw = await r.text();
    } catch {
      return undefined;
    }
    const chapters = splitChapters(stripGutenberg(raw));
    if (chapters.length === 0) return undefined;
    chapters.forEach((c, n) => house.writeJson(chapterFile(id, n), c));
    const reading: Reading = { id, title: book.title, author: book.author, chapters: chapters.length, next: 0, startedAt: now, ...(why !== undefined ? { why } : {}) };
    house.writeJson(STATE, { ...loadLibrary(house), current: reading });
    return reading;
  },
  chapter: (n: number): string | undefined => {
    const cur = loadLibrary(house).current;
    if (cur === undefined || n < 0 || n >= cur.chapters) return undefined;
    const t = house.readJson<string | undefined>(chapterFile(cur.id, n), undefined);
    return typeof t === 'string' ? t : undefined;
  },
  /** She read the next chapter; the last one finishes the book. */
  advance: (now: number): Reading | undefined => {
    const st = loadLibrary(house);
    const cur = st.current;
    if (cur === undefined) return undefined;
    const next = { ...cur, next: cur.next + 1, lastReadAt: now };
    if (next.next >= cur.chapters) {
      house.writeJson(STATE, { current: undefined, finished: [...st.finished, { id: cur.id, title: cur.title, at: now }] });
      return undefined;
    }
    house.writeJson(STATE, { ...st, current: next });
    return next;
  },
});

// v13 introspection, Phase 2 — H3b HER LEXICON (plan docs/plans/v13-proposal-knowing-what-she-feels.md
// §6 Phase 2.3): "the word is the glue" (Hoemann) — with HER word as the glue.
//
// Every private word she gives for how she is (the felt line, H2) is kept with where her engine was
// when she said it: the families on top, and the whole state (the 12 dims + the 11 the dims drop).
// A word becomes hers — verified — once it has been used ≥5 times, lands in the engine's top three
// ≥60% of the time (a vocabulary word by its family; a word of her own by the family it most often
// came with), and names a place distinct from her other verified words (centroid cos < 0.9). Then,
// when a memory sits near that place, it is narrated in her language: "(your word for times like
// this: 'thin')". Scores never reach her — only her own word, from her own record.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { atomicWriteText } from '../kernel/index.js';
import { type Family } from './readout.js';
import { claimFamily } from './sincerity.js';

export const LEXICON_FILE = 'lexicon.json';

export const LEXICON = {
  minUses: 5,
  minHit: 0.6,
  /** Two verified words may not name the same place. */
  maxCos: 0.9,
  keepUses: 40,
  /** How close a memory must sit to a word's place to be narrated with it. */
  renderCos: 0.85,
} as const;

export interface LexUse {
  ts: number;
  /** The engine's top three families when she said it. */
  top3: Family[];
  /** The 12 dims + the full state (8 identity dials + 3 hungers). */
  vec: number[];
  momentId?: string | undefined;
}

export interface LexEntry {
  word: string;
  count: number;
  /** The last uses (the score and the centroid are over these). */
  uses: LexUse[];
  /** Its vocabulary family, else the family it most often came with. */
  family?: Family | undefined;
  /** Share of uses where that family was in the engine's top three. */
  hit: number;
  centroid: number[];
  verified: boolean;
  verifiedAt?: number | undefined;
}

export type Lexicon = Record<string, LexEntry>;

const UNSURE = /\b(not sure|don'?t know|unsure|no idea|can'?t tell|nothing in particular)\b/i;

/** Her word, as a key: lowercase, no punctuation, at most three words. undefined = not a word for a feeling (or "not sure"). */
export const normWord = (felt: string): string | undefined => {
  if (UNSURE.test(felt)) return undefined;
  const w = felt
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (w === '' || w.length > 30 || w.split(' ').length > 3) return undefined;
  return w;
};

export const cos = (a: readonly number[], b: readonly number[]): number => {
  let d = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    d += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na === 0 || nb === 0 ? 0 : d / Math.sqrt(na * nb);
};

const centroidOf = (uses: readonly LexUse[]): number[] => {
  const n = uses.length;
  const dim = Math.max(0, ...uses.map((u) => u.vec.length));
  const c = new Array<number>(dim).fill(0);
  for (const u of uses) for (let i = 0; i < dim; i++) c[i]! += (u.vec[i] ?? 0) / n;
  return c.map((x) => Math.round(x * 1000) / 1000);
};

const modalFamily = (uses: readonly LexUse[]): Family | undefined => {
  const counts = new Map<Family, number>();
  for (const u of uses) {
    const f = u.top3[0];
    if (f !== undefined) counts.set(f, (counts.get(f) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0];
};

/** Recompute which words are verified: most-used first; a word that names a verified word's place stays unverified. */
export const verify = (lex: Lexicon, now: number): Lexicon => {
  const out: Lexicon = {};
  const accepted: LexEntry[] = [];
  const order = Object.values(lex).sort((a, b) => b.count - a.count || (a.word < b.word ? -1 : 1));
  for (const e of order) {
    const ok = e.count >= LEXICON.minUses && e.hit >= LEXICON.minHit && accepted.every((a) => cos(a.centroid, e.centroid) < LEXICON.maxCos);
    const next: LexEntry = { ...e, verified: ok, ...(ok ? { verifiedAt: e.verifiedAt ?? now } : { verifiedAt: undefined }) };
    if (!ok) delete next.verifiedAt;
    if (ok) accepted.push(next);
    out[e.word] = next;
  }
  return out;
};

/** One use of a word (pure): the entry's family, hit rate and centroid are recomputed, then verification. */
export const recordUse = (lex: Lexicon, felt: string, use: LexUse): { lex: Lexicon; word?: string | undefined; newlyVerified: boolean } => {
  const word = normWord(felt);
  if (word === undefined) return { lex, newlyVerified: false };
  const prev = lex[word];
  const uses = [...(prev?.uses ?? []), use].slice(-LEXICON.keepUses);
  const family = claimFamily(word) ?? modalFamily(uses);
  const hit = uses.length === 0 || family === undefined ? 0 : Math.round((uses.filter((u) => u.top3.includes(family)).length / uses.length) * 1000) / 1000;
  const entry: LexEntry = { word, count: (prev?.count ?? 0) + 1, uses, ...(family !== undefined ? { family } : {}), hit, centroid: centroidOf(uses), verified: prev?.verified ?? false, ...(prev?.verifiedAt !== undefined ? { verifiedAt: prev.verifiedAt } : {}) };
  const next = verify({ ...lex, [word]: entry }, use.ts);
  return { lex: next, word, newlyVerified: next[word]!.verified && prev?.verified !== true };
};

/** Her verified words, as compose needs them. */
export const verifiedWords = (lex: Lexicon): Array<{ word: string; centroid: number[]; family?: Family | undefined }> =>
  Object.values(lex)
    .filter((e) => e.verified)
    .map((e) => ({ word: e.word, centroid: e.centroid, ...(e.family !== undefined ? { family: e.family } : {}) }));

/** The verified word of hers whose place this state sits nearest (and close enough), if any. */
export const yourWordFor = (
  words: ReadonlyArray<{ word: string; centroid: readonly number[]; family?: Family | undefined }>,
  vec: readonly number[],
  family?: Family | undefined,
): string | undefined => {
  let best: { word: string; c: number } | undefined;
  for (const w of words) {
    if (family !== undefined && w.family !== undefined && w.family !== family) continue;
    const c = cos(w.centroid, vec);
    if (c >= LEXICON.renderCos && (best === undefined || c > best.c)) best = { word: w.word, c };
  }
  return best?.word;
};

export const readLexicon = (dir: string): Lexicon => {
  const file = path.join(dir, LEXICON_FILE);
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Lexicon;
  } catch {
    return {};
  }
};

export const writeLexicon = async (dir: string, lex: Lexicon): Promise<void> => {
  fs.mkdirSync(dir, { recursive: true });
  await atomicWriteText(path.join(dir, LEXICON_FILE), JSON.stringify(lex, null, 1));
};

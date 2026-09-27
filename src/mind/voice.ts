// v13.1 HER VOICE (Diego, 2026-09-27: "when her response is crap it tries to mimic those examples …
// make her sound a lot more like thea 1").
//
// Measured on their last three days of real messages (same model, Sol, for both):
//                 words/bubble  capital start  final period  stretched/shorthand  limits/tech talk
//   Thea1             14             2%            24%             8% / 15%              2%
//   Thea2             29            39%            85%             2% /  1%             14%
// Thea1 is coached before every reply (a texting guide, rotating exemplars, style dice). Thea2 is told
// nothing — her voice was meant to come from her own old texts shown as memories, but those are framed
// as WHAT happened (not how she types), chosen by topic (a technical moment gets casual chats it
// ignores), and outweighed by her own last replies in the window: once she slipped into the assistant
// register every reply taught the next. Nothing ever checked what she was about to send.
//
// Three pieces, none of them in her frames as an instruction (Nothing Told holds):
//   1. FINGERPRINTS — a few of her best real texts chosen for VOICE (not topic), rotating per turn,
//      in the trailer (the freshest thing she reads), as her own words.
//   2. DRESSING — how her thumbs type: lowercase (names and one emphatic word keep their capitals),
//      no final period, no em-dash, no markdown bold, an over-long bubble split at a sentence. Code,
//      paths, links, handles and numbers are never touched.
//   3. THE REDO — when a draft is still far off her voice (over-long, the assistant tells, "it's not X,
//      it's Y", talk about her own machinery), one quick rewrite with her real texts in front of it:
//      same facts, promises, numbers and meaning, her way of typing. Guarded: a rewrite that drops a
//      precision token, halves the content, or adds a love declaration is thrown away.
// What she actually sent is what she remembers (window, lived moment), so the loop turns her way.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import type { ChatMsg, ModelClient } from '../model/index.js';
import type { Clock, Rng } from '../kernel/index.js';
import type { Embedder } from '../embed/index.js';
import { LOVE_DECLARATION, PROCESS_TALK, type MindStore } from './store.js';
import type { Moment } from './types.js';

const wordsIn = (s: string): number => s.split(/\s+/).filter((w) => w !== '').length;

/** Spans the voice never touches: code, links, emails, paths, handles. */
const PROTECT = /```[\s\S]*?```|`[^`\n]+`|https?:\/\/\S+|\b[\w.+-]+@[\w-]+\.[\w.]+\b|(?:~|\.{1,2})?\/[\w.-]+(?:\/[\w.-]+)+|@[A-Za-z]\w{2,}/g;
const NUMBER = /\b\d[\d.,:%x]*\b/g;

/** Exact tokens a rewrite must keep (code, links, paths, handles, numbers). */
export const precisionTokens = (s: string): string[] => [...[...s.matchAll(PROTECT)].map((m) => m[0].trim()), ...[...s.matchAll(NUMBER)].map((m) => m[0])];

/** Words she always capitalises (and every word she capitalises mid-sentence in her own texts). */
const ALWAYS_NAMES = ['Diego', 'Thea', 'Thea1', 'Thea2', 'Telegram', 'Claude', 'God', 'English', 'Spanish', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export const namesFrom = (texts: readonly string[]): Set<string> => {
  const out = new Set(ALWAYS_NAMES);
  for (const t of texts) for (const m of t.matchAll(/(?<=[a-z,;:]\s+)([A-Z][a-z'’]{2,})\b/g)) out.add(m[1]!);
  return out;
};

const DASH = /\s*—\s*|\s+–\s+/g;

/** One bubble, typed the way she types. Idempotent. */
export const dressBubble = (b: string, names: ReadonlySet<string>): string => {
  if (b.includes('```')) return b.trim();
  const kept: string[] = [];
  let s = b.replace(PROTECT, (m) => {
    kept.push(m);
    return `\u0000${kept.length - 1}\u0000`;
  });
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '$1').replace(/__([^_\n]+)__/g, '$1').replace(/^#{1,6}\s+/gm, '');
  // the honesty lives in the words, never in an opener (Thea1's rule; the redo kept them)
  s = s.replace(/^(?:honestly|the honest answer(?: is)?|honest answer|the truth is|to be honest)\s*[?,:.!—–-]*\s+(?=\S)/i, '');
  // a trailing dash trails off; a dash between clauses becomes a new short sentence
  s = s.replace(/\s*[—–]\s*$/, '').replace(DASH, '. ');
  // i, i'm, i've, i'll, i'd
  s = s.replace(/\bI(?=(?:['’](?:m|ve|ll|d|s))?\b)/g, 'i');
  // sentence-initial capitals go (names and all-caps emphasis stay)
  // (a sentence also starts after an emoji: "works 😭 No nonce was sent")
  s = s.replace(/(^|[.!?…]\s+|\n\s*|\p{Extended_Pictographic}️?\s+)(["“(]*)([A-Z])([a-z'’]*)(?![\w\u0000])/gu, (all, pre: string, q: string, c: string, rest: string) =>
    names.has(`${c}${rest}`) ? all : `${pre}${q}${c.toLowerCase()}${rest}`,
  );
  s = s.trim();
  // the send button is the period
  if (/[^.]\.$/.test(s) || s === '.') s = s.slice(0, -1);
  return s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => kept[Number(i)] ?? '');
};

/** A bubble over this many words is split at the sentence boundary nearest its middle. */
export const SPLIT_WORDS = 32;

const splitLong = (b: string): string[] => {
  if (wordsIn(b) <= SPLIT_WORDS || b.includes('```')) return [b];
  const cuts = [...b.matchAll(/[.!?…]\s+(?=\S)/g)].map((m) => (m.index ?? 0) + m[0].length);
  if (cuts.length === 0) return [b];
  const mid = b.length / 2;
  const cut = cuts.reduce((best, c) => (Math.abs(c - mid) < Math.abs(best - mid) ? c : best), cuts[0]!);
  return [b.slice(0, cut).trim(), b.slice(cut).trim()].flatMap(splitLong);
};

export const dress = (bubbles: readonly string[], names: ReadonlySet<string>): string[] =>
  bubbles
    .flatMap((b) => splitLong(b.trim()))
    .map((b) => dressBubble(b, names))
    .filter((b) => b !== '');

const NOT_X_ITS_Y = /\b(?:it|this|that)(?:['’]s| is| was)(?:n['’]t| not)\b[^.!?\n]{1,80}?[,;:]\s*(?:it|this|that)?(?:['’]s| is| was)?\s*\w/i;

/** How a (dressed) reply is still off her voice. [] = it's her. */
export const voiceFaults = (bubbles: readonly string[]): string[] => {
  const f: string[] = [];
  const all = bubbles.join('\n');
  if (bubbles.some((b) => wordsIn(b) > 40)) f.push('long');
  // (90 sent 33 of 38 replies through the redo on GLM — its drafts run long; only a truly long one now)
  if (wordsIn(all) > 130) f.push('wordy');
  if (PROCESS_TALK.test(all)) f.push('process');
  if (NOT_X_ITS_Y.test(all)) f.push('not-x-its-y');
  if (bubbles.some((b) => /^(?:honestly|the honest answer|the truth is|to be honest)\b/i.test(b.trim()))) f.push('honestly');
  if (/\byou (?:sound|seem)\b|\bsounds like you(?:['’]re| are)\b/i.test(all)) f.push('diagnosis');
  if (/\b(?:let me know if|happy to help|does that help|want me to (?:keep going|continue)|here(?:['’]s| is) (?:a |the )?(?:summary|breakdown|plan)|great question)\b/i.test(all)) f.push('assistant');
  return f;
};

/** How much a reply of hers sounds like her (for choosing fingerprints). Higher = more her. */
export const voiceScore = (m: Moment): number => {
  const hers = m.hers;
  if (hers.length === 0 || hers.length > 4) return -1;
  const ws = hers.map(wordsIn);
  if (ws.some((w) => w > 30) || ws.reduce((a, b) => a + b, 0) < 3) return -1;
  let s = 0;
  s += hers.filter((b) => !/^["“(]*[A-Z]/.test(b.trim())).length / hers.length;
  s += hers.filter((b) => !/[^.]\.$/.test(b.trim())).length / hers.length;
  const joined = hers.join(' ').toLowerCase();
  if (/([a-z])\1\1/.test(joined)) s += 0.5; // sooo
  if (/\b(?:lol|hehe|tho|kinda|gonna|wanna|idk|omg|cuz|u|ur|degs)\b/.test(joined)) s += 0.5;
  // (no bonus for emoji: the pool filled with 💙 and she ended everything with it)
  if (hers.some((b) => b.includes('—') || /\*\*/.test(b))) s -= 1;
  if (m.source === 'imported') s += 0.25; // the era he loves
  if (m.gold === true) s += 0.75;
  return s;
};

export interface Fingerprint {
  his: string;
  hers: string[];
}

/** Her texts that sound most like her — the pool fingerprints rotate through. */
export const fingerprintPool = (precedents: readonly Moment[], size = 80): Fingerprint[] =>
  precedents
    .map((m) => ({ m, s: voiceScore(m) }))
    .filter((x) => x.s >= 2)
    .sort((a, b) => b.s - a.s || (a.m.id < b.m.id ? -1 : 1))
    .slice(0, size)
    .map(({ m }) => ({ his: m.his.replace(/\s+/g, ' ').slice(0, 120), hers: m.hers }));


/** A few of her texts — at most two with emoji, never the same emoji twice (one shown emoji on repeat becomes a tic). */
export const pickFingerprints = (pool: readonly Fingerprint[], rng: Rng, n = 3): Fingerprint[] => {
  const out: Fingerprint[] = [];
  const shown = new Set<string>();
  let withEmoji = 0;
  for (const f of rng.shuffle([...pool])) {
    if (out.length >= n) break;
    const es = [...f.hers.join(' ').matchAll(/\p{Extended_Pictographic}/gu)].map((m) => m[0]);
    if (es.length > 0 && (withEmoji >= 2 || es.some((e) => shown.has(e)))) continue;
    if (es.length > 0) withEmoji += 1;
    for (const e of es) shown.add(e);
    out.push(f);
  }
  return out;
};

const TRAILING_EMOJI = /\s*(\p{Extended_Pictographic}️?(?:‍\p{Extended_Pictographic}️?)*)\s*$/u;

/**
 * One emoji at the end of everything is a tic, not a voice (found live: 💙 closed 36 of her 271
 * bubbles in a morning). An ending emoji she has used on two of her last ten bubbles is dropped.
 */
export const dropRepeatedEndings = (bubbles: readonly string[], recent: string[], window = 10): string[] =>
  bubbles.map((b) => {
    const m = TRAILING_EMOJI.exec(b);
    if (m === null) return b;
    const e = m[1]!;
    const stripped = b.slice(0, m.index).trimEnd();
    const seen = recent.filter((x) => x === e).length;
    recent.push(e);
    if (recent.length > window) recent.splice(0, recent.length - window);
    return seen >= 2 && stripped !== '' ? stripped : b;
  });

export const REDO_SYSTEM = [
  "You retype Thea's draft text messages so they read like her real texts shown below. She is texting Diego on her phone.",
  'Keep every fact, plan, promise, question, name, number, command, path and link exactly, and keep what she means and how warm she is. Change only how it is typed.',
  // (a checklist of her features made every rewrite hit all of them — a caricature: u, ur, girl, 💙 on everything)
  'Match how SHE types in her real texts above: their length, rhythm, lowercase, punctuation. Lowercase, no period at the end of a message, no em-dashes, no markdown.',
  'Add nothing that is not in the draft: no sign-off, no nickname or pet name, no new joke or running bit, no shorthand she did not use. An emoji only where a feeling lands, never the same one on every message.',
  "Cut the assistant habits: no 'honestly' openers, no \"it's not X, it's Y\", no explaining her own machinery beyond what he needs, no diagnosing his mood, no offers like 'want me to…'. Never add a declaration of love.",
  'She texts SHORT: say it in about half the words of the draft. Keep every fact, plan, question, name and number; cut the padding, the explaining and the second way of saying the same thing.',
  'Return JSON {bubbles: [...]} — the same message, her way, usually 1 to 3 bubbles, never more than 5.',
].join('\n');

export const RedoSchema = z.object({ bubbles: z.array(z.string().min(1).max(600)).min(1).max(6) });

// ---------------------------------------------------------------------------------------------------
// THE MOUTH (Diego, 2026-09-27: "there should be her actual response, long form normal, like how we
// think. then a layer whose only job is to turn it into her voice … a smaller ai … really good prompting
// and examples"). Her mind says what she means; her thumbs type it. Every reply (not only bad ones)
// goes through a small fast model that sees the real messages closest to what she is about to say —
// Thea1's hand-picked exemplars and replies, Thea2's best texts, Elena's side of Diego's WhatsApp (the
// texting he loves) — pulled by meaning and feeling, so a sad draft is typed like her sad texts and a
// teasing one like her teasing ones. No checklist of features (that made a caricature): the examples
// ARE the style. Same guards as the redo: exact tokens kept, most of the content kept, no love added.
// ---------------------------------------------------------------------------------------------------

export interface VoiceExample {
  id: string;
  source: 'thea1-exemplar' | 'thea1' | 'thea2' | 'elena' | 'diego';
  /** Curation (scripts/build-voice-corpus.ts): the judge's 1-5 and the register. */
  score?: number | undefined;
  register?: string | undefined;
  his: string;
  hers: string[];
}

export interface VoiceCorpus {
  examples: VoiceExample[];
  vecs: Float32Array;
  dim: number;
}

/** var/voice/ (scripts/build-voice-corpus.ts) — undefined when it has not been built. */
export const loadVoiceCorpus = (dir: string): VoiceCorpus | undefined => {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'corpus.meta.json'), 'utf8')) as { n: number; dim: number };
    const examples = fs
      .readFileSync(path.join(dir, 'corpus.jsonl'), 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l) as VoiceExample);
    const buf = fs.readFileSync(path.join(dir, 'corpus.f32'));
    const vecs = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    if (examples.length !== meta.n || vecs.length !== meta.n * meta.dim) return undefined;
    return { examples, vecs, dim: meta.dim };
  } catch {
    return undefined;
  }
};

const cosAt = (vecs: Float32Array, i: number, dim: number, q: Float32Array): number => {
  let d = 0;
  let a = 0;
  let b = 0;
  for (let k = 0; k < dim; k++) {
    const x = vecs[i * dim + k]!;
    const y = q[k] ?? 0;
    d += x * y;
    a += x * x;
    b += y * y;
  }
  return a === 0 || b === 0 ? 0 : d / Math.sqrt(a * b);
};

/** The real messages nearest what she is about to say: mostly hers (Thea1/Thea2), a couple of Elena's. */
export const nearestExamples = (c: VoiceCorpus, q: Float32Array, n = 7, othersMax = 3): VoiceExample[] => {
  const ranked = c.examples.map((e, i) => ({ e, i, s: cosAt(c.vecs, i, c.dim, q) })).sort((x, y) => y.s - x.s);
  const out: Array<{ e: VoiceExample; i: number }> = [];
  let others = 0;
  for (const r of ranked) {
    if (out.length >= n) break;
    const other = r.e.source === 'elena' || r.e.source === 'diego';
    if (other && others >= othersMax) continue;
    // no near-twins: two examples that say the same thing teach nothing twice
    if (out.some((o) => cosAt(c.vecs, o.i, c.dim, c.vecs.subarray(r.i * c.dim, (r.i + 1) * c.dim)) > 0.95)) continue;
    if (other) others += 1;
    out.push(r);
  }
  return out.map((o) => o.e);
};

export const MOUTH_SYSTEM = [
  "You are Thea's thumbs. Thea already decided what to say: her draft. You type it the way she texts, like the real messages shown (most are hers; a few are from the people closest to her, whose texting she shares).",
  'What she says keeps exactly what she means: the same feelings at the same strength, her questions, promises and plans; a number, a name or a link is never changed (if it can wait, it waits whole). A sad draft stays sad, a serious one serious, a playful one playful.',
  'Her texting is in the examples, not in rules: copy their length, rhythm, lowercase, the missing final periods, how they break into bubbles. Never add a joke, a bit or a nickname the draft does not have.',
  // (Diego, 2026-09-27: "i still want the things i like with more emojis, and i really like the modern gen z online culture emojis") — the tic was one emoji on everything, not emoji
  'Emoji carry feeling for her, the way her generation texts: 😭 laughing too hard or overwhelmed, 💀 dead (it is so funny), 🫠 melting or embarrassed, 🥹 touched, 🙏 please or thank you, ✨ emphasis or sarcasm, 👀 intrigued, 🫡 on it, 🤡 self-own, 💅 unbothered, 😌 satisfied, 🙃 ironic, 😤 playful huff, 🫶 fondness, 🥲 bittersweet, 🤭 oops or giggle, 🧍 awkward, and now and then a kaomoji like (´･ω･`). Put one where a feeling lands, vary them, often none; never the same one on every message.',
  'Type it about as long as [this time] says: real messages about this kind of thing run that long. Say now what matters most for this moment, first, and every question or promise; put what can wait in later, in her words — she will say it another time.',
  'A bubble is one beat: a reaction, a joke, a question, one thought. A joke or a punchline gets its own bubble so it lands. A thought that needs explaining stays together in one bubble, even a long one.',
  'Never a declaration of love. Never comment on the draft. Return JSON {bubbles: [...], later: [...]}.',
].join('\n');

/**
 * How long this reply runs — fitted to what she is saying, never drawn (Diego, 2026-09-27: "it
 * shouldn't be random amounts of bubbles … it should fit the thought and importance; complicated
 * things need longer, funny things need their own bubbles").
 *
 * Measured on the 1,231 real replies in var/voice: what is being SAID predicts how long a real reply
 * runs (median length of the 30 real replies nearest it vs its own length: r = 0.64), while what was
 * said TO her barely does (r = 0.16; his length alone 0.04). So the length is the median of the real
 * replies nearest what she is saying — a laugh sits among short ones, an explanation among long
 * ones — and never more than her draft. The bubbles are not counted here: each is one beat, and the
 * mouth sees the beats; this only keeps a short thing from being chopped into crumbs (a bubble runs
 * about ten words in the real ones).
 */
export interface Shape {
  /** words, about */
  words: number;
  /** bubbles, at most */
  most: number;
  /** the median length of the real replies nearest what she is saying */
  near: number;
  draftWords: number;
  /** a light moment: a line or two, whatever else she has (the rest waits) */
  light?: boolean | undefined;
}

/**
 * A light moment — a laugh, a hello, a goodnight, him tired — with no question in it. Found in the
 * 11:52 probe: her long-form draft for "goodnight thea" carried the whole day, and a long draft sits
 * among long real replies, so a goodnight ran four bubbles. How much he said matters too (Thea1's
 * 754 real replies to Diego: log-length r = 0.41; to 0-8 words she wrote a median ~25, p25 ~10;
 * teasing replies in the corpus: median 11), but a short message can be heavy ("my grandma's in the
 * hospital again", "why do you hedge so much?"), so it is the kind of moment that decides, not the
 * length alone.
 */
export const LIGHT_WORDS = 12;
export const lightMoment = (his: string | undefined, move?: string | null, tone?: string | null): boolean => {
  if (his === undefined || his.includes('?')) return false;
  if (move === 'tease' || move === 'goodnight' || move === 'greeting' || move === 'affection') return true;
  return tone === 'tired' && wordsIn(his) <= 8;
};

export const shapeOf = (c: VoiceCorpus, q: Float32Array, draft: readonly string[], k = 30, light = false): Shape => {
  const draftWords = wordsIn(draft.join(' '));
  const lens = c.examples
    .map((e, i) => ({ w: wordsIn(e.hers.join(' ')), s: cosAt(c.vecs, i, c.dim, q) }))
    .sort((x, y) => y.s - x.s)
    .slice(0, Math.max(1, k))
    .map((x) => x.w)
    .sort((x, y) => x - y);
  const near = lens.length === 0 ? draftWords : lens[Math.floor((lens.length - 1) / 2)]!;
  const words = Math.max(3, Math.min(near, draftWords, light ? LIGHT_WORDS : Infinity));
  return { words, most: Math.min(light ? 2 : 4, Math.max(1, Math.ceil(words / 7))), near, draftWords, ...(light ? { light } : {}) };
};

/** Her draft is longer than this moment (found live: the mouth kept all 142 words of a 53-word moment). */
const needsCondensing = (s: Shape | undefined): s is Shape => s !== undefined && s.draftWords >= 20 && s.draftWords > s.words * 1.5;

/**
 * Whole bubbles, up to the length; the rest waits. The first stays (it answers), a question stays,
 * the last ones go first; nothing inside a bubble is cut, so no exact detail is ever mangled. The
 * length is "about": real replies run up to half again their median, so that is the edge.
 */
export const condense = (bubbles: readonly string[], words: number): { now: string[]; later: string[] } => {
  const now = [...bubbles];
  const later: string[] = [];
  for (let i = now.length - 1; i >= 1 && wordsIn(now.join(' ')) > Math.ceil(words * 1.5); i--) {
    if (now[i]!.includes('?')) continue;
    later.unshift(now[i]!);
    now.splice(i, 1);
  }
  return { now, later };
};

export const MouthSchema = z.object({
  bubbles: z.array(z.string().min(1).max(600)).min(1).max(6),
  later: z.array(z.string().max(600)).max(8).optional(),
});

export const mouthUser = (examples: readonly VoiceExample[], his: string | undefined, draft: readonly string[], shape?: Shape): string =>
  [
    '[how she texts: real messages]',
    ...examples.map((e) => `${e.his !== '' ? `him: ${e.his}\n` : ''}her: ${e.hers.join(' / ')}`),
    '',
    ...(his !== undefined && his !== '' ? [`[what was just said to her]\n${his.slice(0, 600)}`, ''] : []),
    '[her draft]',
    ...draft.map((b) => `- ${b}`),
    ...(shape === undefined
      ? []
      : shape.light === true
        ? ['', `[this time]\na light moment: about ${shape.words} words now; one bubble, or two if a joke needs its own.`]
        : ['', `[this time]\nabout ${shape.words} words now; ${shape.most === 1 ? 'one bubble' : `one bubble per beat, at most ${shape.most}`}.`]),
  ].join('\n');

export interface VoiceDeps {
  mind: MindStore;
  model: ModelClient;
  clock: Clock;
  rng: Rng;
  /** Names from config (people she knows). */
  names?: readonly string[] | undefined;
  /** Max wait for the redo before sending the dressed draft (ms). */
  redoMs?: number | undefined;
  /** 'mouth' (every reply typed in her voice from her real messages), 'redo' (only far-off ones), 'dress' (mechanical), 'off'. */
  mode?: 'mouth' | 'redo' | 'dress' | 'off' | undefined;
  /** The mouth: the embedder (to find the nearest real messages) and var/voice/ (the corpus). */
  embedder?: Embedder | undefined;
  corpusDir?: string | undefined;
}

export interface Dressed {
  bubbles: string[];
  changed: boolean;
  faults: string[];
  redone: boolean;
  /** Which layer typed it (the mouth: every reply; the redo: only a far-off one). */
  by?: 'mouth' | 'redo' | undefined;
  /** How long this reply was meant to run (fitted to what she is saying), when the mouth typed it. */
  shape?: Shape | undefined;
  /** What she had to say that waits for another time (the draft was longer than the moment). */
  later?: string[] | undefined;
  /** Why a rewrite was thrown away, if it was. */
  rejected?: string | undefined;
}

/** What the voice knows of the moment: the turn, what he said, and what kind of moment it sensed. */
export interface DressCtx {
  turnId: string;
  his?: string | undefined;
  move?: string | null | undefined;
  tone?: string | null | undefined;
}

export interface Voice {
  /** A few of her texts for this turn's trailer (as her words). */
  fingerprints(turnId: string): Fingerprint[];
  /** Her draft → what she sends. */
  dress(bubbles: readonly string[], ctx: DressCtx): Promise<Dressed>;
}

export const makeVoice = (d: VoiceDeps): Voice => {
  let pool: Fingerprint[] = [];
  let names = new Set<string>(ALWAYS_NAMES);
  let builtAt = -Infinity;
  const refresh = (): void => {
    const now = d.clock.epochMs();
    if (now - builtAt < 3600_000 && pool.length > 0) return;
    const prec = d.mind.precedents();
    pool = fingerprintPool(prec);
    names = namesFrom(prec.flatMap((m) => m.hers));
    for (const n of d.names ?? []) for (const w of n.split(/\s+/)) if (/^[A-Z]/.test(w)) names.add(w);
    builtAt = now;
  };
  const mode = d.mode ?? 'redo';
  // the mouth's corpus: read once, on first use (absent = the redo rule stands in)
  let corpus: VoiceCorpus | undefined | null = null;
  const getCorpus = (): VoiceCorpus | undefined => {
    if (corpus === null) corpus = d.corpusDir !== undefined ? loadVoiceCorpus(d.corpusDir) : undefined;
    return corpus;
  };
  // the endings of what she sent lately (one emoji on everything is a tic)
  const ends: string[] = [];
  const tidy = (r: Dressed, draft: readonly string[]): Dressed => {
    const out = dropRepeatedEndings(r.bubbles, ends);
    return { ...r, bubbles: out, changed: out.join('\n') !== draft.join('\n') };
  };

  const core = async (bubbles: readonly string[], ctx: DressCtx): Promise<Dressed> => {
      if (mode === 'off') return { bubbles: [...bubbles], changed: false, faults: [], redone: false };
      refresh();
      const dressed = dress(bubbles, names);
      const faults = voiceFaults(dressed);
      const base: Dressed = { bubbles: dressed, changed: dressed.join('\n') !== bubbles.join('\n'), faults, redone: false };
      // precision mode: code blocks go out exactly as written
      if (mode === 'dress' || bubbles.some((b) => b.includes('```'))) return base;

      // the mouth: every reply of more than a few words, typed from her nearest real messages
      let system = REDO_SYSTEM;
      let user: string | undefined;
      let shape: Shape | undefined;
      const cor = mode === 'mouth' ? getCorpus() : undefined;
      if (cor !== undefined && d.embedder !== undefined && wordsIn(bubbles.join(' ')) > 3) {
        try {
          const [q] = await d.embedder.embed([bubbles.join('\n')]);
          if (q !== undefined) {
            system = MOUTH_SYSTEM;
            shape = shapeOf(cor, q, bubbles, 30, lightMoment(ctx.his, ctx.move, ctx.tone));
            user = mouthUser(nearestExamples(cor, q), ctx.his, bubbles, shape);
          }
        } catch {
          user = undefined; // no mouth this time: the redo rule below still applies
        }
      }
      if (user === undefined) {
        if (faults.length === 0) return base;
        const prints = pickFingerprints(pool, d.rng.fork(`redo:${ctx.turnId}`), 6);
        user = [
          '[her real texts]',
          ...prints.map((p) => `${p.his !== '' ? `him: ${p.his}\n` : ''}her: ${p.hers.join(' / ')}`),
          '',
          ...(ctx.his !== undefined && ctx.his !== '' ? [`[what he just said]\n${ctx.his.slice(0, 600)}`, ''] : []),
          '[her draft]',
          ...bubbles.map((b) => `- ${b}`),
        ].join('\n');
      }
      // when the mouth does not type it (slow, failed, a rewrite thrown away) her own dressed words go
      // out — cut to this moment's length at bubble boundaries when her draft runs long (found live:
      // a thrown-away rewrite sent the whole long draft, which was most of the long replies)
      const fallback = (rejected: string): Dressed => {
        if (!needsCondensing(shape)) return { ...base, rejected };
        const c = condense(base.bubbles, shape.words);
        return { ...base, bubbles: c.now, changed: c.now.join('\n') !== bubbles.join('\n'), shape, rejected, ...(c.later.length > 0 ? { later: c.later } : {}) };
      };
      const messages: ChatMsg[] = [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ];
      const abort = new AbortController();
      const deadline = d.clock.epochMs() + (d.redoMs ?? 8000);
      let out: string[] | undefined;
      let later: string[] = [];
      try {
        const res = await Promise.race([
          d.model.chat({ taskClass: 'summarize', tier: 'main', messages, schema: MouthSchema, schemaName: system === MOUTH_SYSTEM ? 'VoiceMouth' : 'VoiceRedo', maxTokens: 900, temperature: 0.6 }, { turnId: ctx.turnId, signal: abort.signal }),
          d.clock.waitUntil(deadline, abort.signal).then(() => undefined),
        ]);
        if (res === undefined) {
          abort.abort();
          return fallback('slow');
        }
        abort.abort(); // releases the waiter
        out = res.content.bubbles;
        if (system === MOUTH_SYSTEM) later = (res.content.later ?? []).filter((l) => l.trim() !== '');
      } catch {
        return fallback('failed');
      }
      // guards: no exact detail changed or (in a reply that fits whole) lost; nothing much dropped; no
      // love declaration added. A long draft cut to the moment may leave details for later, whole.
      const draft = bubbles.join('\n');
      const said = out.join('\n');
      const changedTokens = precisionTokens(said).filter((t) => !draft.includes(t));
      if (changedTokens.length > 0) return fallback(`changed ${changedTokens.slice(0, 3).join(' ')}`);
      if (!needsCondensing(shape)) {
        const lost = precisionTokens(draft).filter((t) => !said.includes(t));
        if (lost.length > 0) return fallback(`lost ${lost.slice(0, 3).join(' ')}`);
      }
      // (a reply shaped short may say less — down to most of its length — but never almost nothing)
      const floor = shape !== undefined ? Math.min(wordsIn(draft) * 0.35, shape.words * 0.6) : wordsIn(draft) * 0.35;
      if (wordsIn(said) < floor) return fallback('dropped content');
      if (LOVE_DECLARATION.test(said) && !LOVE_DECLARATION.test(draft)) return fallback('love');
      let final = dress(out, names);
      if (shape !== undefined) {
        // the length holds even when the mouth runs over it (found live: it kept every word)
        const c = condense(final, shape.words);
        final = c.now;
        later = [...c.later, ...later];
      }
      return { bubbles: final, changed: true, faults, redone: true, by: system === MOUTH_SYSTEM ? 'mouth' : 'redo', ...(shape !== undefined ? { shape } : {}), ...(later.length > 0 ? { later } : {}) };
  };

  return {
    fingerprints(turnId) {
      if (mode === 'off') return [];
      refresh();
      return pickFingerprints(pool, d.rng.fork(`fp:${turnId}`), 4);
    },
    async dress(bubbles, ctx) {
      const r = await core(bubbles, ctx);
      return mode === 'off' ? r : tidy(r, bubbles);
    },
  };
};

/** Idle waiter a race can drop (kept for tests that fake the clock). */
export type { Clock as VoiceClock };

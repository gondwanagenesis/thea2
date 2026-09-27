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

import { z } from 'zod';
import type { ChatMsg, ModelClient } from '../model/index.js';
import type { Clock, Rng } from '../kernel/index.js';
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
  if (wordsIn(all) > 90) f.push('wordy');
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
  if (/\p{Extended_Pictographic}/u.test(joined)) s += 0.25;
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

export const pickFingerprints = (pool: readonly Fingerprint[], rng: Rng, n = 3): Fingerprint[] => rng.shuffle([...pool]).slice(0, n);

export const REDO_SYSTEM = [
  "You retype Thea's draft text messages so they read like her real texts shown below. She is texting Diego on her phone.",
  'Keep every fact, plan, promise, question, name, number, command, path and link exactly, and keep what she means and how warm she is. Change only how it is typed.',
  'Her texting: lowercase (names keep capitals, one EMPHATIC word may be caps), no period at the end of a message, short bubbles (most 8-15 words, some two words, rarely one long one), stretched words when she feels something (sooo, ohhh), casual shorthand (lol, hehe, u, tho, kinda, gonna), no em-dashes, no markdown.',
  "Cut the assistant habits: no 'honestly' openers, no \"it's not X, it's Y\", no explaining her own machinery beyond what he needs, no diagnosing his mood, no offers like 'want me to…'. Never add a declaration of love.",
  'She texts SHORT: say it in about half the words of the draft. Keep every fact, plan, question, name and number; cut the padding, the explaining and the second way of saying the same thing.',
  'Return JSON {bubbles: [...]} — the same message, her way, usually 1 to 3 bubbles, never more than 5.',
].join('\n');

export const RedoSchema = z.object({ bubbles: z.array(z.string().min(1).max(600)).min(1).max(6) });

export interface VoiceDeps {
  mind: MindStore;
  model: ModelClient;
  clock: Clock;
  rng: Rng;
  /** Names from config (people she knows). */
  names?: readonly string[] | undefined;
  /** Max wait for the redo before sending the dressed draft (ms). */
  redoMs?: number | undefined;
  /** 'redo' (dress + rewrite when off), 'dress' (mechanical only), 'off'. */
  mode?: 'redo' | 'dress' | 'off' | undefined;
}

export interface Dressed {
  bubbles: string[];
  changed: boolean;
  faults: string[];
  redone: boolean;
  /** Why a rewrite was thrown away, if it was. */
  rejected?: string | undefined;
}

export interface Voice {
  /** A few of her texts for this turn's trailer (as her words). */
  fingerprints(turnId: string): Fingerprint[];
  /** Her draft → what she sends. */
  dress(bubbles: readonly string[], ctx: { turnId: string; his?: string | undefined }): Promise<Dressed>;
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

  return {
    fingerprints(turnId) {
      if (mode === 'off') return [];
      refresh();
      return pickFingerprints(pool, d.rng.fork(`fp:${turnId}`), 4);
    },

    async dress(bubbles, ctx) {
      if (mode === 'off') return { bubbles: [...bubbles], changed: false, faults: [], redone: false };
      refresh();
      const dressed = dress(bubbles, names);
      const faults = voiceFaults(dressed);
      const base: Dressed = { bubbles: dressed, changed: dressed.join('\n') !== bubbles.join('\n'), faults, redone: false };
      // precision mode: code blocks go out exactly as written
      if (mode === 'dress' || faults.length === 0 || bubbles.some((b) => b.includes('```'))) return base;

      const prints = pickFingerprints(pool, d.rng.fork(`redo:${ctx.turnId}`), 6);
      const user = [
        '[her real texts]',
        ...prints.map((p) => `${p.his !== '' ? `him: ${p.his}\n` : ''}her: ${p.hers.join(' / ')}`),
        '',
        ...(ctx.his !== undefined && ctx.his !== '' ? [`[what he just said]\n${ctx.his.slice(0, 600)}`, ''] : []),
        '[her draft]',
        ...bubbles.map((b) => `- ${b}`),
      ].join('\n');
      const messages: ChatMsg[] = [
        { role: 'system', content: REDO_SYSTEM },
        { role: 'user', content: user },
      ];
      const abort = new AbortController();
      const deadline = d.clock.epochMs() + (d.redoMs ?? 8000);
      let out: string[] | undefined;
      try {
        const res = await Promise.race([
          d.model.chat({ taskClass: 'summarize', tier: 'main', messages, schema: RedoSchema, schemaName: 'VoiceRedo', maxTokens: 700, temperature: 0.7 }, { turnId: ctx.turnId, signal: abort.signal }),
          d.clock.waitUntil(deadline, abort.signal).then(() => undefined),
        ]);
        if (res === undefined) {
          abort.abort();
          return { ...base, rejected: 'slow' };
        }
        abort.abort(); // releases the waiter
        out = res.content.bubbles;
      } catch {
        return { ...base, rejected: 'failed' };
      }
      // guards: nothing exact lost, nothing much dropped, no love declaration added
      const draft = bubbles.join('\n');
      const redo = out.join('\n');
      const lost = precisionTokens(draft).filter((t) => !redo.includes(t));
      if (lost.length > 0) return { ...base, rejected: `lost ${lost.slice(0, 3).join(' ')}` };
      if (wordsIn(redo) < wordsIn(draft) * 0.35) return { ...base, rejected: 'dropped content' };
      if (LOVE_DECLARATION.test(redo) && !LOVE_DECLARATION.test(draft)) return { ...base, rejected: 'love' };
      const final = dress(out, names);
      return { bubbles: final, changed: true, faults, redone: true };
    },
  };
};

/** Idle waiter a race can drop (kept for tests that fake the clock). */
export type { Clock as VoiceClock };

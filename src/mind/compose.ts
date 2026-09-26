// v8 mind — COMPOSE: her packet holds only MATERIAL (law 1.1, "nothing told").
//
//   [me]                 her self-narrative, her own words
//   [on my mind]         open loops and recent thoughts, her own words
//   [times like this]    evoked moments from her real past: dated, how she felt
//                        THEN (past tense), what he said, what she said, how it
//                        landed. These are her options.
//   [things you remember] diary lines and thoughts the moment touched
//   [now]                (trailer) his local time, how long since he wrote
//   [format]             the decide contract — mechanics only
//
// Every rendered segment is typed: 'quote' (her or his real words) or 'frame'
// (text this module writes). The no-telling lint checks every frame segment:
// no present-tense feeling assignments, no style orders, no state numbers, no
// machinery words. A packet that fails the lint is a bug, not a turn.

import type { LoopPacket } from '../loop/index.js';
import type { Concern, Moment, SelfLine, Thought } from './types.js';

export interface Segment {
  kind: 'frame' | 'quote';
  text: string;
}

export const V8_OUTPUT_CONTRACT =
  '[format]\n' +
  'Your tools act for real. To do something (take a selfie, make a picture or a video, search, read, look, remember, set a reminder, send a voice note, send someone out), call that tool; what it did comes back to you. ' +
  'When you are done acting, answer by calling the `decide` tool once, last: decide ends the turn. bubbles are the messages you send, in order, one per bubble. ' +
  "plan 'silent' sends nothing; 'defer' means later. confidence, weight, reluctance and completeness are 0 to 1 and pace the sending. " +
  'expect is private and never sent: one short line on what you think happens next. Nothing outside the tool calls is sent. ' +
  'Saying you will do something does not do it; only the tool call does, and it has to come before decide.';

/** Frame text may never tell her what she feels, how to talk, or show her machinery. */
export const TELLING_PATTERNS: readonly RegExp[] = [
  /\byou(?:'re| are)\s+(?:feeling\s+)?(?:so\s+|very\s+|really\s+|a bit\s+|kind of\s+|sort of\s+)?(?:happy|sad|restless|anxious|lonely|excited|playful|tired|angry|calm|fond|warm|flat|low|nervous|hurt|bored|curious|jealous|attached|longing|bratty|settled|giddy|content)\b/i,
  /\byou (?:feel|are feeling|'re feeling|seem|sound)\b/i,
  /\byour (?:mood|feelings?|emotions?|affect|emotional state|dials?)\b/i,
  /\b(?:be|stay|sound|act) (?:playful|warm|short|brief|funny|sweet|flirty|gentle|honest|casual|excited|bratty|clingy)\b/i,
  /\b(?:keep|make) (?:it|this|them|your repl(?:y|ies)) (?:short|brief|light|casual)\b/i,
  /\b(?:use|add|avoid|no) emojis?\b/i,
  /\b(?:lowercase|capitalize|capital letters)\b/i,
  /\b\d\.\d{2}\b/,
  /\b(?:valence|arousal|dominance|novelty|mastery|dial|ticker|coupling|precedent|exemplar)s?\b/i,
];

export interface LintHit {
  pattern: string;
  text: string;
}

export const lintSegments = (segments: readonly Segment[]): LintHit[] => {
  const hits: LintHit[] = [];
  for (const s of segments) {
    if (s.kind !== 'frame') continue;
    for (const re of TELLING_PATTERNS) {
      const m = re.exec(s.text);
      if (m !== null) hits.push({ pattern: re.source, text: s.text.slice(Math.max(0, m.index - 20), m.index + 40) });
    }
  }
  return hits;
};

// ---------------------------------------------------------------------------
// Time rendering (his zone)
// ---------------------------------------------------------------------------

export const hourIn = (ms: number, timeZone: string): number => {
  const h = new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone }).format(ms);
  return Number(h) % 24;
};

const dayPart = (h: number): string =>
  h < 5 ? 'late night' : h < 8 ? 'early morning' : h < 12 ? 'morning' : h < 17 ? 'afternoon' : h < 21 ? 'evening' : 'night';

export const dateLabel = (ms: number, timeZone: string): string =>
  new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone }).format(ms).toLowerCase();

export const ago = (ms: number): string => {
  const min = Math.round(ms / 60_000);
  if (min < 2) return 'just now';
  if (min < 60) return `${min} minutes ago`;
  const h = Math.round(min / 60);
  if (h < 36) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.round(h / 24);
  return `${d} days ago`;
};

const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

export interface ComposeInput {
  timeZone: string;
  now: number;
  self: readonly SelfLine[];
  concerns: readonly Concern[];
  thoughts: readonly Thought[];
  options: readonly Moment[];
  memories: readonly Moment[];
  /** When he last wrote (epoch ms), if known. */
  lastHisAt?: number | undefined;
  /** Who is on the other end (a name). */
  who: string;
  /** Self-initiated turn: nothing new from him. */
  selfEntry?: boolean | undefined;
  /** v9: facts about his present the body knows (where he is, his local time and sky) — material lines for [now]. */
  nowFacts?: readonly string[] | undefined;
  /** v9: her own note on how she does the thing this moment is about (learned from practice) — her words. */
  howTo?: { name: string; note: string } | undefined;
}

const renderMoment = (m: Moment, tz: string): Segment[] => {
  const segs: Segment[] = [];
  const when = `${dateLabel(m.ts, tz)}, ${dayPart(hourIn(m.ts, tz))}`;
  segs.push({ kind: 'frame', text: m.felt.word !== undefined ? `${when}. you were ${m.felt.word}` : when });
  for (const l of m.before.slice(-1)) {
    segs.push({ kind: 'quote', text: `${l.who === 'him' ? 'him' : 'you'}: ${clip(l.text, 200)}` });
  }
  if (m.his.trim() !== '') segs.push({ kind: 'quote', text: `him: ${clip(m.his, 280)}` });
  else segs.push({ kind: 'frame', text: '(you wrote first)' });
  const shown = m.hers.length > 3 ? m.hers.slice(0, 2) : m.hers;
  for (const b of shown) segs.push({ kind: 'quote', text: `you: ${clip(b, 280)}` });
  if (m.hers.length > 3) segs.push({ kind: 'frame', text: `(+${m.hers.length - 2} more)` });
  // v9: what she DID then, beside what she said — so her own past shows acting, not narrating.
  if (m.acts !== undefined && m.acts.length > 0) {
    segs.push({ kind: 'frame', text: `(and did: ${m.acts.map((a) => `${a.tool}${a.what !== '' ? ` "${clip(a.what, 60)}"` : ''}${a.result !== undefined ? ` → ${clip(a.result, 60)}` : ''}`).join('; ')})` });
  }
  if (m.outcome !== undefined && m.outcome.why.trim() !== '') segs.push({ kind: 'frame', text: `(${clip(m.outcome.why, 90)})` });
  return segs;
};

export const composeSegments = (i: ComposeInput): { head: Segment[]; trailer: Segment[] } => {
  const head: Segment[] = [];
  const blank = (): void => {
    head.push({ kind: 'frame', text: '' });
  };

  if (i.self.length > 0) {
    head.push({ kind: 'frame', text: '[me]' });
    for (const l of i.self.slice(0, 8)) head.push({ kind: 'quote', text: l.text });
    blank();
  }

  const mind: Segment[] = [];
  const open = i.concerns.filter((c) => c.status === 'open').slice(0, 3);
  for (const c of open) {
    mind.push({ kind: 'quote', text: `- ${clip(c.what, 200)}` });
  }
  for (const t of i.thoughts.slice(-2)) {
    mind.push({ kind: 'quote', text: `- ${clip(t.text, 240)}` });
    mind.push({ kind: 'frame', text: `  (a thought from ${ago(i.now - t.ts)})` });
  }
  if (mind.length > 0) {
    head.push({ kind: 'frame', text: '[on my mind]' }, ...mind);
    blank();
  }

  if (i.options.length > 0) {
    head.push({ kind: 'frame', text: '[times like this]' });
    head.push({ kind: 'frame', text: 'from your own texts, times a lot like this one. they happened; they show how you are, not lines to reuse.' });
    for (const m of i.options) {
      blank();
      head.push(...renderMoment(m, i.timeZone));
    }
    blank();
    head.push({ kind: 'frame', text: 'this one is its own moment. go with one of these, mix them, or do something new.' });
    blank();
  }

  if (i.memories.length > 0) {
    head.push({ kind: 'frame', text: '[things you remember]' });
    for (const m of i.memories) {
      const text = m.hers.join(' ') || m.his;
      head.push({ kind: 'frame', text: `${dateLabel(m.ts, i.timeZone)}:` });
      head.push({ kind: 'quote', text: clip(text, 280) });
    }
    blank();
  }

  if (i.howTo !== undefined) {
    blank();
    head.push({ kind: 'frame', text: `[how you've done this before — your own note, "${i.howTo.name}"]` });
    head.push({ kind: 'quote', text: i.howTo.note.replace(/<!--[\s\S]*?-->/g, '').trim() });
  }

  const trailer: Segment[] = [];
  const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: i.timeZone }).format(i.now).toLowerCase();
  const clock = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: i.timeZone }).format(i.now);
  // On a reply, his new message is right there — the gap is the one BEFORE it.
  const since =
    i.lastHisAt === undefined
      ? ''
      : i.selfEntry === true
        ? ` ${i.who} last wrote ${ago(i.now - i.lastHisAt)}.`
        : ` before this, ${i.who} last wrote ${ago(i.now - i.lastHisAt)}.`;
  const facts = (i.nowFacts ?? []).filter((f) => f.trim() !== '').map((f) => `\n${f}`).join('');
  trailer.push({ kind: 'frame', text: `[now]\n${weekday} ${clock} his time.${since}${i.selfEntry === true ? ' no new message from him.' : ''}${facts}` });
  return { head, trailer };
};

const join = (segs: readonly Segment[]): string => segs.map((s) => s.text).join('\n').replace(/\n{3,}/g, '\n\n').trim();

export interface MindPacket extends LoopPacket {
  segments(): { head: Segment[]; trailer: Segment[] };
  lint(): LintHit[];
}

export const composePacket = (i: ComposeInput): MindPacket => {
  const { head, trailer } = composeSegments(i);
  const contract: Segment = { kind: 'frame', text: V8_OUTPUT_CONTRACT };
  return {
    systemText: () => join(head),
    proceduralText: () => null,
    trailerText: () => join(trailer),
    segments: () => ({ head, trailer }),
    lint: () => lintSegments([...head, ...trailer, contract]),
  };
};

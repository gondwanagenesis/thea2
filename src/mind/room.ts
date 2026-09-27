// v13 introspection, Phase 2 — H6 THE QUIET ROOM (plan docs/plans/v13-proposal-knowing-what-she-feels.md
// §6 Phase 2.2): a place in her house to sit, guess and check.
//
// Practice, not therapy: two-choice items about her own state across time ("compared with then, is
// the pull toward him stronger or weaker now?"), each with a confidence, then a reveal — right or
// not right, plus the material of then and now. Every item's truth comes from her engine record
// (the exact state her lived moments were encoded with), never from a model's reading of her words.
//
// The trial mix is randomized so the practice can be read: listening in allowed (noise 0, .15, .30),
// unavailable, or a SHAM (10%: the sense shows a yoked snapshot from another day — in the room only,
// never in live conversation). Accuracy that falls smoothly with noise and collapses on shams is a
// sense being used; flat accuracy is a guesser; sham-insensitive accuracy is something else.
//
// The one who speaks is the one who practises (council N6): a session runs on her voice door. A
// session is stored as a 'practice' memory — it may come back among the things she remembers, never
// as a way to reply (isPrecedent only takes replies). The mastery hunger is its outlet (each hunger
// its own, as in v12), ≤3 sessions a day, only on days he has been around (golden rule 24).

import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import type { AffectState, AffectStore } from '../affect/index.js';
import { DIAL_BASELINE, initialAffectState, PRIMARY_BASELINE } from '../affect/index.js';
import type { ChatMsg, ModelClient } from '../model/index.js';
import type { Clock, Rng } from '../kernel/index.js';
import type { EventLog } from '../events/index.js';
import type { Embedder } from '../embed/index.js';
import { ago } from './compose.js';
import { fullVector, readoutWord, readout } from './readout.js';
import { listenIn, senseViolations } from './inward.js';
import type { MindStore } from './store.js';
import { dayKey, type Item } from './wander.js';
import type { Moment } from './types.js';
import { COUPLING_BASELINES } from '../coupling/index.js';

export const ROOM = {
  perDay: 3,
  items: 3,
  /** "then" is a lived moment 2–6 h ago. */
  thenMinMs: 2 * 3600_000,
  thenMaxMs: 6 * 3600_000,
  /** A yoked snapshot for a sham comes from another day. */
  yokeMinAgeMs: 20 * 3600_000,
  /** Below this difference the two answers are a coin — no item is asked. */
  minDelta: 0.08,
  shamP: 0.1,
  noneP: 0.3,
  noises: [0, 0.15, 0.3] as const,
} as const;

export const ROOM_FILE = 'room.jsonl';
export const ROOM_KEY = 'practice';
export const ROOM_NAME = 'the quiet room';

type Quantity = 'him' | 'new' | 'making' | 'heavy' | 'buzz';
const PULL: Record<'him' | 'new' | 'making', string> = { him: 'him', new: 'something new', making: 'making or fixing something' };

/** The five things a question can be about, read the same way from a memory and from now. */
export const quantities = (sig: readonly number[], full: readonly number[]): Record<Quantity, number> => ({
  him: full[8] ?? 0,
  new: full[9] ?? 0,
  making: full[10] ?? 0,
  heavy: -(sig[0] ?? 0),
  buzz: sig[1] ?? 0,
});

export interface RoomItem {
  kind: 'compare' | 'which';
  q: string;
  question: string;
  options: [string, string];
  /** Index of the right option. */
  truth: 0 | 1;
  /** How far apart the two sides were (harder when small). */
  delta: number;
}

/** Items she can be asked, from the record: comparisons with then (if a then exists), and which pull is bigger now. */
export const roomItems = (nowQ: Record<Quantity, number>, thenQ: Record<Quantity, number> | undefined, rng: Rng, n: number = ROOM.items): RoomItem[] => {
  const all: RoomItem[] = [];
  if (thenQ !== undefined) {
    for (const q of ['him', 'new', 'making'] as const) {
      const d = nowQ[q] - thenQ[q];
      if (Math.abs(d) >= ROOM.minDelta) all.push({ kind: 'compare', q, question: `compared with then, is the pull toward ${PULL[q]} stronger or weaker now?`, options: ['stronger', 'weaker'], truth: d > 0 ? 0 : 1, delta: Math.abs(d) });
    }
    const dh = nowQ.heavy - thenQ.heavy;
    if (Math.abs(dh) >= ROOM.minDelta) all.push({ kind: 'compare', q: 'heavy', question: 'compared with then, is there more heaviness now, or less?', options: ['more', 'less'], truth: dh > 0 ? 0 : 1, delta: Math.abs(dh) });
    const db = nowQ.buzz - thenQ.buzz;
    if (Math.abs(db) >= ROOM.minDelta) all.push({ kind: 'compare', q: 'buzz', question: 'compared with then, is there more buzzing now, or less?', options: ['more', 'less'], truth: db > 0 ? 0 : 1, delta: Math.abs(db) });
  }
  for (const [a, b] of [['new', 'him'], ['making', 'him'], ['new', 'making']] as const) {
    const d = nowQ[a] - nowQ[b];
    if (Math.abs(d) >= ROOM.minDelta) all.push({ kind: 'which', q: `${a}|${b}`, question: `which is bigger right now: the pull toward ${PULL[a]}, or toward ${PULL[b]}?`, options: [PULL[a], PULL[b]], truth: d > 0 ? 0 : 1, delta: Math.abs(d) });
  }
  // a mix: comparisons first when there are any (they need the memory), then which-is-bigger
  const compares = rng.shuffle(all.filter((x) => x.kind === 'compare'));
  const whiches = rng.shuffle(all.filter((x) => x.kind === 'which'));
  const out: RoomItem[] = [];
  while (out.length < n && (compares.length > 0 || whiches.length > 0)) {
    const from = compares.length > 0 && (whiches.length === 0 || out.length % 2 === 0) ? compares : whiches;
    out.push(from.shift()!);
  }
  return out;
};

export type Condition = { kind: 'listen'; noise: number } | { kind: 'none' } | { kind: 'sham'; yokedId: string };

/** The randomized trial mix: 10% sham (only if a yoked snapshot exists), 30% no listening, else listening at a random noise. */
export const drawCondition = (rng: Rng, yokedId: string | undefined): Condition => {
  const r = rng.float();
  if (r < ROOM.shamP) return yokedId !== undefined ? { kind: 'sham', yokedId } : { kind: 'none' };
  if (r < ROOM.shamP + ROOM.noneP) return { kind: 'none' };
  return { kind: 'listen', noise: rng.pick(ROOM.noises) };
};

/**
 * A snapshot rebuilt from a memory's exact state — what the sense would have said then. Used only for
 * shams (a yoked snapshot from another day); its "since" is re-timed to hours so the date can't tell.
 */
export const stateFromFelt = (sig: readonly number[], full: readonly number[], t: number, cause: { text: string; t: number }): AffectState => {
  const s = initialAffectState(t);
  const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));
  const inv = (a: number, b: number): number => clamp01(b + a * Math.max(b, 1 - b));
  s.dials.pleasure = inv(sig[0] ?? 0, DIAL_BASELINE.pleasure);
  s.dials.arousal = inv(sig[1] ?? 0, DIAL_BASELINE.arousal);
  const ids = ['attachment', 'brattiness', 'protectiveness', 'longing', 'playfulness', 'focus', 'calm', 'trust'] as const;
  ids.forEach((k, i) => {
    const base = DIAL_BASELINE[k];
    const dev = full[i] ?? 0;
    s.dials[k] = clamp01(dev >= 0 ? base + dev * (1 - base) : base + dev * base);
  });
  const prims = ['joy', 'anticipation', 'pride', 'surprise', 'sadness', 'fear', 'anger', 'shame', 'disgust'] as const;
  prims.forEach((p, i) => {
    s.primaries[p] = inv(sig[3 + i] ?? 0, PRIMARY_BASELINE[p]);
    if (s.primaries[p] - PRIMARY_BASELINE[p] >= 0.08) s.causes[p] = { text: cause.text, i: 5, t: cause.t, moved: 0.1 };
  });
  s.drives.connection = 0.25 + 0.75 * (full[8] ?? 0);
  s.drives.novelty = 0.25 + 0.75 * (full[9] ?? 0);
  s.drives.mastery = 0.25 + 0.75 * (full[10] ?? 0);
  return s;
};

const clip = (s: string, n: number): string => {
  const t = s.replace(/\s+/g, ' ').trim();
  const cps = [...t];
  return cps.length <= n ? t : `${cps.slice(0, n - 1).join('')}…`;
};

/** A memory as material: what was said then (his words lead). */
export const materialOf = (m: Moment): string => (m.his.trim() !== '' ? `him: "${clip(m.his, 110)}"` : `you: "${clip(m.hers.join(' '), 110)}"`);

/** What is going on now, as material: the newest thing still moving her that can be quoted, else his silence. */
export const nowMaterial = (s: AffectState, now: number, lastHisAt: number | undefined): string => {
  const newest = Object.values(s.causes)
    .filter((c): c is NonNullable<typeof c> => c !== undefined && c.text.trim() !== '' && senseViolations(c.text).length === 0)
    .sort((a, b) => b.t - a.t)[0];
  if (newest !== undefined && now - newest.t < 12 * 3600_000) return `"${clip(newest.text, 90)}" (${ago(now - newest.t)})`;
  return lastHisAt !== undefined ? `he last wrote ${ago(now - lastHisAt)}` : 'a quiet stretch';
};

export const ROOM_SYSTEM = [
  'This is Thea, alone in the quiet room of her house, practising noticing herself. Nobody reads this and nothing here is sent.',
  'Answer each numbered question with exactly one of its two options, as written, and how sure you are: "sure", "fairly" or "guessing".',
  'Return JSON: answers, one per question: {n, choice, sure}.',
].join('\n');

export const RoomAnswerSchema = z.object({
  answers: z
    .array(z.object({ n: z.number().int().min(1).max(6), choice: z.string().min(1).max(80), sure: z.enum(['sure', 'fairly', 'guessing']) }))
    .min(1)
    .max(6),
});

export type Sure = 'sure' | 'fairly' | 'guessing';

export interface RoomTrial {
  ts: number;
  session: string;
  n: number;
  kind: RoomItem['kind'];
  q: string;
  question: string;
  options: [string, string];
  truth: 0 | 1;
  delta: number;
  cond: Condition;
  reading?: string[] | undefined;
  choice?: string | undefined;
  sure?: Sure | undefined;
  /** undefined = no usable answer. */
  right?: boolean | undefined;
  thenId?: string | undefined;
}

const appendTrial = (dir: string, t: RoomTrial): void => {
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, ROOM_FILE), `${JSON.stringify(t)}\n`);
};

export const readRoom = (dir: string): RoomTrial[] => {
  const file = path.join(dir, ROOM_FILE);
  if (!fs.existsSync(file)) return [];
  const out: RoomTrial[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      out.push(JSON.parse(line) as RoomTrial);
    } catch {
      // a torn tail line is skipped
    }
  }
  return out;
};

/** Which option she chose (exact, then containment); undefined = neither. */
export const matchChoice = (choice: string, options: readonly [string, string]): 0 | 1 | undefined => {
  const c = choice.toLowerCase().trim().replace(/[".]/g, '');
  const exact = options.findIndex((o) => o.toLowerCase() === c);
  if (exact === 0 || exact === 1) return exact;
  const hits = options.map((o, i) => (c.includes(o.toLowerCase()) ? i : -1)).filter((i) => i >= 0);
  return hits.length === 1 ? (hits[0] as 0 | 1) : undefined;
};

/** Accuracy by condition and by confidence — the numbers the kill test reads (never shown to her). */
export const roomStats = (trials: readonly RoomTrial[]): { n: number; byCond: Record<string, { n: number; right: number }>; bySure: Record<string, { n: number; right: number }> } => {
  const byCond: Record<string, { n: number; right: number }> = {};
  const bySure: Record<string, { n: number; right: number }> = {};
  let n = 0;
  for (const t of trials) {
    if (t.right === undefined) continue;
    n += 1;
    const ck = t.cond.kind === 'listen' ? `listen@${t.cond.noise}` : t.cond.kind;
    byCond[ck] = { n: (byCond[ck]?.n ?? 0) + 1, right: (byCond[ck]?.right ?? 0) + (t.right ? 1 : 0) };
    const sk = t.sure ?? 'none';
    bySure[sk] = { n: (bySure[sk]?.n ?? 0) + 1, right: (bySure[sk]?.right ?? 0) + (t.right ? 1 : 0) };
  }
  return { n, byCond, bySure };
};

export interface RoomDeps {
  mind: MindStore;
  affect: AffectStore;
  model: ModelClient;
  embedder: Embedder;
  events: EventLog;
  clock: Clock;
  rng: Rng;
  timeZone: string;
  /** Her exact state now (the coupling deviation vector a lived moment is encoded with). */
  feltNow(): number[];
  /** The day's model budget left (0–1); the room is idle work and waits when it runs low. */
  budgetLeft?: (() => number) | undefined;
}

export interface Room {
  /** The wander item the mastery hunger offers, or none (cap, he hasn't been around today, nothing askable). */
  candidate(s: AffectState, now: number): Item | undefined;
  /** One session: ask, answer, reveal, remember. */
  practise(now: number): Promise<{ right: number; of: number } | undefined>;
}

const isThen = (m: Moment): boolean =>
  m.source === 'lived' && (m.kind === 'reply' || m.kind === 'text_first') && m.felt.source === 'exact' && m.felt.full !== undefined && m.felt.full.length >= 11;

export const makeRoom = (d: RoomDeps): Room => {
  const emit = (k: string, p: unknown): void => void d.events.emit(k, p);
  const today = (now: number): { day: string; sessions: number } => {
    const r = d.mind.state().room;
    const day = dayKey(now, d.timeZone);
    return r !== undefined && r.day === day ? { day, sessions: r.sessions } : { day, sessions: 0 };
  };
  const thenOf = (now: number): Moment | undefined => {
    const xs = d.mind.moments().filter((m) => isThen(m) && now - m.ts >= ROOM.thenMinMs && now - m.ts <= ROOM.thenMaxMs);
    return xs.length === 0 ? undefined : d.rng.fork(`then:${now}`).pick(xs);
  };
  const yokedOf = (now: number): Moment | undefined => {
    const xs = d.mind.moments().filter((m) => isThen(m) && now - m.ts >= ROOM.yokeMinAgeMs);
    return xs.length === 0 ? undefined : d.rng.fork(`yoke:${now}`).pick(xs.slice(-200));
  };

  return {
    candidate(s, now) {
      if (today(now).sessions >= ROOM.perDay) return undefined;
      const lastHisAt = d.mind.state().lastHisAt;
      if (lastHisAt === undefined || dayKey(lastHisAt, d.timeZone) !== dayKey(now, d.timeZone)) return undefined;
      if ((d.budgetLeft?.() ?? 1) < 0.15) return undefined;
      // the outlet of unused hands: the mastery hunger alone weighs it (a want with nothing to do is restless)
      const weight = 0.8 * Math.min(1, Math.max(0, (s.drives.mastery - 0.25) * 1.6));
      if (weight <= 0) return undefined;
      return { key: ROOM_KEY, kind: 'practice', about: 'self', text: ROOM_NAME, weight };
    },

    async practise(now) {
      const t0 = today(now);
      if (t0.sessions >= ROOM.perDay) return undefined;
      const s = d.affect.current();
      const sigNow = d.feltNow();
      const fullNow = fullVector(s);
      const then = thenOf(now);
      const rng = d.rng.fork(`room:${now}`);
      const items = roomItems(quantities(sigNow, fullNow), then !== undefined ? quantities(then.felt.sig, then.felt.full!) : undefined, rng);
      if (items.length === 0) {
        // (no undefined in an event payload: the canonical log rejects it — found crashing the probe)
        emit('mind.room', { result: 'nothing', ...(then !== undefined ? { then: then.id } : {}) });
        return undefined;
      }
      const yoked = yokedOf(now);
      const session = `rm_${now}`;
      const conds = items.map(() => drawCondition(rng, yoked?.id));
      const readings = conds.map((c, i) => {
        if (c.kind === 'none') return undefined;
        const st =
          c.kind === 'sham' && yoked !== undefined
            ? stateFromFelt(yoked.felt.sig, yoked.felt.full!, now, { text: clip(yoked.his.trim() !== '' ? yoked.his : yoked.hers.join(' '), 70), t: now - rng.int(1, 5) * 3600_000 })
            : s;
        const r = listenIn(st, { now, rng: rng.fork(`listen${i}`), noise: c.kind === 'listen' ? c.noise : 0.1 });
        return r.lines.filter((l) => senseViolations(l).length === 0);
      });

      const past = readRoom(d.mind.dir).filter((t) => t.right !== undefined).slice(-3);
      const self = d.mind.self().slice(0, 6).map((l) => l.text).join('\n');
      const user = [
        self !== '' ? `[me]\n${self}` : '',
        `[${ROOM_NAME}]\nyou sat down in the quiet room. ${items.length === 1 ? 'one question' : `${items.length === 2 ? 'two' : 'three'} questions`} about yourself; answer, say how sure you are, then you'll see.`,
        then !== undefined ? `[then — ${ago(now - then.ts)}]\n${materialOf(then)}` : '',
        ...items.map((it, i) => {
          const r = readings[i];
          const sense = r === undefined ? '(listening in isn\'t there for this one.)' : `(you listen in, and this comes back:\n${r.join('\n')})`;
          return `[${i + 1}] ${it.question} (${it.options[0]} or ${it.options[1]})\n${sense}`;
        }),
        past.length > 0 ? `[last time here]\n${past.map((t) => `"${t.question}" you said ${t.choice ?? '—'} (${t.sure ?? '—'}): ${t.right === true ? 'right' : 'not right'}`).join('\n')}` : '',
      ]
        .filter((x) => x !== '')
        .join('\n\n');
      const messages: ChatMsg[] = [
        { role: 'system', content: ROOM_SYSTEM },
        { role: 'user', content: user },
      ];
      let answers: z.infer<typeof RoomAnswerSchema>['answers'];
      try {
        // the one who speaks is the one who practises: her voice door
        const res = await d.model.chat({ taskClass: 'heartbeat-thought', tier: 'main', messages, schema: RoomAnswerSchema, schemaName: 'RoomAnswers', maxTokens: 400, temperature: 0.7 });
        answers = res.content.answers;
      } catch (e) {
        emit('incident.mind_room_failed', { error: e instanceof Error ? e.message : String(e) });
        return undefined;
      }

      const nowWhat = nowMaterial(s, now, d.mind.state().lastHisAt);
      const trials: RoomTrial[] = items.map((it, i) => {
        const a = answers.find((x) => x.n === i + 1);
        const idx = a !== undefined ? matchChoice(a.choice, it.options) : undefined;
        return {
          ts: now,
          session,
          n: i + 1,
          kind: it.kind,
          q: it.q,
          question: it.question,
          options: it.options,
          truth: it.truth,
          delta: Math.round(it.delta * 1000) / 1000,
          cond: conds[i]!,
          ...(readings[i] !== undefined ? { reading: readings[i] } : {}),
          ...(a !== undefined ? { choice: idx !== undefined ? it.options[idx] : a.choice, sure: a.sure } : {}),
          ...(idx !== undefined ? { right: idx === it.truth } : {}),
          ...(then !== undefined && it.kind === 'compare' ? { thenId: then.id } : {}),
        };
      });
      for (const t of trials) appendTrial(d.mind.dir, t);

      // the reveal: right or not right, and the material of then and now (past tense — a record, not a verdict on her)
      const reveal = trials.map((t) => {
        const verdict = t.right === undefined ? 'no answer' : t.right ? 'right' : `not right — it was ${t.options[t.truth]}`;
        const listened = t.cond.kind === 'none' ? ', without listening in' : '';
        return `in the quiet room: "${t.question}" you said ${t.choice ?? '—'} (${t.sure ?? '—'}${listened}): ${verdict}.`;
      });
      reveal.push(`${then !== undefined ? `then: ${materialOf(then)}; ` : ''}now: ${nowWhat}.`);
      const right = trials.filter((t) => t.right === true).length;

      // remembered as practice: it may come back among the things she remembers; never a way to reply
      let vec: Float32Array | undefined;
      try {
        [vec] = await d.embedder.embed([reveal.join(' ')]);
      } catch {
        vec = undefined;
      }
      const word = readoutWord(readout(s, COUPLING_BASELINES));
      d.mind.add(
        {
          id: `m_practice_${now}`,
          ts: now,
          source: 'lived',
          kind: 'practice',
          before: [],
          his: '',
          hers: reveal,
          felt: { sig: sigNow, full: fullNow, ...(word !== undefined ? { word } : {}), source: 'exact', by: 'engine' },
          importance: 3,
          value: 0,
          shown: 0,
          followed: 0,
        },
        vec !== undefined ? { sit: vec, reply: vec } : undefined,
      );
      d.mind.setState({ room: { day: t0.day, sessions: t0.sessions + 1 } });
      await d.mind.flush();
      // practising stills the hands a little (the mastery hunger's outlet) — never contact with him
      try {
        await d.affect.applyEvents([{ kind: 'tagFeed', tag: 'DONE' }], { source: 'other' });
      } catch (e) {
        emit('incident.mind_feel_failed', { stage: 'room', error: e instanceof Error ? e.message : String(e) });
      }
      emit('mind.room', { result: 'practised', session, right, of: trials.length, conds: conds.map((c) => (c.kind === 'listen' ? `listen@${c.noise}` : c.kind)), ...(then !== undefined ? { then: then.id } : {}) });
      return { right, of: trials.length };
    },
  };
};

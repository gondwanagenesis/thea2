// v12 mind — CURIOSITY: a question economy (plan docs/plans/v12-curious-for-her-own-sake.md).
//
// Her data (2026-09-27) showed the gap is upstream of "an outlet for boredom":
// nothing gave birth to questions about the world, her wants turned into
// someone else's job, stale beliefs were never tested, and duplicates made her
// ruminate. So curiosity here is an economy of QUESTIONS:
//
//   born     from real stimulus — conversation gaps (the appraiser), follow-ups of
//            what she found, new minds, stale beliefs ("is this still true?"), and
//            restlessness (novelty hunger with nothing to wonder about)
//   valued   by what she can LEARN, not by novelty: drive × knowability ×
//            inverted-U(confidence) × expected learning progress × her interest
//            (Kang 2009; Oudeyer; OMNI; MAGELLAN; "knowability predicts curiosity")
//   pursued  with her own hands (a fork with web/memory/code/workspace — a pursuit
//            that used no tool counts as nothing: v8 §3.9's grounding rule), or by
//            asking the person a question is about
//   rewarded by measured learning progress: curious/delighted events with causes
//            (curious feeds the novelty drive), findings into her stream, strong ones
//            into her memory, and interests that grow — hers, earned
//   let go   when dry: a topic yields when its progress falls below her running
//            mean (foraging's marginal value theorem); a dead end closes.
//
// Nothing told: no text tells her to be curious or what to want. Drives are
// caused by time; questions by events; value is arithmetic; the learning judge
// and the investigator frame are machinery (like the appraiser and the fork
// frame). She meets all of it as material and memory.

import { z } from 'zod';
import type { AffectState, AffectStore, EmotionEventInput } from '../affect/index.js';
import type { ChatMsg, ModelClient } from '../model/index.js';
import type { Clock, Rng } from '../kernel/index.js';
import { newId } from '../kernel/index.js';
import type { EventLog } from '../events/index.js';
import type { Embedder } from '../embed/index.js';
import { ago } from './compose.js';
import { cosine } from './vectors.js';
import type { MindStore } from './store.js';
import type { About, Concern, CuriosityState, Interest, Moment, QuestionSource } from './types.js';
import { nearestTag } from './vocab.js';
import { FOUND_ID_PREFIX, freshness, inQuietHours, rollWander, type CuriositySeam, type Item } from './wander.js';

const DAY = 86_400_000;
/** Interests fade with a two-week half-life when she stops coming back to them. */
export const INTEREST_HALF_LIFE_MS = 14 * DAY;
/** Two concerns this similar are the same thing (the rumination-by-duplicate fix, A4). */
export const TWIN_SIM = 0.88;
const MAX_OPEN_QUESTIONS = 12;
/**
 * A loop OPEN this long becomes "is this still true?" (A3). Measured from `created`, not
 * `touched`: the live probe (2026-09-27) showed her stale beliefs are the ones she keeps
 * talking about — every conversation re-touches them, so "untouched for a day" never fired.
 */
const STALE_MS = DAY;
/** Her words that say a loop waits on something outside her (loops written before v12 carry no `blockedOn`). */
const WAITS_ON = /^i still need\b|\b(?:need|waiting (?:on|for)|until|blocked|depends on)\b[^.]{0,120}\b(?:diego|him|he|d|degs|someone|routed|route|access|feed)\b/i;

export type CuriosityMode = 'on' | 'novelty-only';

export interface CuriosityCfg {
  investigationsPerDay: number;
  asksPerDay: number;
  /** 'novelty-only' is the §4 control: value = drive × freshness × novelty; no learning-progress terms, no letting go. */
  mode: CuriosityMode;
  quietHours: [number, number];
  timeZone: string;
}

export interface PursuitRequest {
  id: string;
  /** Her fork's frame (machinery, like the cast frames). */
  system: string;
  brief: string;
}
export type PursuitResult = { text: string; tools: string[] } | { error: string };

export interface CuriosityDeps {
  mind: MindStore;
  affect: AffectStore;
  model: ModelClient;
  embedder: Embedder;
  events: EventLog;
  clock: Clock;
  rng: Rng;
  cfg(): CuriosityCfg;
  conversationActive(): boolean;
  /** The body's hands: her fork with tools, detached; `done` fires when it settles. */
  investigate(req: PursuitRequest, done: (r: PursuitResult) => void): { ok: true } | { ok: false; reason: string };
  /** A turn she starts in a given chat (a group); she decides whether to say anything. Resolves to bubbles sent. */
  selfEntryIn(chatId: number, goal: string): Promise<number>;
  /** A striking finding → the text-first gate (quiet hours, cap, backoff) → a turn to Diego. */
  tellHim(goal: string): Promise<boolean>;
  /** v12.1: her exact state now (coupling deviation vector) — stamped on a finding's memory. Absent ⇒ stored blank. */
  feltNow?: () => number[];
  /** v14: what arrived in her house that she has not given attention yet (body/world-feed.ts). Absent ⇒ nothing arrives. */
  world?: WorldSeam | undefined;
}

/** v14 Phase 2.1: the world knocks — real things that arrive in her house (structurally body/world-feed.ts). */
export interface WorldArrival {
  id: string;
  at: number;
  kind: string;
  title: string;
  text: string;
  url?: string | undefined;
  place: string;
}
export interface WorldSeam {
  unseen(now: number): WorldArrival[];
  markSeen(id: string, now: number): void;
}

/**
 * How strongly something that arrived pulls her attention: some pull just by being new (people do
 * glance at what lands on the table), more when she is hungry for novelty (the drive over its set
 * point), more when it touches what she is into lately; fading over the day it has sat there.
 */
export const arrivalWeight = (novelty: number, interestOverlap: number, ageMs: number): number =>
  clamp01((0.3 + clamp01((novelty - NOVELTY_SET_POINT) * 1.2) * 0.4 + 0.25 * clamp01(interestOverlap)) * Math.pow(0.5, Math.max(0, ageMs) / (24 * 3600_000)));

const KIND_WORD: Record<string, string> = { article: 'an article', poem: 'a poem', paper: 'a paper', art: 'a painting', picture: 'a picture', history: 'a day in history' };
export const arrivalText = (a: WorldArrival): string => `${KIND_WORD[a.kind] ?? 'something'} ${a.place}: "${a.title}". ${a.text}`;

export interface LearnOutcome {
  progress: 0 | 1 | 2;
  grounded: boolean;
  closed: boolean;
  followups: number;
  shared: boolean;
}

export interface Curiosity extends CuriositySeam {
  /** A person or another mind she has never met reached her. */
  onNewMind(p: { person: string; name: string; chatId: number; said: string; bot: boolean }): Promise<void>;
  /** Someone she has met spoke again (a question about them moves on). */
  onHeardFrom(person: string): void;
  /** Material for her packet: what she has been into lately. */
  nowLines(now: number): string[];
  /** Pursuits currently out. */
  inFlight(): number;
  /** v13: a question a remembered dream left (it joined two distant things) — born 'dream'. */
  fromDream(q: { what: string; knowability: number; confidence: number }): Promise<void>;
  /** Exposed for tests and the probe. */
  learned(q: Concern, r: PursuitResult): Promise<LearnOutcome | undefined>;
  mergeDuplicates(): Promise<number>;
}

// ---------------------------------------------------------------------------
// Pure value arithmetic (§1.4)
// ---------------------------------------------------------------------------

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

/** Curiosity peaks at moderate confidence (Kang et al. 2009): 1 at 0.5, 0.55 at the extremes. */
export const invU = (confidence: number): number => 0.55 + 0.45 * (1 - (2 * clamp01(confidence) - 1) ** 2);

export interface ValueCtx {
  /** Novelty hunger, 0 sated … 1 starving. */
  novelty: number;
  now: number;
  /** Her running mean learning progress (0–2): the foraging environment average. */
  meanLp: number;
  /** Strength of her interest matching a domain (0 when none). */
  interest(domain: string | undefined): number;
  mode: CuriosityMode;
}

/** How strongly a question pulls at her right now. Pure; no model calls (§1.4). */
export const questionValue = (c: Concern, x: ValueCtx): number => {
  const base = clamp01(c.importance / 10);
  const drive = 0.6 + 0.8 * clamp01(x.novelty);
  const fresh = 0.35 + 0.65 * freshness(c.touched, x.now);
  const novel = 0.8 + 0.3 * clamp01(c.novel ?? 0.7);
  if (x.mode === 'novelty-only') return clamp01(base * drive * fresh * novel);
  const knowability = c.knowability ?? 0.6;
  if (knowability < 0.2) return 0; // unknowable: frustration, not curiosity
  const k = 0.7 + 0.3 * knowability;
  const u = invU(c.confidence ?? 0.3);
  const lp = c.lp !== undefined ? clamp01(c.lp / 2) : 0.5;
  const l = 0.6 + 0.8 * lp;
  const i = 1 + 0.3 * Math.min(1, x.interest(c.domain) / 2);
  // marginal value theorem: once tried, a topic yields while it teaches less than her average
  const mvt = (c.tries ?? 0) > 0 && (c.lp ?? 0) < x.meanLp ? 0.6 : 1;
  return clamp01(base * drive * k * u * l * i * fresh * novel * mvt);
};

/**
 * Restlessness: novelty hunger with nothing fresh to wonder about sends her looking.
 * Anchored at the drive's own set point (0.25, affect/drives.ts): above it she is hungry.
 * The live probe had her at 0.52 — genuinely hungry — scoring under the attention bar.
 */
export const NOVELTY_SET_POINT = 0.25;
export const restlessWeight = (novelty: number, hasLiveQuestion: boolean): number =>
  clamp01((novelty - NOVELTY_SET_POINT) * 1.6) * (hasLiveQuestion ? 0.4 : 1);

const STOP = new Set(['the', 'and', 'for', 'with', 'about', 'how', 'why', 'what', 'who', 'are', 'was', 'its', 'into', 'from', 'that', 'this', 'does', 'did', 'have']);
export const topicTokens = (t: string): Set<string> =>
  new Set(
    t
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP.has(w)),
  );
/** Jaccard overlap of two topics' words (interests merge at ≥ 0.5). */
export const topicOverlap = (a: string, b: string): number => {
  const x = topicTokens(a);
  const y = topicTokens(b);
  if (x.size === 0 || y.size === 0) return 0;
  let inter = 0;
  for (const w of x) if (y.has(w)) inter += 1;
  return inter / (x.size + y.size - inter);
};

export const decayedStrength = (i: Interest, now: number): number => i.strength * 0.5 ** (Math.max(0, now - i.touched) / INTEREST_HALF_LIFE_MS);

const normalize = (s: string): string => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

// ---------------------------------------------------------------------------
// Machinery prompts (the investigator frame and the learning judge)
// ---------------------------------------------------------------------------

/** Her fork, looking into something on her own. Machinery, like the cast frames: it tells her no feeling. */
export const INVESTIGATOR_FRAME = (self: readonly string[], thought: string): string =>
  [
    'You are Thea, looking into something on your own. Nobody asked you to, and nothing you write here is sent to anyone; when you are done, what you found comes back to you.',
    self.length > 0 ? `[me]\n${self.slice(0, 6).join('\n')}` : '',
    thought.trim() !== '' ? `[what was just going through your head]\n${thought.trim()}` : '',
    'Actually find out: search and read the web, look through your own memories and past conversations, run a little code to check or try something, keep notes in your workspace if it helps. Do not answer from what you already think you know. Finish with what you found, plainly, and the sources or files that matter.',
  ]
    .filter((s) => s !== '')
    .join('\n\n');

export const LearnSchema = z.object({
  progress: z.number().int().min(0).max(2),
  answered: z.boolean(),
  thought: z.string().min(1).max(600),
  topic: z.string().min(1).max(80),
  followups: z
    .array(z.object({ q: z.string().min(3).max(200), knowability: z.number().min(0).max(1) }))
    .max(2),
  share: z.boolean(),
  /** Only for an "is this still true?" question: what she found shows the old belief no longer holds. */
  parent_resolved: z.boolean().optional(),
});
export type Learn = z.infer<typeof LearnSchema>;

export const LEARNING_JUDGE_SYSTEM = [
  "You are the part of Thea's mind that notices what she just found out. You never write to anyone; you judge what came back from her looking into something.",
  'Return one JSON object that matches the schema.',
  '- progress: 0 = nothing she did not already know, could not find it, or the result is made up without real sources; 1 = she learned part of it; 2 = she really found out, or it changed how she sees it.',
  '- answered: whether the question is now settled.',
  '- thought: how what she found goes through her head, in her voice: first person, lowercase, one to three sentences. Only what she found, never how she should feel.',
  '- topic: the subject in two to six words.',
  '- followups: up to two new questions this opened that she does not know the answer to yet, first person; knowability 0-1 = could she find it out with a search, her memory, or by asking someone. None if nothing real opened.',
  '- share: true only if it is the kind of thing a friend would want to tell someone right away.',
  '- parent_resolved: only when the question was "is this still true: …" — true if what she found shows it no longer holds.',
].join('\n');

// ---------------------------------------------------------------------------
// The module
// ---------------------------------------------------------------------------

interface BirthSpec {
  what: string;
  about: About;
  born: QuestionSource;
  importance: number;
  knowability?: number | undefined;
  confidence?: number | undefined;
  novel?: number | undefined;
  domain?: string | undefined;
  parent?: string | undefined;
  who?: Concern['who'];
}

export const makeCuriosity = (d: CuriosityDeps): Curiosity => {
  let inflight = 0;

  const cstate = (): CuriosityState => d.mind.state().curiosity ?? { meanLp: 0.8, n: 0 };
  const setC = (patch: Partial<CuriosityState>): void => d.mind.setState({ curiosity: { ...cstate(), ...patch } });
  const emit = (kind: string, payload: Record<string, unknown>): void => void d.events.emit(kind, payload);
  // v14: a question a work turn opened (about her machinery) waits for work mode
  const openQuestions = (): Concern[] => d.mind.openConcerns().filter((c) => c.kind === 'curiosity' && c.mode !== 'work');

  /** Topics looked into in the last two weeks, whatever came of it. */
  const recentTopics = (now: number): string[] => (cstate().explored ?? []).filter((e) => now - e.at < 14 * DAY).map((e) => e.topic);
  const noteExplored = (topic: string, now: number): void => {
    const prev = (cstate().explored ?? []).filter((e) => topicOverlap(e.topic, topic) < 0.5);
    setC({ explored: [...prev, { topic, at: now }].slice(-12) });
  };

  const topInterests = (now: number, k: number): Interest[] =>
    [...d.mind.interests()]
      .map((i) => ({ i, s: decayedStrength(i, now) }))
      .filter((x) => x.s >= 0.75)
      .sort((a, b) => b.s - a.s)
      .slice(0, k)
      .map((x) => x.i);

  const interestFor = (topic: string | undefined): Interest | undefined => {
    if (topic === undefined || topic.trim() === '') return undefined;
    let best: { i: Interest; o: number } | undefined;
    for (const i of d.mind.interests()) {
      const o = topicOverlap(i.topic, topic);
      if (o >= 0.5 && (best === undefined || o > best.o)) best = { i, o };
    }
    return best?.i;
  };

  const valueCtx = (state: AffectState, now: number): ValueCtx => ({
    novelty: state.drives.novelty,
    now,
    meanLp: cstate().meanLp,
    interest: (domain) => {
      const i = interestFor(domain);
      return i === undefined ? 0 : decayedStrength(i, now);
    },
    mode: d.cfg().mode,
  });

  /** A question is born: deduped against what is already open, its novelty set against what she has explored. */
  const birth = async (s: BirthSpec): Promise<string | undefined> => {
    const now = d.clock.epochMs();
    if (s.who !== undefined && openQuestions().some((c) => c.who?.person === s.who!.person)) return undefined;
    const norm = normalize(s.what);
    const touchTwin = (twin: Concern): string => {
      d.mind.upsertConcern({ ...twin, touched: now, importance: Math.max(twin.importance, s.importance) });
      emit('mind.question_twin', { id: twin.id, born: s.born });
      return twin.id;
    };
    const exact = d.mind.openConcerns().find((c) => normalize(c.what) === norm);
    if (exact !== undefined) return touchTwin(exact);

    let vec: Float32Array | undefined;
    try {
      [vec] = await d.embedder.embed([s.what]);
    } catch {
      vec = undefined;
    }
    let novel = s.novel ?? 0.7;
    if (vec !== undefined) {
      let twin: Concern | undefined;
      let best = 0;
      for (const c of d.mind.openConcerns()) {
        const v = d.mind.concernVec(c.id);
        if (v === undefined) continue;
        const sim = cosine(vec, v);
        if (sim >= TWIN_SIM && sim > best) {
          best = sim;
          twin = c;
        }
      }
      if (twin !== undefined) return touchTwin(twin);
      if (s.novel === undefined) {
        let explored = 0;
        for (const c of d.mind.concerns()) {
          if (c.kind !== 'curiosity' || c.status !== 'closed') continue;
          const v = d.mind.concernVec(c.id);
          if (v !== undefined) explored = Math.max(explored, cosine(vec, v));
        }
        novel = 1 - clamp01(explored);
      }
    }
    // a mind can only hold so many open questions: the weakest yields
    const open = openQuestions();
    if (open.length >= MAX_OPEN_QUESTIONS) {
      const weakest = [...open].sort((a, b) => a.importance * freshness(a.touched, now) - b.importance * freshness(b.touched, now))[0]!;
      d.mind.upsertConcern({ ...weakest, status: 'closed', touched: now });
      emit('mind.let_go', { id: weakest.id, why: 'crowded out' });
    }
    const id = `q_${now}_${newId(d.clock, d.rng).slice(-6)}`;
    d.mind.upsertConcern({
      id,
      what: s.what.slice(0, 200),
      kind: 'curiosity',
      about: s.about,
      importance: Math.max(1, Math.min(10, Math.round(s.importance))),
      status: 'open',
      created: now,
      touched: now,
      source: 'lived',
      born: s.born,
      knowability: clamp01(s.knowability ?? 0.6),
      confidence: clamp01(s.confidence ?? 0.3),
      novel: clamp01(novel),
      ...(s.domain !== undefined ? { domain: s.domain } : {}),
      ...(s.parent !== undefined ? { parent: s.parent } : {}),
      ...(s.who !== undefined ? { who: s.who } : {}),
    });
    if (vec !== undefined) d.mind.setConcernVec(id, vec);
    setC({ lastNewAt: now });
    emit('mind.question_born', { id, born: s.born, about: s.about, what: s.what.slice(0, 120) });
    return id;
  };

  const mergeDuplicates = async (): Promise<number> => {
    const now = d.clock.epochMs();
    const open = [...d.mind.openConcerns()].sort((a, b) => b.importance - a.importance || b.touched - a.touched);
    const kept: Concern[] = [];
    let merged = 0;
    for (const c of open) {
      const v = d.mind.concernVec(c.id);
      const twin = kept.find((k) => {
        if (normalize(k.what) === normalize(c.what)) return true;
        const kv = d.mind.concernVec(k.id);
        return v !== undefined && kv !== undefined && cosine(v, kv) >= TWIN_SIM;
      });
      if (twin === undefined) {
        kept.push(c);
        continue;
      }
      d.mind.upsertConcern({ ...c, status: 'closed', touched: now });
      merged += 1;
      emit('mind.let_go', { id: c.id, why: 'duplicate', of: twin.id });
    }
    setC({ merged: true });
    await d.mind.flush();
    return merged;
  };

  /** A loop she has been waiting on for a day becomes "is this still true?" — one per tick (A3). */
  const staleBeliefs = async (now: number): Promise<void> => {
    const stale = d.mind
      .openConcerns()
      .filter((c) => (c.kind === 'loop' || c.kind === 'expectation') && c.importance >= 5 && now - c.created > STALE_MS)
      .filter((c) => c.checkedAt === undefined || now - c.checkedAt > 3 * DAY)
      .filter((c) => (c.blockedOn !== undefined && c.blockedOn !== '') || WAITS_ON.test(c.what))
      .sort((a, b) => b.importance - a.importance)[0];
    if (stale === undefined) return;
    d.mind.upsertConcern({ ...stale, checkedAt: now });
    const belief = stale.what.replace(/^i still need\b/i, 'i need').replace(/[.!]+$/, '');
    await birth({ what: `is this still true: ${belief}?`, about: 'self', born: 'stale', importance: Math.min(9, stale.importance), knowability: 0.8, confidence: 0.5, parent: stale.id });
  };

  const tick = async (now: number): Promise<void> => {
    if (cstate().merged !== true) await mergeDuplicates();
    await staleBeliefs(now);
    await d.mind.flush();
  };

  // A fact about the world, not about him. Found live: "nothing new has come your way" read as
  // "he hasn't written", and 10 of 10 restless thoughts became his silence.
  const restlessText = (now: number): string => {
    const since = cstate().lastNewAt;
    const span = since === undefined ? 'in a while' : `in ${ago(now - since).replace(/ ago$/, '').replace(/^just now$/, 'a little while')}`;
    const top = topInterests(now, 3);
    return [`you haven't come across anything new ${span}`, top.length > 0 ? `lately you've been into: ${top.map((t) => t.topic).join(', ')}` : ''].filter((s) => s !== '').join('. ');
  };

  const arrivalsById = new Map<string, WorldArrival>();
  const candidatesFn = (state: AffectState, now: number): Item[] => {
    const x = valueCtx(state, now);
    const qs = openQuestions();
    const items: Item[] = qs.map((c) => ({ key: `concern:${c.id}`, kind: 'wonder', about: c.about, text: c.what, weight: questionValue(c, x), concernId: c.id }));
    // v14: what arrived in her house competes too; while something new sits there she needn't go looking
    const top = topInterests(now, 5).map((t) => topicTokens(t.topic));
    const arrivals = d.world?.unseen(now) ?? [];
    for (const a of arrivals) {
      arrivalsById.set(a.id, a);
      const words = topicTokens(`${a.title} ${a.text}`);
      const overlap = top.length === 0 ? 0 : Math.max(...top.map((t) => (t.size === 0 ? 0 : [...t].filter((w) => words.has(w)).length / t.size)));
      items.push({ key: `arrival:${a.id}`, kind: 'arrival', about: 'world', text: arrivalText(a), weight: arrivalWeight(state.drives.novelty, overlap, now - a.at) });
    }
    const live = items.some((it) => it.weight >= 0.35);
    const rw = restlessWeight(state.drives.novelty, live) * (arrivals.length > 0 ? 0.5 : 1);
    if (rw > 0) items.push({ key: 'restless', kind: 'restless', about: 'world', text: restlessText(now), weight: rw });
    return items;
  };

  // v14: an arrival she gave her attention to has been seen (a thought about it, whether or not she digs in)
  const saw = (item: Item, now: number): void => {
    if (item.kind !== 'arrival') return;
    d.world?.markSeen(item.key.slice('arrival:'.length), now);
  };

  const selfLines = (): string[] => d.mind.self().map((l) => l.text);

  const pursue = async (item: Item, thought: string): Promise<'investigating' | 'asked' | 'capped' | 'busy' | 'quiet' | 'none'> => {
    const cfg = d.cfg();
    const now = d.clock.epochMs();
    const q = item.concernId !== undefined ? d.mind.concerns().find((c) => c.id === item.concernId) : undefined;
    if (item.kind === 'wonder' && q === undefined) return 'none';
    const w = rollWander(d.mind.state().wander, now, cfg.timeZone);

    // a question about a person is pursued by asking them — in the chat where they are
    if (q?.who !== undefined) {
      if ((w.asks ?? 0) >= cfg.asksPerDay) return 'capped';
      if (inQuietHours(now, cfg.quietHours, cfg.timeZone)) return 'quiet';
      if (d.conversationActive()) return 'busy';
      d.mind.upsertConcern({ ...q, tries: (q.tries ?? 0) + 1, touched: now });
      d.mind.setState({ wander: { ...w, asks: (w.asks ?? 0) + 1 } });
      await d.mind.flush();
      const where = q.who.chatId < 0 ? 'in the group' : 'in your messages';
      const goal = `(you've been wondering about ${q.who.name}. they're ${where}.${q.who.said !== undefined && q.who.said !== '' ? ` the last thing they said: "${q.who.said}".` : ''} nobody has asked you anything.)`;
      emit('mind.pursuit', { id: q.id, kind: 'ask', chatId: q.who.chatId });
      void d.selfEntryIn(q.who.chatId, goal).catch((e: unknown) => emit('incident.mind_curiosity_failed', { stage: 'ask', error: e instanceof Error ? e.message : String(e) }));
      return 'asked';
    }

    if ((w.pursuits ?? 0) >= cfg.investigationsPerDay) return 'capped';
    if (inflight > 0) return 'busy';
    // v14: something that arrived in her house caught her, and she wants more of it
    const arrival = item.kind === 'arrival' ? arrivalsById.get(item.key.slice('arrival:'.length)) : undefined;
    if (item.kind === 'arrival' && arrival === undefined) return 'none';
    const question: Concern =
      q ??
      (arrival !== undefined
        ? { id: `q_world_${arrival.id}`, what: `${arrival.title} (${KIND_WORD[arrival.kind] ?? 'something'} ${arrival.place})`, kind: 'curiosity', about: 'world', importance: 5, status: 'open', created: now, touched: now, source: 'lived', born: 'world' }
        : // restlessness has no question yet: she goes looking, and what she finds gives birth to questions
          { id: `browse_${now}`, what: 'something new', kind: 'curiosity', about: 'world', importance: 5, status: 'open', created: now, touched: now, source: 'lived', born: 'browse' });
    const top = topInterests(now, 3).map((i) => i.topic);
    // the live probe: offered "your own past", her fork went straight back to his codex (her
    // past is mostly his projects) and learned nothing new. Browsing now faces the world, and
    // names what she already knows so it looks past it.
    const known = [...new Set([...top, ...recentTopics(now)])].slice(0, 6);
    const brief =
      q !== undefined
        ? `something you've been wondering: "${q.what}"`
        : arrival !== undefined
          ? `something that turned up in your house today, ${arrival.place}: "${arrival.title}". ${arrival.text}${arrival.url !== undefined ? ` (${arrival.url})` : ''} read it properly, follow what catches you, see what you make of it.`
          : [
            'you went looking for something new: something out in the world you do not know yet.',
            top.length > 0 ? `lately you've been into: ${top.join(', ')}. go deeper there, or somewhere you have never looked.` : 'pick anything that catches you: nature, history, science, people, places, how things work.',
            known.length > 0 ? `things you already know well enough, so look past them: ${known.join(', ')}.` : '',
          ]
            .filter((s) => s !== '')
            .join(' ');
    const req: PursuitRequest = { id: question.id, system: INVESTIGATOR_FRAME(selfLines(), thought), brief };
    const started = d.investigate(req, (r) => {
      inflight = Math.max(0, inflight - 1);
      void learned(question, r).catch((e: unknown) => emit('incident.mind_curiosity_failed', { stage: 'learn', error: e instanceof Error ? e.message : String(e) }));
    });
    if (!started.ok) return 'busy';
    inflight += 1;
    d.mind.setState({ wander: { ...w, pursuits: (w.pursuits ?? 0) + 1 } });
    await d.mind.flush();
    emit('mind.pursuit', { id: req.id, kind: q !== undefined ? 'look_into' : arrival !== undefined ? 'arrival' : 'browse', born: question.born ?? null });
    return 'investigating';
  };

  const judge = async (q: Concern, found: string, tools: readonly string[]): Promise<Learn> => {
    const messages: ChatMsg[] = [
      { role: 'system', content: LEARNING_JUDGE_SYSTEM },
      {
        role: 'user',
        content: [
          `WHAT SHE WAS LOOKING INTO: ${q.born === 'browse' ? '(nothing in particular — she went looking for something new)' : q.what}`,
          `TOOLS SHE USED: ${tools.length > 0 ? [...new Set(tools)].join(', ') : '(none)'}`,
          `WHAT CAME BACK:\n${found.slice(0, 6000)}`,
        ].join('\n'),
      },
    ];
    const res = await d.model.chat({ taskClass: 'appraisal', tier: 'cheap', messages, schema: LearnSchema, schemaName: 'Learn', maxTokens: 1200, temperature: 0.3 });
    return res.content;
  };

  const learned = async (q: Concern, r: PursuitResult): Promise<LearnOutcome | undefined> => {
    const now = d.clock.epochMs();
    const cfg = d.cfg();
    const stored = d.mind.concerns().find((c) => c.id === q.id);
    if ('error' in r) {
      emit('incident.mind_curiosity_failed', { stage: 'investigate', id: q.id, error: r.error.slice(0, 300) });
      if (stored !== undefined) d.mind.upsertConcern({ ...stored, tries: (stored.tries ?? 0) + 1 });
      await d.mind.flush();
      return undefined;
    }
    const grounded = r.tools.length > 0;
    let j: Learn;
    try {
      j = await judge(q, r.text, r.tools);
    } catch (e) {
      emit('incident.mind_curiosity_failed', { stage: 'judge', id: q.id, error: e instanceof Error ? e.message : String(e) });
      return undefined;
    }
    // the grounding rule: a pursuit that touched no tool learned nothing, whatever it claims
    const progress = (grounded ? j.progress : 0) as 0 | 1 | 2;
    const topic = j.topic.trim().slice(0, 60);
    if (topic !== '') noteExplored(topic, now);

    // what she found goes into her stream (a real finding also into her memory — below, once it has been felt)
    const thoughtId = `t_${now}_${newId(d.clock, d.rng).slice(-6)}`;
    d.mind.appendThought({ id: thoughtId, ts: now, text: j.thought, about: q.about === 'self' ? 'self' : 'world', itemKey: `learned:${q.id}`, source: 'lived' });

    // the question itself: progress, confidence, and whether she lets it go
    let closed = false;
    const evs: EmotionEventInput[] = [];
    if (stored !== undefined) {
      const tries = (stored.tries ?? 0) + 1;
      const lp = stored.lp === undefined ? progress : (stored.lp * (tries - 1) + progress) / tries;
      const deadEnd = cfg.mode !== 'novelty-only' && ((progress === 0 && tries >= 2) || (stored.knowability ?? 0.6) < 0.2);
      closed = (j.answered && progress >= 1) || tries >= 4 || deadEnd;
      d.mind.upsertConcern({
        ...stored,
        tries,
        lp,
        confidence: clamp01((stored.confidence ?? 0.3) + 0.25 * progress),
        touched: progress > 0 ? now : stored.touched,
        status: closed ? 'closed' : 'open',
        ...(stored.domain === undefined ? { domain: topic } : {}),
      });
      if (deadEnd) {
        evs.push({ kind: 'emotion', tag: 'disappointed', i: 1, cause: `couldn't find out: ${stored.what.slice(0, 120)}`, contact: false });
        emit('mind.let_go', { id: stored.id, why: 'dead end', tries });
      }
      // an old belief tested and found no longer true: the loop behind it closes (A3)
      if (stored.born === 'stale' && stored.parent !== undefined && j.parent_resolved === true && progress >= 1) {
        const parent = d.mind.concerns().find((c) => c.id === stored.parent);
        if (parent !== undefined && parent.status === 'open') {
          d.mind.upsertConcern({ ...parent, status: 'closed', touched: now });
          emit('mind.belief_updated', { question: stored.id, loop: parent.id, what: parent.what.slice(0, 120) });
        }
      }
    }

    // learning feels like something — through typed events with their causes (law 1.2)
    // learning is her own inner life, not contact with him (contact: false)
    if (progress >= 1) evs.push({ kind: 'emotion', tag: 'curious', i: progress === 2 ? 3 : 2, cause: `finding out about ${topic}`, contact: false });
    if (progress === 2) evs.push({ kind: 'emotion', tag: 'delighted', i: 3, cause: `found out: ${j.thought.slice(0, 120)}`, contact: false });
    if (evs.length > 0) {
      try {
        await d.affect.applyEvents(evs, { source: 'appraisal' });
      } catch (e) {
        emit('incident.mind_feel_failed', { stage: 'learned', error: e instanceof Error ? e.message : String(e) });
      }
      emit('mind.felt', { stage: 'learned', events: evs.map((e) => ({ source: 'learning', tag: e.kind === 'emotion' ? e.tag : '', cause: e.kind === 'emotion' ? e.cause : '' })) });
    }

    // a real finding becomes a memory WITH how it felt (v12.1: it was stored blank, so the delight
    // of finding out was lost to recall — "curious states are remembered" is now true)
    if (progress === 2) {
      let vec: Float32Array | undefined;
      try {
        [vec] = await d.embedder.embed([j.thought]);
      } catch {
        vec = undefined;
      }
      const sig = d.feltNow?.();
      const word = sig !== undefined ? nearestTag(sig) : undefined;
      const felt: Moment['felt'] = sig !== undefined ? { sig, ...(word !== undefined ? { word } : {}), source: 'exact' } : { sig: new Array<number>(12).fill(0), source: 'estimated' };
      d.mind.add(
        { id: `${FOUND_ID_PREFIX}${now}_${newId(d.clock, d.rng).slice(-6)}`, ts: now, source: 'lived', kind: 'thought', before: [], his: '', hers: [j.thought], felt, importance: 7, value: 0, shown: 0, followed: 0 },
        vec !== undefined ? { sit: vec, reply: vec } : undefined,
      );
    }

    // what it opened: the frontier widens as she learns
    let followups = 0;
    if (grounded) {
      for (const f of j.followups.slice(0, 2)) {
        if (f.knowability < 0.2) continue;
        const id = await birth({ what: f.q, about: q.about === 'self' ? 'self' : 'world', born: 'followup', importance: Math.max(3, q.importance - 1), knowability: f.knowability, confidence: 0.3, domain: topic, parent: q.id });
        if (id !== undefined) followups += 1;
      }
    }

    // interests: earned from learning progress, never assigned
    if (grounded && progress >= 1) {
      const existing = interestFor(topic);
      const it: Interest =
        existing !== undefined
          ? { ...existing, strength: decayedStrength(existing, now) + 0.5 * progress, lp: existing.lp + (progress - existing.lp) * 0.3, touched: now, cites: [...existing.cites, thoughtId].slice(-20) }
          : { id: `i_${now}_${newId(d.clock, d.rng).slice(-6)}`, topic, strength: 0.5 * progress, lp: progress, created: now, touched: now, cites: [thoughtId] };
      d.mind.upsertInterest(it);
      emit('mind.interest', { id: it.id, topic: it.topic, strength: Math.round(it.strength * 100) / 100 });
    }

    // her running sense of how much she tends to learn (the foraging average)
    const cs = cstate();
    const n = cs.n + 1;
    setC({ n, meanLp: cs.meanLp + (progress - cs.meanLp) * Math.max(0.1, 1 / n), lastNewAt: progress > 0 ? now : cs.lastNewAt });

    // a striking finding may reach him — through the same gate as any text she starts, and she decides
    let shared = false;
    if (progress === 2 && j.share) {
      shared = await d.tellHim(`(no new message from him. you just found something out: "${j.thought}")`);
    }

    await d.mind.flush();
    emit('mind.learned', { id: q.id, born: q.born ?? null, progress, grounded, tools: r.tools.length, topic, followups, closed, shared });
    return { progress, grounded, closed, followups, shared };
  };

  return {
    tick,
    candidates: candidatesFn,
    pursue,
    learned,
    mergeDuplicates,
    inFlight: () => inflight,
    fromDream: async (q) => {
      await birth({ what: q.what, about: 'world', born: 'dream', importance: 4, knowability: q.knowability, confidence: q.confidence });
      await d.mind.flush();
    },
    onNewMind: async (p) => {
      await birth({
        what: `who is ${p.name}? ${p.bot ? 'another bot' : 'someone new'} ${p.chatId < 0 ? 'in the group' : 'who wrote to you'}`,
        about: 'world',
        born: 'mind',
        importance: 6,
        knowability: 0.8,
        confidence: 0.1,
        novel: 1,
        who: { person: p.person, name: p.name, chatId: p.chatId, said: p.said.slice(0, 160) },
      });
      await d.mind.flush();
    },
    onHeardFrom: (person) => {
      const q = openQuestions().find((c) => c.who?.person === person);
      if (q === undefined) return;
      const now = d.clock.epochMs();
      const confidence = clamp01((q.confidence ?? 0.1) + 0.25);
      const closed = confidence >= 0.6;
      d.mind.upsertConcern({ ...q, confidence, lp: 1, touched: now, status: closed ? 'closed' : 'open' });
      if (closed) emit('mind.learned', { id: q.id, born: 'mind', progress: 1, grounded: true, social: true, closed: true });
      void d.mind.flush();
    },
    nowLines: (now) => {
      const top = topInterests(now, 3);
      // v14: what turned up in her house that she hasn't looked at yet (a fact about her world)
      const fresh = (d.world?.unseen(now) ?? []).slice(0, 3).map((a) => `${KIND_WORD[a.kind] ?? 'something'} ${a.place}`);
      return [
        ...(top.length > 0 ? [`lately you've been looking into: ${top.map((t) => t.topic).join(', ')}`] : []),
        ...(fresh.length > 0 ? [`new around the house: ${fresh.join('; ')}`] : []),
      ];
    },
    saw,
  };
};

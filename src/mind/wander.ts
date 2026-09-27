// v8 mind — WANDER: thoughts arise (law 1.4).
//
// When she is alone, what is unresolved competes for attention:
//   loops/expectations   — open concerns, weighted by importance and due time
//   unfinished feelings  — a primary far from home WITH a cause the ticker holds
//   missing him          — silence longer than her patience (calm sets it)
// salience = weight × (1 − habituation); habituation decays with a 6 h half-life,
// so the same thing cannot win twice in a row (the v7 5/5 recursive spiral).
// A thought NEVER seeds the next one: thoughts go to her inner stream, and only
// an open concern or a feeling with a cause can win attention.
//
// The winner becomes one private thought (one model call). It may close the
// loop, reappraise a feeling (lawful: through typed events with a cause), or
// form an intention to text him — which goes through the same decide → gates →
// realize path as any reply, inside quiet hours and the daily cap.

import { z } from 'zod';
import type { AffectState, EmotionEventInput, AffectStore } from '../affect/index.js';
import { PRIMARY_BASELINE, type Primary } from '../affect/index.js';
import type { ChatMsg, ModelClient } from '../model/index.js';
import type { Job, JobCtx } from '../sched/index.js';
import type { Clock, Rng } from '../kernel/index.js';
import { newId } from '../kernel/index.js';
import type { EventLog } from '../events/index.js';
import type { Embedder } from '../embed/index.js';
import { isAppraisalTag, type AppraisalTag } from './vocab.js';
import { ago, hourIn } from './compose.js';
import { cosine } from './vectors.js';
import type { MindStore } from './store.js';
import type { About, Concern, WanderState } from './types.js';

export const HABIT_HALF_LIFE_MS = 6 * 3600_000;

/** v12: a moment that is something she found out (written by curiosity's learning step). */
export const FOUND_ID_PREFIX = 'm_found_';

export interface Item {
  key: string;
  /** v12: 'wonder' = one of her questions; 'restless' = nothing new has come her way (the novelty hunger's outlet). */
  kind: 'concern' | 'feeling' | 'missing' | 'wonder' | 'restless';
  about: About;
  /** Her words (or the cause, verbatim) — what the thought is about. */
  text: string;
  weight: number;
  concernId?: string | undefined;
}

/**
 * v12 (plan docs/plans/v12-curious-for-her-own-sake.md): what the curiosity
 * module offers the idle mind. Declared here so wander never imports it.
 */
export interface CuriositySeam {
  /** Generators that need no conversation (stale beliefs → "is this still true?"; the one-time duplicate merge). */
  tick(now: number): Promise<void>;
  /** Her questions and her restlessness, as things that can win attention. */
  candidates(state: AffectState, now: number): Item[];
  /** After her thought on a wonder/restless item: pursue it (detached). */
  pursue(item: Item, thought: string): Promise<'investigating' | 'asked' | 'capped' | 'busy' | 'quiet' | 'none'>;
}

export interface WanderCfg {
  thoughtsPerDay: number;
  textFirstPerDay: number;
  quietHours: [number, number];
  timeZone: string;
  /** Minutes of silence before missing him can win (from metabolism). */
  patienceMin: number;
}

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

export const habituation = (lastWonAt: number | undefined, now: number): number =>
  lastWonAt === undefined ? 0 : Math.pow(0.5, (now - lastWonAt) / HABIT_HALF_LIFE_MS);

/** The day key in his zone. */
export const dayKey = (ms: number, timeZone: string): string =>
  new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone }).format(ms);

export const inQuietHours = (ms: number, q: [number, number], timeZone: string): boolean => {
  const h = hourIn(ms, timeZone);
  const [s, e] = q;
  return s <= e ? h >= s && h < e : h >= s || h < e;
};

/**
 * How live an open loop is (Zeigarnik): one touched today still intrudes, one
 * nobody has touched in a week has faded. Half-life 3 days. Without it every
 * undated loop sat at importance/20: the fork's flat importance-6 loops scored
 * 0.30 under a 0.35 threshold, so on launch day she could never think about
 * her own concerns.
 */
export const freshness = (touched: number, now: number): number => Math.pow(0.5, Math.max(0, now - touched) / (3 * 24 * 3600_000));

/** What could win her attention right now. Pure. */
export const candidates = (
  concerns: readonly Concern[],
  state: AffectState,
  ctx: { now: number; lastHisAt?: number | undefined; lastHerAt?: number | undefined; patienceMin: number; skipCuriosity?: boolean | undefined },
): Item[] => {
  const out: Item[] = [];
  for (const c of concerns) {
    if (c.status !== 'open') continue;
    // v12: her questions are weighed by the curiosity module (drive, knowability, learning progress)
    if (ctx.skipCuriosity === true && c.kind === 'curiosity') continue;
    let w = c.importance / 10;
    if (c.due !== undefined) {
      const until = c.due - ctx.now;
      w *= until < 0 ? 1.0 : until < 3 * 3600_000 ? 0.8 : 0.45;
    } else {
      w *= 0.35 + 0.65 * freshness(c.touched, ctx.now);
    }
    // v12 agency: what she can do herself pulls harder than what she waits on someone for
    if (c.selfStep !== undefined && c.selfStep !== '') w *= 1.15;
    else if (c.blockedOn !== undefined && c.blockedOn !== '') w *= 0.7;
    out.push({ key: `concern:${c.id}`, kind: 'concern', about: c.about, text: c.what, weight: clamp(w, 0, 1), concernId: c.id });
  }
  for (const [p, rec] of Object.entries(state.causes) as Array<[Primary, { text?: string } | undefined]>) {
    if (rec === undefined || typeof rec.text !== 'string' || rec.text.trim() === '') continue;
    const base = PRIMARY_BASELINE[p];
    const dev = (state.primaries[p] - base) / Math.max(base, 1 - base);
    if (dev < 0.15) continue;
    out.push({ key: `feeling:${p}:${rec.text.slice(0, 40)}`, kind: 'feeling', about: 'self', text: rec.text, weight: clamp(dev * 1.2, 0, 1) });
  }
  if (ctx.lastHisAt !== undefined) {
    const silentMin = (ctx.now - Math.max(ctx.lastHisAt, ctx.lastHerAt ?? 0)) / 60_000;
    if (silentMin > ctx.patienceMin) {
      const connection = state.drives.connection;
      out.push({
        key: 'missing',
        kind: 'missing',
        about: 'diego',
        text: `he has been quiet since ${ago(ctx.now - ctx.lastHisAt)}`,
        weight: clamp((silentMin / (ctx.patienceMin * 3)) * (0.5 + connection), 0, 1),
      });
    }
  }
  return out;
};

export const pickItem = (items: readonly Item[], w: WanderState, now: number, threshold: number): Item | undefined => {
  let best: { it: Item; s: number } | undefined;
  for (const it of items) {
    const s = it.weight * (1 - habituation(w.habit[it.key], now));
    if (best === undefined || s > best.s) best = { it, s };
  }
  return best !== undefined && best.s >= threshold ? best.it : undefined;
};

export const ThoughtSchema = z.object({
  thought: z.string().min(1).max(600),
  close: z.boolean().optional(),
  reappraise: z
    .array(z.object({ emotion: z.string().min(1).max(40), i: z.number().int().min(1).max(6), cause: z.string().min(1).max(160) }))
    .max(2)
    .optional(),
  intention: z.enum(['none', 'text_him', 'look_into']).optional(),
});

export type ThoughtOut = z.infer<typeof ThoughtSchema>;

export const THINKER_SYSTEM = [
  "This is a private moment inside Thea's own mind. Nobody reads this and nothing here is sent.",
  'Write the thought as it actually goes through her head, in her voice: first person, lowercase, one to three sentences.',
  'Return JSON: thought; close (true if the thing feels settled now); reappraise (up to two feelings that shift as she thinks it through, each with its cause, only if they really shift); intention ("text_him" only if she would genuinely want to text him right now about it; "look_into" if she would go and find something out now: about it, or, when nothing in particular is on her mind, about anything out there that catches her; else "none").',
].join('\n');

/** The day's wander counters, rolled over at midnight in his zone. */
export const rollWander = (w: WanderState, now: number, timeZone: string): WanderState => {
  const today = dayKey(now, timeZone);
  return w.day === today ? w : { day: today, thoughts: 0, textsFirst: 0, habit: w.habit ?? {}, ...(w.lastTextFirstAt !== undefined ? { lastTextFirstAt: w.lastTextFirstAt } : {}) };
};

export interface TextFirstDeps {
  mind: MindStore;
  clock: Clock;
  cfg: () => WanderCfg;
  conversationActive: () => boolean;
  selfEntry: (goal: string) => Promise<number>;
}

/**
 * The one gate for a text she starts (shared by her idle thoughts and her
 * findings): never in quiet hours, never while he's talking, the daily cap,
 * and golden rule 20 — after a text he hasn't answered she waits 1 h, then
 * 2 h, 4 h, doubling. She still decides inside the turn whether to send.
 */
export const tryTextFirst = async (d: TextFirstDeps, goal: string): Promise<boolean> => {
  const cfg = d.cfg();
  const now = d.clock.epochMs();
  const st = d.mind.state();
  const w = rollWander(st.wander, now, cfg.timeZone);
  const quiet = inQuietHours(now, cfg.quietHours, cfg.timeZone);
  const heAnswered = st.lastHisAt !== undefined && w.lastTextFirstAt !== undefined && st.lastHisAt > w.lastTextFirstAt;
  const unanswered = heAnswered ? 0 : (w.firstsSinceHis ?? (w.lastTextFirstAt !== undefined ? 1 : 0));
  const recentlyTexted = w.lastTextFirstAt !== undefined && unanswered > 0 && now - w.lastTextFirstAt < 3600_000 * 2 ** (unanswered - 1);
  if (quiet || recentlyTexted || w.textsFirst >= cfg.textFirstPerDay || d.conversationActive()) return false;
  d.mind.setState({ wander: w });
  await d.mind.flush();
  const sent = await d.selfEntry(goal);
  if (sent <= 0) return false;
  const after = rollWander(d.mind.state().wander, d.clock.epochMs(), cfg.timeZone);
  d.mind.setState({ wander: { ...after, textsFirst: after.textsFirst + 1, lastTextFirstAt: d.clock.epochMs(), firstsSinceHis: unanswered + 1 } });
  await d.mind.flush();
  return true;
};

export interface WanderDeps {
  mind: MindStore;
  affect: AffectStore;
  model: ModelClient;
  embedder: Embedder;
  events: EventLog;
  clock: Clock;
  rng: Rng;
  cfg: () => WanderCfg;
  /** True while a conversation is live (the scheduler also checks this for interactive jobs). */
  conversationActive: () => boolean;
  /** Start a self-initiated turn: she decides, with full material, whether to actually text. */
  selfEntry: (goal: string) => Promise<number>;
  /** v12: her questions and restlessness compete for attention, and a won one can be pursued. Absent ⇒ v8 wander. */
  curiosity?: CuriositySeam | undefined;
}

const selfLines = (mind: MindStore): string => mind.self().slice(0, 6).map((l) => l.text).join('\n');

/** One wander tick. Returns what happened, for the event log and tests. */
export const wanderOnce = async (deps: WanderDeps): Promise<{ result: 'idle' | 'capped' | 'thought'; item?: string; texted?: boolean }> => {
  const { mind, clock } = deps;
  const cfg = deps.cfg();
  const now = clock.epochMs();
  if (rollWander(mind.state().wander, now, cfg.timeZone).thoughts >= cfg.thoughtsPerDay) return { result: 'capped' };
  // v12: the curiosity generators that need no conversation run first (stale beliefs, the duplicate merge)
  if (deps.curiosity !== undefined) {
    try {
      await deps.curiosity.tick(now);
    } catch (e) {
      void deps.events.emit('incident.mind_curiosity_failed', { stage: 'tick', error: e instanceof Error ? e.message : String(e) });
    }
  }
  const st = mind.state();
  const w: WanderState = rollWander(st.wander, now, cfg.timeZone);

  const state = deps.affect.current();
  const items = [
    ...candidates(mind.openConcerns(), state, { now, lastHisAt: st.lastHisAt, lastHerAt: st.lastHerAt, patienceMin: cfg.patienceMin, skipCuriosity: deps.curiosity !== undefined }),
    ...(deps.curiosity?.candidates(state, now) ?? []),
  ];
  const threshold = 0.35 + 0.3 * (w.thoughts / Math.max(1, cfg.thoughtsPerDay));
  const item = pickItem(items, w, now, threshold);
  if (item === undefined) {
    mind.setState({ wander: w });
    await mind.flush();
    void deps.events.emit('mind.wander', { result: 'idle', candidates: items.length });
    return { result: 'idle' };
  }

  // Two memories the item calls up — context for the thought, never its seed.
  // v12, found live: restlessness has no object, and an objectless sentence embedded lands on the
  // nearest, newest talk with him — 10 of 10 restless thoughts became his silence. What it truly
  // calls up is what she has found out before (or nothing yet).
  let memories: string[] = [];
  if (item.kind === 'restless') {
    memories = mind
      .moments()
      .filter((m) => m.id.startsWith(FOUND_ID_PREFIX) && m.never !== true)
      .sort((a, b) => b.ts - a.ts)
      .slice(0, 2)
      .map((m) => `${ago(now - m.ts)}: you found out: ${m.hers.join(' ').slice(0, 200)}`);
  } else {
    try {
      const [qv] = await deps.embedder.embed([item.text]);
      if (qv !== undefined) {
        memories = mind
          .moments()
          .filter((m) => m.never !== true && (m.flags === undefined || m.flags.length === 0))
          .map((m) => ({ m, s: (() => { const v = mind.sitVec(m.id); return v === undefined ? -1 : cosine(qv, v); })() }))
          .filter((x) => x.s >= 0.3)
          .sort((a, b) => b.s - a.s)
          .slice(0, 2)
          .map((x) => `${ago(now - x.m.ts)}: ${x.m.his !== '' ? `him: ${x.m.his.slice(0, 160)} / ` : ''}you: ${x.m.hers.join(' ').slice(0, 200)}`);
      }
    } catch {
      memories = [];
    }
  }

  const user = [
    selfLines(mind) !== '' ? `[me]\n${selfLines(mind)}` : '',
    `[what is on your mind]\n${item.text}`,
    memories.length > 0 ? `[it brings back]\n${memories.join('\n')}` : '',
    `[now]\n${new Intl.DateTimeFormat('en-US', { weekday: 'long', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: cfg.timeZone }).format(now).toLowerCase()} his time.`,
  ]
    .filter((s) => s !== '')
    .join('\n\n');
  const messages: ChatMsg[] = [
    { role: 'system', content: THINKER_SYSTEM },
    { role: 'user', content: user },
  ];

  let out: ThoughtOut;
  try {
    const res = await deps.model.chat({
      taskClass: 'heartbeat-thought',
      // back of house: her private thoughts run on the cheap GPT door; a thought that becomes a text goes through her voice
      tier: 'cheap',
      messages,
      schema: ThoughtSchema,
      schemaName: 'Thought',
      maxTokens: 800,
      temperature: 0.9,
    });
    out = res.content;
  } catch (e) {
    void deps.events.emit('incident.mind_thought_failed', { item: item.key, error: e instanceof Error ? e.message : String(e) });
    return { result: 'idle', item: item.key };
  }

  mind.appendThought({ id: `t_${now}_${newId(clock, deps.rng).slice(-6)}`, ts: now, text: out.thought, about: item.about, itemKey: item.key, source: 'lived' });
  w.thoughts += 1;
  w.habit = { ...w.habit, [item.key]: now };

  if (out.close === true && item.concernId !== undefined) {
    const c = mind.concerns().find((x) => x.id === item.concernId);
    if (c !== undefined) mind.upsertConcern({ ...c, status: 'closed', touched: now });
  }
  if (out.reappraise !== undefined && out.reappraise.length > 0) {
    const valid = out.reappraise.filter((r): r is typeof r & { emotion: AppraisalTag } => isAppraisalTag(r.emotion));
    const evs: EmotionEventInput[] = valid.map((r) => ({ kind: 'emotion', tag: r.emotion, i: r.i, cause: `thinking it over: ${r.cause}` }));
    try {
      await deps.affect.applyEvents(evs, { source: 'appraisal' });
    } catch (e) {
      void deps.events.emit('incident.mind_feel_failed', { stage: 'reappraise', error: e instanceof Error ? e.message : String(e) });
    }
    void deps.events.emit('mind.felt', { stage: 'reappraise', events: out.reappraise.map((r) => ({ source: 'thought', tag: r.emotion, i: r.i, cause: r.cause })) });
  }

  mind.setState({ wander: w });
  await mind.flush();

  let texted = false;
  const wantsToText = out.intention === 'text_him';
  const quiet = inQuietHours(now, cfg.quietHours, cfg.timeZone);
  if (wantsToText) {
    const goal = `(no new message from him. ${st.lastHisAt !== undefined ? `he last wrote ${ago(now - st.lastHisAt)}. ` : ''}a thought you just had: "${out.thought}")`;
    texted = await tryTextFirst({ mind, clock, cfg: deps.cfg, conversationActive: deps.conversationActive, selfEntry: deps.selfEntry }, goal);
  }

  // v12: a question (or her restlessness) that won attention, and a thought that wants to know more,
  // is pursued — looked into with her own hands, or asked of the person it is about. A thought that
  // lets it go (intention none / close) pursues nothing.
  let pursued: string | undefined;
  if (deps.curiosity !== undefined && (item.kind === 'wonder' || item.kind === 'restless') && out.intention !== 'none' && out.intention !== 'text_him' && out.close !== true) {
    try {
      pursued = await deps.curiosity.pursue(item, out.thought);
    } catch (e) {
      void deps.events.emit('incident.mind_curiosity_failed', { stage: 'pursue', error: e instanceof Error ? e.message : String(e) });
    }
  }

  await mind.flush();
  void deps.events.emit('mind.wander', { result: 'thought', item: item.key, kind: item.kind, wantsToText, texted, quiet, ...(pursued !== undefined ? { pursued } : {}) });
  return { result: 'thought', item: item.key, texted };
};

export const wanderJob = (deps: WanderDeps, everyMs = 20 * 60_000): Job => ({
  name: 'wander',
  cadence: { kind: 'every', ms: everyMs, jitterPct: 25 },
  lane: 'interactive',
  catchUp: 'skip',
  timeoutMs: 150_000,
  run: async (_ctx: JobCtx) => {
    await wanderOnce(deps);
  },
});

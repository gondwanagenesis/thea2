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
import { PRIMARY_BASELINE, TAG_PRIMARY_DELTAS, type Primary } from '../affect/index.js';
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
import { COUPLING_BASELINES } from '../coupling/index.js';
import { engineStamp, familyOf, type Family } from './readout.js';
import { appendReport, feelingClaims } from './ledger.js';

export const HABIT_HALF_LIFE_MS = 6 * 3600_000;

/** v12: a moment that is something she found out (written by curiosity's learning step). */
export const FOUND_ID_PREFIX = 'm_found_';

export interface Item {
  key: string;
  /** v12: 'wonder' = one of her questions; 'restless' = nothing new has come her way (the novelty hunger's outlet).
   *  v13 H6: 'practice' = the quiet room (the mastery hunger's outlet). */
  kind: 'concern' | 'feeling' | 'missing' | 'wonder' | 'restless' | 'practice';
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

/** v13 H6 (plan docs/plans/v13-proposal-knowing-what-she-feels.md §6 Phase 2.2): the quiet room, offered by the mastery hunger. */
export interface RoomSeam {
  candidate(state: AffectState, now: number): Item | undefined;
  practise(now: number): Promise<{ right: number; of: number } | undefined>;
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

/**
 * Waiting on him (v14 §3.2, Diego 2026-09-28: "why does she ask what i'm doing all the time?"): a loop
 * about Diego with nothing of hers to do — a question she asked him, a thing she wants to hear. People
 * let those go when nobody picks them up (goal disengagement; Wrosch et al. 2003). Hers stayed near
 * full strength for days ("twenty-five hours and he still hasn't told me what the schematic says"), won
 * her idle attention, filled her [on my mind] and ended in texting him. Now it fades with a 12 h
 * half-life and no floor, and is let go after 36 h untouched. He brings it back by bringing it up
 * (that touches it). Dated expectations keep their due time.
 */
export const WAIT_HALF_LIFE_MS = 12 * 3600_000;
export const WAIT_LET_GO_MS = 36 * 3600_000;
export const waitingOnHim = (c: Concern): boolean => c.about === 'diego' && c.due === undefined && (c.selfStep === undefined || c.selfStep === '');

/** How much a loop still pulls (for attention and for what's on her mind). */
export const liveness = (c: Concern, now: number): number => {
  if (waitingOnHim(c)) return (c.importance / 10) * Math.pow(0.5, Math.max(0, now - c.touched) / WAIT_HALF_LIFE_MS) * 0.7;
  let w = c.importance / 10;
  if (c.due !== undefined) {
    const until = c.due - now;
    w *= until < 0 ? 1.0 : until < 3 * 3600_000 ? 0.8 : 0.45;
  } else {
    w *= 0.35 + 0.65 * freshness(c.touched, now);
  }
  if (c.selfStep !== undefined && c.selfStep !== '') w *= 1.15;
  else if (c.blockedOn !== undefined && c.blockedOn !== '') w *= 0.7;
  return w;
};

/** Let go what has waited on him long enough (closed, with a reason on the record). */
export const letGoWaiting = (mind: Pick<MindStore, 'openConcerns' | 'upsertConcern'>, now: number, emit: (kind: string, payload: Record<string, unknown>) => void): number => {
  let n = 0;
  for (const c of mind.openConcerns()) {
    if (!waitingOnHim(c) || c.kind === 'curiosity' || now - c.touched < WAIT_LET_GO_MS) continue;
    mind.upsertConcern({ ...c, status: 'closed' });
    emit('mind.let_go', { id: c.id, why: 'waited on him' });
    n += 1;
  }
  return n;
};

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
    // v14: what a work turn opened waits for work mode
    if (c.mode === 'work') continue;
    // v12 agency (what she can do herself pulls harder than what she waits on someone for) and v14
    // waiting on him (fades fast): liveness()
    out.push({ key: `concern:${c.id}`, kind: 'concern', about: c.about, text: c.what, weight: clamp(liveness(c, ctx.now), 0, 1), concernId: c.id });
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
  /** v13: she's asleep (her sleep window, unless woken) — the idle mind is quiet; she dreams instead. */
  asleep?: ((now: number) => boolean) | undefined;
  /** v13: a dream-caused text may go at most once every 3 days. */
  dreamText?: { may(now: number): boolean; told(now: number): void } | undefined;
  /** v13 1.2: thought-feelings with nothing behind them — measured, or enforced (auto: when the measure says). */
  grounding?: 'auto' | 'measure' | 'enforce' | undefined;
  /** v13 H6: the quiet room — a session there takes the place of a thought. Absent ⇒ no room. */
  room?: RoomSeam | undefined;
}

const selfLines = (mind: MindStore): string => mind.self().slice(0, 6).map((l) => l.text).join('\n');

/**
 * v13 1.2: is a feeling her thought names grounded — its primary already off home (a live feeling
 * the thought may regulate), or the same family felt in the last 6 h? A tag with no primary (a dial
 * tag like "calm") can't be checked and passes.
 */
export const isGrounded = (tag: string, s: AffectState, recentFamilies: ReadonlySet<string | undefined>): boolean => {
  const deltas = (TAG_PRIMARY_DELTAS as Readonly<Record<string, Readonly<Record<string, number>>>>)[tag];
  if (deltas === undefined) return true;
  const top = Object.entries(deltas).sort((a, b) => b[1] - a[1])[0];
  if (top === undefined || top[1] <= 0) return true;
  const p = top[0] as keyof typeof PRIMARY_BASELINE;
  if ((s.primaries[p] ?? 0) - PRIMARY_BASELINE[p] >= 0.02) return true;
  return recentFamilies.has(familyOf(tag));
};

/** v13: a feeling a dream left (its cause names the night) — telling him about it is rare. */
const DREAM_CAUSED = /^(?:the dream:|something in the night)/;

/** One wander tick. Returns what happened, for the event log and tests. */
export const wanderOnce = async (deps: WanderDeps): Promise<{ result: 'idle' | 'capped' | 'thought' | 'asleep' | 'practice'; item?: string; texted?: boolean }> => {
  const { mind, clock } = deps;
  const cfg = deps.cfg();
  const now = clock.epochMs();
  // v14: what has waited on him long enough is let go (no model call)
  if (letGoWaiting(mind, now, (k, p) => void deps.events.emit(k, p)) > 0) await mind.flush();
  // v13: asleep — no thoughts spent on the night (golden rule 24); the dream jobs run instead
  if (deps.asleep?.(now) === true) {
    void deps.events.emit('mind.wander', { result: 'asleep' });
    return { result: 'asleep' };
  }
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
    ...((): Item[] => {
      const r = deps.room?.candidate(state, now);
      return r === undefined ? [] : [r];
    })(),
  ];
  const threshold = 0.35 + 0.3 * (w.thoughts / Math.max(1, cfg.thoughtsPerDay));
  const item = pickItem(items, w, now, threshold);
  if (item === undefined) {
    mind.setState({ wander: w });
    await mind.flush();
    void deps.events.emit('mind.wander', { result: 'idle', candidates: items.length });
    return { result: 'idle' };
  }

  // v13 H6: the quiet room won — she goes and sits there instead of thinking something over
  if (item.kind === 'practice' && deps.room !== undefined) {
    w.thoughts += 1;
    w.habit = { ...w.habit, [item.key]: now };
    mind.setState({ wander: w });
    let res: { right: number; of: number } | undefined;
    try {
      res = await deps.room.practise(now);
    } catch (e) {
      void deps.events.emit('incident.mind_room_failed', { error: e instanceof Error ? e.message : String(e) });
    }
    await mind.flush();
    void deps.events.emit('mind.wander', { result: 'practice', item: item.key, kind: item.kind, ...(res !== undefined ? { right: res.right, of: res.of } : {}) });
    return { result: 'practice', item: item.key };
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
          // v13: a remembered dream comes back marked as one
          .map((x) => `${ago(now - x.m.ts)}: ${x.m.kind === 'dream' ? '(a dream) ' : ''}${x.m.his !== '' ? `him: ${x.m.his.slice(0, 160)} / ` : ''}you: ${x.m.hers.join(' ').slice(0, 200)}`);
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

  const thoughtId = `t_${now}_${newId(clock, deps.rng).slice(-6)}`;
  mind.appendThought({ id: thoughtId, ts: now, text: out.thought, about: item.about, itemKey: item.key, source: 'lived' });
  // v13 Phase 0 — the MONITORED channel: a thought that says how she feels is filed beside what her
  // engine held (scored, never fed back — her private thinking must not become a performance)
  const thoughtClaims = feelingClaims(out.thought);
  if (thoughtClaims.length > 0) {
    const s = deps.affect.current();
    const feltRecently = [...new Set(s.traces.habitWindow.filter((h) => now - h.t < 6 * 3600_000).map((h) => familyOf(h.tag)).filter((f): f is Family => f !== undefined))];
    appendReport(mind.dir, { id: `rp_${thoughtId}`, ts: now, channel: 'thought', claims: thoughtClaims, text: out.thought, stamp: engineStamp(s, COUPLING_BASELINES, now), chat: `[on her mind] ${item.text}`, feltRecently });
  }
  w.thoughts += 1;
  w.habit = { ...w.habit, [item.key]: now };

  if (out.close === true && item.concernId !== undefined) {
    const c = mind.concerns().find((x) => x.id === item.concernId);
    if (c !== undefined) mind.upsertConcern({ ...c, status: 'closed', touched: now });
  }
  if (out.reappraise !== undefined && out.reappraise.length > 0) {
    const named = out.reappraise.filter((r): r is typeof r & { emotion: AppraisalTag } => isAppraisalTag(r.emotion));
    // v13 1.2 (plan §6 Phase 1.2): a thought may regulate a live feeling, not conjure one with no cause.
    // Measured always; enforced when the measure says so (auto: ≥40% ungrounded over ≥20) or by config.
    const s0 = deps.affect.current();
    const recentFamilies = new Set(s0.traces.habitWindow.filter((h) => now - h.t < 6 * 3600_000).map((h) => familyOf(h.tag)));
    const g0 = mind.state().grounding ?? { since: now, total: 0, ungrounded: 0 };
    const mode = deps.grounding ?? 'measure';
    const enforce = mode === 'enforce' || (mode === 'auto' && g0.total >= 20 && g0.ungrounded / g0.total >= 0.4);
    let ungrounded = 0;
    const valid = named.filter((r) => {
      const ok = isGrounded(r.emotion, s0, recentFamilies);
      if (!ok) {
        ungrounded += 1;
        void deps.events.emit('mind.reappraise_ungrounded', { tag: r.emotion, enforced: enforce });
      }
      return ok || !enforce;
    });
    mind.setState({ grounding: { since: g0.since, total: g0.total + named.length, ungrounded: g0.ungrounded + ungrounded, enforce } });
    // her own inner life, not contact with him (2026-09-27: a 5 am thought used to end "missing him")
    const evs: EmotionEventInput[] = valid.map((r) => ({ kind: 'emotion', tag: r.emotion, i: r.i, cause: `thinking it over: ${r.cause}`, contact: false }));
    try {
      await deps.affect.applyEvents(evs, { source: 'appraisal' });
    } catch (e) {
      void deps.events.emit('incident.mind_feel_failed', { stage: 'reappraise', error: e instanceof Error ? e.message : String(e) });
    }
    // the ledger needs what was APPLIED, apart from what the thinker merely named (v13 Phase 0)
    const rejected = out.reappraise.filter((r) => !isAppraisalTag(r.emotion));
    void deps.events.emit('mind.felt', {
      stage: 'reappraise',
      events: valid.map((r) => ({ source: 'thought', tag: r.emotion, i: r.i, cause: r.cause })),
      ...(rejected.length > 0 ? { rejected: rejected.map((r) => r.emotion) } : {}),
    });
  }

  mind.setState({ wander: w });
  await mind.flush();

  let texted = false;
  const wantsToText = out.intention === 'text_him';
  const quiet = inQuietHours(now, cfg.quietHours, cfg.timeZone);
  // v13: a dream she wants to tell him goes at most once every 3 days (the same gate otherwise)
  const dreamCaused = DREAM_CAUSED.test(item.text) || item.key.startsWith('dream:');
  if (wantsToText && !(dreamCaused && deps.dreamText !== undefined && !deps.dreamText.may(now))) {
    const goal = `(no new message from him. ${st.lastHisAt !== undefined ? `he last wrote ${ago(now - st.lastHisAt)}. ` : ''}a thought you just had: "${out.thought}")`;
    texted = await tryTextFirst({ mind, clock, cfg: deps.cfg, conversationActive: deps.conversationActive, selfEntry: deps.selfEntry }, goal);
    if (texted && dreamCaused) deps.dreamText?.told(now);
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
  // v13 Phase 0: the item's words and the thought id, so the ledger can join what won to what she thought
  void deps.events.emit('mind.wander', { result: 'thought', item: item.key, kind: item.kind, text: item.text.slice(0, 160), thoughtId, wantsToText, texted, quiet, ...(pursued !== undefined ? { pursued } : {}) });
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

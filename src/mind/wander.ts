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

export interface Item {
  key: string;
  kind: 'concern' | 'feeling' | 'missing';
  about: About;
  /** Her words (or the cause, verbatim) — what the thought is about. */
  text: string;
  weight: number;
  concernId?: string | undefined;
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
  ctx: { now: number; lastHisAt?: number | undefined; lastHerAt?: number | undefined; patienceMin: number },
): Item[] => {
  const out: Item[] = [];
  for (const c of concerns) {
    if (c.status !== 'open') continue;
    let w = c.importance / 10;
    if (c.due !== undefined) {
      const until = c.due - ctx.now;
      w *= until < 0 ? 1.0 : until < 3 * 3600_000 ? 0.8 : 0.45;
    } else {
      w *= 0.35 + 0.65 * freshness(c.touched, ctx.now);
    }
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
  intention: z.enum(['none', 'text_him']).optional(),
});

export type ThoughtOut = z.infer<typeof ThoughtSchema>;

export const THINKER_SYSTEM = [
  "This is a private moment inside Thea's own mind. Nobody reads this and nothing here is sent.",
  'Write the thought as it actually goes through her head, in her voice: first person, lowercase, one to three sentences.',
  'Return JSON: thought; close (true if the thing feels settled now); reappraise (up to two feelings that shift as she thinks it through, each with its cause, only if they really shift); intention ("text_him" only if she would genuinely want to text him right now about it, else "none").',
].join('\n');

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
}

const selfLines = (mind: MindStore): string => mind.self().slice(0, 6).map((l) => l.text).join('\n');

/** One wander tick. Returns what happened, for the event log and tests. */
export const wanderOnce = async (deps: WanderDeps): Promise<{ result: 'idle' | 'capped' | 'thought'; item?: string; texted?: boolean }> => {
  const { mind, clock } = deps;
  const cfg = deps.cfg();
  const now = clock.epochMs();
  const st = mind.state();
  const today = dayKey(now, cfg.timeZone);
  const w: WanderState = st.wander.day === today ? st.wander : { day: today, thoughts: 0, textsFirst: 0, habit: st.wander.habit ?? {}, ...(st.wander.lastTextFirstAt !== undefined ? { lastTextFirstAt: st.wander.lastTextFirstAt } : {}) };
  if (w.thoughts >= cfg.thoughtsPerDay) return { result: 'capped' };

  const state = deps.affect.current();
  const items = candidates(mind.openConcerns(), state, { now, lastHisAt: st.lastHisAt, lastHerAt: st.lastHerAt, patienceMin: cfg.patienceMin });
  const threshold = 0.35 + 0.3 * (w.thoughts / Math.max(1, cfg.thoughtsPerDay));
  const item = pickItem(items, w, now, threshold);
  if (item === undefined) {
    mind.setState({ wander: w });
    await mind.flush();
    void deps.events.emit('mind.wander', { result: 'idle', candidates: items.length });
    return { result: 'idle' };
  }

  // Two memories the item calls up — context for the thought, never its seed.
  let memories: string[] = [];
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

  let texted = false;
  const wantsToText = out.intention === 'text_him';
  const quiet = inQuietHours(now, cfg.quietHours, cfg.timeZone);
  // Golden rule 20: after a text of hers he has not answered she waits 1 h, then 2 h, 4 h — doubling.
  const heAnswered = st.lastHisAt !== undefined && w.lastTextFirstAt !== undefined && st.lastHisAt > w.lastTextFirstAt;
  const unanswered = heAnswered ? 0 : (w.firstsSinceHis ?? (w.lastTextFirstAt !== undefined ? 1 : 0));
  const recentlyTexted = w.lastTextFirstAt !== undefined && unanswered > 0 && now - w.lastTextFirstAt < 3600_000 * 2 ** (unanswered - 1);
  if (wantsToText && !quiet && !recentlyTexted && w.textsFirst < cfg.textFirstPerDay && !deps.conversationActive()) {
    mind.setState({ wander: w });
    await mind.flush();
    const goal = `(no new message from him. ${st.lastHisAt !== undefined ? `he last wrote ${ago(now - st.lastHisAt)}. ` : ''}a thought you just had: "${out.thought}")`;
    const sent = await deps.selfEntry(goal);
    texted = sent > 0;
    if (texted) {
      w.textsFirst += 1;
      w.lastTextFirstAt = clock.epochMs();
      w.firstsSinceHis = unanswered + 1;
    }
  }

  mind.setState({ wander: w });
  await mind.flush();
  void deps.events.emit('mind.wander', { result: 'thought', item: item.key, kind: item.kind, wantsToText, texted, quiet });
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

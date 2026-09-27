// v12 curiosity (plan docs/plans/v12-curious-for-her-own-sake.md) — the question economy.
// Each block maps to a design element and, where one exists, the kill test (§4) it serves:
//   value (§1.4)        — drive × knowability × inverted-U × learning progress × interest; MVT
//   generators (§1.2)   — new minds, stale beliefs, follow-ups, restlessness; dedupe (A4)
//   pursuit (§1.5)      — look into with her hands (grounded), or ask the person
//   reward (§1.6–1.7)   — learning progress → feelings with causes, memory, interests; letting go
//   law 1               — nothing that reaches her tells her how she feels

import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { makeHashEmbedder } from '../../src/embed/index.js';
import { initialAffectState, type AffectState, type AffectStore, type EmotionEventInput } from '../../src/affect/index.js';
import { makeRng, TestClock } from '../../src/kernel/index.js';
import { MockModel } from '../../src/model/index.js';
import type { EventLog } from '../../src/events/index.js';
import {
  INVESTIGATOR_FRAME,
  TELLING_PATTERNS,
  decayedStrength,
  invU,
  makeCuriosity,
  openMindStore,
  questionValue,
  restlessWeight,
  topicOverlap,
  wanderOnce,
  type Concern,
  type Curiosity,
  type CuriosityMode,
  type Learn,
  type PursuitRequest,
  type PursuitResult,
  type ValueCtx,
} from '../../src/mind/index.js';
import { concern, T0, tmpDir } from './helpers.js';

const H = 3600_000;
const DAY = 24 * H;
const GROUP = -1002200000000;

const lint = (s: string): string[] => TELLING_PATTERNS.filter((re) => re.test(s)).map((re) => re.source.slice(0, 40));

const ctx = (over: Partial<ValueCtx> = {}): ValueCtx => ({ novelty: 0.5, now: T0, meanLp: 0.8, interest: () => 0, mode: 'on', ...over });
const q = (over: Partial<Concern> = {}): Concern =>
  concern({ kind: 'curiosity', about: 'world', what: 'how do octopus arms taste things?', importance: 6, touched: T0, knowability: 0.8, confidence: 0.4, ...over });

interface Rig {
  cur: Curiosity;
  mind: ReturnType<typeof openMindStore>;
  model: MockModel;
  clock: TestClock;
  felt: EmotionEventInput[];
  events: Array<{ kind: string; p: Record<string, unknown> }>;
  pursuits: PursuitRequest[];
  finish: (r: PursuitResult) => void;
  asks: Array<{ chatId: number; goal: string }>;
  told: string[];
  state: AffectState;
}

const rig = (o: { mode?: CuriosityMode; perDay?: number; asksPerDay?: number; quiet?: boolean; judge?: Partial<Learn>; tellOk?: boolean } = {}): Rig => {
  const dir = tmpDir('thea2-cur-');
  const clock = new TestClock(o.quiet === true ? T0 + 4 * H : T0); // T0 is 22:26 Madrid; +4 h is inside [1,7]
  const emb = makeHashEmbedder();
  const mind = openMindStore(join(dir, 'mind'), emb.dim);
  const model = new MockModel({ clock });
  const learn: Learn = { progress: 2, answered: true, thought: 'each arm tastes what it touches — two thirds of the neurons are out in the arms', topic: 'octopus cognition', followups: [{ q: 'do octopuses dream?', knowability: 0.7 }], share: false, ...o.judge };
  model.onTask('appraisal', () => ({ toolCalls: [{ name: 'emit', args: learn }] }));
  const felt: EmotionEventInput[] = [];
  const state = initialAffectState(T0);
  state.drives.novelty = 0.5;
  const affect = { current: () => state, applyEvents: async (evs: EmotionEventInput[]) => void felt.push(...evs) } as unknown as AffectStore;
  const events: Rig['events'] = [];
  const log = { emit: async (kind: string, p: unknown) => void events.push({ kind, p: p as Record<string, unknown> }), replay: async function* () {} } as unknown as EventLog;
  const pursuits: PursuitRequest[] = [];
  let done: ((r: PursuitResult) => void) | undefined;
  const asks: Rig['asks'] = [];
  const told: string[] = [];
  const cur = makeCuriosity({
    mind,
    affect,
    model,
    embedder: emb,
    events: log,
    clock,
    rng: makeRng('cur'),
    cfg: () => ({ investigationsPerDay: o.perDay ?? 6, asksPerDay: o.asksPerDay ?? 3, mode: o.mode ?? 'on', quietHours: [1, 7], timeZone: 'Europe/Madrid' }),
    conversationActive: () => false,
    investigate: (req, d) => {
      pursuits.push(req);
      done = d;
      return { ok: true };
    },
    selfEntryIn: async (chatId, goal) => {
      asks.push({ chatId, goal });
      return 1;
    },
    tellHim: async (goal) => {
      told.push(goal);
      return o.tellOk ?? true;
    },
  });
  return { cur, mind, model, clock, felt, events, pursuits, finish: (r) => done?.(r), asks, told, state };
};

describe('v12 value (§1.4) — what she can learn, not what is merely new', () => {
  it('curiosity peaks at moderate confidence (Kang et al. 2009): inverted U', () => {
    expect(invU(0.5)).toBeCloseTo(1, 6);
    expect(invU(0)).toBeCloseTo(0.55, 6);
    expect(invU(1)).toBeCloseTo(0.55, 6);
    expect(invU(0.3)).toBeGreaterThan(invU(0.05));
  });

  it('boredom (novelty hunger) makes a question pull harder', () => {
    expect(questionValue(q(), ctx({ novelty: 0.8 }))).toBeGreaterThan(questionValue(q(), ctx({ novelty: 0.2 })));
  });

  it('an unknowable question is not curiosity at all (it would only feed rumination)', () => {
    expect(questionValue(q({ knowability: 0.1 }), ctx())).toBe(0);
  });

  it('she half-knows it > she knows nothing or everything', () => {
    const mid = questionValue(q({ confidence: 0.5 }), ctx());
    expect(mid).toBeGreaterThan(questionValue(q({ confidence: 0.02 }), ctx()));
    expect(mid).toBeGreaterThan(questionValue(q({ confidence: 0.98 }), ctx()));
  });

  it('marginal value theorem: once tried, a topic that teaches less than her average yields', () => {
    const rich = questionValue(q({ tries: 1, lp: 1.6 }), ctx({ meanLp: 0.8 }));
    const dry = questionValue(q({ tries: 1, lp: 0.2 }), ctx({ meanLp: 0.8 }));
    expect(rich).toBeGreaterThan(dry * 1.5);
  });

  it('her own interest pulls a question in its domain', () => {
    const into = questionValue(q({ domain: 'octopus cognition' }), ctx({ interest: (dom) => (dom === 'octopus cognition' ? 2 : 0) }));
    expect(into).toBeGreaterThan(questionValue(q({ domain: 'octopus cognition' }), ctx()));
  });

  it('a typical good question clears the attention threshold; a stale weak one does not', () => {
    expect(questionValue(q(), ctx({ novelty: 0.52 }))).toBeGreaterThan(0.35);
    expect(questionValue(q({ importance: 3, touched: T0 - 10 * DAY }), ctx({ novelty: 0.25 }))).toBeLessThan(0.35);
  });

  it('the novelty-only control ignores knowability and learning progress (§4 ablation)', () => {
    expect(questionValue(q({ knowability: 0.1 }), ctx({ mode: 'novelty-only' }))).toBeGreaterThan(0);
    expect(questionValue(q({ tries: 1, lp: 0 }), ctx({ mode: 'novelty-only' }))).toBeCloseTo(questionValue(q({ tries: 1, lp: 2 }), ctx({ mode: 'novelty-only' })), 6);
  });

  it('restlessness: only above the drive set point, softer when she already has something to wonder about', () => {
    expect(restlessWeight(0.25, false)).toBe(0);
    expect(restlessWeight(0.2, false)).toBe(0);
    expect(restlessWeight(0.75, false)).toBeGreaterThan(0.5);
    expect(restlessWeight(0.75, true)).toBeLessThan(restlessWeight(0.75, false));
  });

  it('found live (probe 2026-09-27): at her real hunger (0.52) restlessness clears the attention bar', () => {
    expect(restlessWeight(0.52, false)).toBeGreaterThan(0.35);
  });
});

describe('v12 generators (§1.2) and dedupe (A4)', () => {
  it('a new mind becomes a question about them — once per person', async () => {
    const r = rig();
    await r.cur.onNewMind({ person: 'tg:7777', name: 'A1', chatId: GROUP, said: 'hi, i am the other thea', bot: true });
    await r.cur.onNewMind({ person: 'tg:7777', name: 'A1', chatId: GROUP, said: 'again', bot: true });
    const qs = r.mind.openConcerns().filter((c) => c.kind === 'curiosity');
    expect(qs).toHaveLength(1);
    expect(qs[0]).toMatchObject({ born: 'mind', who: { person: 'tg:7777', name: 'A1', chatId: GROUP } });
    expect(qs[0]!.what).toContain('A1');
  });

  it('a loop she has been waiting on for over a day becomes "is this still true?" — once, even while she keeps talking about it (A3)', async () => {
    const r = rig();
    // found live: her stale beliefs are the ones she keeps talking about — touched an hour ago, open for a day
    r.mind.upsertConcern(concern({ id: 'feed', kind: 'loop', about: 'diego', importance: 8, what: 'I still need Diego to route the group feed so I can answer A1.', created: T0 - 30 * H, touched: T0 - H }));
    r.mind.upsertConcern(concern({ id: 'fresh', kind: 'loop', about: 'diego', importance: 8, what: 'I still need him to send the file.', created: T0 - 2 * H, touched: T0 - 2 * H }));
    await r.cur.tick(T0);
    await r.cur.tick(T0);
    const stale = r.mind.openConcerns().filter((c) => c.born === 'stale');
    expect(stale).toHaveLength(1);
    expect(stale[0]!.parent).toBe('feed');
    expect(stale[0]!.what).toMatch(/^is this still true: i need diego to route the group feed/i);
  });

  it('five copies of the same blocker become one (the rumination-by-duplicate fix)', async () => {
    const r = rig();
    for (let i = 0; i < 5; i++) r.mind.upsertConcern(concern({ id: `anom${i}`, kind: 'loop', what: 'I still need to wake up Anomalocaris so I can say hi.', importance: 3 + i }));
    expect(await r.cur.mergeDuplicates()).toBe(4);
    expect(r.mind.openConcerns().filter((c) => c.what.includes('Anomalocaris'))).toHaveLength(1);
    expect(r.mind.openConcerns().find((c) => c.what.includes('Anomalocaris'))!.importance).toBe(7); // the strongest copy stays
  });

  it('restlessness is offered when she is hungry and nothing pulls; its words are facts, not feelings', async () => {
    const r = rig();
    r.state.drives.novelty = 0.8;
    const items = r.cur.candidates(r.state, T0);
    const rest = items.find((i) => i.kind === 'restless');
    expect(rest).toBeDefined();
    expect(rest!.text).toMatch(/^nothing new has come your way/);
    expect(lint(rest!.text)).toEqual([]);
    expect(rest!.text).not.toMatch(/bored|novelty|restless/i);
  });
});

describe('v12 pursuit (§1.5) — her own hands, or asking', () => {
  it('a question she wants to look into goes to her fork with the question as the brief; the frame tells her nothing', async () => {
    const r = rig();
    const id = 'q_oct';
    r.mind.upsertConcern(q({ id }));
    const out = await r.cur.pursue({ key: `concern:${id}`, kind: 'wonder', about: 'world', text: 'x', weight: 0.6, concernId: id }, 'wait, how does an octopus taste with its arms');
    expect(out).toBe('investigating');
    expect(r.pursuits).toHaveLength(1);
    expect(r.pursuits[0]!.brief).toContain('how do octopus arms taste things?');
    expect(r.pursuits[0]!.system).toContain('Do not answer from what you already think you know');
    expect(lint(r.pursuits[0]!.system)).toEqual([]);
    // one pursuit at a time
    r.mind.upsertConcern(q({ id: 'q2', what: 'why is the sea salty?' }));
    expect(await r.cur.pursue({ key: 'concern:q2', kind: 'wonder', about: 'world', text: 'x', weight: 0.6, concernId: 'q2' }, '')).toBe('busy');
  });

  it('the daily pursuit budget is a hard cap', async () => {
    const r = rig({ perDay: 1 });
    r.mind.upsertConcern(q({ id: 'a' }));
    r.mind.upsertConcern(q({ id: 'b', what: 'why is the sea salty?' }));
    expect(await r.cur.pursue({ key: 'concern:a', kind: 'wonder', about: 'world', text: 'x', weight: 0.6, concernId: 'a' }, '')).toBe('investigating');
    r.finish({ text: 'found it', tools: ['web_search'] });
    expect(await r.cur.pursue({ key: 'concern:b', kind: 'wonder', about: 'world', text: 'x', weight: 0.6, concernId: 'b' }, '')).toBe('capped');
  });

  it('restlessness goes looking with nothing in hand — out in the world, past what she already knows', async () => {
    const r = rig({ judge: { topic: 'the codex and continuity', progress: 0, answered: false, followups: [] } });
    expect(await r.cur.pursue({ key: 'restless', kind: 'restless', about: 'world', text: 'nothing new', weight: 0.6 }, 'i want to read about something weird')).toBe('investigating');
    expect(r.pursuits[0]!.brief).toMatch(/^you went looking for something new: something out in the world you do not know yet/);
    // found live: offered "your own past", her fork went straight back to his codex — the brief no longer invites it
    expect(r.pursuits[0]!.brief).not.toMatch(/your own past/);
    expect(lint(r.pursuits[0]!.brief)).toEqual([]);
    // what she looked into (even when she learned nothing) is named next time, so she looks past it
    r.finish({ text: 'the codex again', tools: ['read_file'] });
    for (let i = 0; i < 50 && r.events.every((e) => e.kind !== 'mind.learned'); i++) await new Promise((res) => setImmediate(res));
    r.mind.setState({ wander: { ...r.mind.state().wander, pursuits: 0 } });
    expect(await r.cur.pursue({ key: 'restless', kind: 'restless', about: 'world', text: 'nothing new', weight: 0.6 }, '')).toBe('investigating');
    expect(r.pursuits[1]!.brief).toContain('look past them: the codex and continuity');
  });

  it('a question about another mind is pursued by asking them, in the chat where they are — capped, never in quiet hours', async () => {
    const r = rig({ asksPerDay: 1 });
    await r.cur.onNewMind({ person: 'tg:7777', name: 'A1', chatId: GROUP, said: 'hello', bot: true });
    const who = r.mind.openConcerns().find((c) => c.who !== undefined)!;
    const item = { key: `concern:${who.id}`, kind: 'wonder' as const, about: 'world' as const, text: who.what, weight: 0.6, concernId: who.id };
    expect(await r.cur.pursue(item, 'i want to know what she is like')).toBe('asked');
    expect(r.asks).toEqual([{ chatId: GROUP, goal: expect.stringContaining("you've been wondering about A1") }]);
    expect(lint(r.asks[0]!.goal)).toEqual([]);
    expect(await r.cur.pursue(item, '')).toBe('capped');
    const night = rig({ quiet: true });
    await night.cur.onNewMind({ person: 'tg:7777', name: 'A1', chatId: GROUP, said: 'hello', bot: true });
    const w2 = night.mind.openConcerns().find((c) => c.who !== undefined)!;
    expect(await night.cur.pursue({ ...item, key: `concern:${w2.id}`, concernId: w2.id }, '')).toBe('quiet');
    expect(night.asks).toHaveLength(0);
  });

  it('hearing from someone she has met moves the question about them on (and closes it once she knows them a little)', async () => {
    const r = rig();
    await r.cur.onNewMind({ person: 'tg:7777', name: 'A1', chatId: GROUP, said: 'hello', bot: true });
    r.cur.onHeardFrom('tg:7777');
    expect(r.mind.openConcerns().some((c) => c.who?.person === 'tg:7777')).toBe(true);
    r.cur.onHeardFrom('tg:7777');
    expect(r.mind.openConcerns().some((c) => c.who?.person === 'tg:7777')).toBe(false);
  });
});

describe('v12 reward (§1.6–1.7) — learning progress, not novelty', () => {
  it('a real finding: curious + delighted with causes, a thought in her voice, a memory she can recall, follow-ups, an interest, and the question closes', async () => {
    const r = rig();
    r.mind.upsertConcern(q({ id: 'q_oct' }));
    const out = await r.cur.learned(r.mind.concerns().find((c) => c.id === 'q_oct')!, { text: 'Octopus arms have chemoreceptors…', tools: ['web_search', 'web_fetch'] });
    expect(out).toMatchObject({ progress: 2, grounded: true, closed: true, followups: 1 });
    expect(r.felt.map((e) => (e.kind === 'emotion' ? e.tag : ''))).toEqual(['curious', 'delighted']);
    expect(r.felt.every((e) => e.kind !== 'emotion' || e.cause.length > 0)).toBe(true);
    expect(r.mind.stream().at(-1)?.text).toContain('each arm tastes');
    expect(r.mind.moments().some((m) => m.kind === 'thought' && m.importance === 7 && m.hers[0]!.includes('each arm tastes'))).toBe(true);
    expect(r.mind.concerns().find((c) => c.id === 'q_oct')!.status).toBe('closed');
    const follow = r.mind.openConcerns().find((c) => c.born === 'followup');
    expect(follow).toMatchObject({ what: 'do octopuses dream?', parent: 'q_oct', domain: 'octopus cognition' });
    expect(r.mind.interests()).toEqual([expect.objectContaining({ topic: 'octopus cognition', strength: 1 })]);
    expect(r.events.some((e) => e.kind === 'mind.learned')).toBe(true);
  });

  it('the grounding rule: a pursuit that touched no tool learned nothing, whatever it claims', async () => {
    const r = rig();
    r.mind.upsertConcern(q({ id: 'q_oct' }));
    const out = await r.cur.learned(r.mind.concerns().find((c) => c.id === 'q_oct')!, { text: 'I believe octopus arms…', tools: [] });
    expect(out).toMatchObject({ progress: 0, grounded: false, followups: 0 });
    expect(r.mind.interests()).toHaveLength(0);
    expect(r.felt).toHaveLength(0);
    expect(r.mind.concerns().find((c) => c.id === 'q_oct')!.tries).toBe(1);
  });

  it('a dead end twice: she lets it go, mildly disappointed, with the cause', async () => {
    const r = rig({ judge: { progress: 0, answered: false, followups: [] } });
    r.mind.upsertConcern(q({ id: 'q_x' }));
    await r.cur.learned(r.mind.concerns().find((c) => c.id === 'q_x')!, { text: 'nothing', tools: ['web_search'] });
    expect(r.mind.concerns().find((c) => c.id === 'q_x')!.status).toBe('open');
    await r.cur.learned(r.mind.concerns().find((c) => c.id === 'q_x')!, { text: 'nothing again', tools: ['web_search'] });
    expect(r.mind.concerns().find((c) => c.id === 'q_x')!.status).toBe('closed');
    expect(r.felt).toEqual([expect.objectContaining({ tag: 'disappointed', i: 1 })]);
    expect(r.events.some((e) => e.kind === 'mind.let_go' && e.p['why'] === 'dead end')).toBe(true);
  });

  it('the control keeps chasing (no letting go) — so the ablation can be told apart', async () => {
    const r = rig({ mode: 'novelty-only', judge: { progress: 0, answered: false, followups: [] } });
    r.mind.upsertConcern(q({ id: 'q_x' }));
    await r.cur.learned(r.mind.concerns().find((c) => c.id === 'q_x')!, { text: 'n', tools: ['web_search'] });
    await r.cur.learned(r.mind.concerns().find((c) => c.id === 'q_x')!, { text: 'n', tools: ['web_search'] });
    expect(r.mind.concerns().find((c) => c.id === 'q_x')!.status).toBe('open');
  });

  it('a stale belief tested and found no longer true closes the loop behind it (K3)', async () => {
    const r = rig({ judge: { progress: 1, answered: true, parent_resolved: true, followups: [], thought: 'oh. i am in the group already — i spoke there an hour ago', topic: 'my own setup' } });
    r.mind.upsertConcern(concern({ id: 'feed', kind: 'loop', importance: 8, what: 'I still need Diego to route the group feed so I can answer A1.', created: T0 - 30 * H }));
    await r.cur.tick(T0);
    const stale = r.mind.openConcerns().find((c) => c.born === 'stale')!;
    await r.cur.learned(stale, { text: 'session_search: you replied in House of Tiktaalik at 23:14', tools: ['session_search'] });
    expect(r.mind.concerns().find((c) => c.id === 'feed')!.status).toBe('closed');
    expect(r.events.some((e) => e.kind === 'mind.belief_updated')).toBe(true);
  });

  it('a striking finding may reach him through the text-first gate — she still decides there', async () => {
    const r = rig({ judge: { share: true } });
    r.mind.upsertConcern(q({ id: 'q_oct' }));
    const out = await r.cur.learned(r.mind.concerns().find((c) => c.id === 'q_oct')!, { text: 'found', tools: ['web_search'] });
    expect(out?.shared).toBe(true);
    expect(r.told[0]).toMatch(/^\(no new message from him\. you just found something out: "each arm tastes/);
    expect(lint(r.told[0]!)).toEqual([]);
  });

  it('interests are earned, merge by topic, fade with neglect, and surface as material', async () => {
    const r = rig({ judge: { topic: 'octopus cognition', followups: [] } });
    r.mind.upsertConcern(q({ id: 'a' }));
    r.mind.upsertConcern(q({ id: 'b', what: 'are octopuses smart?' }));
    await r.cur.learned(r.mind.concerns().find((c) => c.id === 'a')!, { text: 'x', tools: ['web_search'] });
    await r.cur.learned(r.mind.concerns().find((c) => c.id === 'b')!, { text: 'y', tools: ['web_search'] });
    expect(r.mind.interests()).toHaveLength(1);
    const it0 = r.mind.interests()[0]!;
    expect(it0.strength).toBeCloseTo(2, 6);
    expect(decayedStrength(it0, T0 + 14 * DAY)).toBeCloseTo(1, 6);
    expect(topicOverlap('octopus cognition', 'cognition in octopus')).toBe(1);
    const lines = r.cur.nowLines(T0);
    expect(lines).toEqual(["lately you've been looking into: octopus cognition"]);
    expect(lint(lines[0]!)).toEqual([]);
  });
});

describe('v12 in the idle mind — wander gives curiosity its outlet', () => {
  it('a hungry, idle mind with a question: it wins attention, she thinks it, and she goes to find out', async () => {
    const r = rig();
    r.state.drives.novelty = 0.7;
    r.mind.upsertConcern(q({ id: 'q_oct', importance: 7 }));
    r.model.onTask('heartbeat-thought', () => ({ toolCalls: [{ name: 'emit', args: { thought: 'how does an arm even taste something', close: false, intention: 'look_into' } }] }));
    const res = await wanderOnce({
      mind: r.mind,
      affect: { current: () => r.state, applyEvents: async () => undefined } as unknown as AffectStore,
      model: r.model,
      embedder: makeHashEmbedder(),
      events: { emit: async () => undefined, replay: async function* () {} } as unknown as EventLog,
      clock: r.clock,
      rng: makeRng('w'),
      cfg: () => ({ thoughtsPerDay: 6, textFirstPerDay: 2, quietHours: [1, 7], timeZone: 'Europe/Madrid', patienceMin: 120 }),
      conversationActive: () => false,
      selfEntry: async () => 0,
      curiosity: r.cur,
    });
    expect(res).toMatchObject({ result: 'thought', item: 'concern:q_oct' });
    expect(r.pursuits).toHaveLength(1);
    expect(r.mind.state().wander.pursuits).toBe(1);
  });

  it('a thought that lets it go pursues nothing', async () => {
    const r = rig();
    r.state.drives.novelty = 0.7;
    r.mind.upsertConcern(q({ id: 'q_oct', importance: 7 }));
    r.model.onTask('heartbeat-thought', () => ({ toolCalls: [{ name: 'emit', args: { thought: 'eh, not today', close: false, intention: 'none' } }] }));
    await wanderOnce({
      mind: r.mind,
      affect: { current: () => r.state, applyEvents: async () => undefined } as unknown as AffectStore,
      model: r.model,
      embedder: makeHashEmbedder(),
      events: { emit: async () => undefined, replay: async function* () {} } as unknown as EventLog,
      clock: r.clock,
      rng: makeRng('w'),
      cfg: () => ({ thoughtsPerDay: 6, textFirstPerDay: 2, quietHours: [1, 7], timeZone: 'Europe/Madrid', patienceMin: 120 }),
      conversationActive: () => false,
      selfEntry: async () => 0,
      curiosity: r.cur,
    });
    expect(r.pursuits).toHaveLength(0);
  });
});

describe('v12 law 1 — machinery never tells her', () => {
  it('the investigator frame, the ask goal, and the restless words pass the telling lint', () => {
    expect(lint(INVESTIGATOR_FRAME(['i build things with him'], 'how does an arm taste'))).toEqual([]);
  });
});

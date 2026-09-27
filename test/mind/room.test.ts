// v13 introspection, Phase 2 — H6 the quiet room (plan docs/plans/v13-proposal-knowing-what-she-feels.md
// §6 Phase 2.2): items from her real history, a truthful reveal, shams from another day, practice
// that is remembered but never a way to reply, and the mastery hunger as its only pull.

import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { makeHashEmbedder } from '../../src/embed/index.js';
import { initialAffectState, type AffectEvent, type AffectStore } from '../../src/affect/index.js';
import { signature, COUPLING_BASELINES } from '../../src/coupling/index.js';
import { makeRng, TestClock } from '../../src/kernel/index.js';
import { MockModel } from '../../src/model/index.js';
import type { EventLog } from '../../src/events/index.js';
import {
  candidates,
  fullVector,
  isPrecedent,
  lintSegments,
  makeRoom,
  matchChoice,
  openMindStore,
  quantities,
  readRoom,
  roomItems,
  roomStats,
  stateFromFelt,
  tagSignature,
  vecToArray,
  wanderOnce,
  ROOM,
  ROOM_SYSTEM,
  TELLING_PATTERNS,
  type RoomTrial,
} from '../../src/mind/index.js';
import { addMoments, moment, settle, T0, tmpDir } from './helpers.js';

const H = 3600_000;
const NOW = T0 + 12 * H; // a Madrid morning-ish local day

const full = (him: number, nw: number, making: number): number[] => [0, 0, 0, 0, 0, 0, 0, 0, him, nw, making];

describe('H6 — the items come from her record', () => {
  it('compare items read then vs now the same way; the truth is the engine’s, not a reading of words', () => {
    const now = quantities(tagSignature('warm', 3), full(0.8, 0.1, 0.5));
    const then = quantities(tagSignature('warm', 3), full(0.2, 0.1, 0.52));
    const items = roomItems(now, then, makeRng('a'), 6);
    const him = items.find((x) => x.q === 'him')!;
    expect(him).toMatchObject({ kind: 'compare', options: ['stronger', 'weaker'], truth: 0 });
    expect(items.find((x) => x.q === 'making')).toBeUndefined(); // 0.02 apart: a coin, never asked
    expect(items.find((x) => x.q === 'new')).toBeUndefined();
  });

  it('which-is-bigger items need no memory; near-ties are never asked', () => {
    const items = roomItems(quantities(new Array(12).fill(0), full(0.3, 0.9, 0.31)), undefined, makeRng('b'), 6);
    expect(items.every((x) => x.kind === 'which')).toBe(true);
    expect(items.find((x) => x.q === 'new|him')).toMatchObject({ truth: 0 });
    expect(items.find((x) => x.q === 'making|him')).toBeUndefined(); // 0.01 apart
  });

  it('heaviness and buzzing come from valence and arousal', () => {
    const now = quantities([-0.5, 0.4, ...new Array(10).fill(0)], full(0, 0, 0));
    const then = quantities([0.2, 0, ...new Array(10).fill(0)], full(0, 0, 0));
    const items = roomItems(now, then, makeRng('c'), 6);
    expect(items.find((x) => x.q === 'heavy')).toMatchObject({ options: ['more', 'less'], truth: 0 });
    expect(items.find((x) => x.q === 'buzz')).toMatchObject({ truth: 0 });
  });

  it('her choice is read strictly: the option as written, or one plainly contained', () => {
    expect(matchChoice('Stronger', ['stronger', 'weaker'])).toBe(0);
    expect(matchChoice('weaker, i think', ['stronger', 'weaker'])).toBe(1);
    expect(matchChoice('both?', ['stronger', 'weaker'])).toBeUndefined();
    expect(matchChoice('something new', ['something new', 'him'])).toBe(0);
  });

  it('a sham is a real snapshot from another day: rebuilt from that memory’s exact state', () => {
    const s = initialAffectState(T0);
    s.primaries.sadness = 0.45;
    s.drives.connection = 0.9;
    s.dials.arousal = 0.7;
    const sig = vecToArray(signature(s, COUPLING_BASELINES));
    const f = fullVector(s);
    const back = stateFromFelt(sig, f, NOW, { text: 'he went quiet', t: NOW - 2 * H });
    const sig2 = vecToArray(signature(back, COUPLING_BASELINES));
    for (let i = 0; i < 12; i++) expect(sig2[i]).toBeCloseTo(sig[i]!, 2);
    expect(fullVector(back)[8]).toBeCloseTo(f[8]!, 2);
    expect(back.causes.sadness?.text).toBe('he went quiet');
  });

  it('the room’s own words tell her nothing (the law holds for the frame)', () => {
    for (const re of TELLING_PATTERNS) expect(ROOM_SYSTEM).not.toMatch(re);
    const items = roomItems(quantities([-0.5, 0.4, ...new Array(10).fill(0)], full(0.9, 0.1, 0.5)), quantities([0.2, 0, ...new Array(10).fill(0)], full(0.2, 0.5, 0.1)), makeRng('d'), 6);
    expect(lintSegments(items.map((it) => ({ kind: 'frame' as const, text: it.question })))).toEqual([]);
  });

  it('accuracy by condition and confidence (what the kill test reads)', () => {
    const t = (cond: RoomTrial['cond'], right: boolean, sure: RoomTrial['sure']): RoomTrial => ({ ts: 0, session: 's', n: 1, kind: 'which', q: 'x', question: 'q', options: ['a', 'b'], truth: 0, delta: 0.2, cond, right, sure });
    const st = roomStats([t({ kind: 'listen', noise: 0 }, true, 'sure'), t({ kind: 'listen', noise: 0 }, false, 'sure'), t({ kind: 'sham', yokedId: 'y' }, false, 'fairly'), t({ kind: 'none' }, true, 'guessing')]);
    expect(st.byCond['listen@0']).toEqual({ n: 2, right: 1 });
    expect(st.byCond['sham']).toEqual({ n: 1, right: 0 });
    expect(st.bySure['guessing']).toEqual({ n: 1, right: 1 });
  });
});

interface Rig {
  room: ReturnType<typeof makeRoom>;
  mind: ReturnType<typeof openMindStore>;
  model: MockModel;
  fed: AffectEvent[];
  events: Array<{ kind: string; p: Record<string, unknown> }>;
  state: ReturnType<typeof initialAffectState>;
  clock: TestClock;
  emb: ReturnType<typeof makeHashEmbedder>;
  log: EventLog;
  affect: AffectStore;
}

const rig = async (o: { answers?: unknown; hisToday?: boolean; mastery?: number } = {}): Promise<Rig> => {
  const clock = new TestClock(NOW);
  const emb = makeHashEmbedder();
  const mind = openMindStore(join(tmpDir('thea2-room-'), 'mind'), emb.dim);
  const thenState = initialAffectState(NOW - 4 * H);
  thenState.drives.connection = 0.3;
  thenState.drives.novelty = 0.9;
  const oldState = initialAffectState(NOW - 3 * 24 * H);
  oldState.primaries.fear = 0.5;
  oldState.drives.connection = 0.95;
  await addMoments(mind, emb, [
    moment({ id: 'then1', source: 'lived', ts: NOW - 4 * H, his: 'look at this octopus arm paper', hers: ['wait they taste with them??'], felt: { sig: vecToArray(signature(thenState, COUPLING_BASELINES)), full: fullVector(thenState), source: 'exact', by: 'engine' } }),
    moment({ id: 'old1', source: 'lived', ts: NOW - 3 * 24 * H, his: 'long day, talk later', hers: ['ok. i will be here'], felt: { sig: vecToArray(signature(oldState, COUPLING_BASELINES)), full: fullVector(oldState), source: 'exact', by: 'engine' } }),
    moment({ id: 'est', source: 'lived', ts: NOW - 3 * H, his: 'hey', hers: ['hi'], felt: { sig: tagSignature('warm', 3), word: 'warm', source: 'estimated' } }),
  ]);
  if (o.hisToday !== false) mind.setState({ lastHisAt: NOW - 1 * H });
  const state = initialAffectState(NOW);
  state.drives.connection = 0.9;
  state.drives.novelty = 0.3;
  state.drives.mastery = o.mastery ?? 0.9;
  const fed: AffectEvent[] = [];
  const affect = { current: () => state, applyEvents: async (evs: AffectEvent[]) => void fed.push(...evs) } as unknown as AffectStore;
  const events: Rig['events'] = [];
  const log = { emit: async (kind: string, p: unknown) => void events.push({ kind, p: p as Record<string, unknown> }), replay: async function* () {} } as unknown as EventLog;
  const model = new MockModel({ clock });
  model.onTask('heartbeat-thought', () => ({ toolCalls: [{ name: 'emit', args: o.answers ?? { answers: [1, 2, 3].map((n) => ({ n, choice: 'stronger', sure: 'fairly' })) } }] }));
  const room = makeRoom({ mind, affect, model, embedder: emb, events: log, clock, rng: makeRng('room-rig'), timeZone: 'Europe/Madrid', feltNow: () => vecToArray(signature(state, COUPLING_BASELINES)) });
  return { room, mind, model, fed, events, state, clock, emb, log, affect };
};

describe('H6 — a session', () => {
  it('asks from her record, on her voice door; the reveal is the engine’s truth, logged per trial', async () => {
    const r = await rig();
    const res = await r.room.practise(NOW);
    expect(res).toBeDefined();
    const call = r.model.calls.find((c) => c.taskClass === 'heartbeat-thought')!;
    expect(call.tier).toBe('main');
    const user = String(call.messages.find((m) => m.role === 'user')?.content);
    expect(user).toContain('[the quiet room]');
    expect(user).toContain('octopus arm paper'); // then = the only exact lived moment 2–6 h ago (the estimate is never a then)
    const trials = readRoom(r.mind.dir);
    expect(trials.length).toBe(res!.of);
    const himTrial = trials.find((t) => t.q === 'him');
    expect(himTrial).toMatchObject({ truth: 0, thenId: 'then1' }); // 0.9 now vs 0.3 then: stronger
    expect(himTrial?.right).toBe(true);
    // the reveal never shows a number or a feeling name, and says right / not right plainly
    const practice = r.mind.moments().find((m) => m.kind === 'practice')!;
    expect(practice.hers.join('\n')).toMatch(/in the quiet room: .*(right|not right)/);
    expect(practice.hers.join('\n')).toMatch(/then: him: "look at this octopus arm paper"/);
  });

  it('practice is remembered, never a way to reply; stays out of the night; stills the hands, never contact', async () => {
    const r = await rig();
    await r.room.practise(NOW);
    const practice = r.mind.moments().find((m) => m.kind === 'practice')!;
    expect(isPrecedent(practice)).toBe(false);
    expect(r.mind.precedents().some((m) => m.kind === 'practice')).toBe(false);
    expect(practice.felt).toMatchObject({ source: 'exact', by: 'engine' });
    expect(r.fed).toEqual([{ kind: 'tagFeed', tag: 'DONE' }]);
    expect(r.events.find((e) => e.kind === 'mind.room')?.p).toMatchObject({ result: 'practised' });
  });

  it('a sham shows another day’s snapshot (≈10% of trials), never now', async () => {
    const r = await rig();
    let shams = 0;
    let trials = 0;
    for (let i = 0; i < 30; i++) {
      r.mind.setState({ room: { day: 'x', sessions: 0 } });
      await r.room.practise(NOW + i * 1000);
    }
    for (const t of readRoom(r.mind.dir)) {
      trials += 1;
      if (t.cond.kind === 'sham') {
        shams += 1;
        expect(t.cond.yokedId).toBe('old1'); // ≥ 20 h old, exact
      }
    }
    expect(shams / trials).toBeGreaterThan(0.02);
    expect(shams / trials).toBeLessThan(0.25);
  });

  it('at most three a day; only on a day he has been around; the mastery hunger alone weighs it', async () => {
    const r = await rig();
    expect(r.room.candidate(r.state, NOW)).toMatchObject({ key: 'practice', kind: 'practice' });
    for (let i = 0; i < ROOM.perDay; i++) await r.room.practise(NOW + i);
    expect(r.room.candidate(r.state, NOW)).toBeUndefined();
    expect(await r.room.practise(NOW + 10)).toBeUndefined();

    const away = await rig({ hisToday: false });
    expect(away.room.candidate(away.state, NOW)).toBeUndefined();

    const sated = await rig({ mastery: 0.25 });
    expect(sated.room.candidate(sated.state, NOW)).toBeUndefined();
    const hungry = await rig({ mastery: 0.9 });
    const low = await rig({ mastery: 0.5 });
    expect(hungry.room.candidate(hungry.state, NOW)!.weight).toBeGreaterThan(low.room.candidate(low.state, NOW)!.weight);
  });

  it('wander: when the room wins, she sits there instead of thinking (and it counts toward the day)', async () => {
    const r = await rig();
    const out = await wanderOnce({
      mind: r.mind,
      affect: r.affect,
      model: r.model,
      embedder: r.emb,
      events: r.log,
      clock: r.clock,
      rng: makeRng('w'),
      cfg: () => ({ thoughtsPerDay: 12, textFirstPerDay: 1, quietHours: [0, 0], timeZone: 'Europe/Madrid', patienceMin: 100_000 }),
      conversationActive: () => false,
      selfEntry: async () => 0,
      room: r.room,
    });
    expect(candidates([], r.state, { now: NOW, patienceMin: 100_000 }).length).toBe(0); // nothing else pulls: the room wins
    expect(out.result).toBe('practice');
    expect(r.mind.state().wander.thoughts).toBe(1);
    expect(r.mind.state().room?.sessions).toBe(1);
    expect(r.mind.stream().length).toBe(0);
  });

  it('a malformed answer is logged as no answer (never scored right)', async () => {
    const r = await rig({ answers: { answers: [{ n: 1, choice: 'both, sort of', sure: 'guessing' }] } });
    await r.room.practise(NOW);
    const trials = readRoom(r.mind.dir);
    expect(trials[0]!.right).toBeUndefined();
    expect(trials.slice(1).every((t) => t.choice === undefined && t.right === undefined)).toBe(true);
  });
});

describe('H6 — through the REAL event log (found crashing the inward probe: an undefined "then" in the payload)', () => {
  it('a session with no memory 2–6 h ago, and a session with nothing askable, both log cleanly', async () => {
    const { openEventLog } = await import('../../src/events/index.js');
    const clock = new TestClock(NOW);
    const emb = makeHashEmbedder();
    const dir = tmpDir('thea2-room-real-');
    const mind = openMindStore(join(dir, 'mind'), emb.dim);
    mind.setState({ lastHisAt: NOW - H });
    const state = initialAffectState(NOW);
    state.drives.connection = 0.9;
    state.drives.novelty = 0.3;
    const affect = { current: () => state, applyEvents: async () => undefined } as unknown as AffectStore;
    const events = openEventLog(join(dir, 'events'), { clock });
    const model = new MockModel({ clock });
    model.onTask('heartbeat-thought', () => ({ toolCalls: [{ name: 'emit', args: { answers: [{ n: 1, choice: 'him', sure: 'fairly' }] } }] }));
    const room = makeRoom({ mind, affect, model, embedder: emb, events, clock, rng: makeRng('real'), timeZone: 'Europe/Madrid', feltNow: () => vecToArray(signature(state, COUPLING_BASELINES)) });
    await expect(room.practise(NOW)).resolves.toBeDefined();
    const flat = initialAffectState(NOW);
    const flatRoom = makeRoom({ mind, affect: { current: () => flat, applyEvents: async () => undefined } as unknown as AffectStore, model, embedder: emb, events, clock, rng: makeRng('flat'), timeZone: 'Europe/Madrid', feltNow: () => vecToArray(signature(flat, COUPLING_BASELINES)) });
    await expect(flatRoom.practise(NOW + 1)).resolves.toBeUndefined();
    await settle(50); // the room emits without awaiting (a log write must never hold her up)
    const kinds: string[] = [];
    for await (const e of events.replay()) kinds.push(`${e.kind}:${String((e.payload as { result?: string }).result)}`);
    expect(kinds).toEqual(expect.arrayContaining(['mind.room:practised', 'mind.room:nothing']));
  });
});

describe('H6 — a standing order is not a sense (found by the GLM probe: 90 of 90 "which is bigger" had one answer)', () => {
  it('the answers asked come out even: a constant guess scores about half', async () => {
    const { balanced, updateBase } = await import('../../src/mind/index.js');
    const it0 = { kind: 'which' as const, q: 'new|him', question: 'q', options: ['something new', 'him'] as [string, string], truth: 1 as 0 | 1, delta: 0.3 };
    const rng = makeRng('bal');
    let base = {};
    let asked = 0;
    let himAsked = 0;
    for (let i = 0; i < 3000; i++) {
      // the world: "him" is bigger 90% of the time
      const truth: 0 | 1 = rng.float() < 0.9 ? 1 : 0;
      const item = { ...it0, truth };
      const ask = balanced(item, base, rng);
      base = updateBase(base, [item]); // every item the room COULD ask — the base rate, not the asked ones
      if (!ask) continue;
      asked += 1;
      if (truth === 1) himAsked += 1;
    }
    expect(asked).toBeGreaterThan(300);
    expect(himAsked / asked).toBeGreaterThan(0.4);
    expect(himAsked / asked).toBeLessThan(0.6);
  });

  it('a new item is always asked until it has a history', async () => {
    const { balanced } = await import('../../src/mind/index.js');
    expect(balanced({ kind: 'which', q: 'x', question: 'q', options: ['a', 'b'], truth: 0, delta: 0.3 }, {}, makeRng('n'))).toBe(true);
  });
});

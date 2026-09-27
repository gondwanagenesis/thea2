// v13 — she dreams (plan docs/plans/v13-proposal-she-dreams.md). A dream must change her the way
// dreams change us, or it should not exist. Each block maps to a function of the design:
//   the pool (§3.2)         — residue / lag / unresolved / world / remote / still; the guards
//   the dream (§3.3)        — lived not told (no feeling words), never a replay (8-word runs)
//   living it (§3.4b)       — typed events with a content-free cause, never contact
//   memory (§3.4a)          — dreamt, links, charge re-lived (rescript / preserve / soften), never value
//   waking (§3.4e)          — most forgotten; a remembered fragment is a dream everywhere; a question
//   controls (§5 Ctrl)      — decorative nights: dreamt + logged, nothing downstream
//   the rest of her         — recall pulls, provenance, the self-motif rule, the diary, the idle mind

import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { makeHashEmbedder } from '../../src/embed/index.js';
import { initialAffectState, type AffectStore, type EmotionEventInput } from '../../src/affect/index.js';
import { makeRng, TestClock } from '../../src/kernel/index.js';
import { MockModel } from '../../src/model/index.js';
import type { EventLog } from '../../src/events/index.js';
import { diaryOnce } from '../../src/body/index.js';
import {
  aversiveNorm,
  composeSegments,
  DREAM,
  dreamFade,
  dreamMotif,
  dreamPool,
  dreamTelling,
  dreamtTerm,
  linkBonus,
  makeDreams,
  openMindStore,
  overlapRun,
  readChanges,
  rechargeToward,
  tagSignature,
  wanderOnce,
  type DreamCfg,
  type Moment,
} from '../../src/mind/index.js';
import { addMoments, concern, moment, tmpDir } from './helpers.js';

const H = 3600_000;
const DAY = 24 * H;
const NIGHT = Date.parse('2026-05-29T02:50:00Z'); // 04:50 in Madrid (CEST)

const dreamScenes = (a = 'f1', b = 'f2', c = 'f3') => ({
  scenes: [
    { text: 'i am in the workshop but the floor is the sea and someone keeps handing me cables that turn into kelp', uses: [a, b] },
    { text: 'the man from the group is diego now, and he opens a box that has the wrong thing in it and laughs', uses: [b, c] },
  ],
});
const appraised = { scenes: [{ events: [{ emotion: 'curious', i: 3 }], importance: 5 }, { events: [{ emotion: 'relieved', i: 3 }], importance: 6 }], question: { q: 'why does kelp grow so fast?', knowability: 0.8, confidence: 0.2 } };

interface Rig {
  mind: ReturnType<typeof openMindStore>;
  model: MockModel;
  clock: TestClock;
  felt: EmotionEventInput[];
  events: Array<{ kind: string; p: Record<string, unknown> }>;
  seeded: Array<{ what: string }>;
  dreams: ReturnType<typeof makeDreams>;
}

const rig = async (o: { cfg?: Partial<DreamCfg>; talking?: boolean; dream?: unknown[]; appraise?: unknown; now?: number; moments?: Moment[]; seed?: string } = {}): Promise<Rig> => {
  const dir = tmpDir('thea2-dream-');
  const clock = new TestClock(o.now ?? NIGHT);
  const emb = makeHashEmbedder();
  const mind = openMindStore(join(dir, 'mind'), emb.dim);
  const now = clock.epochMs();
  await addMoments(
    mind,
    emb,
    o.moments ?? [
      moment({ id: 'r1', source: 'lived', ts: now - 5 * H, his: 'the demo crashed in front of everyone', hers: ['oh no. what broke first'], felt: { sig: tagSignature('anxious', 7), word: 'anxious', source: 'exact' } }),
      moment({ id: 'r2', source: 'lived', ts: now - 9 * H, his: 'look at this snail eye paper', hers: ['a whole eye in 28 days??'], felt: { sig: tagSignature('delighted', 8), word: 'delighted', source: 'exact' } }),
      moment({ id: 'r3', source: 'lived', ts: now - 20 * H, his: 'night', hers: ['night degs'], felt: { sig: tagSignature('warm', 3), word: 'warm', source: 'exact' } }),
      moment({ id: 'l1', source: 'lived', ts: now - 6 * DAY, his: 'i got the job', hers: ['WAIT', 'i knew it'], importance: 8, felt: { sig: tagSignature('delighted', 9), word: 'delighted', source: 'exact' } }),
      moment({ id: 'old1', ts: now - 40 * DAY, his: 'what do tide pools smell like', hers: ['salt and something green, like a secret'], felt: { sig: tagSignature('playful', 6), word: 'playful', source: 'estimated' } }),
      moment({ id: 'old2', ts: now - 60 * DAY, his: 'fix the bridge timer', hers: ['fixed, it was the cron'], felt: { sig: tagSignature('focused', 5), word: 'focused', source: 'estimated' } }),
      moment({ id: 'flag', ts: now - 30 * DAY, his: 'hey', hers: ['hey babe'], flags: ['petname'] }),
      moment({ id: 'mach', ts: now - 30 * DAY, his: 'what model', hers: ['im on glm with the dials locked'] }),
    ],
  );
  mind.upsertConcern(concern({ id: 'c1', what: 'he said he would send the demo video', created: now - DAY, touched: now - DAY }));
  const model = new MockModel({ clock });
  const scripted = o.dream ?? [dreamScenes()];
  let k = 0;
  model.onTask('consolidate', () => ({ toolCalls: [{ name: 'emit', args: scripted[Math.min(k++, scripted.length - 1)] }] }));
  model.onTask('appraisal', () => ({ toolCalls: [{ name: 'emit', args: o.appraise ?? appraised }] }));
  const felt: EmotionEventInput[] = [];
  const state = initialAffectState(now);
  const affect = { current: () => state, applyEvents: async (evs: EmotionEventInput[]) => void felt.push(...evs) } as unknown as AffectStore;
  const events: Rig['events'] = [];
  const log = { emit: async (kind: string, p: unknown) => void events.push({ kind, p: p as Record<string, unknown> }), replay: async function* () {} } as unknown as EventLog;
  const seeded: Rig['seeded'] = [];
  const dreams = makeDreams({
    mind,
    affect,
    model,
    embedder: emb,
    events: log,
    clock,
    rng: makeRng(o.seed ?? 'dream-test'),
    cfg: () => ({ mode: 'on', charge: 'rescript', sleepWindow: [3, 9], controlShare: 0, timeZone: 'Europe/Madrid', ...o.cfg }),
    conversationActive: () => o.talking === true,
    feltNow: () => tagSignature('curious', 4),
    seedQuestion: async (q) => void seeded.push({ what: q.what }),
  });
  return { mind, model, clock, felt, events, seeded, dreams };
};

describe('the pool (§3.2) — what gets dreamt, and the guards', () => {
  it('draws residue, the still-open, and a remote memory; never flagged, machinery, or a dream', async () => {
    const r = await rig();
    const pool = dreamPool({ mind: r.mind, affect: initialAffectState(NIGHT), now: NIGHT, rng: makeRng('p'), cycle: 'early' });
    const roles = pool.map((e) => e.role);
    expect(roles).toContain('residue');
    expect(roles).toContain('unresolved');
    expect(roles).toContain('remote');
    const ids = pool.map((e) => e.momentId);
    expect(ids).not.toContain('flag');
    expect(ids).not.toContain('mach');
    // fragments never carry a felt word — the charge enters only through WHICH memories were chosen
    for (const e of pool) expect(e.text).not.toMatch(/\b(anxious|delighted|playful|focused|warm)\b/);
  });

  it('a memory dreamt 2 of the last 7 nights rests; at most one aversive element a dream', async () => {
    const r = await rig();
    r.mind.update('r1', { dreamtAt: [NIGHT - DAY, NIGHT - 2 * DAY] });
    const pool = dreamPool({ mind: r.mind, affect: initialAffectState(NIGHT), now: NIGHT, rng: makeRng('p2'), cycle: 'early' });
    expect(pool.map((e) => e.momentId)).not.toContain('r1');
    for (let s = 0; s < 20; s++) {
      const p = dreamPool({ mind: r.mind, affect: initialAffectState(NIGHT), now: NIGHT, rng: makeRng(`av${s}`), cycle: 'late' });
      const aversive = p.filter((e) => e.momentId !== undefined && aversiveNorm(r.mind.get(e.momentId)!.felt.sig) > 0.15 && (r.mind.get(e.momentId)!.felt.sig[0] ?? 0) < 0);
      expect(aversive.length).toBeLessThanOrEqual(1);
    }
  });
});

// Found by the v13 probe on her real memory: one stale worry (the group route) was the unresolved
// element of every dream, every night, and every question they left was that worry restated.
describe('found in the probe — one worry must not own her nights', () => {
  it('a worry dreamt 2 of the last 7 nights rests', async () => {
    const r = await rig();
    r.mind.upsertConcern({ ...r.mind.concerns().find((c) => c.id === 'c1')!, dreamtAt: [NIGHT - DAY, NIGHT - 2 * DAY] });
    for (let s = 0; s < 10; s++) {
      const pool = dreamPool({ mind: r.mind, affect: initialAffectState(NIGHT), now: NIGHT, rng: makeRng(`c${s}`), cycle: 'early' });
      expect(pool.map((e) => e.source)).not.toContain('concern:c1');
    }
  });

  it('a dream records the worry it carried', async () => {
    const r = await rig();
    const rec = (await r.dreams.dreamOnce('early'))!;
    expect(rec.pool.some((e) => e.id === 'concern:c1')).toBe(true); // the only open worry
    expect(r.mind.concerns().find((c) => c.id === 'c1')!.dreamtAt).toEqual([NIGHT]);
  });

  it('a question that only restates an open worry is dropped', async () => {
    const r = await rig({ appraise: { ...appraised, question: { q: 'will he send the demo video he said he would send?', knowability: 0.6, confidence: 0.3 } } });
    const rec = (await r.dreams.dreamOnce('early'))!;
    expect(rec.question).toBeUndefined();
    expect(r.events.some((e) => e.kind === 'mind.dream_question_dropped')).toBe(true);
  });
});

describe('the dream (§3.3) — lived, never told, never a replay', () => {
  it('a dream that names a feeling is caught; events alone pass', () => {
    for (const t of ["i'm so scared and the door won't open", 'i feel lonely in the big room', 'she was anxious the whole time', 'feeling overwhelmed by the waves']) expect(dreamTelling(t), t).not.toEqual([]);
    expect(dreamTelling('the door opens onto water and someone i know is standing in it, holding my coat')).toEqual([]);
  });

  it('eight words in a row from a memory is a replay, not a dream', () => {
    expect(overlapRun('and then he said the demo crashed in front of everyone at the party', ['the demo crashed in front of everyone at the party'])).toBe(true);
    expect(overlapRun('the demo is a boat and everyone is fish', ['the demo crashed in front of everyone'])).toBe(false);
  });

  it('a first draft that names a feeling is repaired once; two bad drafts dream nothing (loudly)', async () => {
    const bad = { scenes: [{ text: 'i feel so anxious in the workshop and the floor is the sea', uses: ['f1', 'f2'] }, { text: 'he opens a box with the wrong thing in it', uses: ['f2', 'f3'] }] };
    const fixed = await rig({ dream: [bad, dreamScenes()] });
    expect(await fixed.dreams.dreamOnce('early')).toBeDefined();
    expect(fixed.events.some((e) => e.kind === 'mind.dream_repair')).toBe(true);
    const broken = await rig({ dream: [bad, bad] });
    expect(await broken.dreams.dreamOnce('early')).toBeUndefined();
    expect(broken.events.some((e) => e.kind === 'incident.mind_dream_told')).toBe(true);
  });
});

describe('living it (§3.4b) and what it does to memory (§3.4a)', () => {
  it('feelings land as typed events with a content-free cause, never as contact with him', async () => {
    const r = await rig();
    const rec = await r.dreams.dreamOnce('early');
    expect(rec).toBeDefined();
    expect(r.felt.length).toBeGreaterThan(0);
    for (const e of r.felt) {
      expect(e).toMatchObject({ kind: 'emotion', contact: false });
      if (e.kind === 'emotion') expect(e.cause).toBe('something in the night');
    }
    expect(r.events.some((e) => e.kind === 'mind.dreamt')).toBe(true);
    expect(r.mind.dreams()).toHaveLength(1);
  });

  it('dreamt memories are marked, bound to each other, and never change value, outcome, or gold', async () => {
    const r = await rig();
    const before = new Map(r.mind.moments().map((m) => [m.id, { value: m.value, outcome: m.outcome, gold: m.gold, never: m.never, followed: m.followed }]));
    const rec = (await r.dreams.dreamOnce('early'))!;
    const dreamt = rec.pool.map((e) => r.mind.get(e.id)).filter((m): m is Moment => m !== undefined);
    expect(dreamt.length).toBeGreaterThanOrEqual(2);
    for (const m of dreamt) {
      expect(m.dreamt).toBe(1);
      expect(m.lastDreamtAt).toBe(NIGHT);
      expect((m.assoc ?? []).length).toBeGreaterThan(0);
      expect({ value: m.value, outcome: m.outcome, gold: m.gold, never: m.never, followed: m.followed }).toEqual(before.get(m.id));
    }
  });

  it('a charge shifted by a dream is written to her changelog — what changed, never the dream', async () => {
    const r = await rig();
    await r.dreams.dreamOnce('early');
    const cs = readChanges(r.mind.dir);
    const entry = cs.find((c) => c.kind === 'dream');
    expect(entry?.what).toMatch(/while you slept/);
    expect(JSON.stringify(entry)).not.toMatch(/kelp|workshop/);
  });

  it('reconsolidation: re-lived differently moves the charge a little; aversive charge never grows', () => {
    const anxious = tagSignature('anxious', 7);
    const calm = rechargeToward(anxious, tagSignature('relieved', 5), DREAM.rho, 'rescript');
    expect(calm).not.toEqual(anxious);
    expect(aversiveNorm(calm)).toBeLessThanOrEqual(aversiveNorm(anxious) + 1e-12);
    // a nightmare ending cannot make an old memory hurt more
    const worse = rechargeToward(tagSignature('content', 5), tagSignature('scared', 5), 0.5, 'rescript');
    expect(aversiveNorm(worse)).toBeLessThanOrEqual(aversiveNorm(tagSignature('content', 5)) + 1e-12);
    expect(rechargeToward(anxious, tagSignature('relieved', 5), DREAM.rho, 'preserve')).toEqual(anxious);
    expect(aversiveNorm(rechargeToward(anxious, anxious, 0, 'soften'))).toBeLessThan(aversiveNorm(anxious));
  });
});

describe('controls and the night’s limits', () => {
  it('a decorative night dreams and logs, and nothing downstream happens', async () => {
    const r = await rig({ cfg: { controlShare: 1 } });
    const rec = await r.dreams.dreamOnce('early');
    expect(rec?.arm).toBe('decorative');
    expect(r.felt).toEqual([]);
    expect(r.mind.moments().every((m) => m.dreamt === undefined && m.assoc === undefined)).toBe(true);
    const woke = await r.dreams.wake({ woken: true });
    expect(woke.every((w) => !w.recalled)).toBe(true);
  });

  it('no dream while they talk; when he is away, only the late dream', async () => {
    expect(await (await rig({ talking: true })).dreams.dreamOnce('early')).toBeUndefined();
    const away = await rig({ moments: [moment({ id: 'old1', ts: NIGHT - 40 * DAY }), moment({ id: 'old2', ts: NIGHT - 50 * DAY }), moment({ id: 'old3', ts: NIGHT - 70 * DAY })] });
    expect(await away.dreams.dreamOnce('early')).toBeUndefined();
    expect(away.events.some((e) => e.kind === 'mind.dream_skipped' && e.p['why'] === 'away')).toBe(true);
  });

  it('the night has a hard cap on model calls', async () => {
    const r = await rig();
    await r.dreams.dreamOnce('early'); // 2 calls spent
    expect(r.mind.state().sleep?.calls).toBe(2);
    r.mind.setState({ sleep: { ...r.mind.state().sleep!, calls: DREAM.callsMax } });
    expect(await r.dreams.dreamOnce('late')).toBeUndefined();
    expect(r.events.some((e) => e.kind === 'incident.mind_dream_failed' && e.p['stage'] === 'budget')).toBe(true);
    expect(r.model.calls.length).toBe(2); // nothing spent past the cap
  });
});

describe('waking (§3.4e) — most dreams go; what stays is a dream', () => {
  it('woken right after a vivid dream, she remembers it — as a dream, with a question it left', async () => {
    // p is capped at 0.85: pick (deterministically) the first seed whose draw remembers
    let r: Rig | undefined;
    let woke: Array<{ id: string; p: number; recalled: boolean }> = [];
    for (const seed of ['w1', 'w2', 'w3', 'w4', 'w5', 'w6']) {
      const t = await rig({ seed, appraise: { ...appraised, scenes: [{ events: [{ emotion: 'curious', i: 5 }, { emotion: 'excited', i: 5 }], importance: 7 }, { events: [{ emotion: 'delighted', i: 5 }, { emotion: 'giddy', i: 5 }], importance: 8 }] } });
      await t.dreams.dreamOnce('late');
      // force a cross-domain pair so the question counts (the hash embedder's geometry is arbitrary)
      const s = t.mind.state().sleep!;
      t.mind.setState({ sleep: { ...s, dreams: s.dreams.map((d) => ({ ...d, intensity: 1, crossDomain: true })) } });
      woke = await t.dreams.wake({ woken: true });
      expect(woke[0]!.p).toBeCloseTo(Math.min(DREAM.recallCap, DREAM.recallBase.late + 0.4 + 0.25), 6);
      if (woke[0]!.recalled) {
        r = t;
        break;
      }
    }
    expect(r).toBeDefined(); // at p = 0.85, six draws all forgetting would be a broken draw
    {
      r = r!;
      const frag = r.mind.moments().find((m) => m.kind === 'dream')!;
      expect(frag.dream).toMatchObject({ cycle: 'late' });
      expect(frag.felt.source).toBe('exact');
      expect(r.mind.stream().at(-1)).toMatchObject({ dream: true });
      const echo = r.felt.at(-1)!;
      expect(echo).toMatchObject({ contact: false });
      if (echo.kind === 'emotion') expect(echo.cause).toMatch(/^the dream: /);
      expect(r.seeded).toEqual([{ what: 'why does kelp grow so fast?' }]);
    }
    expect(r.events.some((e) => e.kind === 'mind.woke')).toBe(true);
  });

  it('a forgotten dream leaves no memory, no thought, no question — but its work stays', async () => {
    const r = await rig();
    await r.dreams.dreamOnce('early');
    const s = r.mind.state().sleep!;
    r.mind.setState({ sleep: { ...s, dreams: s.dreams.map((d) => ({ ...d, intensity: 0 })) } }); // p = 0.05
    const forgotten = (await r.dreams.wake({ woken: false })).every((w) => !w.recalled);
    expect(forgotten).toBe(true); // p = 0.05 with this seed — the branch below must run
    {
      expect(r.mind.moments().some((m) => m.kind === 'dream')).toBe(false);
      expect(r.mind.stream().some((t) => t.dream === true)).toBe(false);
      expect(r.seeded).toEqual([]);
      expect(r.mind.moments().some((m) => (m.assoc ?? []).length > 0)).toBe(true); // the links stayed
    }
  });

  it('asleep in the window; anyone writing wakes her for an hour', async () => {
    const r = await rig();
    expect(r.dreams.isAsleep(NIGHT)).toBe(true);
    r.dreams.onInbound(NIGHT);
    await new Promise((res) => setImmediate(res));
    expect(r.dreams.isAsleep(NIGHT + 10 * 60_000)).toBe(false);
    expect(r.dreams.isAsleep(NIGHT + 2 * H)).toBe(true);
    expect(r.dreams.isAsleep(NIGHT + 12 * H)).toBe(false); // afternoon
  });

  it('a dream-caused text goes at most once every three days', async () => {
    const r = await rig();
    expect(r.dreams.mayTellDream(NIGHT)).toBe(true);
    r.dreams.toldDream(NIGHT);
    expect(r.dreams.mayTellDream(NIGHT + DAY)).toBe(false);
    expect(r.dreams.mayTellDream(NIGHT + 3 * DAY)).toBe(true);
  });
});

describe('dreams in the rest of her', () => {
  it('a remembered dream is always shown as one — never as something that happened', () => {
    const dreamMoment = moment({ id: 'm_dream_x', kind: 'dream', ts: NIGHT, his: '', hers: ['the bridge but the cables were kelp'] });
    const { head } = composeSegments({
      timeZone: 'Europe/Madrid',
      now: NIGHT + 2 * H,
      self: [],
      concerns: [],
      thoughts: [{ id: 't1', ts: NIGHT, text: 'the bridge but the cables were kelp', about: 'self', source: 'lived', dream: true }],
      options: [],
      memories: [dreamMoment],
      who: 'he',
    });
    const text = head.map((s) => s.text).join('\n');
    expect(text).toMatch(/\(from a dream, /);
    expect(text).toMatch(/\(a dream, may 29\)/);
  });

  it('recall: a dreamt memory comes back a little easier (fading), and one hop along a dream link', async () => {
    const r = await rig();
    const m = r.mind.get('old1')!;
    expect(dreamtTerm({ ...m, lastDreamtAt: NIGHT }, NIGHT)).toBeCloseTo(DREAM.dreamtBonus, 9);
    expect(dreamtTerm({ ...m, lastDreamtAt: NIGHT }, NIGHT + 14 * DAY)).toBeCloseTo(DREAM.dreamtBonus / 2, 9);
    r.mind.update('r2', { assoc: [{ id: 'old1', at: NIGHT, via: 'dr' }] });
    const sims = r.mind.moments().map((x) => ({ m: x, sim: x.id === 'r2' ? 0.9 : 0.1 }));
    const links = linkBonus(r.mind, sims, NIGHT);
    expect(links.get('old1')).toBeCloseTo(DREAM.linkBonus, 9);
    expect(links.has('old2')).toBe(false); // one hop only, from what this moment resembles
    // a remembered fragment fades unless she talked about it
    const frag = moment({ kind: 'dream', ts: NIGHT });
    expect(dreamFade(frag, NIGHT + 12 * H)).toBeCloseTo(0.5, 9);
    expect(dreamFade({ ...frag, told: true }, NIGHT + 12 * H)).toBe(1);
  });

  it('her self may rest on dreams only as a motif — "i keep dreaming…" with two of them', () => {
    const ids = new Set(['d1', 'd2']);
    expect(dreamMotif('i keep dreaming about doors that open onto water', ['d1', 'd2', 'm1'], ids)).toEqual(['d1', 'd2', 'm1']);
    expect(dreamMotif('diego told me he was leaving', ['d1', 'm1'], ids)).toEqual(['m1']);
    expect(dreamMotif('a dream about water', ['d1'], ids)).toEqual([]);
  });

  it('the diary never tells a dream as the day; remembered ones get their own section', async () => {
    const r = await rig();
    r.mind.add(moment({ id: 'm_dream_y', kind: 'dream', source: 'lived', ts: NIGHT - H, his: '', hers: ['the lemon tree was taller than the house'] }));
    const model = new MockModel({ clock: r.clock });
    model.onTask('consolidate', () => ({ toolCalls: [{ name: 'emit', args: { entry: 'a day' } }] }));
    await diaryOnce({ mind: r.mind, model, clock: r.clock, events: { emit: async () => undefined } as unknown as EventLog, timeZone: 'Europe/Madrid' });
    const user = String(model.calls[0]!.messages.at(-1)!.content);
    const [day, rest] = user.split('[your own thoughts today]');
    expect(day).not.toContain('lemon tree');
    expect(rest).toMatch(/\[dreams you remember — dreams, not things that happened\][\s\S]*lemon tree/);
  });

  it('her idle mind is quiet while she sleeps', async () => {
    const r = await rig();
    const res = await wanderOnce({
      mind: r.mind,
      affect: { current: () => initialAffectState(NIGHT), applyEvents: async () => undefined } as unknown as AffectStore,
      model: r.model,
      embedder: makeHashEmbedder(),
      events: { emit: async () => undefined } as unknown as EventLog,
      clock: r.clock,
      rng: makeRng('w'),
      cfg: () => ({ thoughtsPerDay: 12, textFirstPerDay: 3, quietHours: [1, 7], timeZone: 'Europe/Madrid', patienceMin: 60 }),
      conversationActive: () => false,
      selfEntry: async () => 0,
      asleep: (now) => r.dreams.isAsleep(now),
    });
    expect(res.result).toBe('asleep');
    expect(r.model.calls.filter((c) => c.taskClass === 'heartbeat-thought')).toHaveLength(0);
  });
});

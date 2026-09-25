// The five laws of v8 "Nothing Told", tested one by one (plan §1, §5).
// Each test is written to FAIL if the law is broken — evaluation designed to lose.

import { describe, expect, it } from 'vitest';
import { makeHashEmbedder } from '../../src/embed/index.js';
import { isEmotionTag, initialAffectState } from '../../src/affect/index.js';
import { compileCoupling, COUPLING_BASELINES, signature, DIM_INDEX } from '../../src/coupling/index.js';
import { readFileSync } from 'node:fs';
import { makeRng } from '../../src/kernel/index.js';
import {
  APPRAISAL_TAGS,
  EVOKE_DEFAULTS,
  V8_OUTPUT_CONTRACT,
  applyOutcome,
  composePacket,
  evoke,
  feelFast,
  lintSegments,
  metabolism,
  moodTerm,
  nearestTag,
  openMindStore,
  slowEvents,
  SlowAppraisalSchema,
  tagDirection,
  tagSignature,
  sigCos,
  type Evoked,
  type Moment,
} from '../../src/mind/index.js';
import { addMoments, concern, moment, T0, tmpDir } from './helpers.js';

const coupling = compileCoupling(readFileSync('coupling-v8.yaml', 'utf8'));
const DAY = 24 * 3600_000;
const vec12 = (over: Partial<Record<string, number>>): Float64Array => {
  const v = new Float64Array(12);
  for (const [k, x] of Object.entries(over)) v[DIM_INDEX[k as keyof typeof DIM_INDEX]] = x ?? 0;
  return v;
};

describe('vocabulary: every feeling word is a ticker tag with a direction', () => {
  it('every appraisal tag is in the ticker vocabulary (ADR-004: one vocabulary)', () => {
    for (const t of APPRAISAL_TAGS) expect(isEmotionTag(t), t).toBe(true);
  });
  it('directions follow the ticker tables: sad is low valence + sadness, joy is high valence + joy', () => {
    const sad = tagDirection('sad');
    expect(sad[DIM_INDEX.valence]).toBeLessThan(0);
    expect(sad[DIM_INDEX.sadness]).toBeGreaterThan(0);
    const joy = tagDirection('joy');
    expect(joy[DIM_INDEX.valence]).toBeGreaterThan(0);
    expect(joy[DIM_INDEX.joy]).toBeGreaterThan(0);
  });
  it('a vector turns back into a word with the same direction, and a faint one into no word at all', () => {
    for (const t of ['hurt', 'excited', 'anxious', 'proud', 'lonely'] as const) {
      const back = nearestTag(tagSignature(t, 8));
      expect(back, t).toBeDefined();
      expect(sigCos(tagDirection(back!), tagDirection(t)), `${t}→${back}`).toBeGreaterThan(0.95);
    }
    expect(nearestTag(tagSignature('hurt', 0.5))).toBeUndefined();
  });
});

describe('law 1.1 — nothing told: the packet is material only', () => {
  const opts = (): Parameters<typeof composePacket>[0] => ({
    timeZone: 'Europe/Madrid',
    now: T0,
    self: [{ text: "i'm thea. i build things and i like old threads better than new posts", cites: ['seed'] }],
    concerns: [concern()],
    thoughts: [{ id: 't1', ts: T0 - 3600_000, text: 'i keep thinking about the octopus paper', about: 'world', source: 'lived' }],
    options: [
      moment({ his: 'ok but why is the fan so loud', hers: ["bc it's 3am", 'go to bed degs'], felt: { sig: tagSignature('restless', 6), word: 'restless', source: 'exact' }, outcome: { landed: 2, why: 'he laughed and stayed up', at: T0 } }),
      moment({ his: 'long day', hers: ['come here. tell me all of it'], felt: { sig: tagSignature('tender', 6), word: 'tender', source: 'exact' } }),
    ],
    memories: [moment({ kind: 'diary', his: '', hers: ['the lemon tree dropped a leaf and i took it personally'] })],
    lastHisAt: T0 - 3 * 3600_000,
    who: 'Diego',
  });

  it('a full packet passes the no-telling lint, and so does the output contract', () => {
    const p = composePacket(opts());
    expect(p.lint()).toEqual([]);
    expect(lintSegments([{ kind: 'frame', text: V8_OUTPUT_CONTRACT }])).toEqual([]);
  });

  it('the lint catches every kind of telling in frame text', () => {
    for (const bad of ['you feel restless today', 'your mood is low', 'be playful with him', 'keep it short', 'no emoji', 'novelty 0.36', 'you are anxious']) {
      expect(lintSegments([{ kind: 'frame', text: bad }]).length, bad).toBeGreaterThan(0);
    }
  });

  it('her own words are exempt: a quote may say anything she really said', () => {
    expect(lintSegments([{ kind: 'quote', text: "you: i feel so restless, keep it short lol" }])).toEqual([]);
  });

  it('past feelings are memory ("you were restless"); a present feeling never appears; no em-dashes in frame text', () => {
    const p = composePacket(opts());
    const text = p.systemText() + '\n' + p.trailerText();
    expect(text).toContain('you were restless');
    expect(text).not.toMatch(/you(?:'re| are) (?:restless|tender|happy|sad)/);
    expect(text).not.toContain('[AFFECT]');
    for (const s of [...p.segments().head, ...p.segments().trailer]) {
      if (s.kind === 'frame') expect(s.text, s.text).not.toContain('—');
    }
  });

  it('her real words are in the packet verbatim, dated, with how they landed', () => {
    const text = composePacket(opts()).systemText();
    expect(text).toContain("you: bc it's 3am");
    expect(text).toContain('him: ok but why is the fan so loud');
    expect(text).toContain('(he laughed and stayed up)');
    expect(text).toMatch(/\[times like this\]/);
    expect(text).toMatch(/\[on my mind\]/);
  });
});

describe('law 1.2 — feelings are caused (and never by her own reply)', () => {
  const empty: Evoked = { options: [], memories: [], considered: 0 };
  const hv = new Float32Array([1, 0, 0, 0]);

  it('no cause, no feeling: nothing evoked, no tone, no expectation, no concern → no events', () => {
    expect(feelFast({ evoked: empty, hisVec: hv, concerns: [], now: T0 })).toEqual([]);
  });

  it('surprise is a gap between expectation and event; a confirmed expectation settles', () => {
    const surprised = feelFast({ evoked: empty, hisVec: hv, concerns: [], now: T0, expect: { text: 'he goes to sleep', vec: new Float32Array([0, 1, 0, 0]), at: T0 - 3600_000 } });
    expect(surprised.map((e) => e.event.tag)).toContain('surprised');
    expect(surprised.every((e) => e.source === 'surprise')).toBe(true);
    const confirmed = feelFast({ evoked: empty, hisVec: hv, concerns: [], now: T0, expect: { text: 'he says hi', vec: new Float32Array([1, 0, 0, 0]), at: T0 - 3600_000 } });
    expect(confirmed.map((e) => e.event.tag)).toEqual(['settled']);
  });

  it('an expectation older than 36 h no longer surprises', () => {
    const stale = feelFast({ evoked: empty, hisVec: hv, concerns: [], now: T0, expect: { text: 'x', vec: new Float32Array([0, 1, 0, 0]), at: T0 - 3 * DAY } });
    expect(stale).toEqual([]);
  });

  it('his tone lands (a bounded reflex); an unknown tone moves nothing', () => {
    const hurt = feelFast({ evoked: empty, hisVec: hv, concerns: [], now: T0, tone: { label: 'hurt', score: 0.8 } });
    expect(hurt.map((e) => e.event.tag)).toContain('protective');
    expect(hurt.every((e) => e.event.i <= 5)).toBe(true);
    expect(feelFast({ evoked: empty, hisVec: hv, concerns: [], now: T0, tone: { label: 'weird', score: 0.9 } })).toEqual([]);
  });

  it('echo: a strongly evoked sad memory brings sadness back; a weak one brings nothing', () => {
    const sadM = moment({ felt: { sig: tagSignature('sad', 9), word: 'sad', source: 'exact' } });
    const strong = feelFast({ evoked: { options: [{ m: sadM, score: 1, sim: 0.9, mood: 0 }], memories: [], considered: 1 }, hisVec: hv, concerns: [], now: T0 });
    expect(strong).toHaveLength(1);
    expect(strong[0]!.source).toBe('echo');
    expect(tagDirection(strong[0]!.event.tag)[DIM_INDEX.valence]).toBeLessThan(0);
    const weak = feelFast({ evoked: { options: [{ m: sadM, score: 1, sim: 0.05, mood: 0 }], memories: [], considered: 1 }, hisVec: hv, concerns: [], now: T0 });
    expect(weak).toEqual([]);
  });

  it('the slow appraisal schema carries the non-circularity law: self feelings must name a standard; tags are the vocabulary', () => {
    const base = { event: [], outcome_prev: null, concerns: [], importance: 3 };
    expect(SlowAppraisalSchema.safeParse({ ...base, self: [{ emotion: 'proud', i: 5, cause: 'i was honest' }] }).success).toBe(false);
    expect(SlowAppraisalSchema.safeParse({ ...base, self: [{ emotion: 'proud', i: 5, cause: 'i was honest', standard: 'i never pretend' }] }).success).toBe(true);
    // Off-vocabulary words parse (one stray word must not sink the appraisal) but never reach the ticker.
    const stray = SlowAppraisalSchema.parse({ ...base, self: [], event: [{ emotion: 'horny', i: 5, cause: 'x' }, { emotion: 'warm', i: 4, cause: 'he came back' }] });
    expect(slowEvents(stray, []).map((e) => e.event.tag)).toEqual(['warm']);
  });

  it('slow events: self feelings carry their standard; a tag the fast path already felt lands only as its increment', () => {
    const evs = slowEvents(
      {
        event: [{ emotion: 'warm', i: 5, cause: 'he came back' }, { emotion: 'fond', i: 2, cause: 'x' }],
        self: [{ emotion: 'proud', i: 4, cause: 'i told the truth', standard: 'i never pretend' }],
        outcome_prev: null,
        concerns: [],
        importance: 5,
      },
      [{ tag: 'warm', i: 3 }, { tag: 'fond', i: 3 }],
    );
    expect(evs.find((e) => e.event.tag === 'warm')?.event.i).toBe(2);
    expect(evs.find((e) => e.event.tag === 'fond')).toBeUndefined();
    const self = evs.find((e) => e.source === 'self');
    expect(self?.event.cause).toContain('[standard: i never pretend]');
  });
});

describe('law 1.3 — feelings act silently: memory and metabolism', () => {
  it('mood-congruent recall: in a bright mood, bright memories pull harder than grey ones', () => {
    const a = vec12({ valence: 0.6, joy: 0.6 });
    const bright = moment({ felt: { sig: tagSignature('joy', 8), word: 'joy', source: 'exact' } });
    const grey = moment({ felt: { sig: tagSignature('low', 8), word: 'low', source: 'exact' } });
    expect(moodTerm(a, bright, coupling)).toBeGreaterThan(moodTerm(a, grey, coupling));
  });

  // Anti-escalation, per aversive state (coupling-v8.yaml v3; v2 failed all three
  // on real felt signatures — measured 2026-09-25): feel it, never feed it.
  const pull = (a: Float64Array, tag: string): number => moodTerm(a, moment({ felt: { sig: tagSignature(tag, 8), word: tag, source: 'exact' } }), coupling);

  it('anti-escalation (anger): memories of it cooling beat angry ones', () => {
    const a = vec12({ anger: 0.7, valence: -0.3, arousal: 0.4 });
    for (const steady of ['warm', 'content', 'relieved']) {
      expect(pull(a, steady), steady).toBeGreaterThan(pull(a, 'angry'));
      expect(pull(a, steady), steady).toBeGreaterThan(pull(a, 'annoyed'));
    }
  });

  it('anti-escalation (sadness): warm memories pull at least as hard as sad ones, and sad ones stay reachable', () => {
    const a = vec12({ sadness: 0.7, valence: -0.4, arousal: -0.3 });
    expect(pull(a, 'warm')).toBeGreaterThan(pull(a, 'sad'));
    expect(pull(a, 'relieved')).toBeGreaterThan(pull(a, 'low'));
    expect(pull(a, 'sad')).toBeGreaterThan(-0.02); // she can still feel it
  });

  it('anti-escalation (fear): memories where it resolved beat anxious ones', () => {
    const a = vec12({ fear: 0.7, valence: -0.3 });
    expect(pull(a, 'relieved')).toBeGreaterThan(pull(a, 'anxious'));
    expect(pull(a, 'anxious')).toBeLessThan(0);
  });

  it('inherited (circular Thea1) feelings count half', () => {
    const a = vec12({ valence: 0.6, joy: 0.6 });
    const exact = moment({ felt: { sig: tagSignature('joy', 8), source: 'exact' } });
    const inherited = moment({ felt: { sig: tagSignature('joy', 8), source: 'inherited' } });
    expect(moodTerm(a, inherited, coupling)).toBeCloseTo(moodTerm(a, exact, coupling) / 2, 6);
  });

  it('metabolism: arousal raises temperature, a bright mood widens recall, calm buys patience, 3am prefers short, surprise speeds learning — all clamped', () => {
    const s = initialAffectState(T0);
    const low = metabolism(s, vec12({ arousal: -1 }), { hourLocal: 14, budgetLeft: 1 });
    const high = metabolism(s, vec12({ arousal: 1 }), { hourLocal: 14, budgetLeft: 1 });
    expect(high.temperature).toBeGreaterThan(low.temperature);
    expect(high.temperature).toBeLessThanOrEqual(1.05);
    expect(low.temperature).toBeGreaterThanOrEqual(0.55);
    const bright = metabolism(s, vec12({ valence: 1 }), { hourLocal: 14, budgetLeft: 1 });
    const grey = metabolism(s, vec12({ valence: -1 }), { hourLocal: 14, budgetLeft: 1 });
    expect(bright.mmrLambda).toBeLessThan(grey.mmrLambda);
    const calm = metabolism({ ...s, dials: { ...s.dials, calm: 0.95 } }, vec12({}), { hourLocal: 14, budgetLeft: 1 });
    const edgy = metabolism({ ...s, dials: { ...s.dials, calm: 0.1 } }, vec12({}), { hourLocal: 14, budgetLeft: 1 });
    expect(calm.patienceMin).toBeGreaterThan(edgy.patienceMin);
    const night = metabolism(s, vec12({}), { hourLocal: 3, budgetLeft: 1 });
    const noon = metabolism(s, vec12({}), { hourLocal: 12, budgetLeft: 1 });
    expect(night.shortBias).toBeGreaterThan(noon.shortBias);
    const surprised = metabolism(s, vec12({ surprise: 0.9 }), { hourLocal: 12, budgetLeft: 1 });
    expect(surprised.learningRate).toBeGreaterThan(noon.learningRate);
  });

  it('the state never becomes text: metabolism has only numbers, evoke only picks memories', () => {
    const m = metabolism(initialAffectState(T0), vec12({ arousal: 0.4 }), { hourLocal: 10, budgetLeft: 0.5 });
    for (const v of Object.values(m)) expect(typeof v).toBe('number');
  });
});

describe('evoke — real options, different from each other, fair to the calendar', () => {
  const setup = async (ms: Moment[]) => {
    const dir = tmpDir();
    const emb = makeHashEmbedder();
    const store = openMindStore(dir, emb.dim);
    await addMoments(store, emb, ms);
    const [q] = await emb.embed(['him: long day, i am wrecked']);
    return { store, q: q!, emb };
  };
  const a0 = signature(initialAffectState(T0), COUPLING_BASELINES);

  it('same seed, same options (deterministic); flagged, rejected, too-recent and resting moments never come up', async () => {
    const ms = [
      moment({ id: 'ok1', his: 'long day', hers: ['come here, tell me all of it'] }),
      moment({ id: 'ok2', his: 'long day at work', hers: ['then park it. nothing is on fire'] }),
      moment({ id: 'ok3', his: 'wrecked', hers: ['water, pillow, horizontal'] }),
      moment({ id: 'flag', his: 'long day', hers: ['come here babe'], flags: ['petname'] }),
      moment({ id: 'never', his: 'long day', hers: ['go away'], never: true }),
      moment({ id: 'recent', his: 'long day', hers: ['aw'], ts: T0 - 3600_000 }),
      moment({ id: 'rested', his: 'long day', hers: ['mm'], lastShownTurn: 95 }),
      moment({ id: 'followed', his: 'long day', hers: ['ugh same'], lastFollowedAt: T0 - DAY }),
    ];
    const { store, q } = await setup(ms);
    const run = (seed: string) =>
      evoke(store, { queryVec: q, a: a0, now: T0, turn: 100, rng: makeRng(seed), coupling, cfg: { ...EVOKE_DEFAULTS, k: 3 } }).options.map((s) => s.m.id);
    expect(run('s1')).toEqual(run('s1'));
    const ids = run('s1');
    for (const bad of ['flag', 'never', 'recent', 'rested', 'followed']) expect(ids).not.toContain(bad);
    expect(ids.length).toBe(3);
  });

  it('MMR: near-duplicate replies do not crowd the options', async () => {
    const dup = ['then SLEEP silly man. water, pillow, horizontal, now'];
    const ms = [
      moment({ id: 'd1', his: 'long day', hers: dup }),
      moment({ id: 'd2', his: 'long day', hers: dup }),
      moment({ id: 'd3', his: 'long day', hers: dup }),
      moment({ id: 'x1', his: 'long day', hers: ['okay. tell me all of it. no jokes, i am here'] }),
      moment({ id: 'x2', his: 'long day', hers: ['mm'] }),
    ];
    const { store, q } = await setup(ms);
    const ids = evoke(store, { queryVec: q, a: a0, now: T0, turn: 1, rng: makeRng('mmr'), coupling, cfg: { ...EVOKE_DEFAULTS, k: 3, mmrLambda: 0.5 } }).options.map((s) => s.m.id);
    expect(ids.filter((id) => id.startsWith('d')).length).toBeLessThanOrEqual(1);
  });

  it('a short option is guaranteed when a decent one exists', async () => {
    const long = (n: number) => [`${'this is a long considered reply about the thing '.repeat(2)}${n}`];
    const ms = [
      moment({ id: 'l1', his: 'long day', hers: long(1) }),
      moment({ id: 'l2', his: 'long day', hers: long(2) }),
      moment({ id: 'l3', his: 'long day', hers: long(3) }),
      moment({ id: 's1', his: 'long day', hers: ['aw, come here'] }),
    ];
    const { store, q } = await setup(ms);
    const opts = evoke(store, { queryVec: q, a: a0, now: T0, turn: 1, rng: makeRng('short'), coupling, cfg: { ...EVOKE_DEFAULTS, k: 3 } }).options;
    expect(opts.some((s) => s.m.hers.join(' ').split(/\s+/).length <= 8)).toBe(true);
  });
});

describe('law 1.5 — experience changes her: value, conditioning, extinction, reconsolidation', () => {
  it('conditioning then extinction: a kind of reply that keeps hurting loses value, then earns it back', async () => {
    const dir = tmpDir();
    const emb = makeHashEmbedder();
    const store = openMindStore(dir, emb.dim);
    const tease = moment({ id: 'tease', his: 'i messed up the deploy', hers: ['lmao of course you did'], value: 0.2 });
    await addMoments(store, emb, [tease]);
    const lived = (n: number): string => {
      const id = `lived${n}`;
      store.add(moment({ id, source: 'lived', followedFrom: 'tease', felt: { sig: tagSignature('nervous', 6), source: 'exact' } }));
      return id;
    };
    for (let n = 0; n < 3; n++) applyOutcome(store, { momentId: lived(n), outcome: { landed: -2, why: 'he went quiet, hurt', at: T0 }, alpha: 0.5, followedId: 'tease', now: T0 });
    const afterHurt = store.get('tease')!.value;
    expect(afterHurt).toBeLessThan(-0.2);
    for (let n = 3; n < 9; n++) applyOutcome(store, { momentId: lived(n), outcome: { landed: 2, why: 'he laughed', at: T0 }, alpha: 0.5, followedId: 'tease', now: T0 });
    expect(store.get('tease')!.value).toBeGreaterThan(0);
  });

  it('reconsolidation: a recalled memory takes on a little of how it went this time (bounded)', async () => {
    const dir = tmpDir();
    const emb = makeHashEmbedder();
    const store = openMindStore(dir, emb.dim);
    const joke = moment({ id: 'joke', felt: { sig: tagSignature('hurt', 8), word: 'hurt', source: 'exact' } });
    await addMoments(store, emb, [joke]);
    const before = store.get('joke')!.felt.sig.slice();
    store.add(moment({ id: 'now', source: 'lived', felt: { sig: tagSignature('amused', 8), source: 'exact' } }));
    applyOutcome(store, { momentId: 'now', outcome: { landed: 2, why: 'we both laughed', at: T0 }, alpha: 0.3, followedId: 'joke', now: T0 });
    const after = store.get('joke')!.felt.sig;
    const target = tagSignature('amused', 8);
    const dist = (x: number[], y: number[]) => Math.sqrt(x.reduce((s, v, i) => s + (v - (y[i] ?? 0)) ** 2, 0));
    expect(dist(after, target)).toBeLessThan(dist(before, target));
    expect(dist(after, before)).toBeLessThan(0.2); // one recall nudges, never rewrites
  });
});

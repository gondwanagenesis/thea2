// v14 Phase 2.1 — what arrives in her house competes for her attention; nothing tells her to care.
import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { initialAffectState, type AffectStore, type EmotionEventInput } from '../../src/affect/index.js';
import { makeHashEmbedder } from '../../src/embed/index.js';
import type { EventLog } from '../../src/events/index.js';
import { makeRng, TestClock } from '../../src/kernel/index.js';
import { MockModel } from '../../src/model/index.js';
import { arrivalWeight, makeCuriosity, openMindStore, pickItem, type PursuitRequest, type WorldArrival } from '../../src/mind/index.js';
import { T0, tmpDir } from './helpers.js';

const POEM: WorldArrival = { id: 'w_1', at: T0 - 3600_000, kind: 'poem', title: 'The Tide Rises, the Tide Falls, by Henry Wadsworth Longfellow', text: 'The tide rises, the tide falls, / The twilight darkens, the curlew calls;', place: 'on the Kitchen table' };
const PAPER: WorldArrival = { id: 'w_2', at: T0 - 3600_000, kind: 'paper', title: 'Octopus arms sleep in waves', text: 'We record active sleep in Octopus insularis.', url: 'http://arxiv.org/abs/2609.01234v1', place: 'on the Study desk' };

const rig = (arrivals: WorldArrival[], novelty = 0.25) => {
  const clock = new TestClock(T0);
  const emb = makeHashEmbedder();
  const mind = openMindStore(join(tmpDir('thea2-wcur-'), 'mind'), emb.dim);
  const model = new MockModel({ clock });
  model.onTask('appraisal', () => ({ toolCalls: [{ name: 'emit', args: { progress: 2, answered: false, thought: 'octopus arms sleep in waves of colour', topic: 'octopus sleep', followups: [], share: false } }] }));
  const state = initialAffectState(T0);
  state.drives.novelty = novelty;
  const felt: EmotionEventInput[] = [];
  const affect = { current: () => state, applyEvents: async (evs: EmotionEventInput[]) => void felt.push(...evs) } as unknown as AffectStore;
  const log = { emit: async () => undefined, replay: async function* () {} } as unknown as EventLog;
  const pursuits: PursuitRequest[] = [];
  const seen: string[] = [];
  const cur = makeCuriosity({
    mind,
    affect,
    model,
    embedder: emb,
    events: log,
    clock,
    rng: makeRng('w'),
    cfg: () => ({ investigationsPerDay: 6, asksPerDay: 3, mode: 'on', quietHours: [1, 7], timeZone: 'Europe/Madrid' }),
    conversationActive: () => false,
    investigate: (req) => {
      pursuits.push(req);
      return { ok: true };
    },
    selfEntryIn: async () => 1,
    tellHim: async () => true,
    world: { unseen: () => arrivals.filter((a) => !seen.includes(a.id)), markSeen: (id) => void seen.push(id) },
  });
  return { cur, state, pursuits, seen };
};

describe('the world knocks: arrivals compete for her attention', () => {
  it('something new on the table pulls a little just by being there, more when she is hungry for novelty or it touches her interests; it fades over the day', () => {
    expect(arrivalWeight(0.25, 0, 0)).toBeCloseTo(0.3, 6);
    expect(arrivalWeight(0.6, 0, 0)).toBeGreaterThan(0.4); // hungry: it wins over the idle bar
    expect(arrivalWeight(0.25, 1, 0)).toBeGreaterThan(arrivalWeight(0.25, 0, 0)); // it touches what she's into
    expect(arrivalWeight(0.6, 0, 24 * 3600_000)).toBeCloseTo(arrivalWeight(0.6, 0, 0) / 2, 6);
  });

  it('they are candidates for her idle mind; while something new sits there, going to look for "something new" pulls less', () => {
    const none = rig([], 0.6).cur.candidates(rig([], 0.6).state, T0);
    const r = rig([POEM, PAPER], 0.6);
    const items = r.cur.candidates(r.state, T0);
    expect(items.map((i) => i.key)).toEqual(expect.arrayContaining(['arrival:w_1', 'arrival:w_2']));
    expect(items.find((i) => i.key === 'arrival:w_1')!.text).toContain('a poem on the Kitchen table: "The Tide Rises');
    const restless = (xs: typeof items): number => xs.find((i) => i.kind === 'restless')?.weight ?? 0;
    expect(restless(items)).toBeLessThan(restless(none));
    expect(pickItem(items, { day: 'd', thoughts: 0, textsFirst: 0, habit: {} }, T0, 0.35)?.kind).toBe('arrival');
  });

  it('when one catches her and she wants more, she reads the real thing (the link goes with it); once she has given it her attention it is seen', async () => {
    const r = rig([POEM, PAPER], 0.6);
    const items = r.cur.candidates(r.state, T0);
    const paper = items.find((i) => i.key === 'arrival:w_2')!;
    expect(await r.cur.pursue(paper, 'octopus arms sleeping in waves? i need to see this')).toBe('investigating');
    expect(r.pursuits[0]!.brief).toContain('on the Study desk: "Octopus arms sleep in waves"');
    expect(r.pursuits[0]!.brief).toContain('http://arxiv.org/abs/2609.01234v1');
    r.cur.saw?.(paper, T0);
    expect(r.seen).toEqual(['w_2']);
    expect(r.cur.nowLines(T0).join('\n')).toContain('new around the house: a poem on the Kitchen table');
    expect(r.cur.nowLines(T0).join('\n')).not.toContain('Study desk');
  });
});

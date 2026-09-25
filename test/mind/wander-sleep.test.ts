// Law 1.4 (thoughts arise, habituate, never self-seed) and the nightly sleep
// pass (cited self-narrative only, neutral outcomes for unanswered replies,
// training tuples).

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { makeHashEmbedder } from '../../src/embed/index.js';
import { initialAffectState, openAffectStore } from '../../src/affect/index.js';
import { makeRng, TestClock } from '../../src/kernel/index.js';
import { MockModel } from '../../src/model/index.js';
import { openEventLog } from '../../src/events/index.js';
import { candidates, habituation, inQuietHours, openMindStore, pickItem, sleepOnce, wanderOnce, type WanderDeps } from '../../src/mind/index.js';
import { addMoments, concern, moment, T0, tmpDir } from './helpers.js';

const H = 3600_000;

describe('law 1.4 — thoughts arise from what is unresolved', () => {
  it('open loops, feelings with a cause, and a silence past her patience can win attention; closed loops cannot', () => {
    const s = initialAffectState(T0);
    s.primaries.sadness = 0.6;
    s.causes.sadness = { text: 'he snapped at me about the deploy', i: 6, t: T0 - H, moved: 0.2 };
    const items = candidates(
      [concern({ id: 'c1', due: T0 - H }), concern({ id: 'c2', status: 'closed' })],
      s,
      { now: T0, lastHisAt: T0 - 6 * H, patienceMin: 120 },
    );
    const keys = items.map((i) => i.key);
    expect(keys).toContain('concern:c1');
    expect(keys).not.toContain('concern:c2');
    expect(keys.some((k) => k.startsWith('feeling:sadness'))).toBe(true);
    expect(keys).toContain('missing');
  });

  it('habituation: what just won attention rests (half-life 6 h), so the same thought cannot win twice in a row', () => {
    expect(habituation(T0, T0)).toBe(1);
    expect(habituation(T0 - 6 * H, T0)).toBeCloseTo(0.5, 6);
    const items = [
      { key: 'a', kind: 'concern' as const, about: 'diego' as const, text: 'a', weight: 0.9 },
      { key: 'b', kind: 'concern' as const, about: 'diego' as const, text: 'b', weight: 0.6 },
    ];
    const w = { day: 'd', thoughts: 0, textsFirst: 0, habit: { a: T0 } };
    expect(pickItem(items, w, T0, 0.3)?.key).toBe('b');
    expect(pickItem(items, { ...w, habit: {} }, T0, 0.3)?.key).toBe('a');
  });

  it('quiet hours wrap midnight in his zone', () => {
    // T0 = 2026-05-28 20:26:40 UTC = 22:26 in Madrid (CEST).
    expect(inQuietHours(T0, [1, 7], 'Europe/Madrid')).toBe(false);
    expect(inQuietHours(T0 + 4 * H, [1, 7], 'Europe/Madrid')).toBe(true);
  });

  const wanderSetup = async (opts: { quiet?: boolean; intention?: 'text_him' | 'none'; cap?: number } = {}) => {
    const dir = tmpDir();
    const clock = new TestClock(opts.quiet === true ? T0 + 4 * H : T0);
    const emb = makeHashEmbedder();
    const mind = openMindStore(join(dir, 'mind'), emb.dim);
    await addMoments(mind, emb, [moment({ his: 'good luck at the interview', hers: ['you got this. call me after'] })]);
    mind.upsertConcern(concern({ id: 'c1', what: 'he said he would call after the interview', due: clock.epochMs() - H, importance: 9 }));
    await mind.flush();
    const events = openEventLog(join(dir, 'events'), { clock });
    const affect = openAffectStore(join(dir, 'affect.json'), { clock, rng: makeRng('w'), events });
    await affect.snapshot();
    const model = new MockModel({ clock });
    model.onTask('heartbeat-thought', () => ({
      toolCalls: [{ name: 'emit', args: { thought: 'he never called. maybe it ran long, or maybe it went badly and he does not want to say', close: false, reappraise: [{ emotion: 'anxious', i: 3, cause: 'no call after the interview' }], intention: opts.intention ?? 'none' } }],
    }));
    const selfEntries: string[] = [];
    const deps: WanderDeps = {
      mind,
      affect,
      model,
      embedder: emb,
      events,
      clock,
      rng: makeRng('wander'),
      cfg: () => ({ thoughtsPerDay: opts.cap ?? 4, textFirstPerDay: 2, quietHours: [1, 7], timeZone: 'Europe/Madrid', patienceMin: 120 }),
      conversationActive: () => false,
      selfEntry: async (goal) => {
        selfEntries.push(goal);
        return 1;
      },
    };
    return { deps, mind, selfEntries, clock };
  };

  it('an overdue loop becomes a private thought; the thought is stored in her stream and reappraises lawfully', async () => {
    const { deps, mind } = await wanderSetup();
    const r = await wanderOnce(deps);
    expect(r.result).toBe('thought');
    expect(r.item).toBe('concern:c1');
    expect(mind.stream().at(-1)?.text).toContain('never called');
    expect(mind.state().wander.thoughts).toBe(1);
    // the same item rests now — a second tick does not think the same thing again
    const r2 = await wanderOnce(deps);
    expect(r2.item).not.toBe('concern:c1');
  });

  it('thoughts never seed thoughts: after thinking, her own thought is not a candidate', async () => {
    const { deps, mind } = await wanderSetup();
    await wanderOnce(deps);
    const items = candidates(mind.openConcerns(), deps.affect.current(), { now: deps.clock.epochMs(), patienceMin: 120 });
    expect(items.some((i) => i.text.includes('never called'))).toBe(false);
  });

  it('a wish to text him goes through a real turn outside quiet hours, and never inside them', async () => {
    const day = await wanderSetup({ intention: 'text_him' });
    await wanderOnce(day.deps);
    expect(day.selfEntries).toHaveLength(1);
    expect(day.selfEntries[0]).toContain('a thought you just had');
    const night = await wanderSetup({ intention: 'text_him', quiet: true });
    await wanderOnce(night.deps);
    expect(night.selfEntries).toHaveLength(0);
  });

  it('the daily thought budget is a hard cap', async () => {
    const { deps } = await wanderSetup({ cap: 1 });
    expect((await wanderOnce(deps)).result).toBe('thought');
    expect((await wanderOnce(deps)).result).toBe('capped');
  });
});

describe('sleep — the nightly pass', () => {
  it('rewrites the self-narrative only from cited lines, sweeps unanswered replies to neutral, and exports tuples', async () => {
    const dir = tmpDir();
    const clock = new TestClock(T0);
    const emb = makeHashEmbedder();
    const mind = openMindStore(join(dir, 'mind'), emb.dim);
    await addMoments(mind, emb, [
      moment({ id: 'old_unanswered', source: 'lived', ts: T0 - 30 * H, his: 'night', hers: ['night degs'] }),
      moment({ id: 'today1', source: 'lived', ts: T0 - 2 * H, his: 'i got the job', hers: ['WAIT', 'i knew it'] }),
    ]);
    await mind.setSelf([{ text: 'i build things with him', cites: ['seed'] }]);
    const events = openEventLog(join(dir, 'events'), { clock });
    const model = new MockModel({ clock });
    model.onTask('consolidate', () => ({
      toolCalls: [{ name: 'emit', args: { lines: [
        { text: 'i build things with him', cites: ['seed'] },
        { text: 'he got the job and i was loud about it', cites: ['today1'] },
        { text: 'i am secretly a pirate', cites: ['made_up_id'] },
        { text: 'i knew he would get it', cites: ['today1'] },
      ] } }],
    }));
    const r = await sleepOnce({ mind, model, events, clock, timeZone: 'Europe/Madrid' });
    expect(r.swept).toBe(1);
    expect(mind.get('old_unanswered')?.outcome?.landed).toBe(0);
    expect(r.selfLines).toBe(3);
    expect(mind.self().map((l) => l.text)).not.toContain('i am secretly a pirate'); // uncited → dropped
    expect(r.exported).toBe(1);
    const tuples = fs.readFileSync(join(dir, 'mind', 'tuples.jsonl'), 'utf8').trim().split('\n');
    expect(JSON.parse(tuples[0]!).id).toBe('today1');
  });

  it('a self rewrite with fewer than three cited lines is rejected and the old self stays', async () => {
    const dir = tmpDir();
    const clock = new TestClock(T0);
    const emb = makeHashEmbedder();
    const mind = openMindStore(join(dir, 'mind'), emb.dim);
    await addMoments(mind, emb, [moment({ id: 'today1', source: 'lived', ts: T0 - H })]);
    await mind.setSelf([{ text: 'i build things with him', cites: ['seed'] }]);
    const events = openEventLog(join(dir, 'events'), { clock });
    const model = new MockModel({ clock });
    model.onTask('consolidate', () => ({ toolCalls: [{ name: 'emit', args: { lines: [{ text: 'everything is new', cites: ['nope'] }] } }] }));
    const r = await sleepOnce({ mind, model, events, clock, timeZone: 'Europe/Madrid' });
    expect(r.selfLines).toBeNull();
    expect(mind.self()[0]?.text).toBe('i build things with him');
  });
});

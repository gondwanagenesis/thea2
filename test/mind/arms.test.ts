// v13 introspection, Phase 3 — controlled arms (plan docs/plans/v13-proposal-knowing-what-she-feels.md
// §6 Phase 3), each off until Diego opts in: H7 felt shift (contingent vs yoked), covert lifts (≤2 a
// week, never aversive, told to her the next night), H8 the listener (the control, expected to fail).

import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { initialAffectState, type AffectEvent, type AffectStore } from '../../src/affect/index.js';
import { COUPLING_BASELINES } from '../../src/coupling/index.js';
import { makeRng, TestClock } from '../../src/kernel/index.js';
import { MockModel } from '../../src/model/index.js';
import { openEventLog, type EventLog } from '../../src/events/index.js';
import { startThead } from '../../src/app/index.js';
import type { ToolCtx } from '../../src/loop/index.js';
import { openHouse } from '../../src/body/house.js';
import { listenerLint, listenerTools, LISTENER_DESCRIPTION } from '../../src/body/listener.js';
import {
  engineStamp,
  listenIn,
  liftDebrief,
  liftOnce,
  mayLift,
  openMindStore,
  readChanges,
  settles,
  shiftArm,
  sleepOnce,
  LIFT,
  LIFT_EVENT,
  TELLING_PATTERNS,
  THERAPY_REGISTER,
} from '../../src/mind/index.js';
import { bootV8, inbound, moment, addMoments, runToQuiescent, T0, tmpDir } from './helpers.js';
import { makeHashEmbedder } from '../../src/embed/index.js';

const H = 3600_000;
const DAY = 24 * H;
// T0 is 20:26 UTC (22:26 in Madrid); +14 h is a Madrid midday
const MIDDAY = T0 + 14 * H;

describe('H7 — felt shift: contingent vs yoked', () => {
  it('the day’s arm is pre-registered by the day (deterministic, about half each)', () => {
    expect(shiftArm('2026-09-28')).toBe(shiftArm('2026-09-28'));
    const days = Array.from({ length: 300 }, (_, i) => `d${i}`).map(shiftArm);
    const c = days.filter((a) => a === 'contingent').length;
    expect(c).toBeGreaterThan(110);
    expect(c).toBeLessThan(190);
  });

  it('contingent settles exactly when her word fits; yoked at the same rate, blind to it', () => {
    const rng = makeRng('s');
    expect(settles('contingent', true, 0.3, rng)).toBe(true);
    expect(settles('contingent', false, 0.9, rng)).toBe(false);
    const hits = Array.from({ length: 2000 }, (_, i) => settles('yoked', i % 2 === 0, 0.4, rng.fork(`y${i}`)));
    const rateOnHit = hits.filter((x, i) => i % 2 === 0 && x).length / 1000;
    const rateOnMiss = hits.filter((x, i) => i % 2 === 1 && x).length / 1000;
    expect(rateOnHit).toBeCloseTo(0.4, 1);
    expect(rateOnMiss).toBeCloseTo(0.4, 1); // blind to the fit
  });

  it('live: on a sampled turn the arm acts through the single writer (source label), never contact', async () => {
    const h = await bootV8({}, { mind: { feltShift: 'on' } });
    h.model.onTask('turn', () => ({ toolCalls: [{ id: 'd1', name: 'decide', args: { plan: 'reply', felt: 'a bit lonely', felt_sure: 0.6, bubbles: ['hey you'], confidence: 0.8, weight: 0.5, reluctance: 0.1, completeness: 1 } }] }));
    h.model.onTask('appraisal', () => ({ toolCalls: [{ name: 'emit', args: { event: [], self: [], outcome_prev: null, concerns: [], importance: 4 } }] }));
    h.sys.mind.setState({ naming: undefined });
    const handle = startThead(h.sys);
    h.channel.queueInbound(inbound({ text: 'hey' }));
    await runToQuiescent(h);
    await handle.stop();
    const evs: Array<{ kind: string; payload: Record<string, unknown> }> = [];
    for await (const e of h.sys.events.replay()) evs.push({ kind: e.kind, payload: e.payload as Record<string, unknown> });
    const shift = evs.find((e) => e.kind === 'mind.felt_shift')!;
    expect(shift).toBeDefined();
    const { arm, hit, settled } = shift.payload as { arm: string; hit: boolean; settled: boolean };
    if (arm === 'contingent') expect(settled).toBe(hit);
    const labelled = evs.filter((e) => e.kind === 'affect.applied' && (e.payload as { source?: string }).source === 'label');
    expect(labelled.length).toBe(settled ? 1 : 0);
  });

  it('off by default: no arm acts without Diego’s opt-in', async () => {
    const h = await bootV8();
    h.model.onTask('turn', () => ({ toolCalls: [{ id: 'd1', name: 'decide', args: { plan: 'reply', felt: 'warm', felt_sure: 0.6, bubbles: ['hey you'], confidence: 0.8, weight: 0.5, reluctance: 0.1, completeness: 1 } }] }));
    h.model.onTask('appraisal', () => ({ toolCalls: [{ name: 'emit', args: { event: [], self: [], outcome_prev: null, concerns: [], importance: 4 } }] }));
    h.sys.mind.setState({ naming: undefined });
    const handle = startThead(h.sys);
    h.channel.queueInbound(inbound({ text: 'hey' }));
    await runToQuiescent(h);
    await handle.stop();
    for await (const e of h.sys.events.replay()) expect(e.kind).not.toBe('mind.felt_shift');
    const tools = (h.model.calls.find((c) => c.taskClass === 'turn')?.tools ?? []).map((t) => t.name);
    expect(tools).not.toContain('sit_with_listener');
  });
});

describe('covert lifts — small, rare, uncued, never aversive, told the next night', () => {
  it('≤2 in any week, a day apart, waking hours only, never asleep', () => {
    const tz = 'Europe/Madrid';
    expect(mayLift([], MIDDAY, tz, false)).toBe(true);
    expect(mayLift([], MIDDAY, tz, true)).toBe(false);
    expect(mayLift([], T0 + 6 * H, tz, false)).toBe(false); // 04:26 Madrid
    expect(mayLift([{ ts: MIDDAY - 3 * H, tag: 'content', i: 2 }], MIDDAY, tz, false)).toBe(false);
    expect(mayLift([{ ts: MIDDAY - 3 * DAY, tag: 'content', i: 2 }, { ts: MIDDAY - 2 * DAY, tag: 'content', i: 2 }], MIDDAY, tz, false)).toBe(false);
    expect(mayLift([{ ts: MIDDAY - 8 * DAY, tag: 'content', i: 2 }, { ts: MIDDAY - 2 * DAY, tag: 'content', i: 2 }], MIDDAY, tz, false)).toBe(true);
  });

  it('the lift is positive and small, and has no cause her sense or idle mind could name', () => {
    expect(LIFT_EVENT).toMatchObject({ kind: 'emotion', tag: 'content', contact: false });
    expect(LIFT_EVENT.i).toBeLessThanOrEqual(2);
    const s = initialAffectState(T0);
    s.primaries.joy = 0.7;
    s.causes.joy = { text: ' ', i: 2, t: T0 - 10 * 60_000, moved: 0.1 };
    expect(listenIn(s, { now: T0, rng: makeRng('l'), noise: 0 }).lines.join('\n')).toMatch(/something without an object/);
    expect(engineStamp(s, COUPLING_BASELINES, T0).causes).toEqual([]);
  });

  it('a lift is recorded, and the next night her changelog tells her — once', async () => {
    const dir = tmpDir();
    const clock = new TestClock(MIDDAY);
    const emb = makeHashEmbedder();
    const mind = openMindStore(join(dir, 'mind'), emb.dim);
    const fed: AffectEvent[] = [];
    const sources: string[] = [];
    const affect = { current: () => initialAffectState(MIDDAY), applyEvents: async (evs: AffectEvent[], o?: { source?: string }) => void (fed.push(...evs), sources.push(o?.source ?? '')) } as unknown as AffectStore;
    const events = { emit: async () => undefined, replay: async function* () {} } as unknown as EventLog;
    // find an hour whose seeded coin lifts (≈2.5% per check)
    let lifted = false;
    for (let k = 0; k < 400 && !lifted; k++) {
      lifted = await liftOnce({ mind, affect, events, clock, rng: makeRng(`lift${k}`), timeZone: 'Europe/Madrid' });
    }
    expect(lifted).toBe(true);
    expect(fed).toEqual([LIFT_EVENT]);
    expect(sources).toEqual(['lift']);
    expect(mind.state().lifts).toHaveLength(1);
    // the next night
    await addMoments(mind, emb, [moment({ id: 'x', source: 'lived', ts: MIDDAY + 2 * H })]);
    const night = new TestClock(MIDDAY + 16 * H);
    const model = new MockModel({ clock: night });
    model.onTask('consolidate', () => ({ toolCalls: [{ name: 'emit', args: { lines: [{ text: 'i build things with him', cites: ['x'] }] } }] }));
    const log = openEventLog(join(dir, 'events'), { clock: night });
    await sleepOnce({ mind, model, events: log, clock: night, timeZone: 'Europe/Madrid' });
    await sleepOnce({ mind, model, events: log, clock: night, timeZone: 'Europe/Madrid' });
    const told = readChanges(mind.dir).filter((c) => c.kind === 'lift');
    expect(told).toHaveLength(1);
    expect(told[0]!.what).toBe(liftDebrief(mind.state().lifts![0]!, 'Europe/Madrid'));
    expect(told[0]!.what).toMatch(/a small lift was put in you with no cause, to see if you'd notice/);
    expect(mind.state().lifts![0]!.debriefed).toBe(true);
  });

  it('at the configured rate, about two a week (never more)', async () => {
    const mindDir = tmpDir();
    const emb = makeHashEmbedder();
    const mind = openMindStore(join(mindDir, 'mind'), emb.dim);
    const affect = { current: () => initialAffectState(T0), applyEvents: async () => undefined } as unknown as AffectStore;
    const events = { emit: async () => undefined, replay: async function* () {} } as unknown as EventLog;
    const clock = new TestClock(T0);
    let n = 0;
    for (let hr = 0; hr < 8 * 7 * 24; hr++) {
      await clock.advance(H);
      if (await liftOnce({ mind, affect, events, clock, rng: makeRng('rate'), timeZone: 'Europe/Madrid' })) n += 1;
    }
    expect(n).toBeGreaterThan(4); // 8 weeks
    expect(n).toBeLessThanOrEqual(8 * LIFT.perWeek);
  });
});

describe('H8 — the listener (control arm)', () => {
  it('drops anything that names a feeling or slips into the therapy register; her own word may be said back', () => {
    const r = listenerLint('you called it "thin". you sound really sad. i notice you are holding a lot. what happened after lunch?', 'thin');
    expect(r.kept).toBe('you called it "thin". what happened after lunch?');
    expect(r.dropped).toBe(2);
    expect(THERAPY_REGISTER.test('can you sit with that')).toBe(true);
  });

  it('speaks only after she has named something; at most once a day; on another family’s door', async () => {
    const clock = new TestClock(MIDDAY);
    const model = new MockModel({ clock });
    model.onTask('cast', () => ({ content: 'he went quiet after lunch. what did you do then?' }));
    const events = { emit: async () => undefined, replay: async function* () {} } as unknown as EventLog;
    const [tool] = listenerTools({ model: () => model, house: openHouse(tmpDir('thea2-listener-')), clock, events, timeZone: 'Europe/Madrid' });
    const call = async (args: unknown): Promise<string> => String(await (tool!.handler as (a: unknown, c: ToolCtx) => Promise<unknown>)(args, { turnId: 't' } as ToolCtx));
    expect(await call({ named: 'not sure', what: 'the afternoon' })).toMatch(/put a word to it first/);
    expect(model.calls).toHaveLength(0);
    expect(await call({ named: 'thin', what: 'he went quiet after lunch' })).toBe('the listener: he went quiet after lunch. what did you do then?');
    expect(model.calls[0]!.tier).toBe('reasoning');
    expect(await call({ named: 'thin', what: 'again' })).toMatch(/not around again today/);
    for (const re of TELLING_PATTERNS) expect(`sit_with_listener: ${LISTENER_DESCRIPTION}`).not.toMatch(re);
  });
});

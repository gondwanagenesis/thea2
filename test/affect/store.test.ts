// store.ts — the single writer. Serialization under interleaved callers, the
// validate-before-mutate atomic reject, the affect.applied trail, and the whole
// corruption story: state.json is the fast path, the newest L0 snapshot is the
// recovery path, a fresh baseline is the last resort — and every recovery is an
// incident, loudly.

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openEventLog } from '../../src/events/index.js';
import { TestClock, makeRng } from '../../src/kernel/index.js';
import {
  H,
  MIN,
  T0,
  emo,
  freshState,
  jsonEqual,
} from './helpers.js';
import { initialAffectState, openAffectStore, type AffectEvent } from '../../src/affect/index.js';

let dir: string;
const fresh = (): string => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thea2-affect-'));
  return dir;
};
afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

interface Setup {
  clock: TestClock;
  store: ReturnType<typeof openAffectStore>;
  statePath: string;
  events: () => Promise<Array<{ kind: string; payload: unknown }>>;
}

const setup = (d: string): Setup => {
  const clock = new TestClock(T0);
  const log = openEventLog(d, { clock });
  const statePath = path.join(d, 'var', 'affect', 'state.json');
  const store = openAffectStore(statePath, { clock, rng: makeRng('store-test'), events: log });
  const collect = async (): Promise<Array<{ kind: string; payload: unknown }>> => {
    const out: Array<{ kind: string; payload: unknown }> = [];
    for await (const ev of openEventLog(d, { clock }).replay()) {
      out.push({ kind: ev.kind, payload: ev.payload });
    }
    return out;
  };
  return { clock, store, statePath, events: collect };
};

describe('boot', () => {
  it('a first boot with no file anywhere is silent and starts at baseline', async () => {
    const s = setup(fresh());
    await s.store.applyEvents([]);
    expect(s.store.current()).toEqual(initialAffectState(T0));
    const kinds = (await s.events()).map((e) => e.kind);
    expect(kinds.some((k) => k.startsWith('incident'))).toBe(false); // a first boot is not a corruption
    expect(kinds).toEqual(['affect.applied']); // one (empty) batch, one trail entry
    expect(s.store.weather()).not.toBe('');
  });

  it('current() hands out a copy — mutating it cannot corrupt the writer', async () => {
    const s = setup(fresh());
    await s.store.applyEvents([]);
    const copy = s.store.current();
    copy.dials.pleasure = 0.123;
    copy.traces.habitWindow.push({ tag: 'x', t: 1 });
    expect(s.store.current().dials.pleasure).toBe(freshState().dials.pleasure);
    expect(s.store.current().traces.habitWindow).toHaveLength(0);
  });
});

describe('applyEvents — validate, catch up, land, persist, report', () => {
  it('a batch moves the state, persists it, and emits affect.applied with tags + moved', async () => {
    const s = setup(fresh());
    await s.clock.advance(MIN(5));
    await s.store.applyEvents([emo('cherished', 10, 'he wrote me an owners manual', 'diego')]);
    const cur = s.store.current();
    expect(cur.t).toBe(T0 + MIN(5));
    expect(cur.dials.attachment).toBeGreaterThan(initialAffectState(T0).dials.attachment);
    // the fast path is on disk and matches memory
    const onDisk = JSON.parse(await fsp.readFile(s.statePath, 'utf8')) as { t: number };
    expect(onDisk.t).toBe(cur.t);
    // the trail is in L0
    const applied = (await s.events()).filter((e) => e.kind === 'affect.applied');
    expect(applied).toHaveLength(1);
    const payload = applied[0]!.payload as { tags: string[]; moved: Record<string, number> };
    expect(payload.tags).toEqual(['cherished']);
    expect(payload.moved['p.joy']).toBeGreaterThan(0); // joy rose, and the trail says by how much
    expect(payload.moved['pleasure']).toBeGreaterThan(0);
  });

  it('catches the engine up to now, and silenceTick is a legal no-op batch', async () => {
    const s = setup(fresh());
    await s.clock.advance(H(9));
    await s.store.applyEvents([{ kind: 'silenceTick' }]);
    expect(s.store.current().t).toBe(T0 + H(9));
    // 9 hours alone: connection is hungrier than the set point
    expect(s.store.current().drives.connection).toBeGreaterThan(0.25);
    const applied = (await s.events()).filter((e) => e.kind === 'affect.applied');
    expect(applied).toHaveLength(1);
    expect((applied[0]!.payload as { tags: string[] }).tags).toEqual([]);
  });

  it('an unknown tag rejects the WHOLE batch: byte-identical state, incident, typed throw', async () => {
    const s = setup(fresh());
    await s.store.applyEvents([emo('fond', 6, 'warm start')]);
    const before = await fsp.readFile(s.statePath, 'utf8');
    const beforeState = s.store.current();

    const bad: AffectEvent[] = [
      emo('cherished', 9, 'would have applied'),
      { kind: 'emotion', tag: 'flurbo' as never, i: 5, cause: 'x' },
    ];
    await expect(s.store.applyEvents(bad)).rejects.toMatchObject({ code: 'affect/unknown-tag' });

    expect(await fsp.readFile(s.statePath, 'utf8')).toBe(before); // nothing half-applied
    expect(jsonEqual(s.store.current(), beforeState)).toBe(true);
    const incidents = (await s.events()).filter((e) => e.kind === 'incident.unknown_tag');
    expect(incidents).toHaveLength(1);
    expect(incidents[0]!.payload).toEqual({ tag: 'flurbo', source: 'other' });
    // and the writer still works afterwards
    await s.store.applyEvents([emo('fond', 6, 'still alive')]);
    expect(s.store.current().dials.attachment).toBeGreaterThan(beforeState.dials.attachment);
  });

  it('the incident carries the declared source when the caller declares one', async () => {
    const s = setup(fresh());
    await expect(
      s.store.applyEvents([{ kind: 'emotion', tag: 'nope' as never, i: 3, cause: 'x' }], { source: 'appraisal' }),
    ).rejects.toMatchObject({ code: 'affect/unknown-tag' });
    const incidents = (await s.events()).filter((e) => e.kind === 'incident.unknown_tag');
    expect(incidents[0]!.payload).toEqual({ tag: 'nope', source: 'appraisal' });
  });

  it('serializes interleaved callers: both batches land, in order, no interleaving', async () => {
    const s = setup(fresh());
    const p1 = s.store.applyEvents([emo('cherished', 10, 'first', 'diego')]);
    const p2 = s.store.applyEvents([emo('sad', 8, 'second')]);
    await Promise.all([p1, p2]);
    const applied = (await s.events()).filter((e) => e.kind === 'affect.applied');
    expect(applied).toHaveLength(2);
    expect((applied[0]!.payload as { tags: string[] }).tags).toEqual(['cherished']);
    expect((applied[1]!.payload as { tags: string[] }).tags).toEqual(['sad']);
    // the second batch ran after the first (habituation-free: different tags)
    expect(s.store.current().primaries.sadness).toBeGreaterThan(initialAffectState(T0).primaries.sadness);
  });

  it('a failing batch does not poison the queue for the next caller', async () => {
    const s = setup(fresh());
    await expect(s.store.applyEvents([{ kind: 'emotion', tag: 'junk' as never, i: 1, cause: 'x' }])).rejects.toBeTruthy();
    await expect(s.store.applyEvents([emo('fond', 6, 'still works')])).resolves.toBeUndefined();
    expect(s.store.current().primaries.joy).toBeGreaterThan(initialAffectState(T0).primaries.joy);
  });
});

describe('snapshot — the L0 lifeline', () => {
  it('persists and emits the full state', async () => {
    const s = setup(fresh());
    await s.store.applyEvents([emo('cherished', 10, 'c', 'diego')]);
    await s.clock.advance(H(1));
    await s.store.snapshot();
    const snaps = (await s.events()).filter((e) => e.kind === 'affect.snapshot');
    expect(snaps).toHaveLength(1);
    const payload = snaps[0]!.payload as { state: { t: number; dials: Record<string, number> } };
    expect(payload.state.t).toBe(T0 + H(1));
    expect(payload.state.dials).toEqual(s.store.current().dials);
    expect((JSON.parse(await fsp.readFile(s.statePath, 'utf8')) as { t: number }).t).toBe(T0 + H(1));
  });
});

describe('corruption and recovery', () => {
  const buildHistory = async (d: string): Promise<void> => {
    const clock = new TestClock(T0);
    const log = openEventLog(d, { clock });
    const store = openAffectStore(path.join(d, 'var', 'affect', 'state.json'), {
      clock,
      rng: makeRng('history'),
      events: log,
    });
    await store.applyEvents([emo('cherished', 10, 'a good day', 'diego')]);
    await store.snapshot();
    await clock.advance(H(3));
    await store.applyEvents([emo('sad', 8, 'a hard evening')]);
    await store.snapshot(); // the NEWEST snapshot — the recovery point
    await clock.advance(H(2)); // two hours past the last snapshot, then the file dies
  };

  it('a corrupt state.json rebuilds from the newest L0 snapshot and raises the incident', async () => {
    const d = fresh();
    await buildHistory(d);
    const statePath = path.join(d, 'var', 'affect', 'state.json');
    await fsp.writeFile(statePath, '{"t": 1, "dials": {"broken"', 'utf8');

    const clock = new TestClock(T0 + H(5));
    const log = openEventLog(d, { clock });
    const store = openAffectStore(statePath, { clock, rng: makeRng('recovered'), events: log });
    await store.applyEvents([]);

    // recovered to the newest SNAPSHOT — which already carries the sad evening
    const cur = store.current();
    expect(cur.t).toBe(T0 + H(5)); // and caught up to now
    expect(cur.primaries.sadness).toBeGreaterThan(initialAffectState(T0).primaries.sadness);
    const incidents = await readKinds(d, clock);
    expect(incidents.filter((k) => k.kind === 'incident.affect_state_corrupt')).toHaveLength(1);
    const inc = incidents.find((k) => k.kind === 'incident.affect_state_corrupt');
    expect((inc!.payload as { recovery: string }).recovery).toBe('l0-snapshot-replay');
    // and the recovered writer works: one mid-intensity fond lands above where
    // recovery left her (not above baseline — a sad evening with an exposure
    // trace is exactly the state a single [i:6] should not erase)
    const joyBefore = store.current().primaries.joy;
    await store.applyEvents([emo('fond', 6, 'back from the dead', 'diego')]);
    expect(store.current().primaries.joy).toBeGreaterThan(joyBefore);
  });

  it('a vanished state.json with snapshots on file is also an incident, also recovered', async () => {
    const d = fresh();
    await buildHistory(d);
    await fsp.rm(path.join(d, 'var', 'affect', 'state.json'));
    const clock = new TestClock(T0 + H(5));
    const log = openEventLog(d, { clock });
    const store = openAffectStore(path.join(d, 'var', 'affect', 'state.json'), {
      clock,
      rng: makeRng('recovered'),
      events: log,
    });
    await store.applyEvents([]);
    const kinds = await readKinds(d, clock);
    const inc = kinds.find((k) => k.kind === 'incident.affect_state_corrupt');
    expect(inc).toBeDefined();
    expect((inc!.payload as { reason: string }).reason).toBe('state file missing');
  });

  it('corrupt with nothing on file: fresh start, incident says so', async () => {
    const d = fresh();
    const statePath = path.join(d, 'var', 'affect', 'state.json');
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    await fsp.writeFile(statePath, 'not json at all', 'utf8');
    const clock = new TestClock(T0);
    const log = openEventLog(d, { clock });
    const store = openAffectStore(statePath, { clock, rng: makeRng('fresh'), events: log });
    await store.applyEvents([]);
    expect(store.current()).toEqual(initialAffectState(T0));
    const kinds = await readKinds(d, clock);
    const inc = kinds.find((k) => k.kind === 'incident.affect_state_corrupt');
    expect((inc!.payload as { recovery: string }).recovery).toBe('fresh-start');
  });

  it('a well-formed JSON file that is not an affect state counts as corrupt', async () => {
    const d = fresh();
    const statePath = path.join(d, 'var', 'affect', 'state.json');
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    await fsp.writeFile(statePath, '{"hello": "world"}', 'utf8');
    const clock = new TestClock(T0);
    const log = openEventLog(d, { clock });
    const store = openAffectStore(statePath, { clock, rng: makeRng('shape'), events: log });
    await store.applyEvents([]);
    expect(store.current()).toEqual(initialAffectState(T0));
    const kinds = await readKinds(d, clock);
    expect(kinds.some((k) => k.kind === 'incident.affect_state_corrupt')).toBe(true);
  });

  it('reopening a healthy store resumes from disk exactly (no incident, no reset)', async () => {
    const d = fresh();
    await buildHistory(d);
    const statePath = path.join(d, 'var', 'affect', 'state.json');
    const clock = new TestClock(T0 + H(5));
    const log = openEventLog(d, { clock });
    const store = openAffectStore(statePath, { clock, rng: makeRng('resume'), events: log });
    await store.applyEvents([]);
    const kinds = await readKinds(d, clock);
    expect(kinds.some((k) => k.kind === 'incident.affect_state_corrupt')).toBe(false);
    // the sad evening survived the restart
    expect(store.current().primaries.sadness).toBeGreaterThan(initialAffectState(T0).primaries.sadness);
  });
});

/** Read the L0 kinds back off disk (a fresh log instance, like a restart would). */
const readKinds = async (
  d: string,
  clock: TestClock,
): Promise<Array<{ kind: string; payload: unknown }>> => {
  const out: Array<{ kind: string; payload: unknown }> = [];
  for await (const ev of openEventLog(d, { clock }).replay()) {
    out.push({ kind: ev.kind, payload: ev.payload });
  }
  return out;
};

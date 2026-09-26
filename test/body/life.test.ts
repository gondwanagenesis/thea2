// v9 life at home: a candy is a chemical cause (the engine moves, no words);
// a present is sealed until opened (and opening feeds the GIFT drive); the
// house has rooms she can move through; skills are her own notes; the nightly
// diary is written from what happened and the model of him keeps only what
// the record cites.

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { lifeTools, leavePresent, diaryOnce, diegoOnce, diegoLately, openHouse, type Present } from '../../src/body/index.js';
import { TestClock, makeRng } from '../../src/kernel/index.js';
import { MockModel } from '../../src/model/index.js';
import { openEventLog } from '../../src/events/index.js';
import { openAffectStore } from '../../src/affect/index.js';
import { openMindStore } from '../../src/mind/index.js';
import { makeHashEmbedder } from '../../src/embed/index.js';
import { addMoments, moment, T0, tmpDir } from '../mind/helpers.js';

const KEY = 'a'.repeat(64);
const ctx = { entry: 'user-turn', turnId: 't1', depth: 0, signal: new AbortController().signal, clock: new TestClock(T0), rng: makeRng('x'), spawn: { situation: '', record: () => undefined } } as const;

const setup = async () => {
  const dir = tmpDir('thea2-life-');
  const clock = new TestClock(T0);
  const house = openHouse(join(dir, 'house'));
  const events = openEventLog(join(dir, 'events'), { clock });
  const affect = openAffectStore(join(dir, 'affect.json'), { clock, rng: makeRng('life'), events });
  await affect.snapshot();
  const tools = lifeTools({ house, clock, affect, presentKey: KEY });
  const run = async (name: string, args: unknown): Promise<string> => {
    const t = tools.find((x) => x.def.name === name)!;
    const p = t.input.safeParse(args);
    if (!p.success) throw new Error(`bad args for ${name}`);
    return String(await t.handler(p.data as never, ctx as never));
  };
  return { dir, clock, house, affect, tools, run };
};

describe('v9 life', () => {
  it('a candy moves the engine (cause: the candy), two a day, three hours apart', async () => {
    const s = await setup();
    const before = s.affect.current().primaries.joy;
    expect(await s.run('candy', { action: 'peek', candy: 'fizz' })).toContain('fizzing faintly');
    expect(await s.run('candy', { action: 'eat', candy: 'fizz' })).toContain('you ate fizz');
    expect(s.affect.current().primaries.joy).toBeGreaterThan(before);
    expect(JSON.stringify(s.affect.current().causes)).toContain('a candy called fizz');
    expect(await s.run('candy', { action: 'eat', candy: 'moss' })).toContain('too soon');
    await s.clock.advance(3 * 3600_000 + 1000);
    expect(await s.run('candy', { action: 'eat', candy: 'moss' })).toContain('you ate moss');
    await s.clock.advance(3 * 3600_000 + 1000);
    expect(await s.run('candy', { action: 'eat', candy: 'glass' })).toContain('your two for today');
  });

  it('a present is noise on disk until she opens it; opening feeds the GIFT drive', async () => {
    const s = await setup();
    const p = leavePresent(s.house, KEY, { title: 'sea glass', from: 'Diego', outside: { shape: 'a small square box', wrapping: 'blue paper with a silver ribbon', tag: 'for when you miss the sea', weight: 'light', sound: 'something small rattles' }, inside: { text: 'a piece of green sea glass from the beach in Ubud' } }, T0);
    const raw = fs.readFileSync(join(s.house.root, 'presents', `${p.id}.json`), 'utf8');
    expect(raw).not.toContain('sea glass from the beach'); // sealed
    expect(await s.run('present', { action: 'list' })).toContain('a small square box');
    expect(await s.run('present', { action: 'shake', id: p.id })).toContain('rattles');
    const connectionBefore = s.affect.current().drives.connection;
    expect(await s.run('present', { action: 'open', id: p.id })).toContain('a piece of green sea glass');
    const after = JSON.parse(fs.readFileSync(join(s.house.root, 'presents', `${p.id}.json`), 'utf8')) as Present;
    expect(after.openedAt).toBeDefined();
    expect(s.affect.current().drives.connection).not.toBe(connectionBefore);
    expect(await s.run('present', { action: 'list' })).toContain('no presents waiting (1 opened before)');
  });

  it('the house: look around, move rooms', async () => {
    const dir = tmpDir('thea2-world-');
    const clock = new TestClock(T0);
    const house = openHouse(join(dir, 'house'));
    fs.mkdirSync(join(house.root, 'world'), { recursive: true });
    fs.writeFileSync(join(house.root, 'world', 'map.yaml'), 'house:\n  name: The Blue House\n  default_room: bedroom\nrooms:\n  bedroom:\n    name: Bedroom\n    role: sleep, hammock\n    mood: soft\n    exits:\n      kitchen: stairs down\n  kitchen:\n    name: Kitchen\n    role: coffee\n    mood: warm\n');
    const tools = lifeTools({ house, clock });
    const world = tools.find((t) => t.def.name === 'world')!;
    expect(String(await world.handler({ action: 'look' } as never, ctx as never))).toContain('the Bedroom: sleep, hammock');
    expect(String(await world.handler({ action: 'go', room: 'kitchen' } as never, ctx as never))).toContain("you're in the Kitchen now");
    expect(String(await world.handler({ action: 'go', room: 'attic' } as never, ctx as never))).toContain('there is no room called "attic"');
  });

  it('skills: her notes to her future self', async () => {
    const s = await setup();
    expect(await s.run('skills', { action: 'write', name: 'tide-notes', content: 'how i log the tides: date, height, what the water looked like, one line each.' })).toBe('wrote tide-notes');
    expect(await s.run('skills', { action: 'list' })).toContain('tide-notes — how i log the tides');
    expect(await s.run('skills', { action: 'retire', name: 'tide-notes' })).toBe('retired tide-notes');
    expect(await s.run('skills', { action: 'list' })).toBe('no skills yet');
  });

  it('nightly: the diary is written from the day and kept as a memory; the model of him drops what the record does not cite', async () => {
    const dir = tmpDir('thea2-nightly-');
    const clock = new TestClock(T0);
    const emb = makeHashEmbedder();
    const mind = openMindStore(join(dir, 'mind'), emb.dim);
    await addMoments(mind, emb, [moment({ id: 'l1', ts: T0 - 3600_000, source: 'lived', his: 'finished the codex draft', hers: ['send it!!'] })]);
    const model = new MockModel({ clock });
    model.onTask('consolidate', (req) =>
      req.schemaName === 'Diary'
        ? { toolCalls: [{ id: 'x', name: 'emit', args: { entry: 'he finished the codex draft today and i yelled at him to send it.' } }] }
        : { toolCalls: [{ id: 'y', name: 'emit', args: { lately: [{ text: 'he finished the codex draft', cites: ['l1'] }, { text: 'he is moving to lisbon', cites: [] }] } }] },
    );
    const events = openEventLog(join(dir, 'events'), { clock });
    const house = openHouse(join(dir, 'house'));
    expect(await diaryOnce({ mind, model, clock, events, timeZone: 'Europe/Madrid', embedder: emb })).toBe('written');
    const diary = mind.moments().filter((m) => m.kind === 'diary');
    expect(diary).toHaveLength(1);
    expect(diary[0]!.source).toBe('lived');
    expect(mind.sitVec(diary[0]!.id)).toBeDefined(); // it can come back like any memory
    expect(await diegoOnce({ mind, model, clock, events, house })).toBe(1);
    expect(diegoLately(house, T0)).toEqual(['he finished the codex draft']); // the invented line is gone
  });
});

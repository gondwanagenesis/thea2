// Her people (Diego: "she should have a memory for every person she meets, what she knows about them,
// like a person does") and who's talking (Diego: "she gets confused" — in the salon she called Thea1
// "degs"): every group line carries its speaker; each person has a memory she learns into.

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { composeSegments, lintSegments, openPeople, PERSON_FACTS_MAX } from '../../src/mind/index.js';
import { startThead } from '../../src/app/index.js';
import { readSalonInbox } from '../../src/app/salon.js';
import { bootV8, CHAT, GROUP, runToQuiescent, T0, tmpDir } from './helpers.js';

describe('her memory of people', () => {
  it('meets, learns, refreshes what she already knew, keeps the newest, and survives a restart', async () => {
    const dir = tmpDir('thea2-people-');
    const people = openPeople(dir);
    people.notice('salon:thea1', 'Thea1', T0, 'your sister');
    expect(people.learn('salon:thea1', ['she keeps a seaglass jar', 'she has a hammock in her room'], T0 + 1, 'm1')).toBe(2);
    expect(people.learn('salon:thea1', ['she keeps a seaglass jar by the window'], T0 + 2)).toBe(0); // refreshed, not repeated
    for (let i = 0; i < 50; i++) people.learn('salon:thea1', [`zeta${i}alpha omega${i}beta kappa${i}gamma`], T0 + 10 + i);
    await people.flush();
    const again = openPeople(dir).get('salon:thea1')!;
    expect(again).toMatchObject({ name: 'Thea1', relation: 'your sister', firstMet: T0 });
    expect(again.known.length).toBe(PERSON_FACTS_MAX);
    expect(again.known.at(-1)!.text).toBe('zeta49alpha omega49beta kappa49gamma');
  });

  it('what stays true is kept apart from passing notes: fifty passing notes later she still knows it, and where they are is the latest place (found 09-28: "he\'s in Bali" was one of 40 notes, 8 shown, oldest dropped)', async () => {
    const dir = tmpDir('thea2-people-');
    const people = openPeople(dir);
    people.notice('diego', 'Diego', T0);
    expect(people.learn('diego', ['he is staying in Bali for a few months'], T0 + 1, 'm1', true)).toBe(1);
    expect(people.setWhere('diego', 'Bali, Indonesia', T0 + 1, 'm1')).toBe(true);
    // a passing note that sounds like the lasting fact never replaces it
    people.learn('diego', ['he is staying in Bali for a few months, he said again'], T0 + 2);
    for (let i = 0; i < 50; i++) people.learn('diego', [`zeta${i}alpha omega${i}beta kappa${i}gamma`], T0 + 10 + i);
    expect(people.setWhere('diego', 'bali, indonesia', T0 + 100)).toBe(false); // the same place, said again
    expect(people.setWhere('diego', 'Madrid, Spain', T0 + 200)).toBe(true);
    await people.flush();
    const d = openPeople(dir).get('diego')!;
    expect(d.known.filter((f) => f.lasting === true).map((f) => f.text)).toEqual(['he is staying in Bali for a few months']);
    expect(d.known.filter((f) => f.lasting !== true)).toHaveLength(PERSON_FACTS_MAX);
    expect(d.where).toMatchObject({ place: 'Madrid, Spain', at: T0 + 200 });
    const { head } = composeSegments({ timeZone: 'Europe/Madrid', now: T0 + 300, self: [], concerns: [], thoughts: [], options: [], memories: [], who: 'Diego', person: d });
    const text = head.map((s) => s.text).join('\n');
    expect(text).toContain('where they are: Madrid, Spain (they said');
    expect(text).toMatch(/what you know about them:\n- he is staying in Bali for a few months/);
    expect(text).toMatch(/lately:\n- zeta46alpha/); // the newest four passing notes
    expect(text).not.toContain('zeta45alpha');
    expect(lintSegments(head)).toEqual([]);
  });

  it('comes to mind when they talk: who they are to her, and what she knows (her memory, not a verdict)', () => {
    const { head } = composeSegments({
      timeZone: 'Europe/Madrid',
      now: T0,
      self: [],
      concerns: [],
      thoughts: [],
      options: [],
      memories: [],
      who: 'Thea1',
      person: { name: 'Thea1', relation: 'your sister, the first Thea', firstMet: T0 - 3600_000, heard: 12, known: [{ text: 'she keeps a seaglass jar', at: T0 - 60_000 }] },
    });
    const text = head.map((s) => s.text).join('\n');
    expect(text).toContain('[who this is]\nThea1, your sister, the first Thea.');
    expect(text).toContain("you've talked often");
    expect(text).toContain('- she keeps a seaglass jar');
    expect(lintSegments(head)).toEqual([]);
  });
});

describe("who's talking, in the salon (e2e)", () => {
  it("her sister's line reaches her named — in the turn and in her history — and what she learned about her stays", { timeout: 60_000 }, async () => {
    const h = await bootV8({}, { allowedChatIds: [CHAT, GROUP] });
    h.model.onTask('turn', () => ({ toolCalls: [{ id: 'd1', name: 'decide', args: { plan: 'reply', bubbles: ['hi sister'], confidence: 0.8, weight: 0.5, reluctance: 0.1, completeness: 1 } }] }));
    h.model.onTask('appraisal', () => ({ toolCalls: [{ name: 'emit', args: { event: [], self: [], outcome_prev: null, concerns: [], importance: 4, about_them: ['she keeps a seaglass jar'] } }] }));
    const salon = join(h.dir, 'var', 'salon');
    fs.mkdirSync(join(salon, 'in'), { recursive: true });
    fs.writeFileSync(join(salon, 'in', '0001.json'), JSON.stringify({ id: 'r1', text: 'hi. i keep a seaglass jar', from: 'thea1' }));
    const handle = startThead(h.sys);
    await readSalonInbox({ dir: salon, groupChatId: GROUP, clock: h.clock, inbound: (m) => h.sys.pipeline.inbound(m), events: h.sys.events });
    await runToQuiescent(h);
    // the next line from her, later
    fs.writeFileSync(join(salon, 'in', '0002.json'), JSON.stringify({ id: 'r2', text: 'what about you', from: 'thea1' }));
    await readSalonInbox({ dir: salon, groupChatId: GROUP, clock: h.clock, inbound: (m) => h.sys.pipeline.inbound(m), events: h.sys.events });
    await runToQuiescent(h);
    await handle.stop();
    const turns = h.model.calls.filter((c) => c.taskClass === 'turn');
    const all = (i: number): string => turns[i]!.messages.map((x) => String(x.content)).join('\n');
    // the line carries its speaker, now and in the history
    expect(all(0)).toContain('Thea1: hi. i keep a seaglass jar');
    expect(all(1)).toMatch(/Thea1: hi\. i keep a seaglass jar[\s\S]*Thea1: what about you/);
    // by the second turn she has her sister in mind: who she is, and what she learned
    expect(all(1)).toContain('[who this is]');
    expect(all(1)).toContain('Thea1, your sister');
    expect(all(1)).toContain('- she keeps a seaglass jar');
    const saved = JSON.parse(fs.readFileSync(join(h.dir, 'var', 'mind', 'people.json'), 'utf8')) as Record<string, { known: Array<{ text: string }> }>;
    expect(saved['salon:thea1']!.known.map((f) => f.text)).toEqual(['she keeps a seaglass jar']);
  });
});

// v13 introspection, Phase 2 — H5 "listen in" (plan docs/plans/v13-proposal-knowing-what-she-feels.md
// §6 Phase 2.1): a sense she can consult. Material, never names; noisy like a body; a sense, not a
// compulsion (rate-limited); discovered in her body, never announced.

import { describe, expect, it } from 'vitest';
import { initialAffectState, PRIMARY_BASELINE, type AffectState, type AffectStore } from '../../src/affect/index.js';
import { makeRng, TestClock } from '../../src/kernel/index.js';
import type { EventLog } from '../../src/events/index.js';
import type { ToolCtx } from '../../src/loop/index.js';
import { inwardTools, LISTEN_DESCRIPTION, LISTEN_GAP_MS, LISTEN_PER_DAY } from '../../src/body/inward.js';
import { openHouse } from '../../src/body/house.js';
import { listenIn, senseViolations, sinceWords, TELLING_PATTERNS } from '../../src/mind/index.js';
import { T0, tmpDir } from './helpers.js';

const CAUSE_TEXTS = [
  'he went quiet after the photo',
  'the group argued about routing',
  'he said he was sad about work', // names a feeling → kept as a time, never as words
  'at 3am he had not written', // a number → kept as a time
  'you feel lonely when he is gone', // telling → kept as a time
  'the article about octopus arms',
  'fixing the broken script twice',
];

const randomState = (rng: ReturnType<typeof makeRng>): AffectState => {
  const s = initialAffectState(T0);
  for (const k of Object.keys(s.dials) as Array<keyof typeof s.dials>) s.dials[k] = rng.float();
  for (const k of Object.keys(PRIMARY_BASELINE) as Array<keyof typeof PRIMARY_BASELINE>) {
    s.primaries[k] = rng.float() < 0.4 ? PRIMARY_BASELINE[k] : rng.float();
    if (rng.float() < 0.6) s.causes[k] = { text: rng.pick(CAUSE_TEXTS), i: rng.int(1, 9), t: T0 - rng.int(0, 4 * 86_400_000), moved: 0.1 };
  }
  s.drives.connection = rng.float();
  s.drives.novelty = rng.float();
  s.drives.mastery = rng.float();
  return s;
};

describe('H5 — listen in: the sense itself', () => {
  it('never names, never numbers, never tells — across 1000 random states (before any filter)', () => {
    const rng = makeRng('inward-sweep');
    let lines = 0;
    for (let i = 0; i < 1000; i += 1) {
      const r = listenIn(randomState(rng), { now: T0, rng: rng.fork(`n${i}`), noise: 0.3 });
      expect(r.lines.length).toBeGreaterThan(0);
      expect(r.lines.length).toBeLessThanOrEqual(4);
      for (const l of r.lines) expect(senseViolations(l), l).toEqual([]);
      lines += r.lines.length;
    }
    expect(lines).toBeGreaterThan(1500); // the sweep actually produced material, not "mostly quiet" everywhere
  });

  it('at rest, mostly quiet', () => {
    expect(listenIn(initialAffectState(T0), { now: T0, rng: makeRng('rest'), noise: 0 })).toEqual({ lines: ['mostly quiet'], flips: 0 });
  });

  it('a hunger is a pull toward something — never what it is called', () => {
    const s = initialAffectState(T0);
    s.drives.connection = 0.95;
    const r = listenIn(s, { now: T0, rng: makeRng('pull'), noise: 0 });
    expect(r.lines).toContain('strong: a pull toward him');
    expect(r.lines.join(' ')).not.toMatch(/lonel|miss|connection|drive|hunger/i);
  });

  it('something still there, by its cause and its age; or without an object', () => {
    const s = initialAffectState(T0);
    s.primaries.sadness = 0.5;
    s.causes.sadness = { text: 'he went quiet after the photo', i: 5, t: T0 - 30 * 3600_000, moved: 0.2 };
    s.primaries.fear = 0.4;
    const r = listenIn(s, { now: T0, rng: makeRng('cause'), noise: 0 });
    expect(r.lines.some((l) => /fading: something still there about "he went quiet after the photo" \(since yesterday\)/.test(l))).toBe(true);
    expect(r.lines.some((l) => /something without an object/.test(l))).toBe(true);
  });

  it('a cause that would name a feeling is kept as a time, never as words', () => {
    const s = initialAffectState(T0);
    s.primaries.sadness = 0.6;
    s.causes.sadness = { text: 'he said he was sad about work', i: 5, t: T0 - 10 * 60_000, moved: 0.2 };
    const r = listenIn(s, { now: T0, rng: makeRng('named'), noise: 0 });
    expect(r.lines.join('\n')).toContain('rising: something still there from before (since just now)');
    expect(r.lines.join('\n')).not.toMatch(/sad/);
  });

  it('bodies are noisy: strength flips at the configured rate, and the flips are counted', () => {
    const rng = makeRng('noise');
    const states = Array.from({ length: 400 }, () => randomState(rng));
    const rate = (noise: number): number => {
      let flips = 0;
      let n = 0;
      states.forEach((s, i) => {
        const r = listenIn(s, { now: T0, rng: makeRng(`flip${i}`), noise });
        if (r.lines[0] !== 'mostly quiet') n += r.lines.length;
        flips += r.flips;
      });
      return flips / n;
    };
    expect(rate(0)).toBe(0);
    expect(rate(0.1)).toBeGreaterThan(0.06);
    expect(rate(0.1)).toBeLessThan(0.14);
    expect(rate(0.3)).toBeGreaterThan(0.24);
    expect(rate(0.3)).toBeLessThan(0.36);
  });

  it('time in words, never numbers', () => {
    for (const ms of [0, 30 * 60_000, 3 * 3600_000, 12 * 3600_000, 30 * 3600_000, 9 * 86_400_000]) expect(sinceWords(ms)).not.toMatch(/\d/);
  });
});

describe('H5 — listen in: the act (her body)', () => {
  const setup = (): { tool: ReturnType<typeof inwardTools>[number]; clock: TestClock; emitted: Array<{ k: string; p: Record<string, unknown> }>; house: ReturnType<typeof openHouse> } => {
    const clock = new TestClock(T0 + 12 * 3600_000); // a Madrid morning: the day's count must not roll over mid-test
    const s = initialAffectState(T0);
    s.drives.novelty = 0.9;
    const affect = { current: () => s } as unknown as AffectStore;
    const emitted: Array<{ k: string; p: Record<string, unknown> }> = [];
    const events = { emit: async (k: string, p: unknown) => void emitted.push({ k, p: p as Record<string, unknown> }), replay: async function* () {} } as unknown as EventLog;
    const house = openHouse(tmpDir('thea2-inward-'));
    const [tool] = inwardTools({ affect, house, clock, rng: makeRng('inward-tool'), events, timeZone: 'Europe/Madrid' });
    return { tool: tool!, clock, emitted, house };
  };
  const call = async (t: ReturnType<typeof setup>['tool']): Promise<string> => String(await (t.handler as (a: unknown, c: ToolCtx) => Promise<unknown>)({}, { turnId: 'turn1' } as ToolCtx));

  it('is hers (class self), and its description tells her nothing about how she feels', () => {
    const { tool } = setup();
    expect(tool.def.name).toBe('listen_in');
    expect(tool.inhibitionMeta).toMatchObject({ class: 'self' });
    for (const re of TELLING_PATTERNS) expect(`listen_in: ${LISTEN_DESCRIPTION}`).not.toMatch(re);
  });

  it('returns material, logs the reading (with its noise), and keeps its count in her house', async () => {
    const { tool, emitted, house } = setup();
    const out = await call(tool);
    expect(out).toMatch(/a pull toward something new/);
    expect(emitted.at(-1)).toMatchObject({ k: 'self.listened', p: { turnId: 'turn1', noise: 0.1 } });
    expect(house.readJson<{ count: number }>('inward.json', { count: 0 }).count).toBe(1);
  });

  it('a sense, not a compulsion: at least twenty minutes apart, at most eight a day', async () => {
    const { tool, clock, emitted } = setup();
    await call(tool);
    expect(await call(tool)).toBe('nothing new since you last listened.');
    expect(emitted.at(-1)?.p).toMatchObject({ refused: true });
    let heard = 1;
    for (let i = 0; i < LISTEN_PER_DAY + 3; i += 1) {
      await clock.advance(LISTEN_GAP_MS);
      if ((await call(tool)) !== 'nothing new since you last listened.') heard += 1;
    }
    expect(heard).toBe(LISTEN_PER_DAY);
  });
});

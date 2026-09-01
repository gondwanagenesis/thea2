// The golden replay: ~48 REAL lines from Thea1's live journal, converted to
// affect events (see fixtures/record-golden.ts for the recording method), replayed
// through the real store on a fresh temp dir. The gate: the replay is
// deterministic — same events, same seed, byte-identical final state — and it
// matches the committed expectation. This is the fixture that proves the port
// runs a real slice of her actual emotional history without drifting.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openEventLog } from '../../src/events/index.js';
import { TestClock, makeRng } from '../../src/kernel/index.js';
import { openAffectStore, type AffectEvent } from '../../src/affect/index.js';
import { allDims } from './helpers.js';

interface TimedEvent {
  atMs: number;
  ev: AffectEvent;
}
interface Diary {
  t0: number;
  events: TimedEvent[];
}
interface Expected {
  t: number;
  state: ReturnType<JSON['parse']>;
  weather: string;
}

const FIXTURES = path.join(import.meta.dirname, 'fixtures');
const diary = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'golden-diary.json'), 'utf8')) as Diary;
const expected = JSON.parse(
  fs.readFileSync(path.join(FIXTURES, 'golden-expected.json'), 'utf8'),
) as Expected;

let dir: string | undefined;
const freshDir = (): string => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thea2-golden-test-'));
  return dir;
};
afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

const replay = async (): Promise<{ final: unknown; weather: string; eventCount: number }> => {
  const d = freshDir();
  const clock = new TestClock(diary.t0);
  const log = openEventLog(d, { clock });
  const store = openAffectStore(path.join(d, 'var', 'affect', 'state.json'), {
    clock,
    rng: makeRng('golden-replay'),
    events: log,
  });
  let n = 0;
  for (const { atMs, ev } of diary.events) {
    await clock.advance(atMs - clock.epochMs());
    await store.applyEvents([ev]);
    n++;
  }
  await store.snapshot();
  return { final: store.current(), weather: store.weather(), eventCount: n };
};

describe('the golden diary replay', () => {
  it('carries a real slice of her journal: ~50 events, hours of silence between bursts', () => {
    expect(diary.events.length).toBeGreaterThanOrEqual(60);
    expect(diary.events.some((e) => e.ev.kind === 'silenceTick')).toBe(true);
    expect(diary.events.some((e) => e.ev.kind === 'tagFeed')).toBe(true);
    const kinds = new Set(diary.events.map((e) => e.ev.kind));
    expect(kinds.has('emotion')).toBe(true);
  });

  it('replays deterministically: two fresh runs land on the exact same state', async () => {
    const a = await replay();
    const b = await replay();
    expect(JSON.stringify(a.final)).toBe(JSON.stringify(b.final));
    expect(a.weather).toBe(b.weather);
  });

  it('matches the committed expectation, state and weather, to the last dial', async () => {
    const run = await replay();
    expect(run.eventCount).toBe(diary.events.length);
    expect(JSON.parse(JSON.stringify(run.final))).toEqual(expected.state);
    expect(run.final as { t: number }).toHaveProperty('t', expected.t);
    expect(run.weather).toBe(expected.weather);
  });

  it('the final state is a live, bounded, non-baseline world', () => {
    const state = expected.state as {
      t: number;
      dials: Record<string, number>;
      primaries: Record<string, number>;
      drives: Record<string, number>;
      traces: { habitWindow: unknown[] };
    };
    expect(state.t).toBeGreaterThan(diary.t0);
    for (const v of Object.values(allDims(state as never))) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    // 48 real emotional lines left marks: she is not at baseline any more
    const movedCount = Object.entries(state.primaries).filter(([k, v]) => {
      const base = { joy: 0.35, anticipation: 0.3, pride: 0.28, surprise: 0.1, sadness: 0.1, fear: 0.08, anger: 0.06, shame: 0.06, disgust: 0.05 }[k as keyof typeof state.primaries];
      return base !== undefined && Math.abs(v - base) > 0.01;
    }).length;
    expect(movedCount).toBeGreaterThanOrEqual(3);
  });

  it('the recorded weather line is quotable and bounded', () => {
    expect(expected.weather.length).toBeGreaterThan(0);
    expect(expected.weather.split(' ').length).toBeLessThan(60);
  });
});

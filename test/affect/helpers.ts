// test/affect — shared helpers. Everything is hermetic: TestClock, makeRng with
// fixed seeds, temp dirs for the store, no wall clock, no randomness that is not
// replayable, no network.

import type { EventEnvelope } from '../../src/events/index.js';
import { makeRng, type Rng } from '../../src/kernel/index.js';
import {
  initialAffectState,
  type AffectEvent,
  type AffectState,
  type Dial,
  type EmotionTag,
  type Primary,
} from '../../src/affect/index.js';

/** Fixture epoch: 2026-09-01T00:00:00Z. Never "now". */
export const T0 = Date.UTC(2026, 8, 1, 0, 0, 0);

export const H = (hours: number): number => hours * 3_600_000;
export const MIN = (minutes: number): number => minutes * 60_000;

export const freshState = (t: number = T0): AffectState => initialAffectState(t);

export const makeRngSeeded = (seed: string | number): Rng => makeRng(seed);

export const emo = (tag: EmotionTag, i = 8, cause = 'test cause', people?: string): AffectEvent => ({
  kind: 'emotion',
  tag,
  i,
  cause,
  ...(people !== undefined ? { people } : {}),
});

/** Every movable number in one record — the boundedness/movement assertions walk this. */
export const allDims = (s: AffectState): Record<string, number> => ({
  ...s.dials,
  ...s.primaries,
  ...s.drives,
});

export const readDial = (s: AffectState, k: Dial): number => s.dials[k];
export const readPrim = (s: AffectState, k: Primary): number => s.primaries[k];

/** JSON round-trip deep clone (state is plain JSON all the way down). */
export const jsonClone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export const jsonEqual = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

/** A tiny deterministic stand-in for the L0 log when the store's file IO is not under test. */
export interface MemoryLog {
  log: import('../../src/events/index.js').EventLog;
  events: EventEnvelope[];
}

export const memoryLog = (): MemoryLog => {
  const events: EventEnvelope[] = [];
  return {
    events,
    log: {
      emit: async (kind, payload, turnId) => {
        events.push({
          seq: events.length + 1,
          ts: 0,
          kind,
          ...(turnId !== undefined ? { turnId } : {}),
          payload,
        });
      },
      async *replay(filter) {
        for (const e of events) {
          if (filter?.kinds !== undefined && !filter.kinds.includes(e.kind)) continue;
          if (filter?.sinceTs !== undefined && e.ts < filter.sinceTs) continue;
          yield e;
        }
      },
    },
  };
};

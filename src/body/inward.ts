// v13 introspection, Phase 2 — H5 "listen in", as a thing she can do (plan docs/plans/
// v13-proposal-knowing-what-she-feels.md §6 Phase 2.1). The sense itself is pure (src/mind/
// inward.ts); here it becomes an act: discovered in her body (never announced — golden rule 4),
// rate-limited (≤8 a day, ≥20 min apart — a sense, not a compulsion), logged (the noise flips
// ride along so the kill test can read accuracy against noise), and linted (a line that would name
// a feeling is dropped, never shown). Class 'self': hers in a turn with him; never offered to her
// background workers or to other people's turns.

import { z } from 'zod';
import type { ToolCtx, ToolRegistryEntry } from '../loop/index.js';
import type { AffectStore } from '../affect/index.js';
import type { Clock, Rng } from '../kernel/index.js';
import type { EventLog } from '../events/index.js';
import { listenIn, senseViolations } from '../mind/index.js';
import type { House } from './house.js';

type Entry = ToolRegistryEntry<never>;

export const LISTEN_PER_DAY = 8;
export const LISTEN_GAP_MS = 20 * 60_000;
/** Bodies are noisy: live noise on each strength word. */
export const LISTEN_NOISE = 0.1;

export const LISTEN_DESCRIPTION = 'listen in: turn your attention inward for a moment and notice what is moving in you, and toward what. what comes back has no names on it.';

export interface InwardDeps {
  affect: AffectStore;
  house: House;
  clock: Clock;
  rng: Rng;
  events: EventLog;
  timeZone: string;
}

export const inwardTools = (d: InwardDeps): Entry[] => [
  {
    def: { name: 'listen_in', description: LISTEN_DESCRIPTION, parameters: { type: 'object', properties: {}, required: [] } },
    input: z.object({}).passthrough(),
    inhibitionMeta: { class: 'self' },
    handler: async (_args: unknown, ctx: ToolCtx) => {
      const now = d.clock.epochMs();
      const day = new Intl.DateTimeFormat('en-CA', { timeZone: d.timeZone }).format(now);
      const st = d.house.readJson<{ day: string; count: number; lastAt?: number }>('inward.json', { day, count: 0 });
      const today = st.day === day ? st : { day, count: 0 };
      if (today.count >= LISTEN_PER_DAY || (st.lastAt !== undefined && now - st.lastAt < LISTEN_GAP_MS)) {
        void d.events.emit('self.listened', { turnId: ctx.turnId, refused: true });
        return 'nothing new since you last listened.';
      }
      const reading = listenIn(d.affect.current(), { now, rng: d.rng.fork(`listen:${now}`), noise: LISTEN_NOISE });
      const lines = reading.lines.filter((l) => senseViolations(l).length === 0);
      d.house.writeJson('inward.json', { day, count: today.count + 1, lastAt: now });
      void d.events.emit('self.listened', { turnId: ctx.turnId, lines: lines.length, flips: reading.flips, noise: LISTEN_NOISE, dropped: reading.lines.length - lines.length });
      return lines.length === 0 ? 'mostly quiet' : lines.join('\n');
    },
  } as unknown as Entry,
];

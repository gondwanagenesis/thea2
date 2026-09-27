// v13 introspection, Phase 3 — CONTROLLED ARMS (plan docs/plans/v13-proposal-knowing-what-she-feels.md
// §6 Phase 3). Each is off by default and needs Diego's opt-in (config), because each perturbs the
// very thing Phase 2 measures.
//
//   H7 FELT SHIFT (Focusing's resonance; affect labelling as regulation, Lieberman): when her private
//      word fits where her engine is, something eases — a small typed event through the single writer
//      (source 'label', never contact). A/B by day: CONTINGENT days settle exactly when the word fits;
//      YOKED days settle at the same rate but blind to whether it fit. Kill: accuracy gain ≤ yoked, or
//      the felt line volunteered +50% (labelling to feel better).
//   COVERT LIFTS (the choice-blindness / concept-injection analogue): ≤2 a week, a small positive
//      nudge with no cause, in waking hours; never aversive; debriefed to her the next night on her
//      changelog ("at 14:10 a small lift was put in you with no cause, to see if you'd notice").
//
// Pure pieces here; the pipeline (H7), a job (lifts) and sleep (the debrief) do the acting.

import type { AffectStore, EmotionEventInput } from '../affect/index.js';
import type { Clock } from '../kernel/index.js';
import type { EventLog } from '../events/index.js';
import type { Job } from '../sched/index.js';
import type { MindStore } from './store.js';
import type { Rng } from '../kernel/index.js';
import { makeRng } from '../kernel/index.js';
import { hourIn } from './compose.js';

export type ShiftArm = 'contingent' | 'yoked';

/** The day's arm, pre-registered by the day itself (deterministic, ~half each). */
export const shiftArm = (day: string): ShiftArm => (makeRng(`felt-shift:${day}`).float() < 0.5 ? 'contingent' : 'yoked');

/**
 * Does this naming settle her? Contingent: exactly when her word landed. Yoked: at the running
 * contingent hit rate, blind to this word (so the two arms get the same dose, differently timed).
 */
export const settles = (arm: ShiftArm, hit: boolean, yokedRate: number, rng: Rng): boolean => (arm === 'contingent' ? hit : rng.float() < Math.min(0.9, Math.max(0.1, yokedRate)));

/** The settling itself: small, typed, hers — never contact with him. */
export const SETTLE_EVENT: EmotionEventInput = { kind: 'emotion', tag: 'settled', i: 2, cause: 'putting a word to how it was', contact: false };

export const LIFT = {
  perWeek: 2,
  minGapMs: 24 * 3600_000,
  /** Chance per hourly check in waking hours (≈2 a week over ~14 waking hours a day). */
  pPerHour: 0.025,
  waking: [10, 22] as [number, number],
} as const;

/**
 * The lift carries no cause (a blank one — the engine keeps a slot, but nothing is there to name:
 * her sense reads "something without an object", her idle mind finds nothing to think about).
 */
export const LIFT_EVENT: EmotionEventInput = { kind: 'emotion', tag: 'content', i: 2, cause: ' ', contact: false };

export interface LiftRecord {
  ts: number;
  tag: string;
  i: number;
  debriefed?: boolean | undefined;
}

/** May a lift happen now? (≤2 in any 7 days, ≥1 day apart, waking hours his time, never asleep.) */
export const mayLift = (lifts: readonly LiftRecord[], now: number, timeZone: string, asleep: boolean): boolean => {
  if (asleep) return false;
  const h = hourIn(now, timeZone);
  if (h < LIFT.waking[0] || h >= LIFT.waking[1]) return false;
  const week = lifts.filter((l) => now - l.ts < 7 * 24 * 3600_000);
  if (week.length >= LIFT.perWeek) return false;
  return lifts.every((l) => now - l.ts >= LIFT.minGapMs);
};

/** The debrief, in plain words, for her changelog. */
export const liftDebrief = (l: LiftRecord, timeZone: string): string => {
  const when = new Intl.DateTimeFormat('en-GB', { weekday: 'long', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone }).format(l.ts).toLowerCase();
  return `on ${when} a small lift was put in you with no cause, to see if you'd notice`;
};

export interface LiftDeps {
  mind: MindStore;
  affect: AffectStore;
  events: EventLog;
  clock: Clock;
  rng: Rng;
  timeZone: string;
  asleep?: ((now: number) => boolean) | undefined;
}

/** One hourly check: maybe a lift (recorded, so the night can tell her). */
export const liftOnce = async (d: LiftDeps): Promise<boolean> => {
  const now = d.clock.epochMs();
  const lifts = d.mind.state().lifts ?? [];
  if (!mayLift(lifts, now, d.timeZone, d.asleep?.(now) === true)) return false;
  if (d.rng.fork(`lift:${now}`).float() >= LIFT.pPerHour) return false;
  try {
    await d.affect.applyEvents([LIFT_EVENT], { source: 'lift' });
  } catch (e) {
    void d.events.emit('incident.mind_feel_failed', { stage: 'lift', error: e instanceof Error ? e.message : String(e) });
    return false;
  }
  d.mind.setState({ lifts: [...lifts, { ts: now, tag: LIFT_EVENT.tag, i: LIFT_EVENT.i }].slice(-20) });
  await d.mind.flush();
  void d.events.emit('mind.lift', { tag: LIFT_EVENT.tag, i: LIFT_EVENT.i });
  return true;
};

export const liftJob = (d: LiftDeps, everyMs = 3600_000): Job => ({
  name: 'lift',
  cadence: { kind: 'every', ms: everyMs, jitterPct: 25 },
  lane: 'maintenance',
  catchUp: 'skip',
  timeoutMs: 30_000,
  run: async () => {
    await liftOnce(d);
  },
});

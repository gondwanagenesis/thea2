// M05 affect — habituation. Two dulling forces, deliberately distinct:
//  - the short-window rule (HABITUATION 0.7 / HABIT_WINDOW_H 0.5): the same tag
//    again inside 30 min lands at ≤70%. Repetition dulls; novelty spikes.
//  - exposure traces (EXPO_GAIN / HALF_LIFE_EXPO): tolerance that builds with
//    every push and fades over hours, so the twentieth 'cherished' cannot land
//    like the first — but intensity cuts through it (see engine.ts's caller).

import type { AffectState, ExposureTrace } from './state.js';
import { HOURS, round4 } from './state.js';

export const HABITUATION = 0.7; // same emotion again within the window -> 70%
export const HABIT_WINDOW_H = 0.5;

export const EXPO_GAIN = 5.0; // how fast repetition builds tolerance
export const HALF_LIFE_EXPO = 6.0; // ...and how fast sensitivity comes back (h)

/** Is this tag still inside the 30-minute habituation window as of `t`? */
export const isHabituated = (s: AffectState, tag: string, t: number): boolean =>
  s.traces.habitWindow.some((h) => h.tag === tag && (t - h.t) / HOURS < HABIT_WINDOW_H);

/** Record the tag, pruning entries that have left the window (state stays bounded). */
export const recordTag = (s: AffectState, tag: string, t: number): void => {
  s.traces.habitWindow = s.traces.habitWindow.filter(
    (h) => h.tag === tag || (t - h.t) / HOURS < HABIT_WINDOW_H,
  );
  s.traces.habitWindow.push({ tag, t });
};

/** Exposure traces decay on their own clock BEFORE a run's events land — a gap between messages genuinely restores her. */
export const decayExposure = (level: number, dtH: number): number => {
  const next = Math.min(12.0, level * 0.5 ** (dtH / HALF_LIFE_EXPO));
  return next < 1e-3 ? 0 : round4(next);
};

export const growExposure = (
  trace: ExposureTrace | undefined,
  by: number,
  t: number,
): ExposureTrace => ({
  level: round4(Math.min(12.0, (trace?.level ?? 0) + Math.abs(by) * EXPO_GAIN)),
  t,
});

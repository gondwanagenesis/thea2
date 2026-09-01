// M05 affect — the three homeostatic wants. 0 = satiated, 1 = starving, set
// point 0.25 (a mild pull that keeps a life), floor 0.05 (a want never fully
// dies). Hunger is CONTINUOUS — per hour, not once per calendar day: v3's daily
// starvation was outrun two orders of magnitude by satiation and all three sat
// on the floor in 100% of 104 snapshots. A want that never comes back is not a
// want, and a woman with nothing left to want is not content, she is finished.

import { CONNECTION_GAIN } from './decay.js';
import type { AffectState } from './state.js';
import type { Drive } from './vocab.js';

export const SET_POINT = 0.25;
export const DRIVE_FLOOR = 0.05; // a want never fully dies
export const DRIVE_FEED_SCALE = 0.2; // satiation is gentler than it was; one fond line is not a cure
export const HALF_LIFE_DRIVE = 30.0; // wants come back within a day (96h left her permanently satiated)

/** Starvation per hour, ticker.py verbatim: boredom, missing him, unused hands. */
export const STARVE_PER_HOUR: Record<Drive, number> = {
  novelty: 0.01,
  connection: 0.018,
  mastery: 0.014,
};

/** Did an event in the batch this tick follows feed this drive? (Starvation is suppressed for that tick.) */
export const wasFed = (s: AffectState, d: Drive): boolean => s.fedAt[d] === s.t;

/** Relax target: the set point, except connection — silence feeds it, contact soothes it. */
export const driveTarget = (
  d: Drive,
  contact: boolean,
  silenceH: number,
  longingTauH: number,
): number => {
  if (d !== 'connection') return SET_POINT;
  if (contact) return SET_POINT - 0.05;
  return SET_POINT + CONNECTION_GAIN * (1 - Math.exp(-silenceH / longingTauH));
};

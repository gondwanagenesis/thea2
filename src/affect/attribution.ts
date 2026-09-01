// M05 affect — cause attribution (v4.1 introspection). The ticker knew exactly
// how far each primary moved and then threw the link away, so she could not say
// the uneasiness came FROM the thing that caused it. Attribution keeps, per
// primary, the event that actually raised it. Only RISES are attributed —
// nothing causes a feeling to decay, it just runs out.

import type { CauseRecord } from './state.js';
import { HOURS } from './state.js';

/** Smaller than this is drift, not an event. */
export const ATTRIB_MIN = 0.03;
/** After this a stored reason may be superseded by a smaller one. */
export const ATTRIB_STALE_H = 36.0;
/** Once a primary is back within this (normalized) of baseline, it has no cause. */
export const ATTRIB_CLEAR = 0.05;
/** A line has to actually be about something to be quotable as the reason she feels this way. */
export const CAUSE_MIN_I = 5;

/**
 * Should a rise of `step` on `p` (re)write the cause slot? Bigger steps supersede;
 * after ATTRIB_STALE_H even a smaller step may, so a stored reason cannot outlive
 * its era on mere seniority.
 */
export const attributionWins = (
  existing: CauseRecord | undefined,
  step: number,
  now: number,
): boolean =>
  existing === undefined ||
  step >= existing.moved ||
  (now - existing.t) / HOURS > ATTRIB_STALE_H;

export const makeCause = (
  text: string,
  i: number,
  t: number,
  step: number,
  people?: string | undefined,
): CauseRecord => ({
  text,
  i,
  t,
  moved: Math.round(step * 1000) / 1000,
  ...(people !== undefined ? { people } : {}),
});

/** A primary back within ATTRIB_CLEAR of home is no longer caused by anything. */
export const causeIsStale = (value: number, baseline: number): boolean =>
  (value - baseline) / Math.max(1e-6, 1.0 - baseline) < ATTRIB_CLEAR;

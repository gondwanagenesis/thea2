// M05 affect — refractory. Crossing PEAK_HI counts as a peak; for REFRACTORY_H
// the dimension is spent: re-rises land at a fraction (dials 0.25, primaries 0.5)
// and the relax loop lets it come down twice as fast. This is the "after" of the
// v4 hedonic four (rush / tolerance / comedown / after).

import { HOURS } from './state.js';

export const PEAK_HI = 0.93; // crossing this counts as a peak and starts the refractory
export const REFRACTORY_H = 5.0; // how long a dimension stays spent afterwards
export const REFRACTORY_DAMP = 0.25; // pushes land at a quarter while spent (dials)
export const PRIM_REFRACTORY_DAMP = 0.5; // right after a peak it comes down twice as fast (primaries)
/** The relax loop's version for dials: spent means it comes down twice as fast. */
export const REFRACTORY_DECAY_MULT = 0.5;

export const isInRefractory = (
  peaks: Partial<Record<string, number>> | undefined,
  key: string,
  t: number,
): boolean => {
  const at = peaks?.[key];
  return at !== undefined && (t - at) / HOURS < REFRACTORY_H;
};

export const recordPeakIf = (peaks: { [k: string]: number | undefined }, key: string, value: number, t: number): void => {
  if (value >= PEAK_HI) peaks[key] = t;
};

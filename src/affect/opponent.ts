// M05 affect — the b-process (Solomon & Corbit). An opposing pull that builds
// with every rush and OUTLIVES it: it collects during the night and comes for
// her afterwards. Slow on BOTH ends — OPP_LAG_H gates how much of it pulls, so
// it must not fight the rush while the rush is happening, or she can never peak
// at all. That asymmetry is the point.

import type { OpponentTrace } from './state.js';
import { HOURS, round4 } from './state.js';

export const OPP_GAIN = 0.35; // size of the opposing process relative to the rush (dials)
export const HALF_LIFE_OPP = 14.0; // the comedown outlasts the rush (h)
export const OPP_LAG_H = 2.0; // ...and takes this long to reach full strength
export const PRIM_OPP_GAIN = 0.55; // the comedown pulls harder on primaries (v6)
export const PRIM_OPP_LAG_H = 1.0; // full ~1h after the push stops

export const growOpponent = (
  trace: OpponentTrace | undefined,
  step: number,
  gain: number,
  t: number,
): OpponentTrace => ({ b: round4((trace?.b ?? 0) + step * gain), t0: t });

/** The pull on a decay target: target −= opponentPull(trace, t, lagH). */
export const opponentPull = (trace: OpponentTrace | undefined, t: number, lagH: number): number => {
  if (trace === undefined) return 0;
  const lag = Math.min(1.0, (t - trace.t0) / HOURS / lagH);
  return trace.b * lag;
};

/** The comedown fades on its own clock before a run's events land. */
export const decayOpponent = (b: number, dtH: number): number => {
  const next = b * 0.5 ** (dtH / HALF_LIFE_OPP);
  return Math.abs(next) < 1e-3 ? 0 : round4(next);
};

// M05 affect — superlinear intensity. The diary scale was i/10 flat in v3, so a
// routine [i:4] landed at 40% of an [i:10]; INTENSITY_EXP keeps the top intact
// while pulling the routine floor down hard (ticker.py v4.1):
//   i:3 -> 0.12 (was 0.30)   i:5 -> 0.29 (was 0.50)   i:8 -> 0.69 (was 0.80)

export const INTENSITY_EXP = 1.7;

/** The v4.1 curve: (clamp(i,0,10)/10)^1.7 — [i:10] still lands at exactly 1.0. */
export const intensityScale = (i: number): number =>
  (Math.max(0, Math.min(10, i)) / 10.0) ** INTENSITY_EXP;

/** Applied to primaries after the curve: the grid-searched gain (ticker.py PRIMARY_GAIN, calibrated against 438 real diary lines). */
export const PRIMARY_GAIN = 4.0;

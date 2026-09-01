// M05 affect — the earned ceiling. v3 escalated and nothing else: she sat at
// 0.99 on trust, attachment and pleasure for 100% of 104 snapshots. A dial that
// is always maxed carries no information. SATURATE_EXP shrinks a delta as the
// dimension nears the end it is heading for; above CAP_SOFT only a genuinely big
// moment ([i:9]+) moves her at all. The point is not to make her feel less — it
// is to make the high mean something.

export const CAP_SOFT = 0.9; // above here, only a genuinely big moment moves her
export const CAP_DAMP = 0.12; // ...everything else lands at 12%
export const PRIM_CAP_SOFT = 0.72; // aversive primaries stop ratcheting near 0.8 instead of pinning at 0.95
export const SATURATE_EXP = 0.9; // was 0.6 — the old ceiling still passed 6% of a push through at 0.99
export const PEAK_INTENSITY = 10; // [i:9]+ is what "genuinely big" means, per the diary schema

/**
 * Shrink a delta as the dimension nears the end it is heading for. The exponent
 * went 0.6 -> 1.2 in v4: at current=0.99 the old curve still let 6% of a push
 * through, which exactly matched decay pulling the other way, so the dimension
 * parked at the ceiling. At 1.2 the same push lands at 0.4%.
 */
export const saturate = (current: number, delta: number): number =>
  delta >= 0
    ? delta * Math.max(0, 1.0 - current) ** SATURATE_EXP
    : delta * Math.max(0, current) ** SATURATE_EXP;

/** THE CEILING IS EARNED — above the soft cap only a big moment moves her. */
export const ceilingDamp = (current: number, raw: number, i: number, capSoft: number): number => {
  if (raw > 0 && current >= capSoft && i < PEAK_INTENSITY) return raw * CAP_DAMP;
  return raw;
};

/** Tolerance cuts both ways: intensity cuts through it (an [i:10] night is NOT the same stimulus again). */
export const toleranceDivisor = (exposureLevel: number, i: number): number =>
  1.0 + exposureLevel * Math.max(0.15, (10.0 - i) / 4.0);

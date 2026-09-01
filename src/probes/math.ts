// M19 probes — the aggregation math behind k=3. Pure, deterministic, no rng:
// the median is what makes "only the model is nondeterministic" survivable, and
// the variance is the tracked-not-gated instability signal.

/**
 * Median of a non-empty sample; even lengths average the two middle values.
 * Returns null only for an empty sample, which callers treat as "not measured".
 */
export const median = (xs: readonly number[]): number | null => {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const lo = sorted[mid - 1];
  const hi = sorted[mid];
  if (sorted.length % 2 === 1) return hi !== undefined ? hi : null;
  return lo !== undefined && hi !== undefined ? (lo + hi) / 2 : null;
};

/** Population variance over a sample (empty or single-element ⇒ 0 — no spread to report). */
export const variance = (xs: readonly number[]): number => {
  if (xs.length <= 1) return 0;
  const n = xs.length;
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  return xs.reduce((a, b) => a + (b - mean) * (b - mean), 0) / n;
};

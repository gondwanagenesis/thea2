// M18 siblings — small shared helpers: typed error summaries, the module's one
// incident event, and the number formatting both reports use (one formatter per
// shape so every report renders the same numbers the same way).

import type { EventLog } from '../events/index.js';

export interface ErrorSummary {
  code?: string | undefined;
  message: string;
}

export const errorSummary = (e: unknown): ErrorSummary => {
  const code =
    typeof e === 'object' && e !== null && 'code' in e && typeof (e as { code: unknown }).code === 'string'
      ? (e as { code: string }).code
      : undefined;
  return {
    ...(code !== undefined ? { code } : {}),
    message: e instanceof Error ? e.message : String(e),
  };
};

/**
 * `sibling.incident` — the module's loudness valve. Anything a runner absorbs to
 * keep its report/job alive (an unreadable routing.json, a failed voice pass) is
 * recorded here rather than swallowed; a job-killing error instead propagates so
 * M16's failure counter reaches `sched.alarm` on its own.
 */
export const emitSiblingIncident = async (
  events: EventLog,
  source: string,
  e: unknown,
): Promise<void> => {
  await events.emit('sibling.incident', { source, ...errorSummary(e) });
};

export const usd = (v: number): string => `$${v.toFixed(2)}`;

export const pct = (part: number, whole: number): string =>
  whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : 'n/a';

/** Whole minutes, floored — report-speak for an age or a duration. */
export const minutes = (ms: number): string => `${Math.floor(ms / 60_000)} min`;

/** `a ×2, b ×1` — a counted-by-key list, key-sorted so rendering is stable. */
export const countedList = (rows: ReadonlyArray<{ key: string; count: number }>): string =>
  rows.length === 0
    ? 'none'
    : rows.map((r) => `${r.key} ×${r.count}`).join(', ');

/** Groups values into key-count rows, sorted by key — every report list uses this. */
export const countBy = (keys: readonly string[]): Array<{ key: string; count: number }> => {
  const counts = new Map<string, number>();
  for (const k of keys) counts.set(k, (counts.get(k) ?? 0) + 1);
  return [...counts.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, count]) => ({ key, count }));
};

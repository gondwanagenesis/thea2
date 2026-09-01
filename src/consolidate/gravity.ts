// M10 consolidate — seed-gravity metrics and the drift alarms (spec §2.4,
// ADR-005). Definitions pinned there: seed = canon + derived; lived competes in
// the pattern and episode tiers only; the disposition slot is canon-reserved.
//
// The pure functions take WHAT they need as arguments (a seed-id set, a
// dimension resolver) because neither is decidable from a packet record alone —
// a hash id does not say which population it came from, and the dimension lives
// in the corpus index, not in the record. run.ts supplies both from M07.

import { compareStrings } from '../corpus/types.js';
import { DAY_MS } from './cluster.js';
import type { Alarm, PacketRecordView, RunKind, SlotTier } from './types.js';

/** ADR-005's rolling window: the last 50 packets. */
export const ROLLING_WINDOW = 50;

/** seedRatio < 0.25 ⇒ unmoored. */
export const ALARM_UNMOORED_RATIO = 0.25;
/** seedRatio > 0.90 after week 6 ⇒ not-integrating. */
export const ALARM_NOT_INTEGRATING_RATIO = 0.9;
export const ALARM_NOT_INTEGRATING_WEEK = 6;
/** > 70% of disposition slots from one dimension over 7 days ⇒ tunnel vision. */
export const ALARM_TUNNEL_VISION_SHARE = 0.7;
/** The tunnel-vision measurement window. */
export const TUNNEL_VISION_WINDOW_MS = 7 * DAY_MS;

/** The most recent `n` packets, most recent first — (ts, turnId) descending.
 * The ratio math is order-agnostic, but the window reports the RECENT past, so
 * it is presented newest-first (the status projection's baseline sections read
 * the same way). */
export const lastNPackets = (packets: readonly PacketRecordView[], n: number): PacketRecordView[] => {
  if (n <= 0) return [];
  const ordered = [...packets].sort((a, b) => b.ts - a.ts || compareStrings(b.turnId, a.turnId));
  return ordered.slice(0, n);
};

/** Packets inside the last `windowMs` ending at `now`. */
export const packetsWithin = (packets: readonly PacketRecordView[], now: number, windowMs: number): PacketRecordView[] =>
  packets.filter((p) => p.ts >= now - windowMs && p.ts <= now);

/**
 * Seed share of one tier's slots over the given packets. 0 when the tier drew
 * nothing — callers gate the alarms on slot counts, so an empty window alarms
 * at nothing instead of alarming at everything.
 */
export const seedRatio = (
  packets: readonly PacketRecordView[],
  tier: Extract<SlotTier, 'pattern' | 'episode'>,
  seedIds: ReadonlySet<string>,
): number => {
  let total = 0;
  let seed = 0;
  for (const p of packets) {
    for (const slot of p.slots) {
      if (slot.tier !== tier) continue;
      total += 1;
      if (seedIds.has(slot.exemplarId)) seed += 1;
    }
  }
  return total === 0 ? 0 : seed / total;
};

const UNKNOWN_DIM = 'unknown';

/** Slot count for one tier over the given packets — the empty-window gate. */
export const slotCountOf = (packets: readonly PacketRecordView[], tier: SlotTier): number =>
  packets.reduce((acc, p) => acc + p.slots.filter((s) => s.tier === tier).length, 0);

/**
 * Share of character-channel slots per behavioral dimension, over `packets`.
 * Only slots whose dimension resolves count (memory/procedure have none); the
 * keys come back sorted so the record renders identically everywhere.
 */
export const dimensionCoverage = (
  packets: readonly PacketRecordView[],
  dimensionOf: (id: string) => string | undefined,
): Record<string, number> => {
  const counts = new Map<string, number>();
  let total = 0;
  for (const p of packets) {
    for (const slot of p.slots) {
      if (slot.channel !== 'character') continue;
      const dim = dimensionOf(slot.exemplarId);
      if (dim === undefined) continue;
      counts.set(dim, (counts.get(dim) ?? 0) + 1);
      total += 1;
    }
  }
  const out: Record<string, number> = {};
  for (const dim of [...counts.keys()].sort(compareStrings)) {
    const n = counts.get(dim) ?? 0;
    out[dim] = total === 0 ? 0 : n / total;
  }
  return out;
};

export interface DispositionShare {
  /** The dimension holding the largest share of disposition slots ('none' when the window had none). */
  dimension: string;
  share: number;
  slots: number;
}

/**
 * The tunnel-vision measurement: over the disposition slots (canon-reserved,
 * ADR-006) in `packets`, how concentrated is one behavioral dimension.
 */
export const dispositionTopShare = (
  packets: readonly PacketRecordView[],
  dimensionOf: (id: string) => string | undefined,
): DispositionShare => {
  const counts = new Map<string, number>();
  let total = 0;
  for (const p of packets) {
    for (const slot of p.slots) {
      if (slot.tier !== 'disposition') continue;
      const dim = dimensionOf(slot.exemplarId) ?? UNKNOWN_DIM;
      counts.set(dim, (counts.get(dim) ?? 0) + 1);
      total += 1;
    }
  }
  let best: { dimension: string; share: number } = { dimension: 'none', share: 0 };
  for (const dimension of [...counts.keys()].sort(compareStrings)) {
    const share = total === 0 ? 0 : (counts.get(dimension) ?? 0) / total;
    if (share > best.share) best = { dimension, share };
  }
  return { dimension: best.dimension, share: best.share, slots: total };
};

// ---------------------------------------------------------------------------
// Alarms
// ---------------------------------------------------------------------------

export interface GravityMetrics {
  seedRatio: { pattern: number; episode: number };
  /** Slot counts behind each ratio — an empty tier alarms at nothing. */
  patternSlots: number;
  episodeSlots: number;
  disposition: DispositionShare;
  /** Weeks since launch; gates not-integrating until week 6 is past. */
  gravityWeek: number;
}

/**
 * The alarm truth table (ADR-005). Each alarm fires at most once per run and
 * only when its tier actually drew slots — a fresh install with an empty
 * rolling window is not "unmoored", it is just new.
 */
export const gravityAlarms = (m: GravityMetrics): Alarm[] => {
  const alarms: Alarm[] = [];
  const low = (ratio: number, slots: number): boolean => slots > 0 && ratio < ALARM_UNMOORED_RATIO;
  const high = (ratio: number, slots: number): boolean => slots > 0 && ratio > ALARM_NOT_INTEGRATING_RATIO;

  if (low(m.seedRatio.pattern, m.patternSlots) || low(m.seedRatio.episode, m.episodeSlots)) {
    alarms.push('unmoored');
  }
  if (m.gravityWeek > ALARM_NOT_INTEGRATING_WEEK) {
    if (high(m.seedRatio.pattern, m.patternSlots) || high(m.seedRatio.episode, m.episodeSlots)) {
      alarms.push('not-integrating');
    }
  }
  if (m.disposition.slots > 0 && m.disposition.share > ALARM_TUNNEL_VISION_SHARE) {
    alarms.push('tunnel-vision');
  }
  return alarms;
};

// ---------------------------------------------------------------------------
// The status projection (var/reports/status.md)
// ---------------------------------------------------------------------------

const fmt = (x: number): string => x.toFixed(3);

export interface StatusInput {
  kind: RunKind;
  gravityWeek: number;
  windowPackets: number;
  seedRatio: { pattern: number; episode: number };
  coverage: Record<string, number>;
  disposition: DispositionShare;
  /** M19's latest drift cosine, injected — never computed here. */
  driftCosine?: number | undefined;
  alarms: Alarm[];
  /** Weekly runs add the relationship baseline section (deterministic summary). */
  baseline?: readonly string[] | undefined;
}

/**
 * The nightly projection Diego (and Nightingale) read. Numbers side by side on
 * purpose: a healthy seedRatio beside a falling drift cosine means the problem
 * is derived quality, not gravity — the reader should not have to know that rule.
 */
export const renderStatus = (input: StatusInput): string => {
  const coverage = Object.keys(input.coverage)
    .sort(compareStrings)
    .map((d) => `${d} ${fmt(input.coverage[d] ?? 0)}`)
    .join(' · ');
  const lines: string[] = [
    '# status — consolidation projection',
    '',
    `kind: ${input.kind}`,
    `gravityWeek: ${input.gravityWeek}`,
    `window: ${input.windowPackets} packets`,
    '',
    '## gravity',
    `seedRatio pattern: ${fmt(input.seedRatio.pattern)}`,
    `seedRatio episode: ${fmt(input.seedRatio.episode)}`,
    `dimension coverage: ${coverage.length === 0 ? '(no resolved dimensions)' : coverage}`,
    `disposition top dimension: ${input.disposition.dimension} ${fmt(input.disposition.share)}`,
    `probe drift cosine: ${input.driftCosine === undefined ? '(not injected)' : fmt(input.driftCosine)} (from M19)`,
    `alarms: ${input.alarms.length === 0 ? 'none' : [...input.alarms].sort(compareStrings).join(', ')}`,
    '',
    'Cross-check: a healthy seedRatio beside a falling drift cosine means derived',
    'quality, not gravity.',
  ];
  if (input.baseline !== undefined && input.baseline.length > 0) {
    lines.push('', '## relationship baseline', ...input.baseline);
  }
  return `${lines.join('\n')}\n`;
};

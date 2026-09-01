// M10 gate — gravity metrics and the three drift alarms (ADR-005). The truth
// table is asserted at its boundaries: the empty-window suppression, the week-6
// gate (strictly greater), the exact 0.25/0.90/0.70 thresholds, and the
// disposition concentration window.

import { describe, expect, it } from 'vitest';
import {
  ALARM_NOT_INTEGRATING_WEEK,
  ALARM_TUNNEL_VISION_SHARE,
  ALARM_UNMOORED_RATIO,
  DAY_MS,
  dimensionCoverage,
  dispositionTopShare,
  gravityAlarms,
  lastNPackets,
  packetsWithin,
  renderStatus,
  seedRatio,
  slotCountOf,
} from '../../src/consolidate/index.js';
import type { PacketRecordView } from '../../src/consolidate/index.js';

const packetOf = (ts: number, turnId: string, slots: PacketRecordView['slots']): PacketRecordView => ({
  ts,
  turnId,
  slots,
  affectSig: [],
});

const char = (id: string, tier: PacketRecordView['slots'][number]['tier'] = 'pattern') => ({
  exemplarId: id,
  tier,
  channel: 'character' as const,
  baseScore: 1,
  modulation: 0,
});

describe('rolling window + measurement window', () => {
  it('lastNPackets takes the most recent n in (ts, turnId) order', () => {
    const packets = [
      packetOf(300, 'c', [char('a')]),
      packetOf(100, 'b', [char('a')]),
      packetOf(100, 'a', [char('a')]),
      packetOf(200, 'd', [char('a')]),
    ];
    const window = lastNPackets(packets, 2);
    expect(window.map((p) => p.turnId)).toEqual(['c', 'd']);
    expect(lastNPackets(packets, 0)).toEqual([]);
    expect(lastNPackets(packets, 99)).toHaveLength(4);
  });

  it('packetsWithin is inclusive on both ends', () => {
    const packets = [packetOf(0, 'a', []), packetOf(700, 'b', []), packetOf(1000, 'c', []), packetOf(1001, 'd', [])];
    expect(packetsWithin(packets, 1000, 1000).map((p) => p.turnId)).toEqual(['a', 'b', 'c']);
  });
});

describe('seedRatio — hand computed', () => {
  it('is the seed share of one tier slots over the given packets', () => {
    const packets = [
      packetOf(1, 't1', [char('seed1'), char('lived1', 'episode'), char('derived1')]),
      packetOf(2, 't2', [char('lived2'), char('lived3', 'episode')]),
    ];
    const seeds = new Set(['seed1', 'derived1']);
    // Hand-computed (ADR-005: seed = canon + derived, ratio per tier): the
    // pattern tier drew 3 slots — seed1, derived1, lived2 — of which BOTH seed
    // ids are seed, so 2/3. The episode tier drew lived1+lived3, neither seed.
    expect(seedRatio(packets, 'pattern', seeds)).toBeCloseTo(2 / 3, 12);
    expect(seedRatio(packets, 'episode', seeds)).toBe(0);
  });

  it('ignores the disposition and memory tiers entirely', () => {
    const packets = [packetOf(1, 't1', [char('lived1', 'disposition'), char('lived2', 'memory')])];
    expect(seedRatio(packets, 'pattern', new Set(['lived1']))).toBe(0);
    expect(slotCountOf(packets, 'pattern')).toBe(0);
  });

  it('an empty denominator is 0 — the alarms gate on slot counts', () => {
    expect(seedRatio([], 'pattern', new Set(['a']))).toBe(0);
    expect(ALARM_UNMOORED_RATIO).toBe(0.25);
  });
});

describe('dimensionCoverage + disposition concentration', () => {
  const dimOf = (id: string): string | undefined => (id === 'mystery' ? undefined : `dim-${id.slice(-1)}`);

  it('counts character-channel slots with resolvable dimensions only', () => {
    const packets = [
      packetOf(1, 't1', [
        char('x1'),
        char('x1'),
        { ...char('proc1'), channel: 'procedural' as const },
        char('mystery'),
        char('x2', 'episode'),
      ]),
    ];
    const coverage = dimensionCoverage(packets, dimOf);
    expect(Object.keys(coverage)).toEqual(['dim-1', 'dim-2']); // sorted
    expect(coverage['dim-1']).toBeCloseTo(2 / 3, 12);
    expect(coverage['dim-2']).toBeCloseTo(1 / 3, 12);
  });

  it('the disposition top share is the tunnel-vision measurement', () => {
    const packets = [
      packetOf(1, 't1', [char('a1', 'disposition'), char('a2', 'disposition'), char('b1', 'disposition')]),
    ];
    const top = dispositionTopShare(packets, dimOf);
    expect(top.dimension).toBe('dim-1');
    expect(top.share).toBeCloseTo(2 / 3, 12);
    expect(top.slots).toBe(3);
  });

  it('an empty window reads as none, not as a dimension', () => {
    expect(dispositionTopShare([], dimOf)).toEqual({ dimension: 'none', share: 0, slots: 0 });
  });
});

describe('alarm truth table', () => {
  const metrics = (over: {
    patternRatio?: number;
    episodeRatio?: number;
    patternSlots?: number;
    episodeSlots?: number;
    gravityWeek?: number;
    disposition?: { dimension: string; share: number; slots: number };
  }) => ({
    // The implicit tier sits at a HEALTHY mid ratio (0.5), never 1.0: 1.0 is the
    // not-integrating trigger itself, so a 1.0 default would fire the alarm from
    // the tier under test's innocent bystander and the exact-threshold cases
    // (pattern 0.95 vs 0.90) could not isolate anything.
    seedRatio: { pattern: over.patternRatio ?? 0.5, episode: over.episodeRatio ?? 0.5 },
    patternSlots: over.patternSlots ?? 1,
    episodeSlots: over.episodeSlots ?? 1,
    disposition: over.disposition ?? { dimension: 'none', share: 0, slots: 0 },
    gravityWeek: over.gravityWeek ?? 1,
  });

  it('an empty window alarms at nothing — new is not unmoored', () => {
    expect(gravityAlarms(metrics({ patternSlots: 0, episodeSlots: 0, patternRatio: 0, episodeRatio: 0 }))).toEqual([]);
  });

  it('unmoored: either tier below 0.25 with slots on the table', () => {
    expect(gravityAlarms(metrics({ patternRatio: 0.24, episodeRatio: 1 }))).toEqual(['unmoored']);
    expect(gravityAlarms(metrics({ patternRatio: 1, episodeRatio: 0.24 }))).toEqual(['unmoored']);
    expect(gravityAlarms(metrics({ patternRatio: 0.25, episodeRatio: 1 }))).toEqual([]); // exact threshold holds
  });

  it('not-integrating fires only strictly past week 6 and above 0.90', () => {
    expect(ALARM_NOT_INTEGRATING_WEEK).toBe(6);
    expect(gravityAlarms(metrics({ patternRatio: 0.95, gravityWeek: 6 }))).toEqual([]);
    expect(gravityAlarms(metrics({ patternRatio: 0.95, gravityWeek: 7 }))).toEqual(['not-integrating']);
    expect(gravityAlarms(metrics({ patternRatio: 0.9, gravityWeek: 7 }))).toEqual([]);
    expect(gravityAlarms(metrics({ patternRatio: 1, episodeRatio: 0.95, gravityWeek: 8 }))).toEqual([
      'not-integrating',
    ]);
  });

  it('tunnel-vision is disposition concentration over the 7-day window, strictly above 0.70', () => {
    expect(ALARM_TUNNEL_VISION_SHARE).toBe(0.7);
    expect(gravityAlarms(metrics({ disposition: { dimension: 'voice', share: 0.7, slots: 10 } }))).toEqual([]);
    expect(gravityAlarms(metrics({ disposition: { dimension: 'voice', share: 0.71, slots: 10 } }))).toEqual([
      'tunnel-vision',
    ]);
    expect(gravityAlarms(metrics({ disposition: { dimension: 'voice', share: 1, slots: 0 } }))).toEqual([]);
  });

  it('all three can fire in one run', () => {
    const alarms = gravityAlarms(
      metrics({
        patternRatio: 0.1,
        episodeRatio: 0.95,
        gravityWeek: 9,
        disposition: { dimension: 'voice', share: 0.9, slots: 5 },
      }),
    );
    expect(alarms).toEqual(['unmoored', 'not-integrating', 'tunnel-vision']);
  });
});

describe('the status projection', () => {
  it('renders the numbers side by side, deterministically', () => {
    const text = renderStatus({
      kind: 'nightly',
      gravityWeek: 3,
      windowPackets: 50,
      seedRatio: { pattern: 0.8, episode: 0.25 },
      coverage: { voice: 0.5, warmth: 0.25 },
      disposition: { dimension: 'voice', share: 0.5, slots: 4 },
      alarms: ['unmoored'],
    });
    expect(text).toContain('kind: nightly');
    expect(text).toContain('gravityWeek: 3');
    expect(text).toContain('window: 50 packets');
    expect(text).toContain('seedRatio pattern: 0.800');
    expect(text).toContain('seedRatio episode: 0.250');
    expect(text).toContain('dimension coverage: voice 0.500 · warmth 0.250');
    expect(text).toContain('disposition top dimension: voice 0.500');
    expect(text).toContain('probe drift cosine: (not injected) (from M19)');
    expect(text).toContain('alarms: unmoored');
    expect(text).toContain('a healthy seedRatio beside a falling drift cosine');
    expect(text).not.toContain('relationship baseline');
  });

  it('the weekly projection carries the relationship baseline', () => {
    const text = renderStatus({
      kind: 'weekly',
      gravityWeek: 7,
      windowPackets: 50,
      seedRatio: { pattern: 1, episode: 1 },
      coverage: {},
      disposition: { dimension: 'none', share: 0, slots: 0 },
      driftCosine: 0.91,
      alarms: [],
      baseline: ['- episodes this window: 12', '- top affect tags: fond 4 · longing 2'],
    });
    expect(text).toContain('probe drift cosine: 0.910 (from M19)');
    expect(text).toContain('alarms: none');
    expect(text).toContain('## relationship baseline');
    expect(text).toContain('- episodes this window: 12');
    expect(text).toContain('dimension coverage: (no resolved dimensions)');
  });
});

describe('the tunnel-vision window constant', () => {
  it('is seven days', () => {
    expect(DAY_MS).toBe(86_400_000);
  });
});

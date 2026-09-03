// M17 life — configuration. Cadences and caps live here so M20 can move them
// without touching the job bodies; the values that ARE law (threshold 3.2, cap
// 3, gate 0.45, the balance rule) live in policy.ts as exported constants, not
// config, because they are spec-pinned behavior rather than tuning knobs.

export interface LifeConfig {
  /** Quiet hours as a [start, end) pair of LOCAL hours in `timeZone`; wraps midnight. */
  quietHours: [number, number];
  /**
   * The IANA zone his day runs in (quiet hours + the daily cap's midnight).
   * Default 'UTC' keeps every existing fixture byte-identical; prod sets
   * Europe/Madrid via thea2.config.yaml. Validated by M20's config loader.
   * The reflect cadence stays on M16's UTC grid (reflectUtcMinute) — the
   * scheduler is DST-agnostic by construction, and 03:00 UTC is inside quiet
   * hours in Madrid either way.
   */
  timeZone: string;
  /** Heartbeat period (spec: 30 min, catchUp 'skip'). */
  heartbeatEveryMs: number;
  /** Ponder period (spec: 20 min, catchUp 'skip'). */
  ponderEveryMs: number;
  /** Slot jitter ± percentage, passed straight to M16's cadence. */
  jitterPct: number;
  /** Nightly reflection fire (spec: nightly, catchUp 'once'); minutes past UTC midnight. */
  reflectUtcMinute: number;
  /** The UTC day-of-week the weekly L3 consolidator rides the nightly pass (0 = Sunday). */
  reflectWeeklyDow: number;
  heartbeatTimeoutMs: number;
  ponderTimeoutMs: number;
  reflectTimeoutMs: number;
  /** The private heartbeat-thought call (cheap-tier, structured ladder). Sized
   * for reasoning models: the thinking trace draws from the same budget as the
   * visible content, and a starved call returns empty text (live-proven). */
  thoughtMaxTokens: number;
  thoughtTemperature: number;
  /** Committee node calls (main-tier; PO.1: each node's schema rides the
   * request, so M03's structured ladder runs per node). Same reasoning-budget
   * caveat as thoughtMaxTokens: 2000 starved glm-5.3's seed node into empty
   * output on the first live ponder; the spec pins 3000. */
  committeeMaxTokens: number;
  committeeTemperature: number;
  /** Recent episodes rendered into her private context blocks. */
  contextEpisodes: number;
  /** The private-thought and committee model tiers (cheap thought, main nodes). */
  thoughtTier: 'cheap';
  committeeTier: 'main';
}

const MIN = 60_000;

export const LIFE_CONFIG_DEFAULTS: LifeConfig = {
  quietHours: [23, 8], // PROPOSED: he is asleep 23:00–08:00 local; see Build deltas
  timeZone: 'UTC',
  heartbeatEveryMs: 30 * MIN,
  ponderEveryMs: 20 * MIN,
  jitterPct: 10,
  reflectUtcMinute: 180, // 03:00 UTC — inside quiet hours, matches the M16 week fixture
  reflectWeeklyDow: 0, // Sunday — the weekly L3 rides the Sunday-night pass
  heartbeatTimeoutMs: 5 * MIN,
  ponderTimeoutMs: 6 * MIN,
  reflectTimeoutMs: 15 * MIN,
  thoughtMaxTokens: 2000, // 800 was borderline: flash thinking alone can pass 700
  thoughtTemperature: 0.7,
  /** Committee node calls (main-tier; PO.1: the node schema rides the request,
   * so the structured ladder runs per node). Same reasoning-budget caveat as
   * thoughtMaxTokens — the thinking trace draws from the same budget as the
   * visible content — with the spec pinning the headroom at 3000. */
  committeeMaxTokens: 3000,
  committeeTemperature: 0.6,
  contextEpisodes: 8,
  thoughtTier: 'cheap',
  committeeTier: 'main',
};

export const resolveLifeConfig = (partial: Partial<LifeConfig> = {}): LifeConfig => ({
  ...LIFE_CONFIG_DEFAULTS,
  ...partial,
});

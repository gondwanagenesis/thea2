// M17 gate — the config split. Cadences and caps are TUNING KNOBS and live in
// LifeConfig so M20 can move them; the values that ARE law (threshold 3.2, cap
// 3, gate 0.45) live in policy.ts as constants and must NOT be reachable through
// config. The defaults table pins the spec cadences: heartbeat 30 min, ponder
// 20 min, reflection nightly at 03:00 UTC — inside quiet hours, matching the
// M16 week fixture.

import { describe, expect, it } from 'vitest';
import { LIFE_CONFIG_DEFAULTS, resolveLifeConfig } from '../../src/life/config.js';
import { isQuietHour } from '../../src/life/policy.js';

describe('LIFE_CONFIG_DEFAULTS — the spec cadences', () => {
  it('heartbeat every 30 min, ponder every 20 min, both catchUp: skip cadences', () => {
    expect(LIFE_CONFIG_DEFAULTS.heartbeatEveryMs).toBe(30 * 60_000);
    expect(LIFE_CONFIG_DEFAULTS.ponderEveryMs).toBe(20 * 60_000);
  });

  it('quiet hours are a midnight-wrapping [23, 8) UTC window', () => {
    expect(LIFE_CONFIG_DEFAULTS.quietHours).toEqual([23, 8]);
    expect(isQuietHour(23.5, LIFE_CONFIG_DEFAULTS.quietHours)).toBe(true);
    expect(isQuietHour(5, LIFE_CONFIG_DEFAULTS.quietHours)).toBe(true);
    expect(isQuietHour(12, LIFE_CONFIG_DEFAULTS.quietHours)).toBe(false);
  });

  it('nightly reflection fires at 03:00 UTC — inside quiet hours, per the M16 week fixture', () => {
    expect(LIFE_CONFIG_DEFAULTS.reflectUtcMinute).toBe(180);
    expect(isQuietHour(LIFE_CONFIG_DEFAULTS.reflectUtcMinute / 60, LIFE_CONFIG_DEFAULTS.quietHours)).toBe(true);
  });

  it('the private thought is cheap-tier, the committee nodes main-tier (spec: tiers by job)', () => {
    expect(LIFE_CONFIG_DEFAULTS.thoughtTier).toBe('cheap');
    expect(LIFE_CONFIG_DEFAULTS.committeeTier).toBe('main');
  });

  it('timeouts, jitter and context budgets are present and positive', () => {
    expect(LIFE_CONFIG_DEFAULTS.jitterPct).toBe(10);
    expect(LIFE_CONFIG_DEFAULTS.heartbeatTimeoutMs).toBeGreaterThan(0);
    expect(LIFE_CONFIG_DEFAULTS.ponderTimeoutMs).toBeGreaterThan(0);
    expect(LIFE_CONFIG_DEFAULTS.reflectTimeoutMs).toBeGreaterThan(0);
    expect(LIFE_CONFIG_DEFAULTS.thoughtMaxTokens).toBeGreaterThan(0);
    expect(LIFE_CONFIG_DEFAULTS.committeeMaxTokens).toBeGreaterThan(0);
    expect(LIFE_CONFIG_DEFAULTS.contextEpisodes).toBeGreaterThan(0);
  });
});

describe('the config/policy split — the law is not a knob', () => {
  it('no config key can move the threshold, the gate, the cap or the backoff', () => {
    const keys = Object.keys(LIFE_CONFIG_DEFAULTS).map((k) => k.toLowerCase());
    for (const banned of ['threshold', 'gate', 'cap', 'backoff', 'balance']) {
      expect(keys.some((k) => k.includes(banned))).toBe(false);
    }
  });
});

describe('resolveLifeConfig', () => {
  it('with nothing given, hands back the defaults verbatim', () => {
    expect(resolveLifeConfig()).toEqual(LIFE_CONFIG_DEFAULTS);
    expect(resolveLifeConfig({})).toEqual(LIFE_CONFIG_DEFAULTS);
  });

  it('a partial override merges field-by-field, never dropping a sibling', () => {
    const cfg = resolveLifeConfig({ heartbeatEveryMs: 5 * 60_000, quietHours: [1, 7] });
    expect(cfg.heartbeatEveryMs).toBe(5 * 60_000);
    expect(cfg.quietHours).toEqual([1, 7]);
    expect(cfg.ponderEveryMs).toBe(LIFE_CONFIG_DEFAULTS.ponderEveryMs);
    expect(cfg.thoughtTier).toBe('cheap');
    expect(cfg.reflectUtcMinute).toBe(180);
  });
});

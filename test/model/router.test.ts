// M03 model — the router guardrail table: every task class × every tier, with
// and without routing overrides (ADR-008: downgrades only, never on `turn`).

import { describe, expect, it } from 'vitest';
import { makeRouter } from '../../src/model/router.js';
import { TASK_CLASSES, type RoutingOverride, type TaskClass, type Tier } from '../../src/model/index.js';
import { memoryLog, TEST_TIERS } from './helpers.js';

const TIERS: Tier[] = ['main', 'cheap', 'reasoning'];
const modelFor = (tier: Tier): string => TEST_TIERS[tier];

describe('router — no routing table: every class rides its requested tier (turn pinned to main)', () => {
  for (const taskClass of TASK_CLASSES) {
    for (const tier of TIERS) {
      // ADR-008: `turn` resolves to main even when the caller asks for less.
      const effectiveTier: Tier = taskClass === 'turn' ? 'main' : tier;
      it(`${taskClass} @ ${tier} → ${modelFor(effectiveTier)}`, () => {
        const router = makeRouter({ tiers: { ...TEST_TIERS } });
        expect(router.resolve(taskClass, tier)).toEqual({ model: modelFor(effectiveTier), tier: effectiveTier });
      });
    }
  }
});

describe('router — guardrails', () => {
  it('AC: a downgrade proposal on summarize is honored; an upgrade attempt is ignored + warned', () => {
    const { log, events } = memoryLog();
    const downgraded = makeRouter({
      log,
      tiers: { ...TEST_TIERS },
      routing: [{ taskClass: 'summarize', tier: 'cheap' }] as RoutingOverride[],
    });
    expect(downgraded.resolve('summarize', 'main')).toEqual({ model: TEST_TIERS.cheap, tier: 'cheap' });
    expect(events.filter((e) => e.kind === 'model.routing_ignored')).toHaveLength(0);

    const upgradeAttempt = makeRouter({
      log,
      tiers: { ...TEST_TIERS },
      routing: [{ taskClass: 'summarize', tier: 'reasoning' }] as RoutingOverride[],
    });
    // Requested cheap (rank 0); proposal reasoning (rank 1) is an UPGRADE ⇒ ignored.
    expect(upgradeAttempt.resolve('summarize', 'cheap')).toEqual({ model: TEST_TIERS.cheap, tier: 'cheap' });
    const ignored = events.filter((e) => e.kind === 'model.routing_ignored');
    expect(ignored).toHaveLength(1);
    expect(ignored[0]!.payload).toEqual({ taskClass: 'summarize', attemptedTier: 'reasoning', pinnedTier: 'cheap' });
  });

  it('AC: `turn` is pinned to main in code — any proposal (or request) off it is ignored + warned', () => {
    const { log, events } = memoryLog();
    const router = makeRouter({
      log,
      tiers: { ...TEST_TIERS },
      routing: [{ taskClass: 'turn', tier: 'cheap' }] as RoutingOverride[],
    });
    // Even a caller asking for cheap gets main.
    expect(router.resolve('turn', 'cheap')).toEqual({ model: TEST_TIERS.main, tier: 'main' });
    const ignored = events.filter((e) => e.kind === 'model.routing_ignored');
    expect(ignored).toHaveLength(1);
    expect(ignored[0]!.payload).toEqual({ taskClass: 'turn', attemptedTier: 'cheap', pinnedTier: 'main' });
  });

  it('turn @ main with no proposal is silent — no warning for the happy path', () => {
    const { log, events } = memoryLog();
    const router = makeRouter({ log, tiers: { ...TEST_TIERS } });
    expect(router.resolve('turn', 'main')).toEqual({ model: TEST_TIERS.main, tier: 'main' });
    expect(events).toHaveLength(0);
  });

  it('an override matching the requested tier changes nothing and stays silent', () => {
    const { log, events } = memoryLog();
    const router = makeRouter({
      log,
      tiers: { ...TEST_TIERS },
      routing: [{ taskClass: 'summarize', tier: 'cheap' }] as RoutingOverride[],
    });
    expect(router.resolve('summarize', 'cheap')).toEqual({ model: TEST_TIERS.cheap, tier: 'cheap' });
    expect(events).toHaveLength(0);
  });

  it('reasoning-tier downgrade chain: main request + reasoning proposal is a legal downgrade', () => {
    const { log, events } = memoryLog();
    const router = makeRouter({
      log,
      tiers: { ...TEST_TIERS },
      routing: [{ taskClass: 'appraisal', tier: 'reasoning' }] as RoutingOverride[],
    });
    expect(router.resolve('appraisal', 'main')).toEqual({ model: TEST_TIERS.reasoning, tier: 'reasoning' });
    expect(events).toHaveLength(0);
  });

  it('later entries win — the Ledger supersedes its own earlier proposals', () => {
    const router = makeRouter({
      tiers: { ...TEST_TIERS },
      routing: [
        { taskClass: 'summarize', tier: 'cheap' },
        { taskClass: 'summarize', tier: 'reasoning' },
      ] as RoutingOverride[],
    });
    expect(router.resolve('summarize', 'main')).toEqual({ model: TEST_TIERS.reasoning, tier: 'reasoning' });
  });

  it('all nine task classes are downgrade-eligible except turn (pin table)', () => {
    const router = makeRouter({
      tiers: { ...TEST_TIERS },
      routing: TASK_CLASSES.map((c): RoutingOverride => ({ taskClass: c as TaskClass, tier: 'cheap' })),
    });
    for (const c of TASK_CLASSES) {
      const r = router.resolve(c as TaskClass, 'main');
      expect(r.tier).toBe(c === 'turn' ? 'main' : 'cheap');
    }
  });
});

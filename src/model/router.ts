// M03 model — the per-call router with the ADR-008 guardrails.
//
// var/routing.json (written by M18's Ledger, loaded by M20) may only DOWNGRADE
// non-user-facing task classes. `turn` is pinned to the main tier here in code:
// a proposal (or a caller request) that would move it is ignored and warned to
// L0. Any applied routing change counts as a deploy — M18's Nightingale trigger.

import type { EventLog } from '../events/index.js';
import { PINNED_TURN_TIER, TIER_RANK, TIER_TABLE, USER_FACING_TASK_CLASSES } from './tiers.js';
import type {
  ModelRouter,
  RoutingIgnoredEvent,
  RoutingOverride,
  RoutingTable,
  TaskClass,
  Tier,
} from './types.js';

export interface RouterDeps {
  /** L0 sink for `model.routing_ignored` warnings; omitted ⇒ warnings are dropped (test doubles). */
  log?: EventLog;
  /** Parsed var/routing.json. Omitted ⇒ every call rides its requested tier. */
  routing?: RoutingTable;
  /** tier → model id; defaults to the one-line swap table. */
  tiers?: Record<Tier, string>;
}

export const makeRouter = (deps: RouterDeps = {}): ModelRouter => {
  const tiers = deps.tiers ?? TIER_TABLE;
  const routing = deps.routing ?? [];

  const warn = (payload: RoutingIgnoredEvent): void => {
    const log = deps.log;
    if (!log) return;
    // resolve() is sync by contract, so the emit is fire-and-forget. M02 already
    // owns failure loudness (one retry + stderr) if the log itself is broken.
    void log.emit('model.routing_ignored', payload).catch(() => undefined);
  };

  return {
    resolve(taskClass, requested) {
      if (USER_FACING_TASK_CLASSES.includes(taskClass)) {
        const attempted = overrideFor(routing, taskClass)?.tier;
        if (requested !== PINNED_TURN_TIER || (attempted !== undefined && attempted !== PINNED_TURN_TIER)) {
          warn({ taskClass, attemptedTier: attempted ?? requested, pinnedTier: PINNED_TURN_TIER });
        }
        return { model: tiers[PINNED_TURN_TIER], tier: PINNED_TURN_TIER };
      }

      const override = overrideFor(routing, taskClass);
      if (override !== undefined && override.tier !== requested) {
        // Guardrail: only downgrades are legal, and never on a user-facing class.
        if (TIER_RANK[override.tier] < TIER_RANK[requested]) {
          return { model: tiers[override.tier], tier: override.tier };
        }
        warn({ taskClass, attemptedTier: override.tier, pinnedTier: requested });
      }
      return { model: tiers[requested], tier: requested };
    },
  };
};

/** Last entry wins — later Ledger proposals supersede earlier ones. */
const overrideFor = (routing: RoutingTable, taskClass: TaskClass): RoutingOverride | undefined => {
  let found: RoutingOverride | undefined;
  for (const entry of routing) if (entry.taskClass === taskClass) found = entry;
  return found;
};

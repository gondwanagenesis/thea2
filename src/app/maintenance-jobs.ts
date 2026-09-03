// M20 app — the two maintenance jobs the architecture promised and prod never
// registered (Phase 1, 2026-09-02): `reconcile` every 5 min (ADR-003) and
// `affect-snapshot` every 15 min (ARCHITECTURE job table). Both are thin M16
// bodies over interfaces other modules own; the one piece of policy that lives
// HERE is lost-reply RECOVERY — what to do with a LOST_REPLY beyond alarming.
//
// Recovery law: a lost inbound younger than `graceMs` is re-run through the
// pipeline exactly once per process (an in-memory set of update ids — a second
// loss of the same message is alarmed, never looped); an older loss is alarmed
// only (answering a question from three hours ago as if it just arrived is
// worse than the alarm). The boot reconcile in thead.ts and the 5-min job share
// this helper and the same set, so a boot re-run is not repeated by the job.
//
// Failure is loud: a throwing reconcile lands `incident.reconcile_failed`, a
// throwing snapshot lands `incident.affect_snapshot_failed`; neither ever
// throws out of run() (the scheduler's backoff is for bugs, not for policy).

import type { AffectStore } from '../affect/index.js';
import { emitLostReplyAlarms, type Discrepancy, type MessageLedger } from '../bridge/index.js';
import type { EventLog } from '../events/index.js';
import type { Job } from '../sched/index.js';
import type { Pipeline } from './pipeline.js';

const MIN = 60_000;

/** ADR-003: the reconcile job runs every 5 minutes and on boot. */
export const RECONCILE_EVERY_MS = 5 * MIN;
/** ARCHITECTURE job table: affect-snapshot every 15 min, maintenance, skip. */
export const AFFECT_SNAPSHOT_EVERY_MS = 15 * MIN;
/** A lost inbound older than this is alarmed but never re-run. */
export const DEFAULT_RERUN_GRACE_MS = 60 * MIN;
const MAINTENANCE_TIMEOUT_MS = 60_000;

/** `bridge.reply_rerun` — a lost inbound was re-enqueued as a fresh turn. */
export const REPLY_RERUN_EVENT = 'bridge.reply_rerun';
export const RECONCILE_INCIDENT = 'incident.reconcile_failed';
export const AFFECT_SNAPSHOT_INCIDENT = 'incident.affect_snapshot_failed';

export interface ReplyRerunEvent {
  updateId: number;
  turnId: string;
  ageMs: number;
}

export interface RecoverLostDeps {
  ledger: Pick<MessageLedger, 'reconcile' | 'linkTurn'>;
  events: EventLog;
  /** `inbound` re-enqueues; `isBusy` defers a re-run while a turn is in flight (the loss may BE that turn). */
  pipeline: Pick<Pipeline, 'inbound' | 'isBusy'>;
  /** Losses younger than this are re-run; default 60 min. */
  graceMs?: number | undefined;
  /**
   * Update ids already re-run in this process. Callers that share a set
   * (compose hands one to both the boot reconcile and the job) get the
   * once-per-process guarantee across both paths.
   */
  rerun: Set<number>;
}

export interface RecoveryOutcome {
  /** Every discrepancy reconcile returned (alarms already emitted for the losses). */
  discrepancies: Discrepancy[];
  /** The update ids re-enqueued by this pass. */
  rerunUpdateIds: number[];
}

const asErrorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * The recovery half, given a discrepancy list: alarm every LOST_REPLY (M15's
 * emitter), then re-run the young ones once. Pure over its inputs beyond the
 * pipeline enqueue and the ledger link; no clock — ages ride the discrepancy.
 */
export const recoverLost = async (deps: RecoverLostDeps, discrepancies: readonly Discrepancy[]): Promise<number[]> => {
  await emitLostReplyAlarms(deps.events, discrepancies);
  const graceMs = deps.graceMs ?? DEFAULT_RERUN_GRACE_MS;
  const rerunIds: number[] = [];
  for (const d of discrepancies) {
    if (d.kind !== 'LOST_REPLY') continue;
    if (d.ageMs >= graceMs) continue; // too old: alarmed above, never re-run
    const updateId = d.inbound.updateId;
    if (deps.rerun.has(updateId)) continue; // once per process
    // A turn in flight may be the very turn reconcile is counting as lost
    // (slow model past T): re-running now would answer him twice. The next
    // pass (5 min) re-runs it if it is still owed.
    if (deps.pipeline.isBusy()) continue;
    const turnId = deps.pipeline.inbound(d.inbound);
    if (turnId === undefined) continue; // the pipeline declined (skipped/denied) — nothing to link
    deps.rerun.add(updateId);
    await deps.ledger.linkTurn(updateId, turnId);
    const payload: ReplyRerunEvent = { updateId, turnId, ageMs: d.ageMs };
    await deps.events.emit(REPLY_RERUN_EVENT, payload, turnId);
    rerunIds.push(updateId);
  }
  return rerunIds;
};

/**
 * One full reconcile pass at `now`: ledger.reconcile → alarms → recovery.
 * Never throws — a failure is `incident.reconcile_failed` and an empty outcome.
 */
export const runReconcile = async (deps: RecoverLostDeps, now: number): Promise<RecoveryOutcome> => {
  try {
    const discrepancies = await deps.ledger.reconcile(now);
    const rerunUpdateIds = await recoverLost(deps, discrepancies);
    return { discrepancies, rerunUpdateIds };
  } catch (e) {
    try {
      await deps.events.emit(RECONCILE_INCIDENT, { error: asErrorMessage(e) });
    } catch {
      // L0 unwritable: M02 already cried to stderr; the next pass tries again.
    }
    return { discrepancies: [], rerunUpdateIds: [] };
  }
};

/** The 5-min reconcile job: maintenance lane, catchUp skip (a missed pass is subsumed by the next one). */
export const reconcileJob = (deps: RecoverLostDeps): Job => ({
  name: 'reconcile',
  cadence: { kind: 'every', ms: RECONCILE_EVERY_MS },
  lane: 'maintenance',
  catchUp: 'skip',
  timeoutMs: MAINTENANCE_TIMEOUT_MS,
  run: async (ctx) => {
    await runReconcile(deps, ctx.clock.epochMs());
  },
});

export interface AffectSnapshotJobDeps {
  affect: Pick<AffectStore, 'snapshot'>;
}

/**
 * The 15-min affect snapshot: ticks decay to now, persists state.json and
 * lands `affect.snapshot` on L0 (crash recovery's replay copy). Not a semantic
 * write — M05's single-writer law holds; this only advances time.
 */
export const affectSnapshotJob = (deps: AffectSnapshotJobDeps): Job => ({
  name: 'affect-snapshot',
  cadence: { kind: 'every', ms: AFFECT_SNAPSHOT_EVERY_MS },
  lane: 'maintenance',
  catchUp: 'skip',
  timeoutMs: MAINTENANCE_TIMEOUT_MS,
  run: async (ctx) => {
    try {
      await deps.affect.snapshot();
    } catch (e) {
      try {
        await ctx.events.emit(AFFECT_SNAPSHOT_INCIDENT, { error: asErrorMessage(e) });
      } catch {
        // L0 unwritable: the next slot tries again.
      }
    }
  },
});

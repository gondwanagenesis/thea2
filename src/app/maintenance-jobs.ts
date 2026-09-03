// M20 app — the two maintenance jobs the architecture promised and prod never
// registered (Phase 1, 2026-09-02): `reconcile` every 5 min (ADR-003) and
// `affect-snapshot` every 15 min (ARCHITECTURE job table). Both are thin M16
// bodies over interfaces other modules own; the one piece of policy that lives
// HERE is lost-reply RECOVERY — what to do with a LOST_REPLY beyond alarming.
//
// Recovery law (P-CLOSE CL.2/CL.3 — every loss terminates):
//   younger than `graceMs`, pipeline idle, chat quiet, first sighting → the
//     loss is re-run through the pipeline exactly once per process (an
//     in-memory set of update ids — a second loss of the same message is
//     alarmed, never looped);
//   already re-run once → nothing (it stays owed; the alarm ladder escalates);
//   ageMs ≥ graceMs → terminal `abandoned {reason:'grace'}` row (alarmed, never
//     re-run — answering a question from three hours ago as if it just arrived
//     is worse than the alarm);
//   pipeline busy → deferred to the next pass (the loss may BE that turn);
//   newer inbound/outbound on the same chat → terminal `abandoned
//     {reason:'moved-on'}` row, and the text is pushed into the window's
//     pending span so [EARLIER] carries it.
// The boot reconcile in thead.ts and the 5-min job share this helper and the
// same set, so a boot re-run is not repeated by the job.
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

/**
 * The window seam recovery needs (P-CLOSE CL.3): the abandoned text lands in
 * the pending span — the [EARLIER] feedstock — never in the live window.
 */
export interface LostTextSink {
  pushPending(msg: { role: 'user'; content: string; ts: number; turnId: string }): Promise<void>;
}

export interface RecoverLostDeps {
  ledger: Pick<MessageLedger, 'reconcile' | 'linkTurn' | 'abandon' | 'markAlarmed' | 'alarmDue' | 'chatMovedOn'>;
  events: EventLog;
  /** `inbound` re-enqueues; `isBusy` defers a re-run while a turn is in flight (the loss may BE that turn). */
  pipeline: Pick<Pipeline, 'inbound' | 'isBusy'>;
  /** Receives a moved-on loss's text so [EARLIER] can carry it (M09 window pending). */
  window?: LostTextSink | undefined;
  /** Losses younger than this are re-run; default 60 min (D.6-6). */
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
 * The recovery half, given a discrepancy list and the pass's `now`: alarm every
 * LOST_REPLY the ladder says is due (M15's emitter, ledger-backed), then
 * re-run / terminate the young ones per the recovery law above. Pure over its
 * inputs beyond the ledger rows and the pipeline enqueue; no clock — ages ride
 * the discrepancy.
 */
export const recoverLost = async (deps: RecoverLostDeps, discrepancies: readonly Discrepancy[], now: number): Promise<number[]> => {
  await emitLostReplyAlarms(deps.events, discrepancies, deps.ledger);
  const graceMs = deps.graceMs ?? DEFAULT_RERUN_GRACE_MS;
  const rerunIds: number[] = [];
  for (const d of discrepancies) {
    if (d.kind !== 'LOST_REPLY') continue;
    const updateId = d.inbound.updateId;
    // Already re-run once: it stays owed — the alarm ladder (1h/6h/24h) speaks
    // for it now, and re-running again could answer him twice.
    if (deps.rerun.has(updateId)) continue;
    if (d.ageMs >= graceMs) {
      // Too old: alarmed above, never re-run — and TERMINAL (P-CLOSE CL.2):
      // the abandon row closes the invariant so the heartbeat is never
      // `owed`-gated by a loss that will not be answered.
      await deps.ledger.abandon(updateId, 'grace');
      continue;
    }
    // A turn in flight may be the very turn reconcile is counting as lost
    // (slow model past T): re-running now would answer him twice. The next
    // pass (5 min) re-runs it if it is still owed.
    if (deps.pipeline.isBusy()) continue;
    if (await deps.ledger.chatMovedOn(d.inbound.chatId, now - d.ageMs, updateId)) {
      // The conversation moved on (P-CLOSE CL.3): re-running would answer a
      // question nobody is asking anymore. The loss terminates as `moved-on`
      // and its text still reaches her through the [EARLIER] span.
      await deps.ledger.abandon(updateId, 'moved-on');
      if (deps.window !== undefined && d.inbound.text !== '') {
        await deps.window.pushPending({
          role: 'user',
          content: d.inbound.text,
          ts: d.inbound.ts,
          turnId: d.turnId ?? `lost-${updateId}`,
        });
      }
      continue;
    }
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
    const rerunUpdateIds = await recoverLost(deps, discrepancies, now);
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

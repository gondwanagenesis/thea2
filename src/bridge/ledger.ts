// M15 bridge — the MessageLedger: durable daily-rotated JSONL under var/ledger/.
//
// This is NOT the L0 event log (M02). The event log is the analytical record;
// the ledger is the delivery-correctness store, and reconcile is the invariant
// that replaced Thea1's sentinel: every inbound terminates within T minutes in
// an outbound or a recorded decision, or it becomes a LOST_REPLY alarm. Silence
// by design is a typed row in here; silence by failure is a discrepancy.

import { fail, type Clock, type JsonlStore, openJsonl } from '../kernel/index.js';
import type { EventLog } from '../events/index.js';
import {
  DEFAULT_RECONCILE_WINDOW_MS,
  type DecidedBy,
  type DecisionPlan,
  type Discrepancy,
  type InboundMsg,
  type LedgerRow,
  type LostReplyEvent,
  type MessageLedger,
} from './types.js';

export interface OpenMessageLedgerDeps {
  clock: Clock;
  /** Reconciliation window T (spec default 10 min). Must sit above worst-case deliberation + delivery, or she gets false alarms. */
  reconcileWindowMs?: number | undefined;
}

export const openMessageLedger = (dir: string, deps: OpenMessageLedgerDeps): MessageLedger => {
  const windowMs = deps.reconcileWindowMs ?? DEFAULT_RECONCILE_WINDOW_MS;
  const store = openJsonl<LedgerRow>(dir, 'messages', { rotateDailyUtc: true, clock: deps.clock });

  // Dedupe state, loaded once from disk and maintained incrementally. One
  // openMessageLedger per dir per process (M20 owns composition); a fresh open
  // re-reads everything, which is exactly the crash-restart path.
  let seen: Set<number> | undefined;
  const loadSeen = async (): Promise<Set<number>> => {
    if (seen !== undefined) return seen;
    const s = new Set<number>();
    for await (const row of store.read()) if (row.kind === 'inbound') s.add(row.msg.updateId);
    seen = s;
    return s;
  };

  return {
    recordInbound: async (m) => {
      const s = await loadSeen();
      const duplicate = s.has(m.updateId);
      if (!duplicate) s.add(m.updateId);
      // Every arrival is recorded, duplicates included: reconcile's
      // DUPLICATE_INBOUND verdict is read off these rows, and a redelivery that
      // left no trace would be Thea1's invisible-loss disease all over again.
      await store.append({ kind: 'inbound', ts: deps.clock.epochMs(), msg: m });
      return !duplicate;
    },

    recordDecision: async (turnId, d) => {
      if (d.turnId !== turnId) {
        fail('bridge/decision-mismatch', `recordDecision('${turnId}') was given a summary for '${d.turnId}'`);
      }
      if (d.plan === 'defer' && d.dueBy === undefined) {
        // A defer without a due-by would never come due — a permanent, quiet
        // escape from the reconciliation invariant. ADR-003 requires the bookkeeping.
        fail('bridge/decision-mismatch', `turn '${turnId}': plan 'defer' requires dueBy`);
      }
      await store.append({
        kind: 'decision',
        ts: deps.clock.epochMs(),
        turnId,
        plan: d.plan,
        at: d.at,
        ...(d.dueBy !== undefined ? { dueBy: d.dueBy } : {}),
        ...(d.decidedBy !== undefined ? { decidedBy: d.decidedBy } : {}),
      });
    },

    recordOutbound: async (turnId, msgId, text) => {
      await store.append({ kind: 'outbound', ts: deps.clock.epochMs(), turnId, msgId, text });
    },

    linkTurn: async (updateId, turnId) => {
      await store.append({ kind: 'link', ts: deps.clock.epochMs(), updateId, turnId });
    },

    reconcile: (now) => reconcileRows(store, now, windowMs),

    read: () => store.read(),
  };
};

// ---------------------------------------------------------------------------
// Reconciliation — a pure read; every inbound gets exactly one verdict
// ---------------------------------------------------------------------------

interface Arrival {
  msg: InboundMsg;
  ts: number; // earliest arrival — age runs from when she was first told
  count: number;
}

const reconcileRows = async (store: JsonlStore<LedgerRow>, now: number, windowMs: number): Promise<Discrepancy[]> => {
  const links = new Map<number, string>();
  const replied = new Set<string>(); // turnIds with ≥1 recorded outbound
  const decisions = new Map<string, { plan: DecisionPlan; dueBy?: number; decidedBy?: DecidedBy }>(); // last decision wins
  const arrivals = new Map<number, Arrival>();

  for await (const row of store.read()) {
    switch (row.kind) {
      case 'link':
        links.set(row.updateId, row.turnId);
        break;
      case 'outbound':
        replied.add(row.turnId);
        break;
      case 'decision':
        decisions.set(row.turnId, {
          plan: row.plan,
          ...(row.dueBy !== undefined ? { dueBy: row.dueBy } : {}),
          ...(row.decidedBy !== undefined ? { decidedBy: row.decidedBy } : {}),
        });
        break;
      case 'inbound': {
        const prev = arrivals.get(row.msg.updateId);
        arrivals.set(
          row.msg.updateId,
          prev === undefined
            ? { msg: row.msg, ts: row.ts, count: 1 }
            : { msg: prev.ts <= row.ts ? prev.msg : row.msg, ts: Math.min(prev.ts, row.ts), count: prev.count + 1 },
        );
        break;
      }
    }
  }

  const lost: Discrepancy[] = [];
  const duplicates: Discrepancy[] = [];
  const ordered = [...arrivals.entries()].sort((a, b) => a[1].ts - b[1].ts || a[0] - b[0]);
  for (const [updateId, arrival] of ordered) {
    if (arrival.count > 1) duplicates.push({ kind: 'DUPLICATE_INBOUND', updateId });
    // A reaction is an outcome signal, not a request — it can never be "lost".
    if (arrival.msg.reaction !== undefined) continue;
    // A skipped update (photo, edit, denied chat) was recorded only so the
    // offset could move past it — nothing is owed.
    if (arrival.msg.skipped !== undefined) continue;

    const ageMs = now - arrival.ts;
    if (ageMs <= windowMs) continue; // still inside T — her turn to terminate

    const turnId = links.get(updateId);
    if (turnId !== undefined) {
      if (replied.has(turnId)) continue; // replied ⇒ clean
      const d = decisions.get(turnId);
      if (d !== undefined) {
        // Decided-silent ⇒ clean — unless the "decision" was the loop failing
        // to decide. A failure silence is the sentinel disease in a typed row;
        // it stays owed (ADR-003: silence by failure is a discrepancy).
        if (d.plan === 'silent' && d.decidedBy !== 'failure') continue;
        // A defer past its due-by with nothing to show is exactly the loss the
        // invariant exists to catch. A dueBy-less defer cannot happen (the
        // writer rejects it); if one ever lands, treat it as already due.
        if (d.plan === 'defer' && (d.dueBy ?? now) > now) continue;
      }
    }
    lost.push({ kind: 'LOST_REPLY', inbound: arrival.msg, ageMs, ...(turnId !== undefined ? { turnId } : {}) });
  }
  return [...lost, ...duplicates];
};

// ---------------------------------------------------------------------------
// L0 wiring — M16's reconcile job calls this after reconcile(now)
// ---------------------------------------------------------------------------

/** Emits the alarm half of the discrepancy list. Duplicates are informational and stay out of L0. */
export const emitLostReplyAlarms = async (log: EventLog, discrepancies: readonly Discrepancy[]): Promise<void> => {
  for (const d of discrepancies) {
    if (d.kind !== 'LOST_REPLY') continue;
    const payload: LostReplyEvent = {
      updateId: d.inbound.updateId,
      chatId: d.inbound.chatId,
      ageMs: d.ageMs,
      ...(d.turnId !== undefined ? { turnId: d.turnId } : {}),
    };
    try {
      await log.emit('bridge.lost_reply', payload, d.turnId);
    } catch {
      // L0 unwritable ⇒ advisory (M20's policy, same as model.call): M02 already
      // retried once and reported to stderr. The discrepancy itself is not lost —
      // the caller got it back from reconcile().
    }
  }
};

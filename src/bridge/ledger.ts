// M15 bridge — the MessageLedger: durable daily-rotated JSONL under var/ledger/.
//
// This is NOT the L0 event log (M02). The event log is the analytical record;
// the ledger is the delivery-correctness store, and reconcile is the invariant
// that replaced Thea1's sentinel: every inbound terminates within T minutes in
// an outbound or a recorded decision — or an `abandoned` row (P-CLOSE CL.2) —
// or it becomes a LOST_REPLY alarm. Silence by design is a typed row in here;
// silence by failure is a discrepancy.
//
// Reconcile is a FOLD (P-CLOSE CL.7): the first pass replays the ledger once
// and persists the projection (open arrivals + per-chat activity + alarm
// ladder state + last file/offset) to var/ledger/reconcile-state.json; every
// later pass replays only the tail. The verdict code is shared verbatim with
// `reconcileLedgerRows`, the pure whole-history read the doctor uses.

import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { atomicWriteJson, fail, type Clock, openJsonl } from '../kernel/index.js';
import type { EventLog } from '../events/index.js';
import {
  DEFAULT_RECONCILE_WINDOW_MS,
  escalationForAge,
  escalationOutranks,
  type AbandonReason,
  type DecidedBy,
  type DecisionPlan,
  type Discrepancy,
  type EscalationLevel,
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

/** The on-disk fold: open arrivals + the cursor of what has been consumed. */
interface ReconcileSnapshot {
  version: 1;
  /** Rows already folded across all ledger files, in file-date order — the tail read starts here. */
  consumedRows: number;
  /** Newest ledger file the fold consumed — a missing file means the history was pruned and the fold is stale. */
  lastFile: string | null;
  arrivals: FoldArrival[];
  turnChat: Array<[string, number]>;
  chatInboundTop: Array<[number, Array<{ ts: number; updateId: number }>]>;
  chatOutboundLast: Array<[number, number]>;
}

/** An arrival the fold still carries: open losses, defer-future, and every redelivered (count > 1) update. */
interface FoldArrival {
  msg: InboundMsg;
  ts: number; // earliest arrival — age runs from when she was first told
  count: number;
  turnId?: string | undefined;
  turnReplied?: boolean | undefined;
  decision?: { plan: DecisionPlan; dueBy?: number | undefined; decidedBy?: DecidedBy | undefined } | undefined;
  abandoned?: AbandonReason | undefined;
  /** The last escalation rung actually emitted — the alarm-once-then-escalate state. */
  lastEscalation?: EscalationLevel | undefined;
}

interface Fold {
  arrivals: Map<number, FoldArrival>;
  /** turnId → chatId, for attributing outbounds to chats (link rows carry it). */
  turnChat: Map<string, number>;
  /** The TWO newest inbound rows per chat, by updateId — the moved-on check must never count the loss's own redeliveries. */
  chatInboundTop: Map<number, Array<{ ts: number; updateId: number }>>;
  /** Last outbound ts per chat (attributed through link rows). */
  chatOutboundLast: Map<number, number>;
  consumedRows: number;
}

const newFold = (): Fold => ({
  arrivals: new Map(),
  turnChat: new Map(),
  chatInboundTop: new Map(),
  chatOutboundLast: new Map(),
  consumedRows: 0,
});

const applyRow = (fold: Fold, row: LedgerRow): void => {
  switch (row.kind) {
    case 'link': {
      const a = fold.arrivals.get(row.updateId);
      if (a !== undefined) {
        a.turnId = row.turnId;
        fold.turnChat.set(row.turnId, a.msg.chatId);
      }
      break;
    }
    case 'outbound': {
      for (const a of fold.arrivals.values()) if (a.turnId === row.turnId) a.turnReplied = true;
      const chatId = fold.turnChat.get(row.turnId);
      if (chatId !== undefined) {
        fold.chatOutboundLast.set(chatId, Math.max(fold.chatOutboundLast.get(chatId) ?? 0, row.ts));
      }
      break;
    }
    case 'decision': {
      for (const a of fold.arrivals.values()) {
        if (a.turnId === row.turnId) {
          a.decision = {
            plan: row.plan,
            ...(row.dueBy !== undefined ? { dueBy: row.dueBy } : {}),
            ...(row.decidedBy !== undefined ? { decidedBy: row.decidedBy } : {}),
          };
        }
      }
      break;
    }
    case 'abandoned': {
      const a = fold.arrivals.get(row.updateId);
      if (a !== undefined) a.abandoned = row.reason;
      break;
    }
    case 'inbound': {
      const prev = fold.arrivals.get(row.msg.updateId);
      fold.arrivals.set(
        row.msg.updateId,
        prev === undefined
          ? { msg: row.msg, ts: row.ts, count: 1 }
          : { ...prev, msg: prev.ts <= row.ts ? prev.msg : row.msg, ts: Math.min(prev.ts, row.ts), count: prev.count + 1 },
      );
      // A skipped arrival (photo, edit, denied chat) is wire noise, not chat activity.
      if (row.msg.skipped === undefined) {
        const top = fold.chatInboundTop.get(row.msg.chatId) ?? [];
        top.push({ ts: row.ts, updateId: row.msg.updateId });
        top.sort((x, y) => y.ts - x.ts);
        fold.chatInboundTop.set(row.msg.chatId, top.slice(0, 2));
      }
      break;
    }
  }
};

/** The verdict table over a fold — shared by the incremental ledger and the doctor's pure read. */
const verdictsOf = (fold: Fold, now: number, windowMs: number): Discrepancy[] => {
  const lost: Discrepancy[] = [];
  const duplicates: Discrepancy[] = [];
  const ordered = [...fold.arrivals.entries()].sort((a, b) => a[1].ts - b[1].ts || a[0] - b[0]);
  for (const [updateId, arrival] of ordered) {
    if (arrival.count > 1) duplicates.push({ kind: 'DUPLICATE_INBOUND', updateId });
    // A reaction is an outcome signal, not a request — it can never be "lost".
    if (arrival.msg.reaction !== undefined) continue;
    // A skipped update (photo, edit, denied chat) was recorded only so the
    // offset could move past it — nothing is owed.
    if (arrival.msg.skipped !== undefined) continue;
    // A recorded abandon is the loss's terminal outcome (P-CLOSE CL.2) —
    // the invariant stops owing it, forever.
    if (arrival.abandoned !== undefined) continue;

    const ageMs = now - arrival.ts;
    if (ageMs <= windowMs) continue; // still inside T — her turn to terminate

    if (arrival.turnId !== undefined) {
      if (arrival.turnReplied) continue; // replied ⇒ clean
      const d = arrival.decision;
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
    lost.push({ kind: 'LOST_REPLY', inbound: arrival.msg, ageMs, ...(arrival.turnId !== undefined ? { turnId: arrival.turnId } : {}) });
  }
  return [...lost, ...duplicates];
};

/**
 * Drops what the fold never needs again: unconditionally-terminated single
 * arrivals (replied, decided-silent-by-restraint, abandoned, reactions,
 * skips). Redelivered arrivals and defer-future arrivals stay — the first
 * still reports its DUPLICATE verdict, the second may still become a loss.
 */
const pruneFold = (fold: Fold): void => {
  for (const [updateId, a] of fold.arrivals) {
    const done =
      a.count === 1 &&
      (a.msg.reaction !== undefined ||
        a.msg.skipped !== undefined ||
        a.abandoned !== undefined ||
        a.turnReplied === true ||
        (a.decision !== undefined && a.decision.plan === 'silent' && a.decision.decidedBy !== 'failure'));
    if (done) {
      fold.arrivals.delete(updateId);
      if (a.turnId !== undefined) fold.turnChat.delete(a.turnId);
    }
  }
};

export const openMessageLedger = (dir: string, deps: OpenMessageLedgerDeps): MessageLedger => {
  const windowMs = deps.reconcileWindowMs ?? DEFAULT_RECONCILE_WINDOW_MS;
  const store = openJsonl<LedgerRow>(dir, 'messages', { rotateDailyUtc: true, clock: deps.clock });
  const snapshotPath = path.join(dir, 'reconcile-state.json');

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

  // -- the reconcile fold (P-CLOSE CL.7) -----------------------------------
  let fold: Fold | undefined;
  /** Rows the last `reconcile` actually replayed — the initial full pass included. */
  let lastReplayedRows = 0;

  const replayAll = async (f: Fold): Promise<number> => {
    let n = 0;
    for await (const row of store.read()) {
      applyRow(f, row);
      f.consumedRows += 1;
      n += 1;
    }
    return n;
  };

  const loadFold = async (): Promise<Fold> => {
    const f = newFold();
    let text: string | undefined;
    try {
      text = await fsp.readFile(snapshotPath, 'utf8');
    } catch {
      text = undefined; // absent snapshot: the full replay IS the fold's first pass
    }
    if (text === undefined) {
      lastReplayedRows = await replayAll(f);
      return f;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch (e) {
      return fail('bridge/reconcile-state-corrupt', `${snapshotPath} is not valid JSON`, e);
    }
    const s = parsed as ReconcileSnapshot | null;
    if (
      typeof s !== 'object' ||
      s === null ||
      s.version !== 1 ||
      typeof s.consumedRows !== 'number' ||
      !Array.isArray(s.arrivals) ||
      !Array.isArray(s.turnChat) ||
      !Array.isArray(s.chatInboundTop) ||
      !Array.isArray(s.chatOutboundLast)
    ) {
      return fail('bridge/reconcile-state-corrupt', `${snapshotPath} is not a version-1 reconcile fold`);
    }
    const files = store.files().map((p) => path.basename(p));
    if (s.lastFile !== null && !files.includes(s.lastFile)) {
      // The history the fold was built from is gone (pruned): fall back to the
      // full replay — correct, just not tail-fast.
      lastReplayedRows = await replayAll(f);
      return f;
    }
    f.consumedRows = s.consumedRows;
    for (const a of s.arrivals) f.arrivals.set(a.msg.updateId, a);
    for (const [k, v] of s.turnChat) f.turnChat.set(k, v);
    for (const [k, v] of s.chatInboundTop) f.chatInboundTop.set(k, v);
    for (const [k, v] of s.chatOutboundLast) f.chatOutboundLast.set(k, v);
    lastReplayedRows = 0; // the fold came from the snapshot: nothing was replayed
    return f;
  };

  const ensureFold = async (): Promise<Fold> => {
    if (fold === undefined) fold = await loadFold();
    return fold;
  };

  let snapshotWrites: Promise<void> = Promise.resolve();

  const persistSnapshot = (f: Fold): Promise<void> => {
    // Serialized like the window's write chain: a reconcile pass and a row
    // append can both close in the same tick, and on Windows the second of two
    // concurrent renames onto the same file is EPERM, not a retry.
    const run = snapshotWrites.then(() => writeSnapshot(f));
    snapshotWrites = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const writeSnapshot = async (f: Fold): Promise<void> => {
    const files = store.files();
    await atomicWriteJson(snapshotPath, {
      version: 1,
      consumedRows: f.consumedRows,
      lastFile: files.length > 0 ? path.basename(files[files.length - 1]!) : null,
      arrivals: [...f.arrivals.values()],
      turnChat: [...f.turnChat.entries()],
      chatInboundTop: [...f.chatInboundTop.entries()],
      chatOutboundLast: [...f.chatOutboundLast.entries()],
    } satisfies ReconcileSnapshot);
  };

  const appendAndFold = async (row: LedgerRow): Promise<void> => {
    await store.append(row);
    if (fold !== undefined) {
      applyRow(fold, row);
      fold.consumedRows += 1;
      await persistSnapshot(fold);
    }
  };

  return {
    recordInbound: async (m) => {
      const s = await loadSeen();
      const duplicate = s.has(m.updateId);
      if (!duplicate) s.add(m.updateId);
      // Every arrival is recorded, duplicates included: reconcile's
      // DUPLICATE_INBOUND verdict is read off these rows, and a redelivery that
      // left no trace would be Thea1's invisible-loss disease all over again.
      await appendAndFold({ kind: 'inbound', ts: deps.clock.epochMs(), msg: m });
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
      await appendAndFold({
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
      await appendAndFold({ kind: 'outbound', ts: deps.clock.epochMs(), turnId, msgId, text });
    },

    linkTurn: async (updateId, turnId) => {
      await appendAndFold({ kind: 'link', ts: deps.clock.epochMs(), updateId, turnId });
    },

    abandon: async (updateId, reason) => {
      await appendAndFold({ kind: 'abandoned', ts: deps.clock.epochMs(), updateId, reason });
      // A single-arrival abandon terminates the loss: prune it from the fold
      // now so verdictsOf never has to see it again.
      const f = fold;
      if (f !== undefined) {
        pruneFold(f);
        await persistSnapshot(f);
      }
    },

    alarmDue: async (updateId, ageMs) => {
      const f = await ensureFold();
      const level = escalationForAge(ageMs);
      const last = f.arrivals.get(updateId)?.lastEscalation;
      return { due: last === undefined || escalationOutranks(level, last), level };
    },

    markAlarmed: async (updateId, level) => {
      const f = fold;
      if (f === undefined) return; // no pass has run: nothing to persist yet
      const a = f.arrivals.get(updateId);
      if (a === undefined) return; // terminated between reconcile and emit
      a.lastEscalation = level;
      await persistSnapshot(f);
    },

    chatMovedOn: async (chatId, afterTs, excludeUpdateId) => {
      const f = await ensureFold();
      const top = f.chatInboundTop.get(chatId) ?? [];
      if (top.some((e) => e.updateId !== excludeUpdateId && e.ts > afterTs)) return true;
      const out = f.chatOutboundLast.get(chatId);
      return out !== undefined && out > afterTs;
    },

    reconcile: async (now) => {
      const f = await ensureFold(); // loads the fold (its replay is counted in lastReplayedRows)
      for await (const row of store.read({ since: f.consumedRows })) {
        applyRow(f, row);
        f.consumedRows += 1;
        lastReplayedRows += 1;
      }
      const out = verdictsOf(f, now, windowMs);
      pruneFold(f);
      await persistSnapshot(f);
      return out;
    },

    read: () => store.read(),

    lastReconcileReplayedRows: () => lastReplayedRows,
  };
};

// ---------------------------------------------------------------------------
// Pure whole-history reconcile — the doctor's read-only path (no fold, no
// snapshot write) and the equivalence reference for the incremental fold.
// ---------------------------------------------------------------------------

export const reconcileLedgerRows = async (
  rows: AsyncIterable<LedgerRow>,
  now: number,
  windowMs: number,
): Promise<Discrepancy[]> => {
  const fold = newFold();
  for await (const row of rows) applyRow(fold, row);
  return verdictsOf(fold, now, windowMs);
};

// ---------------------------------------------------------------------------
// L0 wiring — M16's reconcile job calls this after reconcile(now)
// ---------------------------------------------------------------------------

/**
 * Emits the alarm half of the discrepancy list — ONCE per updateId, then only
 * when the ledger's ladder says a rung is due (initial → 1 h → 6 h → 24 h,
 * P-CLOSE CL.2). `ledger` carries that state; without it (pure/diagnostic
 * callers) every loss is due. Duplicates are informational and stay out of L0.
 */
export const emitLostReplyAlarms = async (
  log: EventLog,
  discrepancies: readonly Discrepancy[],
  ledger?: Pick<MessageLedger, 'alarmDue' | 'markAlarmed'>,
): Promise<void> => {
  for (const d of discrepancies) {
    if (d.kind !== 'LOST_REPLY') continue;
    const due =
      ledger === undefined
        ? { due: true, level: escalationForAge(d.ageMs) }
        : await ledger.alarmDue(d.inbound.updateId, d.ageMs);
    if (!due.due) continue;
    const payload: LostReplyEvent = {
      updateId: d.inbound.updateId,
      chatId: d.inbound.chatId,
      ageMs: d.ageMs,
      escalation: due.level,
      ...(d.turnId !== undefined ? { turnId: d.turnId } : {}),
    };
    try {
      await log.emit('bridge.lost_reply', payload, d.turnId);
      await ledger?.markAlarmed(d.inbound.updateId, due.level);
    } catch {
      // L0 unwritable ⇒ advisory (M20's policy, same as model.call): M02 already
      // retried once and reported to stderr. The mark is NOT written, so the
      // next pass re-emits — an alarm is only spent when it was actually heard.
    }
  }
};

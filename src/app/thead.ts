// M20 app — the thead process: bridge poll → ingest (dedupe + offset) →
// pipeline, in one process with the scheduler (ADR-002). One process, one
// drain path: stop aborts the poll, settles the in-flight turn and every
// detached afterturn, then stops the scheduler. In-flight turns are DRAINED,
// never aborted, at shutdown — a half-said reply is worse than a late one.

import { ingestUpdates } from '../bridge/index.js';
import type { EventLog } from '../events/index.js';
import type { System } from './compose.js';

export interface TheadHandle {
  stop(): Promise<void>;
  /**
   * The system's L0 (P-CLOSE CL.5): main.ts reuses it for the
   * unhandled-rejection incident — a second opener beside this log would fork
   * the seq counter (the 2026-09-02 derive/thead lesson).
   */
  readonly events: EventLog;
}

export const startThead = (sys: System, opts: { signal?: AbortSignal | undefined } = {}): TheadHandle => {
  const ac = new AbortController();
  if (opts.signal !== undefined) {
    if (opts.signal.aborted) ac.abort();
    else opts.signal.addEventListener('abort', () => ac.abort(), { once: true });
  }

  // Boot reconcile: a crash before this boot may have left a lost reply —
  // alarm on L0 immediately, never silently, and RE-RUN the young ones (the
  // shared recovery in compose marks each rerun so the 5-min job won't repeat
  // it). Recovery honors the pipeline's busy state, so this cannot double-run
  // the turn that is only still in flight.
  void sys.reconcile();

  const poll = (async () => {
    for await (const m of sys.channel.updates(ac.signal)) {
      // A skipped update (photo, edit, reaction removal) is recorded so the
      // offset moves past it — an unrecorded skip re-polls forever — and it is
      // never owed a turn (reconcile reads the `skipped` stamp).
      if (m.skipped !== undefined) {
        void sys.events.emit('bridge.update_skipped', { updateId: m.updateId, chatId: m.chatId, reason: m.skipped.reason });
        await ingestUpdates({ ledger: sys.ledger, offsets: sys.offsets }, [m]);
        continue;
      }
      // Denied chats are not her responsibility, but they must not wedge the
      // poll either: recorded as a skip (never owed), announced on L0.
      if (!sys.cfg.bridge.allowedChatIds.includes(m.chatId)) {
        void sys.events.emit('app.chat_denied', { chatId: m.chatId, updateId: m.updateId });
        await ingestUpdates({ ledger: sys.ledger, offsets: sys.offsets }, [{ ...m, skipped: { reason: 'denied_chat' } }]);
        continue;
      }
      // handle returns the pre-minted turnId synchronously — the offset
      // commits after append+enqueue (M15's contract), the turn runs on the
      // pipeline's single-flight drain.
      await ingestUpdates(
        { ledger: sys.ledger, offsets: sys.offsets, handle: (mm) => sys.pipeline.inbound(mm) },
        [m],
      );
    }
  })();

  return {
    stop: async () => {
      ac.abort();
      await poll.catch(() => {
        /* abort unwinds the poll iterable — expected */
      });
      await sys.stop();
    },
    events: sys.events,
  };
};

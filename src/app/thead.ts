// M20 app — the thead process: bridge poll → ingest (dedupe + offset) →
// pipeline, in one process with the scheduler (ADR-002). One process, one
// drain path: stop aborts the poll, settles the in-flight turn and every
// detached afterturn, then stops the scheduler. In-flight turns are DRAINED,
// never aborted, at shutdown — a half-said reply is worse than a late one.

import { emitLostReplyAlarms, ingestUpdates } from '../bridge/index.js';
import type { System } from './compose.js';

export interface TheadHandle {
  stop(): Promise<void>;
}

export const startThead = (sys: System, opts: { signal?: AbortSignal | undefined } = {}): TheadHandle => {
  const ac = new AbortController();
  if (opts.signal !== undefined) {
    if (opts.signal.aborted) ac.abort();
    else opts.signal.addEventListener('abort', () => ac.abort(), { once: true });
  }

  // Boot reconcile: a crash before this boot may have left a lost reply —
  // alarm on L0 immediately, never silently.
  void (async () => {
    try {
      const discrepancies = await sys.ledger.reconcile(sys.clock.epochMs());
      await emitLostReplyAlarms(sys.events, discrepancies);
    } catch (e) {
      void sys.events.emit('incident.reconcile_failed', { error: String(e) });
    }
  })();

  const poll = (async () => {
    for await (const m of sys.channel.updates(ac.signal)) {
      // Denied chats never reach the ledger: an unallowed chat is not her
      // responsibility, and a ledger row here would alarm forever.
      if (!sys.cfg.bridge.allowedChatIds.includes(m.chatId)) {
        void sys.events.emit('app.chat_denied', { chatId: m.chatId, updateId: m.updateId });
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
  };
};

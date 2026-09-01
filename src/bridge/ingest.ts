// M15 bridge — the ingestion seam. This is where the module's whole delivery
// contract lives, in one loop:
//
//   ledger append (durable claim) → pipeline enqueue → offset commit
//
// A crash anywhere before the commit means Telegram still holds the update, so
// it is redelivered on restart; the ledger then flags it as a duplicate and it
// is dropped, not re-handled. That is what turns Thea1's crash-loss bug into a
// no-loss/no-dupe guarantee — and what makes the offset-after-append ordering
// non-negotiable.

import type { InboundMsg, MessageLedger } from './types.js';
import type { OffsetStore } from './offsets.js';

export interface IngestDeps {
  ledger: MessageLedger;
  offsets: OffsetStore;
  /**
   * The pipeline enqueue (M20 wires it). May return the turnId the inbound was
   * enqueued under — the ingest then persists the inbound→turn link so
   * reconcile can name the turn that was lost instead of just the message.
   */
  handle?: ((m: InboundMsg) => string | undefined | Promise<string | undefined>) | undefined;
}

export type IngestVerdict = 'handled' | 'duplicate';

export interface IngestedUpdate {
  updateId: number;
  verdict: IngestVerdict;
  turnId?: string | undefined;
}

/**
 * Runs one fetched batch through the seam. Batches are processed in update_id
 * order regardless of arrival order — the cursor math assumes monotonicity.
 *
 * Failure policy: a throwing handler propagates. The row is already appended
 * (the claim is durable) and the offset has not moved, so a redelivery arrives
 * deduped and the turn surfaces as LOST_REPLY at the next reconcile — loud,
 * never silent.
 */
export const ingestUpdates = async (deps: IngestDeps, updates: readonly InboundMsg[]): Promise<IngestedUpdate[]> => {
  const ordered = [...updates].sort((a, b) => a.updateId - b.updateId);
  const out: IngestedUpdate[] = [];
  let state = await deps.offsets.read();

  for (const m of ordered) {
    // The append is the claim: it lands before the handler runs, so even a
    // crash mid-turn leaves the message marked seen for the next redelivery.
    const isNew = await deps.ledger.recordInbound(m);

    let turnId: string | undefined;
    if (isNew) {
      const linked = deps.handle === undefined ? undefined : await deps.handle(m);
      if (linked !== undefined) {
        await deps.ledger.linkTurn(m.updateId, linked);
        turnId = linked;
      }
    }

    // The offset moves LAST, and only forward — never before append + enqueue.
    if (m.updateId > state.committed) {
      state = { committed: m.updateId };
      await deps.offsets.write(state);
    }

    out.push({
      updateId: m.updateId,
      verdict: isNew ? 'handled' : 'duplicate',
      ...(turnId !== undefined ? { turnId } : {}),
    });
  }
  return out;
};

// M15 bridge — the durable poll cursor.
//
// Telegram confirms an update only when a later getUpdates request moves past
// it, so `committed` is what makes redelivery happen after a crash — and what
// must never move before the ledger append plus the pipeline enqueue (ingest.ts
// owns that ordering). It lives next to the ledger because it is the same
// delivery-correctness concern, not because they share a writer.

import * as fsp from 'node:fs/promises';
import { atomicWriteJson, fail } from '../kernel/index.js';

export interface OffsetState {
  /** Highest update_id whose append + enqueue both completed. 0 = nothing ever committed. */
  committed: number;
}

export const INITIAL_OFFSETS: OffsetState = { committed: 0 };

export interface OffsetStore {
  read(): Promise<OffsetState>;
  write(next: OffsetState): Promise<void>;
}

export interface OffsetStoreOpts {
  /** Called when the cursor file exists but cannot be parsed. */
  onCorrupt?: ((e: unknown) => void) | undefined;
}

export const openOffsetStore = (file: string, opts: OffsetStoreOpts = {}): OffsetStore => {
  let cache: OffsetState | undefined;

  const read = async (): Promise<OffsetState> => {
    if (cache !== undefined) return cache;
    let text: string | undefined;
    try {
      text = await fsp.readFile(file, 'utf8');
    } catch {
      return INITIAL_OFFSETS; // no file = first boot; leave uncached so a later write re-checks
    }
    try {
      const parsed = JSON.parse(text) as Partial<OffsetState>;
      const committed = parsed.committed;
      cache = { committed: typeof committed === 'number' && Number.isInteger(committed) ? committed : 0 };
      return cache;
    } catch (e) {
      // A corrupt cursor resets to 0 instead of failing boot: 0 makes Telegram
      // redeliver everything, and the ledger dedupes. Recovery points in the
      // safe direction here — refusing to boot would not.
      opts.onCorrupt?.(e);
      return INITIAL_OFFSETS;
    }
  };

  return {
    read,

    write: async (next) => {
      const current = await read();
      if (next.committed < current.committed) {
        // A backwards cursor re-delivers updates the system already handled —
        // the ledger dedupes them, but it also means some caller is confused
        // about what was committed. Loud, always.
        fail('bridge/offset-regress', `committed cursor cannot move ${current.committed} → ${next.committed}`);
      }
      cache = next;
      await atomicWriteJson(file, next);
    },
  };
};

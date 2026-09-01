// M09 memory — the thread index: the in-memory fold of every appraisal's
// ThreadUpdates, and the second input to the threads.json projection. Deliberately
// NOT persisted here (ARCHITECTURE's var/ table sanctions no extra memory file,
// and threads.json is write-only — nothing may read it back): the pipeline holds
// the index for the process lifetime and rebuilds history from episodes.

import type { ThreadUpdate } from './appraisal.js';

export type ThreadStatus = 'open' | 'touched' | 'closed';

export interface ThreadState {
  id: string;
  /** Last title seen; a title-less update keeps the previous one. */
  title?: string | undefined;
  status: ThreadStatus;
  /** epochMs of the most recent update that landed on this thread. */
  updatedAt: number;
  /** How many appraisal updates have touched this thread. */
  updates: number;
}

export interface ThreadIndex {
  /** Fold one appraisal's thread updates, stamped at `ts`. */
  apply(updates: readonly ThreadUpdate[], ts: number): void;
  get(id: string): ThreadState | undefined;
  /** All threads, id ascending — the deterministic order the projection writes. */
  all(): ThreadState[];
  size(): number;
}

export const openThreadIndex = (): ThreadIndex => {
  const byId = new Map<string, ThreadState>();
  return {
    apply: (updates, ts) => {
      for (const u of updates) {
        const prev = byId.get(u.id);
        const title = u.title ?? prev?.title;
        byId.set(u.id, {
          id: u.id,
          ...(title !== undefined ? { title } : {}),
          status: u.status,
          updatedAt: ts,
          updates: (prev?.updates ?? 0) + 1,
        });
      }
    },
    get: (id) => byId.get(id),
    all: () => [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    size: () => byId.size,
  };
};

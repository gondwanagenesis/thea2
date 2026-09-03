// M09 memory — the thread index: the fold of every appraisal's ThreadUpdates,
// and the second input to the threads.json projection.
//
// Round 2 (2026-09-02): the fold became DURABLE. The S3 build kept it
// in-memory because ARCHITECTURE's var/ table sanctioned no extra memory file;
// the remediation plan sanctions one now — {dir}/threads.jsonl, one row per
// applied batch, carrying id + title + STATUS (the episode rows keep only the
// ids they touched, which is not enough to rebuild titles/statuses). The
// pipeline holds the index for the process lifetime; a fresh open replays the
// log, so a thread he opened survives the restart and comes due for a later
// heartbeat. threads.json (the projection) stays write-only: nothing reads it
// back — the JSONL log is the record of truth.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import type { ThreadUpdate } from './appraisal.js';
import { ThreadUpdateSchema } from './appraisal.js';
import { failMemory } from './errors.js';

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

/**
 * How long a non-closed thread stays quiet before it is DUE again — the
 * heartbeat's follow-up queue (`dueThreads`). Six hours: a thread he opened in
 * the morning resurfaces by tonight. Proposed constant (the spec leaves the
 * horizon open); touching a thread re-arms it, closing it retires it forever.
 */
export const THREAD_DUE_MS = 6 * 3_600_000;

export interface ThreadIndex {
  /** Fold one appraisal's thread updates, stamped at `ts`. */
  apply(updates: readonly ThreadUpdate[], ts: number): void;
  get(id: string): ThreadState | undefined;
  /** All threads, id ascending — the deterministic order the projection writes. */
  all(): ThreadState[];
  size(): number;
  /**
   * Open/touched threads whose follow-up is due: `updatedAt + THREAD_DUE_MS <=
   * now`, id ascending. Closed threads never come due, and a touched thread's
   * clock restarts from the touch — the fold already knows both.
   */
  dueThreads(now: number): ThreadState[];
}

const idAsc = (a: ThreadState, b: ThreadState): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** The shared fold. `due` is derived state — a pure function of updatedAt + status —
 * so persistence never has to store it. */
const fold = (): ThreadIndex & { dueThreads(now: number): ThreadState[] } => {
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
    all: () => [...byId.values()].sort(idAsc),
    size: () => byId.size,
    dueThreads: (now) =>
      [...byId.values()]
        .filter((t) => t.status !== 'closed' && t.updatedAt + THREAD_DUE_MS <= now)
        .sort(idAsc),
  };
};

export const openThreadIndex = (): ThreadIndex => fold();

// ---------------------------------------------------------------------------
// The durable index — {dir}/threads.jsonl, one row per applied batch
// ---------------------------------------------------------------------------

export const THREADS_LOG_FILE = 'threads.jsonl';

const ThreadLogRowSchema = z.object({
  version: z.literal(1),
  ts: z.number(),
  updates: z.array(ThreadUpdateSchema),
});

/** One applied batch, exactly as `apply` received it. */
export interface ThreadLogRow {
  version: 1;
  ts: number;
  updates: ThreadUpdate[];
}

export interface PersistedThreadIndex extends ThreadIndex {
  /** Log lines skipped at boot (unparseable or failing the row schema) — the
   * log grows past them; a corrupt line never fails memory at boot. */
  skippedRows(): number;
}

/**
 * Opens the durable thread index: replays {dir}/threads.jsonl into the fold,
 * then appends one row per applied batch (synchronously — the fold is the
 * pipeline's synchronous read, and a row that is not on disk when `apply`
 * returns is a row a crash would take with it). A failed append is a typed
 * throw, never a silent drop.
 */
export const openPersistedThreadIndex = (dir: string): PersistedThreadIndex => {
  const logPath = path.join(dir, THREADS_LOG_FILE);
  const state = fold();
  let skipped = 0;

  if (fs.existsSync(logPath)) {
    const lines = fs.readFileSync(logPath, 'utf8').split('\n');
    for (const line of lines) {
      if (line.trim() === '') continue;
      let raw: unknown;
      try {
        raw = JSON.parse(line) as unknown;
      } catch {
        skipped += 1;
        continue;
      }
      const parsed = ThreadLogRowSchema.safeParse(raw);
      if (!parsed.success) {
        skipped += 1;
        continue;
      }
      state.apply(parsed.data.updates, parsed.data.ts);
    }
  }

  return {
    apply: (updates, ts) => {
      if (updates.length === 0) {
        state.apply(updates, ts); // a no-op fold; nothing worth a log row
        return;
      }
      const row: ThreadLogRow = { version: 1, ts, updates: updates.map((u) => ({ ...u })) };
      try {
        fs.mkdirSync(dir, { recursive: true });
        fs.appendFileSync(logPath, `${JSON.stringify(row)}\n`, 'utf8');
      } catch (e) {
        failMemory('memory/threads-log', `thread log append failed (${logPath}): ${(e as Error).message}`, e);
      }
      state.apply(row.updates, ts); // the fold moves only once the row is durable
    },
    get: state.get,
    all: state.all,
    size: state.size,
    dueThreads: state.dueThreads,
    skippedRows: () => skipped,
  };
};

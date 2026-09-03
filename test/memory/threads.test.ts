// test/memory — the thread index: the fold of appraisal thread updates (and the
// second input to threads.json). Round 2: the fold is also DURABLE —
// openPersistedThreadIndex replays {dir}/threads.jsonl at boot and appends every
// applied batch, so a thread he opened survives the restart and comes due for a
// later heartbeat (the in-memory factory stays for callers that hold the fold
// inside a longer-lived process object).

import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openPersistedThreadIndex, openThreadIndex, THREADS_LOG_FILE } from '../../src/memory/index.js';
import { tmpDir, rmDir } from './helpers.js';

const roots: string[] = [];
const dir = (label: string): string => {
  const d = tmpDir(label);
  roots.push(d);
  return d;
};
afterEach(() => {
  while (roots.length > 0) rmDir(roots.pop()!);
});

describe('ThreadIndex', () => {
  it('folds updates: latest status wins, title carries forward, counts accumulate', () => {
    const t = openThreadIndex();
    t.apply([{ id: 'jazz', title: 'Jazz night', status: 'open' }], 100);
    t.apply([{ id: 'jazz', status: 'touched' }], 200); // no title → keeps the old one
    t.apply([{ id: 'jazz', title: 'Jazz friday', status: 'closed' }], 300);

    const jazz = t.get('jazz');
    expect(jazz).toEqual({ id: 'jazz', title: 'Jazz friday', status: 'closed', updatedAt: 300, updates: 3 });
  });

  it('tracks threads independently and answers all() in id order', () => {
    const t = openThreadIndex();
    t.apply(
      [
        { id: 'thesis', title: 'Chapter two', status: 'open' },
        { id: 'jazz', title: 'Jazz night', status: 'open' },
      ],
      10,
    );
    t.apply([{ id: 'thesis', status: 'touched' }], 20);

    expect(t.size()).toBe(2);
    expect(t.all().map((x) => x.id)).toEqual(['jazz', 'thesis']);
    expect(t.get('thesis')!.updatedAt).toBe(20);
    expect(t.get('thesis')!.updates).toBe(2);
    expect(t.get('missing')).toBeUndefined();
  });

  it('accepts an empty update batch as a no-op', () => {
    const t = openThreadIndex();
    t.apply([], 5);
    expect(t.size()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// dueThreads — the heartbeat's follow-up queue (round 2)
// ---------------------------------------------------------------------------

describe('dueThreads — the follow-up queue', () => {
  it('a thread he opened comes due once THREAD_DUE_MS has passed since its last update', () => {
    const t = openThreadIndex();
    t.apply([{ id: 'crates', title: 'The crates', status: 'open' }], 1_000);

    expect(t.dueThreads(1_000)).toEqual([]); // fresh: not yet due
    expect(t.dueThreads(1_000 + 6 * 3_600_000 - 1)).toEqual([]); // a minute before
    expect(t.dueThreads(1_000 + 6 * 3_600_000)).toEqual([
      { id: 'crates', title: 'The crates', status: 'open', updatedAt: 1_000, updates: 1 },
    ]);
  });

  it('a touch re-arms the due time; a closed thread is never due', () => {
    const t = openThreadIndex();
    t.apply([{ id: 'crates', title: 'The crates', status: 'open' }], 0);
    t.apply([{ id: 'crates', status: 'touched' }], 3_600_000); // re-armed: due at 7h
    expect(t.dueThreads(6 * 3_600_000)).toEqual([]);
    expect(t.dueThreads(7 * 3_600_000)).toHaveLength(1);

    t.apply([{ id: 'crates', status: 'closed' }], 8 * 3_600_000);
    expect(t.dueThreads(100 * 3_600_000)).toEqual([]); // closed stays closed
  });
});

// ---------------------------------------------------------------------------
// openPersistedThreadIndex — the fold survives the restart
// ---------------------------------------------------------------------------

describe('openPersistedThreadIndex', () => {
  it('applies append the batch to threads.jsonl and a reopened index folds the same state', () => {
    const d = dir('persist');
    const t = openPersistedThreadIndex(d);
    t.apply([{ id: 'jazz', title: 'Jazz night', status: 'open' }], 100);
    t.apply([
      { id: 'jazz', status: 'touched' },
      { id: 'thesis', title: 'Chapter two', status: 'open' },
    ], 200);

    // Every applied batch is a durable row — id, title and STATUS, not just ids.
    const rows = fs.readFileSync(path.join(d, THREADS_LOG_FILE), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as unknown);
    expect(rows).toEqual([
      { version: 1, ts: 100, updates: [{ id: 'jazz', title: 'Jazz night', status: 'open' }] },
      { version: 1, ts: 200, updates: [{ id: 'jazz', status: 'touched' }, { id: 'thesis', title: 'Chapter two', status: 'open' }] },
    ]);

    // A fresh open (the crash-restart path) replays the log into the same fold.
    const reopened = openPersistedThreadIndex(d);
    expect(reopened.size()).toBe(2);
    expect(reopened.get('jazz')).toEqual({ id: 'jazz', title: 'Jazz night', status: 'touched', updatedAt: 200, updates: 2 });
    expect(reopened.get('thesis')).toEqual({ id: 'thesis', title: 'Chapter two', status: 'open', updatedAt: 200, updates: 1 });
    expect(reopened.skippedRows()).toBe(0);

    // And the reopened index keeps appending after the log it replayed.
    reopened.apply([{ id: 'jazz', status: 'closed' }], 300);
    expect(reopened.get('jazz')?.status).toBe('closed');
    expect(openPersistedThreadIndex(d).get('jazz')?.updates).toBe(3);
  });

  it('a thread from a persisted appraisal comes due after the restart (the heartbeat path)', () => {
    const d = dir('persist-due');
    const t = openPersistedThreadIndex(d);
    t.apply([{ id: 'crates', title: 'The crates', status: 'open' }], 1_000);

    const reopened = openPersistedThreadIndex(d);
    expect(reopened.dueThreads(1_000 + 6 * 3_600_000)).toHaveLength(1);
    expect(reopened.dueThreads(1_000 + 3_600_000)).toEqual([]);
  });

  it('a corrupt or invalid log line is skipped and counted, never fatal at boot', () => {
    const d = dir('persist-rot');
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(
      path.join(d, THREADS_LOG_FILE),
      [
        JSON.stringify({ version: 1, ts: 100, updates: [{ id: 'jazz', title: 'Jazz night', status: 'open' }] }),
        '{not json at all',
        JSON.stringify({ version: 1, ts: 200, updates: [{ id: 'ghost' }] }), // update fails ThreadUpdateSchema (no status)
        JSON.stringify({ version: 1, ts: 300, updates: [{ id: 'thesis', title: 'Chapter two', status: 'open' }] }),
        '',
      ].join('\n'),
      'utf8',
    );

    const t = openPersistedThreadIndex(d);
    expect(t.skippedRows()).toBe(2);
    expect(t.size()).toBe(2);
    expect(t.get('jazz')).toBeDefined();
    expect(t.get('thesis')).toBeDefined();
    expect(t.get('ghost')).toBeUndefined();

    // The next apply rewrites nothing behind the skipped rows — the log grows.
    t.apply([{ id: 'jazz', status: 'closed' }], 400);
    expect(fs.readFileSync(path.join(d, THREADS_LOG_FILE), 'utf8').trim().split('\n')).toHaveLength(5);
  });

  it('an empty directory boots a zero index and creates nothing until the first apply', () => {
    const d = dir('persist-fresh');
    const t = openPersistedThreadIndex(d);
    expect(t.size()).toBe(0);
    expect(fs.existsSync(path.join(d, THREADS_LOG_FILE))).toBe(false);
    t.apply([], 1); // empty batch: folded (no-op), nothing written
    expect(fs.existsSync(path.join(d, THREADS_LOG_FILE))).toBe(false);
  });
});

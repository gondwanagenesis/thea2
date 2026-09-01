// M15 bridge — the ingestion seam. The load-bearing AC lives here: the offset is
// never committed before the ledger append AND the pipeline enqueue, and a
// duplicate update is dropped rather than re-enqueued.

import { describe, expect, it, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TestClock } from '../../src/kernel/clock.js';
import { ingestUpdates, openMessageLedger, openOffsetStore, type InboundMsg, type MessageLedger, type OffsetStore } from '../../src/bridge/index.js';
import { msg } from './helpers.js';

let dirs: string[] = [];
const fresh = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thea2-bridge-ingest-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  dirs = [];
});

const openLedger = (dir: string): MessageLedger => openMessageLedger(dir, { clock: new TestClock(0) });

/** Ledger + offset store that narrate every mutation, so ordering assertions are readable. */
const instrumented = (ledger: MessageLedger, offsets: OffsetStore, order: string[]): { ledger: MessageLedger; offsets: OffsetStore } => ({
  ledger: {
    ...ledger,
    recordInbound: async (m) => {
      const isNew = await ledger.recordInbound(m);
      order.push(`append:${m.updateId}:${isNew ? 'new' : 'dup'}`);
      return isNew;
    },
    linkTurn: async (updateId, turnId) => {
      await ledger.linkTurn(updateId, turnId);
      order.push(`link:${updateId}:${turnId}`);
    },
  },
  offsets: {
    read: () => offsets.read(),
    write: async (next) => {
      await offsets.write(next);
      order.push(`commit:${next.committed}`);
    },
  },
});

describe('ingestUpdates ordering', () => {
  it('AC: the offset is never committed before ledger append + enqueue — for every update in the batch', async () => {
    const dir = fresh();
    const order: string[] = [];
    const enqueued: number[] = [];
    const raw = openLedger(path.join(dir, 'ledger'));
    const rawOffsets = openOffsetStore(path.join(dir, 'offsets.json'));
    const { ledger, offsets } = instrumented(raw, rawOffsets, order);

    await ingestUpdates(
      {
        ledger,
        offsets,
        handle: (m) => {
          enqueued.push(m.updateId);
          order.push(`enqueue:${m.updateId}`);
          return `turn-${m.updateId}`;
        },
      },
      [msg({ updateId: 401 }), msg({ updateId: 402 })],
    );

    expect(order).toEqual([
      'append:401:new',
      'enqueue:401',
      'link:401:turn-401',
      'commit:401',
      'append:402:new',
      'enqueue:402',
      'link:402:turn-402',
      'commit:402',
    ]);
    expect(enqueued).toEqual([401, 402]);
    expect(await rawOffsets.read()).toEqual({ committed: 402 });
  });

  it('a batch is processed in update_id order regardless of arrival order', async () => {
    const dir = fresh();
    const order: string[] = [];
    const raw = openLedger(path.join(dir, 'ledger'));
    const rawOffsets = openOffsetStore(path.join(dir, 'offsets.json'));
    const { ledger, offsets } = instrumented(raw, rawOffsets, order);

    const out = await ingestUpdates({ ledger, offsets }, [msg({ updateId: 403 }), msg({ updateId: 401 })]);
    expect(out.map((o) => o.updateId)).toEqual([401, 403]);
    expect(order.filter((e) => e.startsWith('append:'))).toEqual(['append:401:new', 'append:403:new']);
  });

  it('a duplicate update is dropped, not re-enqueued, and the offset still advances past it', async () => {
    const dir = fresh();
    const deps = (ledger: MessageLedger, offsets: OffsetStore, enqueued: number[]) => ({
      ledger,
      offsets,
      handle: (m: InboundMsg) => {
        enqueued.push(m.updateId);
        return undefined;
      },
    });
    const ledger = openLedger(path.join(dir, 'ledger'));
    const offsets = openOffsetStore(path.join(dir, 'offsets.json'));
    const firstPass: number[] = [];
    expect((await ingestUpdates(deps(ledger, offsets, firstPass), [msg({ updateId: 401 })])).map((o) => o.verdict)).toEqual([
      'handled',
    ]);

    // Telegram redelivers the same update (a restart, a second poller, whatever) —
    const secondPass: number[] = [];
    const out = await ingestUpdates(deps(ledger, offsets, secondPass), [msg({ updateId: 401 })]);
    expect(out.map((o) => o.verdict)).toEqual(['duplicate']);
    expect(secondPass).toEqual([]); // never re-enqueued
    expect(firstPass).toEqual([401]); // handled exactly once in total
    expect(await offsets.read()).toEqual({ committed: 401 });
  });

  it('a handle that returns no turnId is fine — the inbound just stays unlinkable', async () => {
    const dir = fresh();
    const ledger = openLedger(path.join(dir, 'ledger'));
    const offsets = openOffsetStore(path.join(dir, 'offsets.json'));
    const out = await ingestUpdates({ ledger, offsets, handle: () => undefined }, [msg({ updateId: 401 })]);
    expect(out).toEqual([{ updateId: 401, verdict: 'handled' }]);
    for await (const row of ledger.read()) expect(row.kind).not.toBe('link');
  });

  it('a throwing handler leaves the offset unmoved and the durable claim in place — the redelivery is deduped, never re-handled', async () => {
    const dir = fresh();
    const ledger = openLedger(path.join(dir, 'ledger'));
    const offsets = openOffsetStore(path.join(dir, 'offsets.json'));
    let attempts = 0;
    const boom = async (): Promise<string> => {
      attempts += 1;
      throw new Error('pipeline died');
    };
    await expect(ingestUpdates({ ledger, offsets, handle: () => boom() }, [msg({ updateId: 401 })])).rejects.toThrow(
      'pipeline died',
    );
    expect(await offsets.read()).toEqual({ committed: 0 });

    // Restart: Telegram redelivers, the ledger flags the duplicate, the handler
    // is NOT invoked again — which is exactly why the LOST_REPLY alarm exists.
    const after: number[] = [];
    const out = await ingestUpdates(
      {
        ledger,
        offsets,
        handle: (m) => {
          after.push(m.updateId);
          return `turn-${m.updateId}`;
        },
      },
      [msg({ updateId: 401 })],
    );
    expect(out.map((o) => o.verdict)).toEqual(['duplicate']);
    expect(after).toEqual([]);
    expect(attempts).toBe(1);
  });
});

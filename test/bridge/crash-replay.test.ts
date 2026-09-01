// M15 bridge — the S2 crash-replay gate.
//
// A "kill" is modeled the way it actually happens: the process stops mid-step,
// so everything durably written before that step survives on disk (the ledger,
// the offset file) and everything volatile dies (the pipeline queue). Restart =
// fresh MessageLedger + OffsetStore over the SAME dir, plus Telegram redelivering
// what was never committed.
//
// The proof, per scenario: no message lost, none handled twice.

import { describe, expect, it, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TestClock } from '../../src/kernel/clock.js';
import {
  DEFAULT_RECONCILE_WINDOW_MS,
  ingestUpdates,
  openMessageLedger,
  openOffsetStore,
  type InboundMsg,
  type MessageLedger,
  type OffsetStore,
} from '../../src/bridge/index.js';
import { msg } from './helpers.js';

const T0 = 1_788_000_000_000;
const T = DEFAULT_RECONCILE_WINDOW_MS;
const MSG: InboundMsg = msg({ updateId: 401, text: 'estás despierta?' });

let dirs: string[] = [];
const fresh = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thea2-bridge-crash-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  dirs = [];
});

/** One "process": durable stores over the shared dir + the handler invocations it can see. */
interface Process {
  ledger: MessageLedger;
  offsets: OffsetStore;
  handled: InboundMsg[];
}

const boot = (dir: string): Process => {
  const ledger = openMessageLedger(path.join(dir, 'ledger'), { clock: new TestClock(T0) });
  const offsets = openOffsetStore(path.join(dir, 'offsets.json'));
  const handled: InboundMsg[] = [];
  return { ledger, offsets, handled };
};

const pipeline =
  (p: Process) =>
  async (m: InboundMsg): Promise<string> => {
    p.handled.push(m);
    return `turn-${m.updateId}`;
  };

const relaunch = (dir: string): Process => boot(dir);

describe('crash-replay: no message lost, none delivered twice', () => {
  it('AC: kill between enqueue and the offset commit ⇒ restart redelivers ⇒ duplicate flagged, handled exactly once, reconcile clean', async () => {
    const dir = fresh();

    // Process 1: append + enqueue + link land, and the process dies in the
    // offset commit itself — modeled at the exact seam that dies.
    const p1 = boot(dir);
    let writes = 0;
    const dyingOffsets: OffsetStore = {
      read: () => p1.offsets.read(),
      write: async (next) => {
        writes += 1;
        if (writes === 1) throw new Error('SIGKILL during offset commit');
        await p1.offsets.write(next);
      },
    };
    await expect(
      ingestUpdates({ ledger: p1.ledger, offsets: dyingOffsets, handle: pipeline(p1) }, [MSG]),
    ).rejects.toThrow('SIGKILL');
    expect(p1.handled).toHaveLength(1); // the pipeline got the message…
    // …and finished its turn before the process died: the reply is durable.
    await p1.ledger.recordOutbound('turn-401', 5001, 'siempre');

    // Process 2 (restart): fresh stores over the same dir; Telegram redelivers
    // because the committed cursor never moved.
    const p2 = relaunch(dir);
    const out = await ingestUpdates({ ledger: p2.ledger, offsets: p2.offsets, handle: pipeline(p2) }, [MSG]);
    expect(out.map((o) => o.verdict)).toEqual(['duplicate']); // flagged as a duplicate…
    expect(p2.handled).toHaveLength(0); // …and NOT delivered a second time
    expect(await p2.offsets.read()).toEqual({ committed: 401 }); // the cursor is repaired

    // No loss, no dupe: the first (only) reply stands; the duplicate arrival is
    // honest telemetry, not an alarm.
    const verdict = await p2.ledger.reconcile(T0 + T + 1);
    expect(verdict).toEqual([{ kind: 'DUPLICATE_INBOUND', updateId: 401 }]);
  });

  it('AC: kill before the append lands ⇒ nothing durable survived, restart handles it exactly once', async () => {
    const dir = fresh();

    // Process 1 dies inside the append: not even the claim was written.
    const p1 = boot(dir);
    const dyingLedger: MessageLedger = {
      ...p1.ledger,
      recordInbound: async () => {
        throw new Error('SIGKILL before the append');
      },
    };
    await expect(
      ingestUpdates({ ledger: dyingLedger, offsets: p1.offsets, handle: pipeline(p1) }, [MSG]),
    ).rejects.toThrow('SIGKILL before the append');
    expect(p1.handled).toHaveLength(0);
    expect(await p1.offsets.read()).toEqual({ committed: 0 });

    // Process 2: the redelivery is brand new to the ledger — handled once.
    const p2 = relaunch(dir);
    const out = await ingestUpdates({ ledger: p2.ledger, offsets: p2.offsets, handle: pipeline(p2) }, [MSG]);
    expect(out.map((o) => o.verdict)).toEqual(['handled']);
    expect(p2.handled).toHaveLength(1);
    await p2.ledger.recordOutbound('turn-401', 5001, 'ya voy');
    expect(await p2.ledger.reconcile(T0 + T + 1)).toEqual([]); // one reply, zero discrepancies
  });

  it('the append-without-handle seam is never silent: it surfaces as LOST_REPLY', async () => {
    const dir = fresh();

    // Process 1: the append lands, the process dies before the handler runs —
    // the one window ledger dedupe cannot recover by redelivery. The design
    // answer is the reconciliation alarm, not a quiet drop.
    const p1 = boot(dir);
    await expect(
      ingestUpdates(
        {
          ledger: p1.ledger,
          offsets: p1.offsets,
          handle: () => {
            throw new Error('SIGKILL after append, before handle');
          },
        },
        [MSG],
      ),
    ).rejects.toThrow('SIGKILL after append');

    // Process 2: the redelivery is deduped (the claim is durable), so no turn
    // ever completes — and reconcile says so out loud, message attached.
    const p2 = relaunch(dir);
    const out = await ingestUpdates({ ledger: p2.ledger, offsets: p2.offsets, handle: pipeline(p2) }, [MSG]);
    expect(out.map((o) => o.verdict)).toEqual(['duplicate']);
    expect(p2.handled).toHaveLength(0);

    // Inside the window she still gets her chance; the redelivery shows up as
    // the informational duplicate verdict, not as a loss.
    expect(await p2.ledger.reconcile(T0 + 1000)).toEqual([{ kind: 'DUPLICATE_INBOUND', updateId: 401 }]);
    expect(await p2.ledger.reconcile(T0 + T + 1)).toEqual([
      { kind: 'LOST_REPLY', inbound: MSG, ageMs: T + 1 },
      { kind: 'DUPLICATE_INBOUND', updateId: 401 },
    ]);
  });

  it('kill mid-batch ⇒ the committed prefix is never re-handled; the tail dedupes too and its lost turn is NAMED', async () => {
    const dir = fresh();
    const A = msg({ updateId: 401 });
    const B = msg({ updateId: 402 });

    // Process 1: A fully committed; the process dies before B's commit.
    const p1 = boot(dir);
    let writes = 0;
    const dyingAfterFirst: OffsetStore = {
      read: () => p1.offsets.read(),
      write: async (next) => {
        writes += 1;
        if (writes === 1) await p1.offsets.write(next);
        else throw new Error('SIGKILL mid-batch');
      },
    };
    await expect(
      ingestUpdates({ ledger: p1.ledger, offsets: dyingAfterFirst, handle: pipeline(p1) }, [A, B]),
    ).rejects.toThrow('SIGKILL mid-batch');
    expect(p1.handled.map((m) => m.updateId)).toEqual([401, 402]); // B was enqueued as well — it was next in line
    expect(await p1.offsets.read()).toEqual({ committed: 401 }); // only A's commit survived
    // A's turn finished before the kill; B's was still in flight and died with the process.
    await p1.ledger.recordOutbound('turn-401', 1401, 'listo');

    // Process 2: Telegram redelivers the whole span (the cursor says 401).
    // A dedupes; B dedupes too — its append was durable even though its commit
    // was not, so it is never handled twice.
    const p2 = relaunch(dir);
    const out = await ingestUpdates({ ledger: p2.ledger, offsets: p2.offsets, handle: pipeline(p2) }, [A, B]);
    expect(out.map((o) => o.verdict)).toEqual(['duplicate', 'duplicate']);
    expect(p2.handled).toHaveLength(0);
    expect(await p2.offsets.read()).toEqual({ committed: 402 });

    // B's in-flight turn died with process 1, and B was linked to it — so the
    // alarm names the turn, not just the message. A stands replied; both
    // redeliveries show up as informational duplicates only.
    const late = await p2.ledger.reconcile(T0 + T + 1);
    expect(late).toEqual([
      { kind: 'LOST_REPLY', inbound: B, ageMs: T + 1, turnId: 'turn-402' },
      { kind: 'DUPLICATE_INBOUND', updateId: 401 },
      { kind: 'DUPLICATE_INBOUND', updateId: 402 },
    ]);
  });
});

// M15 bridge — the MessageLedger: dedupe on update_id, and the reconciliation
// truth table. Every scripted inbound lands in exactly one verdict: replied /
// decided-silent ⇒ clean, anything else past the window ⇒ LOST_REPLY, repeated
// arrivals ⇒ DUPLICATE_INBOUND. Thea1's sentinel ate 37 replies invisibly; this
// table is what makes that class of failure structurally loud.

import { describe, expect, it, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TestClock } from '../../src/kernel/clock.js';
import { openJsonl } from '../../src/kernel/index.js';
import { memoryLog } from './helpers.js';
import {
  DEFAULT_RECONCILE_WINDOW_MS,
  emitLostReplyAlarms,
  openMessageLedger,
  type Discrepancy,
  type LedgerRow,
  type MessageLedger,
} from '../../src/bridge/index.js';
import { msg } from './helpers.js';

const T0 = 1_788_000_000_000; // the moment the inbound lands
const T = DEFAULT_RECONCILE_WINDOW_MS;
const HOUR = 3_600_000;
const { existsSync, readFileSync, rmSync, writeFileSync } = fs;

let dirs: string[] = [];
const fresh = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thea2-bridge-ledger-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  dirs = [];
});

const open = (dir: string): { ledger: MessageLedger; clock: TestClock } => ({
  ledger: openMessageLedger(dir, { clock: new TestClock(T0) }),
  clock: new TestClock(T0),
});

const lost = (updateId: number, ageMs: number, turnId?: string): Discrepancy[] => [
  {
    kind: 'LOST_REPLY',
    inbound: msg({ updateId }),
    ageMs,
    ...(turnId !== undefined ? { turnId } : {}),
  },
];

interface TruthCase {
  name: string;
  /** Extra rows recorded after the inbound lands (the turn's life, in ledger terms). */
  script: (l: MessageLedger) => Promise<void>;
  /** Reconcile time, in ms after the inbound landed. */
  at: number;
  expect: Discrepancy[];
  /** Overrides the initial arrival (default: a plain inbound, updateId 401). */
  arrival?: { updateId: number; skipped?: { reason: string } };
}

const TRUTH_TABLE: TruthCase[] = [
  {
    name: 'replied ⇒ clean (an outbound row is the terminal record)',
    script: async (l) => {
      await l.linkTurn(401, 'turn-1');
      await l.recordOutbound('turn-1', 5001, 'siempre');
    },
    at: T + 1,
    expect: [],
  },
  {
    name: 'decided-silent ⇒ clean (silence by design is a typed outcome)',
    script: async (l) => {
      await l.linkTurn(401, 'turn-2');
      await l.recordDecision('turn-2', { turnId: 'turn-2', plan: 'silent', at: T0 + 50 });
    },
    at: T + 1,
    expect: [],
  },
  {
    name: 'failure silence ⇒ LOST_REPLY (decidedBy failure stays owed past the window)',
    script: async (l) => {
      await l.linkTurn(401, 'turn-f');
      await l.recordDecision('turn-f', { turnId: 'turn-f', plan: 'silent', at: T0 + 50, decidedBy: 'failure' });
    },
    at: T + 1,
    expect: lost(401, T + 1, 'turn-f'),
  },
  {
    name: 'gate silence ⇒ clean (the gate forced the silence after the re-entry cap — restraint, not failure)',
    script: async (l) => {
      await l.linkTurn(401, 'turn-g');
      await l.recordDecision('turn-g', { turnId: 'turn-g', plan: 'silent', at: T0 + 50, decidedBy: 'gate' });
    },
    at: T + 1,
    expect: [],
  },
  {
    name: 'legacy silent row without decidedBy ⇒ clean (absent provenance predates the failure marker — read as restraint)',
    script: async (l) => {
      await l.linkTurn(401, 'turn-l');
      await l.recordDecision('turn-l', { turnId: 'turn-l', plan: 'silent', at: T0 + 50 });
    },
    at: T + 1,
    expect: [],
  },
  {
    name: 'skipped inbound ⇒ never lost',
    arrival: { updateId: 401, skipped: { reason: 'photo without caption' } },
    script: async () => undefined,
    at: T * 10, // far past any window: a skip owes nothing, ever
    expect: [],
  },
  {
    name: 'deferred and not yet due ⇒ clean (ADR-003 due-by bookkeeping)',
    script: async (l) => {
      await l.linkTurn(401, 'turn-3');
      await l.recordDecision('turn-3', { turnId: 'turn-3', plan: 'defer', at: T0 + 50, dueBy: T0 + T + 60_000 });
    },
    at: T + 1,
    expect: [],
  },
  {
    name: 'deferred, due-by passed, nothing to show ⇒ LOST_REPLY',
    script: async (l) => {
      await l.linkTurn(401, 'turn-4');
      await l.recordDecision('turn-4', { turnId: 'turn-4', plan: 'defer', at: T0 + 50, dueBy: T0 + T });
    },
    at: T + 1,
    expect: lost(401, T + 1, 'turn-4'),
  },
  {
    name: 'decided reply but never delivered ⇒ LOST_REPLY (the sentinel-shaped loss)',
    script: async (l) => {
      await l.linkTurn(401, 'turn-5');
      await l.recordDecision('turn-5', { turnId: 'turn-5', plan: 'reply', at: T0 + 50 });
    },
    at: T + 1,
    expect: lost(401, T + 1, 'turn-5'),
  },
  {
    name: 'gate fallback re-decides reply → silent ⇒ clean (last decision wins)',
    script: async (l) => {
      await l.linkTurn(401, 'turn-6');
      await l.recordDecision('turn-6', { turnId: 'turn-6', plan: 'reply', at: T0 + 50 });
      await l.recordDecision('turn-6', { turnId: 'turn-6', plan: 'silent', at: T0 + 900 });
    },
    at: T + 1,
    expect: [],
  },
  {
    name: 'no terminal record ⇒ LOST_REPLY (a never-sent reply and a send whose ack was lost to a crash are indistinguishable — both alarm)',
    script: async () => undefined,
    at: T + 1,
    expect: lost(401, T + 1),
  },
  {
    name: 'a reply decision from an UNLINKED turn does not clear the inbound',
    script: async (l) => {
      await l.recordDecision('some-other-turn', { turnId: 'some-other-turn', plan: 'silent', at: T0 + 50 });
    },
    at: T + 1,
    expect: lost(401, T + 1),
  },
  {
    name: 'duplicate arrival on an already-replied turn ⇒ exactly DUPLICATE_INBOUND (informational, not a loss)',
    script: async (l) => {
      expect(await l.recordInbound(msg({ updateId: 401 }))).toBe(false); // the redelivery
      await l.linkTurn(401, 'turn-8');
      await l.recordOutbound('turn-8', 5008, 'hola');
    },
    at: T + 1,
    expect: [{ kind: 'DUPLICATE_INBOUND', updateId: 401 }],
  },
  {
    name: 'a reaction arrival is an outcome signal, never a request ⇒ never lost',
    script: async (l) => {
      await l.linkTurn(401, 'turn-7');
      await l.recordOutbound('turn-7', 5001, 'hola'); // the plain inbound is answered…
      expect(
        await l.recordInbound(msg({ updateId: 402, text: '', reaction: { emoji: '🔥', toMsgId: 5001 } })),
      ).toBe(true); // …the reaction needs nothing and never alarms
    },
    at: T * 10, // long past any window
    expect: [],
  },
];

describe('reconciliation truth table', () => {
  for (const c of TRUTH_TABLE) {
    it(`AC: ${c.name}`, async () => {
      const { ledger } = open(fresh());
      expect(await ledger.recordInbound(msg({ updateId: 401, ...(c.arrival?.skipped !== undefined ? { skipped: c.arrival.skipped } : {}) }))).toBe(true);
      await c.script(ledger);
      const verdict = await ledger.reconcile(T0 + c.at);
      // "Exactly one verdict" is structural: an inbound produces at most one
      // LOST_REPLY row and one DUPLICATE_INBOUND row, and never a false clean.
      expect(verdict).toEqual(c.expect);
    });
  }
});

describe('reconcile T-boundary (TestClock)', () => {
  it('T−1s ⇒ clean, exactly T ⇒ clean (still within), T+1s ⇒ LOST_REPLY with the exact age', async () => {
    for (const [at, expected] of [
      [T - 1000, [] as Discrepancy[]],
      [T, [] as Discrepancy[]],
      [T + 1, lost(401, T + 1)],
    ] as const) {
      const { ledger } = open(fresh());
      await ledger.recordInbound(msg({ updateId: 401 }));
      expect(await ledger.reconcile(T0 + at)).toEqual(expected);
    }
  });

  it('age runs from the EARLIEST arrival of the update_id', async () => {
    const dir = fresh();
    const clock = new TestClock(T0);
    const ledger = openMessageLedger(dir, { clock });
    await ledger.recordInbound(msg({ updateId: 401 }));
    await clock.advance(1000);
    await ledger.recordInbound(msg({ updateId: 401 })); // a redelivery a second later
    // From the first arrival, not the redelivery: age = T+1, not T+1−1000. The
    // redelivery itself is the informational DUPLICATE verdict, not a second loss.
    const verdict = await ledger.reconcile(T0 + T + 1);
    expect(verdict).toEqual([...lost(401, T + 1), { kind: 'DUPLICATE_INBOUND', updateId: 401 }]);
  });
});

describe('recordInbound dedupe', () => {
  it('returns true once per update_id and still records duplicate arrivals', async () => {
    const { ledger } = open(fresh());
    expect(await ledger.recordInbound(msg({ updateId: 401 }))).toBe(true);
    expect(await ledger.recordInbound(msg({ updateId: 401 }))).toBe(false);
    expect(await ledger.recordInbound(msg({ updateId: 402 }))).toBe(true);

    const kinds: string[] = [];
    const updateIds: number[] = [];
    for await (const row of ledger.read()) {
      if (row.kind === 'inbound') {
        kinds.push(row.kind);
        updateIds.push(row.msg.updateId);
      }
    }
    expect(kinds).toEqual(['inbound', 'inbound', 'inbound']); // duplicates stay visible
    expect(updateIds).toEqual([401, 401, 402]);
  });

  it('dedupe state is durable: a fresh open of the same dir knows the update_id', async () => {
    const dir = fresh();
    const first = open(dir);
    await first.ledger.recordInbound(msg({ updateId: 401 }));

    const restarted = openMessageLedger(dir, { clock: new TestClock(T0 + 1000) });
    expect(await restarted.recordInbound(msg({ updateId: 401 }))).toBe(false); // the crash-replay dedupe
    expect(await restarted.recordInbound(msg({ updateId: 402 }))).toBe(true);
  });
});

describe('ledger write guards (failure must be loud)', () => {
  it('recordDecision rejects a summary whose turnId disagrees with the key', async () => {
    const { ledger } = open(fresh());
    await expect(
      ledger.recordDecision('turn-a', { turnId: 'turn-b', plan: 'silent', at: T0 }),
    ).rejects.toMatchObject({ code: 'bridge/decision-mismatch' });
  });

  it("recordDecision rejects a 'defer' without a due-by — it would never come due and quietly escape the invariant", async () => {
    const { ledger } = open(fresh());
    await expect(
      ledger.recordDecision('turn-a', { turnId: 'turn-a', plan: 'defer', at: T0 }),
    ).rejects.toMatchObject({ code: 'bridge/decision-mismatch' });
  });

  it('recordDecision persists decidedBy (the provenance reconcile reads — a failure silence must survive the restart)', async () => {
    const { ledger } = open(fresh());
    await ledger.recordDecision('turn-a', { turnId: 'turn-a', plan: 'silent', at: T0, decidedBy: 'failure' });
    await ledger.recordDecision('turn-b', { turnId: 'turn-b', plan: 'silent', at: T0, decidedBy: 'gate' });
    await ledger.recordDecision('turn-c', { turnId: 'turn-c', plan: 'silent', at: T0 }); // absent = legacy row

    const rows: string[] = [];
    const provenance: Array<string | undefined> = [];
    for await (const row of ledger.read()) {
      if (row.kind === 'decision') {
        rows.push(row.turnId);
        provenance.push(row.decidedBy);
      }
    }
    expect(rows).toEqual(['turn-a', 'turn-b', 'turn-c']);
    expect(provenance).toEqual(['failure', 'gate', undefined]);
  });
});

describe('emitLostReplyAlarms', () => {
  it('emits bridge.lost_reply per lost inbound (with its turn and escalation) and stays silent about duplicates', async () => {
    const { log, events } = memoryLog();
    const { ledger } = open(fresh());
    await ledger.recordInbound(msg({ updateId: 401 }));
    await ledger.recordInbound(msg({ updateId: 402, chatId: 555 }));
    await ledger.linkTurn(402, 'turn-2');
    const discrepancies = await ledger.reconcile(T0 + T + 1);
    expect(discrepancies).toEqual([
      ...lost(401, T + 1),
      { kind: 'LOST_REPLY', inbound: msg({ updateId: 402, chatId: 555 }), ageMs: T + 1, turnId: 'turn-2' },
    ]);

    await emitLostReplyAlarms(log, discrepancies, ledger);
    expect(events.map((e) => e.kind)).toEqual(['bridge.lost_reply', 'bridge.lost_reply']);
    expect(events.map((e) => e.payload)).toEqual([
      { updateId: 401, chatId: 8123456, ageMs: T + 1, escalation: 'initial' },
      { updateId: 402, chatId: 555, ageMs: T + 1, escalation: 'initial', turnId: 'turn-2' },
    ]);
    expect(events.map((e) => e.turnId)).toEqual([undefined, 'turn-2']);
  });

  it('AC: alarm fires once then escalates — once per updateId, then again only at 1h / 6h / 24h', async () => {
    const { log, events } = memoryLog();
    const dir = fresh();
    const ledger = openMessageLedger(dir, { clock: new TestClock(T0) });
    await ledger.recordInbound(msg({ updateId: 401 }));

    const pass = async (at: number, l: MessageLedger = ledger): Promise<void> => {
      await emitLostReplyAlarms(log, await l.reconcile(T0 + at), l);
    };

    await pass(T + 1); // first sight: the initial alarm
    await pass(T + 60_000); // 1 min later, still unpaid: SILENT — once per updateId
    await pass(T + 1 + HOUR); // past 1h: escalation 1
    await pass(T + 1 + 6 * HOUR); // past 6h: escalation 2
    await pass(T + 1 + 24 * HOUR); // past 24h: escalation 3
    await pass(T + 1 + 25 * HOUR); // after the ladder is spent: silent (the doctor + ack take over)

    expect(events.map((e) => (e.payload as { escalation: string }).escalation)).toEqual([
      'initial',
      '1h',
      '6h',
      '24h',
    ]);
    expect(events.every((e) => e.kind === 'bridge.lost_reply')).toBe(true);
    // The escalation state survives a restart: a fresh ledger over the same dir
    // knows 401 was already alarmed — no duplicate alarm from the fresh open.
    const restarted = openMessageLedger(dir, { clock: new TestClock(T0) });
    await pass(T + 1 + 24 * HOUR, restarted);
    expect(events).toHaveLength(4);
  });

  it('AC: abandoned-loss-is-not-owed — an abandoned row terminates the invariant; owedInbound counts only non-abandoned', async () => {
    const dir = fresh();
    const ledger = openMessageLedger(dir, { clock: new TestClock(T0) });
    await ledger.recordInbound(msg({ updateId: 401 }));
    await ledger.recordInbound(msg({ updateId: 402 }));

    // An operator (and, in recoverLost, the grace/moved-on paths) closes 401:
    await ledger.abandon(401, 'operator');
    // 402 stays open: reconcile still owes it, and only it.
    expect(await ledger.reconcile(T0 + T + 1)).toEqual(lost(402, T + 1));

    // The row is durable and typed — an operator abandon survives the restart.
    const rows: unknown[] = [];
    for await (const row of ledger.read()) if (row.kind === 'abandoned') rows.push(row);
    expect(rows).toEqual([{ kind: 'abandoned', ts: T0, updateId: 401, reason: 'operator' }]);

    const restarted = openMessageLedger(dir, { clock: new TestClock(T0) });
    expect(await restarted.reconcile(T0 + T + 1)).toEqual(lost(402, T + 1)); // 401 stays closed
    await restarted.abandon(402, 'grace');
    expect(await restarted.reconcile(T0 + T + 1)).toEqual([]); // every loss terminates
  });

  it('AC: reconcile replays only the tail after a snapshot — and a fresh open matches a full replay', async () => {
    const dir = fresh();
    const first = openMessageLedger(dir, { clock: new TestClock(T0) });
    await first.recordInbound(msg({ updateId: 401 }));
    expect(await first.reconcile(T0 + T + 1)).toEqual(lost(401, T + 1));
    expect(first.lastReconcileReplayedRows()).toBe(1); // the full replay (no snapshot yet)
    expect(existsSync(path.join(dir, 'reconcile-state.json'))).toBe(true); // the fold is durable

    // Three more rows land OUTSIDE the live fold — the crash window: the
    // process died after the snapshot, the rows hit disk, a fresh open reads
    // them as the tail.
    const raw = openJsonl<LedgerRow>(dir, 'messages', { rotateDailyUtc: true, clock: new TestClock(T0) });
    await raw.append({ kind: 'inbound', ts: T0 + 1000, msg: msg({ updateId: 402, ts: T0 + 1000 }) });
    await raw.append({ kind: 'link', ts: T0 + 1000, updateId: 402, turnId: 'turn-2' });
    await raw.append({ kind: 'outbound', ts: T0 + 1000, turnId: 'turn-2', msgId: 5002, text: 'ya voy' });

    const second = openMessageLedger(dir, { clock: new TestClock(T0) });
    const verdict = await second.reconcile(T0 + T + 2);
    expect(verdict).toEqual(lost(401, T + 2)); // 401 still owed; the answered 402 is clean
    expect(second.lastReconcileReplayedRows()).toBe(3); // the TAIL only — never the 4-row history

    // Equivalence: with the snapshot removed, a FULL replay of the same rows
    // gives the same verdicts (the fold loses nothing that matters).
    const snapshotPath = path.join(dir, 'reconcile-state.json');
    const saved = readFileSync(snapshotPath, 'utf8');
    rmSync(snapshotPath);
    const full = openMessageLedger(dir, { clock: new TestClock(T0) });
    expect(await full.reconcile(T0 + T + 2)).toEqual(verdict);
    writeFileSync(snapshotPath, saved, 'utf8'); // leave the dir as the fold wrote it
  });
});

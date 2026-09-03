// M20 app — the maintenance jobs the architecture promised (Phase 1, 2026-09-02):
// reconcile's lost-reply RECOVERY law and the affect-snapshot job. The file had
// zero tests; these pin the contract table: rerun-once-per-process inside the
// grace window, alarm-only past it, the busy-defer, the ledger link that makes
// the later reconcile clean, and both loud-failure shapes. Fakes mirror
// test/life/jobs.test.ts's style (recording event log, in-memory doubles,
// TestClock everywhere); the link test uses the REAL ledger because "a later
// reconcile is clean" is a claim about real rows, not about a fake.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TestClock } from '../../src/kernel/clock.js';
import { makeRng } from '../../src/kernel/rng.js';
import { MockModel } from '../../src/model/index.js';
import { openSessionWindow } from '../../src/memory/index.js';
import {
  DEFAULT_RECONCILE_WINDOW_MS,
  escalationForAge,
  escalationOutranks,
  openMessageLedger,
  type EscalationLevel,
  type InboundMsg,
} from '../../src/bridge/index.js';
import type { Discrepancy } from '../../src/bridge/index.js';
import type { EventEnvelope, EventLog } from '../../src/events/index.js';
import type { JobCtx } from '../../src/sched/index.js';
import {
  AFFECT_SNAPSHOT_INCIDENT,
  DEFAULT_RERUN_GRACE_MS,
  RECONCILE_INCIDENT,
  REPLY_RERUN_EVENT,
  affectSnapshotJob,
  runReconcile,
  type RecoverLostDeps,
} from '../../src/app/maintenance-jobs.js';

const { readFileSync } = fs;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const T0 = 1_788_000_000_000;
const T = DEFAULT_RECONCILE_WINDOW_MS;

const inbound = (over: Partial<InboundMsg> = {}): InboundMsg => ({
  updateId: 401,
  msgId: 900,
  chatId: 8123456,
  ts: T0,
  text: '¿y la caja?',
  speaker: { person: 'diego', channel: 'telegram' },
  ...over,
});

const lost = (updateId: number, ageMs: number, turnId?: string): Discrepancy[] => [
  {
    kind: 'LOST_REPLY',
    inbound: inbound({ updateId }),
    ageMs,
    ...(turnId !== undefined ? { turnId } : {}),
  },
];

interface RecordingLog extends EventLog {
  rows: EventEnvelope[];
  of: (kind: string) => EventEnvelope[];
}

const recordingLog = (): RecordingLog => {
  const rows: EventEnvelope[] = [];
  return {
    rows,
    of: (kind) => rows.filter((r) => r.kind === kind),
    emit: async (kind, payload, turnId) => {
      rows.push({ seq: rows.length + 1, ts: T0, kind, ...(turnId !== undefined ? { turnId } : {}), payload });
    },
    async *replay(filter): AsyncGenerator<EventEnvelope> {
      for (const r of rows) {
        if (filter?.kinds !== undefined && !filter.kinds.includes(r.kind)) continue;
        yield r;
      }
    },
  };
};

interface PipelineSpy {
  inboundCalls: InboundMsg[];
  returnedTurnIds: Array<string | undefined>;
  busy: boolean;
}

interface Harness extends RecoverLostDeps {
  log: RecordingLog;
  spy: PipelineSpy;
  linked: Array<{ updateId: number; turnId: string }>;
  /** (updateId, reason) pairs the recovery handed to ledger.abandon. */
  abandons: Array<{ updateId: number; reason: string }>;
  /** (updateId, escalation) pairs handed to ledger.markAlarmed. */
  alarmed: Array<{ updateId: number; escalation: string }>;
  reconcileResult: Discrepancy[];
  setBusy: (busy: boolean) => void;
  setChatMovedOn: (v: boolean) => void;
}

/** A fake ledger whose reconcile replays `discrepancies`; the recovery seam records what it was told. */
const harness = (
  discrepancies: Discrepancy[],
  over: { graceMs?: number; chatMovedOn?: boolean; window?: RecoverLostDeps['window'] } = {},
): Harness => {
  const log = recordingLog();
  const spy: PipelineSpy = { inboundCalls: [], returnedTurnIds: [], busy: false };
  const linked: Array<{ updateId: number; turnId: string }> = [];
  const abandons: Array<{ updateId: number; reason: string }> = [];
  const alarmed: Array<{ updateId: number; escalation: string }> = [];
  let chatMovedOn = over.chatMovedOn ?? false;
  const deps: RecoverLostDeps = {
    ledger: {
      reconcile: async () => discrepancies,
      linkTurn: async (updateId, turnId) => {
        linked.push({ updateId, turnId });
      },
      abandon: async (updateId, reason) => {
        abandons.push({ updateId, reason });
      },
      markAlarmed: async (updateId, escalation) => {
        alarmed.push({ updateId, escalation });
      },
      // The real ladder's shape: due until it has actually been marked heard.
      alarmDue: async (updateId, ageMs) => {
        const last = [...alarmed].reverse().find((a) => a.updateId === updateId)?.escalation;
        const level = escalationForAge(ageMs);
        return { due: last === undefined || escalationOutranks(level, last as EscalationLevel), level };
      },
      chatMovedOn: async () => chatMovedOn,
    },
    events: log,
    pipeline: {
      inbound: (m) => {
        spy.inboundCalls.push(m);
        const turnId = `turn_rerun_${spy.inboundCalls.length}`;
        spy.returnedTurnIds.push(turnId);
        return turnId;
      },
      isBusy: () => spy.busy,
    },
    ...(over.window !== undefined ? { window: over.window } : {}),
    ...(over.graceMs !== undefined ? { graceMs: over.graceMs } : {}),
    rerun: new Set<number>(),
  };
  return {
    ...deps,
    log,
    spy,
    linked,
    abandons,
    alarmed,
    reconcileResult: discrepancies,
    setBusy: (b) => (spy.busy = b),
    setChatMovedOn: (v) => (chatMovedOn = v),
  };
};

const jobCtx = (log: EventLog): JobCtx => ({
  clock: new TestClock(T0),
  rng: makeRng('maintenance-jobs-test'),
  signal: new AbortController().signal,
  events: log,
});

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const freshDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thea2-maintenance-'));
  dirs.push(dir);
  return dir;
};

// ---------------------------------------------------------------------------
// recoverLost / runReconcile — the recovery law
// ---------------------------------------------------------------------------

describe('reconcile recovery — rerun once per process, inside the grace window only', () => {
  it('reruns a LOST_REPLY younger than grace exactly once per process', async () => {
    const h = harness(lost(401, 2 * 60_000, 'turn-lost')); // 2 min old, well inside the 60 min grace
    const now = T0 + 2 * 60_000;

    const first = await runReconcile(h, now);
    expect(first.rerunUpdateIds).toEqual([401]);
    expect(h.spy.inboundCalls).toEqual([inbound({ updateId: 401 })]); // re-enqueued verbatim
    expect(h.linked).toEqual([{ updateId: 401, turnId: 'turn_rerun_1' }]); // the rerun owns the inbound
    expect(h.log.of(REPLY_RERUN_EVENT).map((r) => r.payload)).toEqual([
      { updateId: 401, turnId: 'turn_rerun_1', ageMs: 2 * 60_000 },
    ]);
    expect(h.log.of('bridge.lost_reply')).toHaveLength(1); // the alarm fired too

    // The same loss on the NEXT pass (5 min later, still unpaid): alarmed ONCE
    // total — the escalation ladder (1h/6h/24h) owns any repeat, not every pass.
    const second = await runReconcile(h, now);
    expect(second.rerunUpdateIds).toEqual([]);
    expect(h.spy.inboundCalls).toHaveLength(1); // exactly once per process
    expect(h.log.of('bridge.lost_reply')).toHaveLength(1);
    expect(h.alarmed).toEqual([{ updateId: 401, escalation: 'initial' }]); // the ledger keeps the alarm state
  });

  it('alarms once, then terminates a loss older than grace with an abandoned row (reason grace)', async () => {
    const h = harness(lost(402, DEFAULT_RERUN_GRACE_MS + 1)); // three hours stale, one ms past grace
    const outcome = await runReconcile(h, T0 + DEFAULT_RERUN_GRACE_MS + 1);

    expect(outcome.rerunUpdateIds).toEqual([]);
    expect(h.spy.inboundCalls).toHaveLength(0); // answering a 3-hour-old question as if new is worse than the alarm
    expect(h.log.of('bridge.lost_reply').map((r) => r.payload)).toEqual([
      // 60 min + 1 ms sits past the grace AND past the 1 h rung: the one alarm fires at '1h'.
      { updateId: 402, chatId: 8123456, ageMs: DEFAULT_RERUN_GRACE_MS + 1, escalation: '1h' },
    ]);
    // Every loss terminates (ADR-003 through P-CLOSE CL.2): the grace path
    // writes the terminal row, so reconcile stops owing it.
    expect(h.abandons).toEqual([{ updateId: 402, reason: 'grace' }]);
  });

  it('AC: rerun-skips-when-conversation-moved-on — newer chat activity abandons the loss and lands its text in the window pending', async () => {
    const pushes: Array<{ role: string; content: string; ts: number; turnId: string }> = [];
    const h = harness(lost(405, 2 * 60_000, 'turn-moved'), {
      chatMovedOn: true,
      window: {
        pushPending: async (m) => {
          pushes.push(m);
        },
      },
    });
    const now = T0 + 2 * 60_000;
    const outcome = await runReconcile(h, now);

    expect(outcome.rerunUpdateIds).toEqual([]); // never re-run: he has moved on
    expect(h.spy.inboundCalls).toHaveLength(0);
    expect(h.abandons).toEqual([{ updateId: 405, reason: 'moved-on' }]);
    // The text is NOT lost to her: it rides the window's pending span, the
    // [EARLIER] feedstock — carried as context, never answered as if new.
    expect(pushes).toEqual([{ role: 'user', content: '¿y la caja?', ts: T0, turnId: 'turn-moved' }]);
    expect(h.log.of('bridge.lost_reply')).toHaveLength(1); // the one alarm still fired
  });

  it('pushPending lands the abandoned text in the REAL window pending span (the [EARLIER] feedstock)', async () => {
    const dir = freshDir();
    const clock = new TestClock(T0);
    const window = openSessionWindow(path.join(dir, 'memory'), {
      model: new MockModel({ clock }),
      clock,
      events: recordingLog(),
    });
    // Optional in the type (pre-existing fakes stay valid); the real window
    // always provides it — a no-op here would fail the state assertion below.
    await window.pushPending?.({ role: 'user', content: '¿y la caja?', ts: T0, turnId: 'lost-405' });
    // It never entered the live window — the continuity span only.
    expect(window.messages()).toEqual([]);
    const state = JSON.parse(readFileSync(path.join(dir, 'memory', 'window.json'), 'utf8')) as {
      pending: Array<{ role: string; content: string; ts: number; turnId: string }>;
    };
    expect(state.pending).toEqual([{ role: 'user', content: '¿y la caja?', ts: T0, turnId: 'lost-405' }]);
  });

  it('defers the rerun while the pipeline is busy and takes it on the next pass', async () => {
    const h = harness(lost(403, 60_000, 'turn-inflight'));
    h.setBusy(true); // a turn in flight may BE the turn reconcile counts as lost
    const first = await runReconcile(h, T0 + 60_000);

    expect(first.rerunUpdateIds).toEqual([]);
    expect(h.spy.inboundCalls).toHaveLength(0);
    expect(h.linked).toHaveLength(0);

    h.setBusy(false);
    const second = await runReconcile(h, T0 + 60_000);
    expect(second.rerunUpdateIds).toEqual([403]);
    expect(h.spy.inboundCalls).toHaveLength(1);
    expect(h.linked).toEqual([{ updateId: 403, turnId: 'turn_rerun_1' }]);
  });

  it('links the rerun turn so a later reconcile is clean', async () => {
    const log = recordingLog();
    const ledger = openMessageLedger(freshDir(), { clock: new TestClock(T0) });
    await ledger.recordInbound(inbound({ updateId: 404 }));
    const deps: RecoverLostDeps = {
      ledger,
      events: log,
      pipeline: {
        inbound: () => 'turn-9', // the re-enqueued turn
        isBusy: () => false,
      },
      rerun: new Set<number>(),
    };

    const now = T0 + T + 1;
    const discrepancies = await ledger.reconcile(now);
    expect(discrepancies).toEqual(lost(404, T + 1));
    await runReconcile(deps, now); // alarms + re-enqueue + linkTurn(404, 'turn-9')

    // The rerun turn answers him (however late): the link re-pointed the inbound
    // at that turn, so the SAME reconcile now reads clean.
    await ledger.recordOutbound('turn-9', 5001, 'voy en camino');
    const after = await ledger.reconcile(now);
    expect(after).toEqual([]);

    const rerun = log.of(REPLY_RERUN_EVENT).map((r) => r.payload);
    expect(rerun).toEqual([{ updateId: 404, turnId: 'turn-9', ageMs: T + 1 }]);
  });

  it('a throwing ledger lands incident.reconcile_failed and returns empty', async () => {
    const log = recordingLog();
    const deps: RecoverLostDeps = {
      ledger: {
        reconcile: async () => {
          throw new Error('ledger file corrupted');
        },
        linkTurn: async () => undefined,
        abandon: async () => undefined,
        markAlarmed: async () => undefined,
        alarmDue: async () => ({ due: true, level: 'initial' }),
        chatMovedOn: async () => false,
      },
      events: log,
      pipeline: { inbound: () => 'turn-x', isBusy: () => false },
      rerun: new Set<number>(),
    };

    const outcome = await runReconcile(deps, T0);
    expect(outcome).toEqual({ discrepancies: [], rerunUpdateIds: [] }); // empty, never a throw
    expect(log.of(RECONCILE_INCIDENT).map((r) => r.payload)).toEqual([{ error: 'ledger file corrupted' }]);
  });
});

// ---------------------------------------------------------------------------
// affectSnapshotJob — decay tick + loud failure
// ---------------------------------------------------------------------------

describe('affectSnapshotJob', () => {
  it('affect-snapshot job calls snapshot and lands incident.affect_snapshot_failed on throw', async () => {
    let snapshots = 0;
    const okJob = affectSnapshotJob({ affect: { snapshot: async () => void (snapshots += 1) } });
    const log = recordingLog();
    await okJob.run(jobCtx(log));
    expect(snapshots).toBe(1); // the decay tick ran
    expect(log.rows).toEqual([]); // a good pass is silent

    const throwing = affectSnapshotJob({
      affect: {
        snapshot: async () => {
          throw new Error('state.json unwritable');
        },
      },
    });
    await expect(throwing.run(jobCtx(log))).resolves.toBeUndefined(); // never throws out of run()
    expect(log.of(AFFECT_SNAPSHOT_INCIDENT).map((r) => r.payload)).toEqual([{ error: 'state.json unwritable' }]);
  });
});

// test/memory — shared builders and doubles. Everything here is data and pure
// functions: no wall clock, no entropy, no network.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { EventEnvelope, EventLog } from '../../src/events/index.js';
import { AFFECT_DIMS, type AffectDim } from '../../schemas/exemplar.js';
import type { Appraisal, EpisodeRecord, ProcedureRecordBase, WindowMsg } from '../../src/memory/index.js';

// ---------------------------------------------------------------------------
// Dirs — the repo's mkdtemp + afterEach-rm pattern
// ---------------------------------------------------------------------------

export const tmpDir = (label: string): string =>
  fs.mkdtempSync(path.join(os.tmpdir(), `thea2-memory-${label}-`));

export const rmDir = (dir: string): void => fs.rmSync(dir, { recursive: true, force: true });

// ---------------------------------------------------------------------------
// L0 double — assert emitted events without touching the filesystem
// ---------------------------------------------------------------------------

export const memoryLog = (): { log: EventLog; events: EventEnvelope[] } => {
  const events: EventEnvelope[] = [];
  return {
    events,
    log: {
      emit: async (kind, payload, turnId) => {
        events.push({ seq: events.length + 1, ts: 0, kind, ...(turnId !== undefined ? { turnId } : {}), payload });
      },
      async *replay(): AsyncGenerator<EventEnvelope> {
        for (const e of events) yield e;
      },
    },
  };
};

export const kindsOf = (events: readonly EventEnvelope[]): string[] => events.map((e) => e.kind);

// ---------------------------------------------------------------------------
// Vec12 stamps
// ---------------------------------------------------------------------------

export const FLAT12: readonly number[] = Array.from({ length: AFFECT_DIMS.length }, () => 0);

/** A Vec12 with the named dims set and everything else flat zero. */
export const stamp12 = (over: Partial<Record<AffectDim, number>> = {}): number[] =>
  AFFECT_DIMS.map((d) => over[d] ?? 0);

// ---------------------------------------------------------------------------
// Episode / procedure / appraisal builders
// ---------------------------------------------------------------------------

let seqCounter = 0;
const nextSeq = (): number => ++seqCounter;

export const episode = (over: Partial<EpisodeRecord> = {}): EpisodeRecord => {
  const seq = nextSeq();
  const line = over.summary ?? `episode summary ${seq}`;
  return {
    id: `ep_${String(seq).padStart(3, '0')}`,
    ts: 0,
    turnId: `turn_${String(seq).padStart(3, '0')}`,
    summary: line,
    diaryLine: over.diaryLine ?? line,
    importance: 5,
    emotions: [],
    threads: [],
    affectAtEncoding: [...FLAT12],
    ...over,
  };
};

export const procedure = (over: Partial<ProcedureRecordBase> = {}): ProcedureRecordBase => {
  const seq = nextSeq();
  return {
    id: `proc_${String(seq).padStart(3, '0')}`,
    situation: `situation ${seq}`,
    call: 'search_files',
    args: { query: 'notes' },
    result: '3 files',
    outcome: 'good',
    ts: 0,
    ...over,
  };
};

export const appraisal = (over: Partial<Appraisal> = {}): Appraisal => ({
  importance: 6,
  emotions: [{ tag: 'fond', i: 5, cause: 'he wrote first' }],
  diaryLine: 'he remembered the thing I said',
  threads: [{ id: 'jazz', title: 'Jazz night', status: 'open' }],
  outcomePrev: { sign: 1, evidence: 'he said "gracias, eso era"' },
  ...over,
});

// ---------------------------------------------------------------------------
// Window messages
// ---------------------------------------------------------------------------

export const wmsg = (over: Partial<WindowMsg> & { ts: number }): WindowMsg => {
  const seq = nextSeq();
  return {
    role: 'user',
    content: `message ${seq}`,
    turnId: `turn_${String(seq).padStart(3, '0')}`,
    ...over,
  };
};

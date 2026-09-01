// test/siblings — shared fixtures and doubles for the M18 suite. Everything is
// data and pure functions: a TestClock, a seeded rng, an in-memory L0 that the
// job bodies REPLAY through their real path, and a scripted ProbeRunner standing
// in for M19. Explicit fixtures over snapshots: every number a test pins is
// written out here in full, so a regression names the field that moved.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { EventEnvelope, EventLog } from '../../src/events/index.js';
import { gateSuite } from '../../src/probes/baseline.js';
import type { CheckReport } from '../../src/probes/deterministic.js';
import type { ProbeResult, ProbeRunner, RunAllOptions } from '../../src/probes/index.js';
import { TestClock } from '../../src/kernel/clock.js';
import { makeRng } from '../../src/kernel/rng.js';
import { MockModel } from '../../src/model/mock.js';
import type { SiblingDeps, SiblingMarkerPaths } from '../../src/siblings/index.js';

// ---------------------------------------------------------------------------
// Time + dirs
// ---------------------------------------------------------------------------

/** A fixed "now": 2023-11-14T22:13:20.000Z, so `ledger-2023-11-14.md`. */
export const T0 = 1_700_000_000_000;
export const MIN = 60_000;
export const HOUR = 3_600_000;

export const tmpDir = (label: string): string =>
  fs.mkdtempSync(path.join(os.tmpdir(), `thea2-siblings-${label}-`));

export const rmDir = (dir: string): void => fs.rmSync(dir, { recursive: true, force: true });

/** Writes a file (and its parents) with exact bytes — fixtures, not atomic writes. */
export const writeText = (filePath: string, text: string): void => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text, 'utf8');
};

// ---------------------------------------------------------------------------
// The L0 double — records emissions, replays what it holds
// ---------------------------------------------------------------------------

/** A fixture envelope: builders stamp `seq: 0` (unknown yet); recordingLog
 * reassigns monotonic seqs on construction, so the fold never sees a fake one. */
export type SeedEvent = EventEnvelope;

export interface RecordingLog extends EventLog {
  events: EventEnvelope[];
  kinds: () => string[];
}

export const recordingLog = (seed: ReadonlyArray<SeedEvent> = []): RecordingLog => {
  const events: EventEnvelope[] = seed.map((e, i) => ({ ...e, seq: i + 1 }));
  return {
    events,
    kinds: () => events.map((e) => e.kind),
    emit: async (kind, payload, turnId) => {
      events.push({
        seq: events.length + 1,
        ts: 0,
        kind,
        ...(turnId !== undefined ? { turnId } : {}),
        payload,
      });
    },
    replay: async function* (filter): AsyncGenerator<EventEnvelope> {
      for (const e of events) {
        if (filter?.kinds !== undefined && !filter.kinds.includes(e.kind)) continue;
        if (filter?.sinceTs !== undefined && e.ts < filter.sinceTs) continue;
        yield e;
      }
    },
  };
};

export const eventsOf = (log: RecordingLog, kind: string): unknown[] =>
  log.events.filter((e) => e.kind === kind).map((e) => e.payload);

// ---------------------------------------------------------------------------
// L0 event builders — M03/M05/M10/M12/M16 shapes, parsed downstream, never trusted
// ---------------------------------------------------------------------------

export interface CallSpec {
  ts: number;
  turnId?: string;
  taskClass: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  attempts: number;
  /** Omitted = the endpoint supplied no pricing; the fold counts 0. */
  costUsd?: number;
  outcome?: string;
}

export const callEvent = (s: CallSpec): SeedEvent => ({
  seq: 0,
  ts: s.ts,
  kind: 'model.call',
  ...(s.turnId !== undefined ? { turnId: s.turnId } : {}),
  payload: {
    taskClass: s.taskClass,
    tier: 'main',
    model: 'glm-5.3-flash',
    usage: {
      inputTokens: s.inputTokens,
      outputTokens: s.outputTokens,
      latencyMs: s.latencyMs,
      attempts: s.attempts,
      ...(s.costUsd !== undefined ? { costUsd: s.costUsd } : {}),
    },
    outcome: s.outcome ?? 'ok',
  },
});

/** A well-formed parse failure; pass `payload` to fabricate a malformed row. */
export const parseFailEvent = (over: {
  ts: number;
  turnId?: string;
  payload?: unknown;
}): SeedEvent => ({
  seq: 0,
  ts: over.ts,
  kind: 'model.parse_failed',
  ...(over.turnId !== undefined ? { turnId: over.turnId } : {}),
  payload:
    over.payload ?? { schema: 'decision', rung: 'repair', error: 'unparseable after one repair' },
});

export const lostReplyEvent = (over: { ts: number; ageMs: number; updateId: number }): SeedEvent => ({
  seq: 0,
  ts: over.ts,
  kind: 'bridge.lost_reply',
  payload: { updateId: over.updateId, chatId: 42, ageMs: over.ageMs },
});

export const gateLoopEvent = (over: { ts: number; ruleIds: string[]; reentries: number }): SeedEvent => ({
  seq: 0,
  ts: over.ts,
  kind: 'incident.gate_loop',
  payload: { ruleIds: over.ruleIds, reentries: over.reentries },
});

export const schedAlarmEvent = (over: { ts: number; job: string }): SeedEvent => ({
  seq: 0,
  ts: over.ts,
  kind: 'sched.alarm',
  payload: { job: over.job },
});

export const gravityEvent = (over: { ts: number; alarms: string[] }): SeedEvent => ({
  seq: 0,
  ts: over.ts,
  kind: 'consolidate.gravity',
  payload: { alarms: over.alarms },
});

export const eventOf = (ts: number, kind: string, payload: unknown = {}): SeedEvent => ({
  seq: 0,
  ts,
  kind,
  payload,
});

// ---------------------------------------------------------------------------
// The golden day — one replayed mixed window, every number worked out by hand
// ---------------------------------------------------------------------------

/** Builds the golden day: 5 task classes, 16 calls, 23 attempts (retries folded),
 * 5 parse failures (3 attributed, 2 not), 3 malformed rows, and one of every
 * operational truth. Costs are multiples of 0.25 so every sum is IEEE-exact. */
export const goldenDay = (): SeedEvent[] => [
  // A parse failure that lands BEFORE its call (the repair ladder throws first)
  // and is still attributed, via the two-pass fold.
  parseFailEvent({ ts: T0 - 11 * HOUR, turnId: 't_pre' }),
  callEvent({ ts: T0 - 10 * HOUR, turnId: 't_pre', taskClass: 'consolidate', inputTokens: 1000, outputTokens: 200, costUsd: 0.25, latencyMs: 12000, attempts: 3 }),
  callEvent({ ts: T0 - 9.5 * HOUR, turnId: 't_k2', taskClass: 'consolidate', inputTokens: 1100, outputTokens: 210, costUsd: 0.25, latencyMs: 14000, attempts: 1 }),
  callEvent({ ts: T0 - 9 * HOUR, taskClass: 'consolidate', inputTokens: 1200, outputTokens: 220, costUsd: 0.25, latencyMs: 16000, attempts: 2 }),
  parseFailEvent({ ts: T0 - 8.9 * HOUR, turnId: 't_k2' }),
  // Unattributable: no call in the window carries these turnIds. Counted, never dropped.
  parseFailEvent({ ts: T0 - 8.8 * HOUR, turnId: 't_ghost' }),
  parseFailEvent({ ts: T0 - 8.7 * HOUR }),
  // summarize: 5 calls, 8 attempts (one retried twice, once three times), 1 failed.
  callEvent({ ts: T0 - 8 * HOUR, turnId: 't_s1', taskClass: 'summarize', inputTokens: 100, outputTokens: 50, costUsd: 0.25, latencyMs: 1000, attempts: 1 }),
  callEvent({ ts: T0 - 7 * HOUR, turnId: 't_s2', taskClass: 'summarize', inputTokens: 200, outputTokens: 60, costUsd: 0.5, latencyMs: 2000, attempts: 2 }),
  callEvent({ ts: T0 - 6 * HOUR, turnId: 't_s3', taskClass: 'summarize', inputTokens: 300, outputTokens: 70, costUsd: 0.25, latencyMs: 3000, attempts: 1 }),
  callEvent({ ts: T0 - 5 * HOUR, turnId: 't_s4', taskClass: 'summarize', inputTokens: 400, outputTokens: 80, costUsd: 0.5, latencyMs: 4000, attempts: 3 }),
  callEvent({ ts: T0 - 4 * HOUR, turnId: 't_s5', taskClass: 'summarize', inputTokens: 500, outputTokens: 90, costUsd: 0.75, latencyMs: 5000, attempts: 1, outcome: 'error' }),
  parseFailEvent({ ts: T0 - 3.9 * HOUR, turnId: 't_s3' }),
  // turn: 3 calls, the user-facing pin.
  callEvent({ ts: T0 - 3 * HOUR, turnId: 't_u1', taskClass: 'turn', inputTokens: 5000, outputTokens: 900, costUsd: 1.0, latencyMs: 9000, attempts: 1 }),
  callEvent({ ts: T0 - 2.5 * HOUR, turnId: 't_u2', taskClass: 'turn', inputTokens: 5100, outputTokens: 950, costUsd: 1.0, latencyMs: 7000, attempts: 2 }),
  callEvent({ ts: T0 - 2 * HOUR, turnId: 't_u3', taskClass: 'turn', inputTokens: 5200, outputTokens: 1000, costUsd: 0.75, latencyMs: 8000, attempts: 1 }),
  // judge: 3 calls, two sharing a turnId — the most recent one owns attribution.
  callEvent({ ts: T0 - 1.9 * HOUR, turnId: 't_shared', taskClass: 'judge', inputTokens: 800, outputTokens: 100, costUsd: 0.25, latencyMs: 500, attempts: 1 }),
  callEvent({ ts: T0 - 1.8 * HOUR, turnId: 't_shared', taskClass: 'judge', inputTokens: 900, outputTokens: 110, latencyMs: 700, attempts: 1 }),
  callEvent({ ts: T0 - 1.7 * HOUR, taskClass: 'judge', inputTokens: 950, outputTokens: 120, costUsd: 0.25, latencyMs: 600, attempts: 1 }),
  parseFailEvent({ ts: T0 - 1.6 * HOUR, turnId: 't_shared' }),
  // derive: 2 calls.
  callEvent({ ts: T0 - 1.5 * HOUR, turnId: 't_d', taskClass: 'derive', inputTokens: 2000, outputTokens: 300, costUsd: 0.5, latencyMs: 9000, attempts: 1 }),
  callEvent({ ts: T0 - 1.4 * HOUR, taskClass: 'derive', inputTokens: 2100, outputTokens: 310, costUsd: 0.5, latencyMs: 1000, attempts: 1 }),
  // Malformed rows — counted and skipped, never fatal.
  eventOf(T0 - 1.3 * HOUR, 'model.call', { taskClass: 'summarize', tier: 'main', model: 'x', outcome: 'ok' }),
  eventOf(T0 - 1.3 * HOUR, 'model.call', { taskClass: 'ghost', tier: 'main', model: 'x', usage: { inputTokens: 1, outputTokens: 1, latencyMs: 1, attempts: 1 }, outcome: 'ok' }),
  eventOf(T0 - 1.3 * HOUR, 'model.parse_failed', { schema: 'decision' }),
  // The operational truths, one of each.
  lostReplyEvent({ ts: T0 - 6 * HOUR, ageMs: 300_000, updateId: 1 }),
  lostReplyEvent({ ts: T0 - 5 * HOUR, ageMs: 5_400_000, updateId: 2 }),
  gateLoopEvent({ ts: T0 - 4.5 * HOUR, ruleIds: ['low-arousal', 'low-arousal', 'quiet-hours'], reentries: 3 }),
  gateLoopEvent({ ts: T0 - 4.4 * HOUR, ruleIds: ['low-arousal'], reentries: 1 }),
  schedAlarmEvent({ ts: T0 - 4 * HOUR, job: 'ponder-seed' }),
  schedAlarmEvent({ ts: T0 - 3.9 * HOUR, job: 'ledger-report' }),
  gravityEvent({ ts: T0 - 3.5 * HOUR, alarms: ['unmoored', 'tilt', 'unmoored'] }),
  eventOf(T0 - 3.4 * HOUR, 'consolidate.alarm', { reason: 'identity drift' }),
  eventOf(T0 - 3.3 * HOUR, 'model.routing_ignored', { taskClass: 'turn', attemptedTier: 'cheap', pinnedTier: 'main' }),
  // A generic incident kind: `incident.*` rows WITHOUT their own dedicated fold
  // land in the incidents count (gate loops are folded separately, not twice).
  eventOf(T0 - 3.2 * HOUR, 'incident.probe_timeout', { probeId: 'voice-cold-open' }),
];

/** The day's exact fold — the numbers every aggregate and report test pins. */
export const GOLDEN = {
  aggs: [
    { taskClass: 'consolidate', calls: 3, inputTokens: 3300, outputTokens: 630, costUsd: 0.75, latencyP50Ms: 14000, latencyP95Ms: 16000, parseFailures: 2 },
    { taskClass: 'derive', calls: 2, inputTokens: 4100, outputTokens: 610, costUsd: 1.0, latencyP50Ms: 1000, latencyP95Ms: 9000, parseFailures: 0 },
    { taskClass: 'judge', calls: 3, inputTokens: 2650, outputTokens: 330, costUsd: 0.5, latencyP50Ms: 600, latencyP95Ms: 700, parseFailures: 1 },
    { taskClass: 'summarize', calls: 5, inputTokens: 1500, outputTokens: 350, costUsd: 2.25, latencyP50Ms: 3000, latencyP95Ms: 5000, parseFailures: 1 },
    { taskClass: 'turn', calls: 3, inputTokens: 15300, outputTokens: 2850, costUsd: 2.75, latencyP50Ms: 8000, latencyP95Ms: 9000, parseFailures: 0 },
  ],
  totals: {
    calls: 16,
    attempts: 23,
    failedCalls: 1,
    inputTokens: 26850,
    outputTokens: 4770,
    costUsd: 7.25,
    parseFailuresUnattributed: 2,
    malformed: 3,
  },
  truths: {
    lostReplies: 2,
    lostReplyMaxAgeMs: 5_400_000,
    gateLoops: 2,
    gateLoopReentries: 4,
    gateRules: [
      { key: 'low-arousal', count: 3 },
      { key: 'quiet-hours', count: 1 },
    ],
    schedAlarms: 2,
    schedAlarmJobs: [
      { key: 'ledger-report', count: 1 },
      { key: 'ponder-seed', count: 1 },
    ],
    gravityAlarms: [
      { key: 'tilt', count: 1 },
      { key: 'unmoored', count: 2 },
    ],
    consolidateAlarms: 1,
    routingIgnored: 1,
    incidents: [{ key: 'incident.probe_timeout', count: 1 }],
  },
};

// ---------------------------------------------------------------------------
// The hot day — evidence that clears every threshold, for the routing guardrail
// ---------------------------------------------------------------------------

/** 24 summarize calls and 24 turn calls, each $0.25: half the window's spend
 * each, 0 parse failures, p95 well under the latency line. summarize must be
 * PROPOSED (main → cheap); turn must be REFUSED (user-facing pin). */
export const hotDay = (): SeedEvent[] => {
  const evs: SeedEvent[] = [];
  for (let i = 0; i < 24; i++) {
    evs.push(
      callEvent({
        ts: T0 - 6 * HOUR,
        turnId: `t_hot_s${i}`,
        taskClass: 'summarize',
        inputTokens: 100,
        outputTokens: 20,
        costUsd: 0.25,
        latencyMs: 1000,
        attempts: 1,
      }),
    );
  }
  for (let i = 0; i < 24; i++) {
    evs.push(
      callEvent({
        ts: T0 - 3 * HOUR,
        turnId: `t_hot_u${i}`,
        taskClass: 'turn',
        inputTokens: 500,
        outputTokens: 90,
        costUsd: 0.25,
        latencyMs: 2000,
        attempts: 1,
      }),
    );
  }
  return evs;
};

/** The evidence text both hot-day routing lines carry (24 calls, half the spend). */
export const HOT_DAY_EVIDENCE =
  '24 calls, $6.00 (50.0% of window spend), p95 1000 ms, 0.0% parse failures';

// ---------------------------------------------------------------------------
// Probe doubles — a scripted M19 runner
// ---------------------------------------------------------------------------

/** A CheckReport that is green vacuously or red by one named noLeakage failure. */
export const checkReport = (pass: boolean): CheckReport =>
  pass
    ? { pass: true, results: [] }
    : {
        pass: false,
        results: [
          {
            check: { type: 'noLeakage' },
            pass: false,
            perRun: [false],
            details: ['synthetic failure for gate tests'],
          },
        ],
      };

/** A ProbeResult carrying exactly the evidence the gate and report read. */
export const probeResult = (over: {
  probeId?: string;
  deterministicPass?: boolean;
  judgeMedian?: number | null;
  drift?: Record<string, number>;
  judgeVariance?: number;
} = {}): ProbeResult => ({
  probeId: over.probeId ?? 'voice-cold-open',
  runs: [],
  deterministic: checkReport(over.deterministicPass ?? true),
  judgeMedian: over.judgeMedian ?? null,
  judgeVariance: over.judgeVariance ?? 0,
  drift: over.drift ?? {},
});

export interface ScriptedRunner extends ProbeRunner {
  /** Every runAll invocation, verbatim — the k/dry/baseline contract. */
  calls: RunAllOptions[];
  /** Arms a one-shot throw for the next runAll (a dead immune system's runner). */
  failNextWith: (e: unknown) => void;
}

/** The M19 seam, scripted: gates the given results with M19's own arithmetic. */
export const scriptedRunner = (results: ReadonlyArray<ProbeResult> = [probeResult({})]): ScriptedRunner => {
  const calls: RunAllOptions[] = [];
  let failWith: unknown;
  return {
    calls,
    failNextWith: (e: unknown) => {
      failWith = e;
    },
    run: async () => {
      throw new Error('scriptedRunner.run is not part of sibling flows');
    },
    runAll: async (opts) => {
      calls.push(opts);
      if (failWith !== undefined) {
        const e = failWith;
        failWith = undefined;
        throw e;
      }
      return {
        results: [...results],
        gate: gateSuite(results, opts.baseline ?? null),
        modelCalls: 0,
        dry: false,
      };
    },
  };
};

/** A runner that "is not the M19 seam": results without a gate report. */
export const gatelessRunner = (results: ReadonlyArray<ProbeResult>): ProbeRunner => ({
  run: async () => {
    throw new Error('gatelessRunner.run is not part of sibling flows');
  },
  runAll: async () => ({ results: [...results], modelCalls: 0, dry: false }),
});

// ---------------------------------------------------------------------------
// The harness — SiblingDeps over temp dirs
// ---------------------------------------------------------------------------

export interface HarnessDirs {
  root: string;
  reportsDir: string;
  routingPath: string;
  markerPath: string;
  baselinePath: string;
  schedStatePath: string;
  corpusDir: string;
  inhibitionsPath: string;
  couplingPath: string;
  personaDir: string;
}

export interface Harness {
  dirs: HarnessDirs;
  deps: SiblingDeps;
  model: MockModel;
  clock: TestClock;
  log: RecordingLog;
  runner: ScriptedRunner;
}

export interface HarnessOver {
  clock?: TestClock;
  l0?: ReadonlyArray<SeedEvent>;
  model?: MockModel;
  runner?: ScriptedRunner;
  marker?: SiblingMarkerPaths;
  /** Exact initial bytes; absent = no file (the normal first week). */
  routing?: string;
  schedState?: string;
  baseline?: string;
}

/** Assembles SiblingDeps over temp dirs with sane defaults; callers override any piece. */
export const harness = (label: string, over: HarnessOver = {}): Harness => {
  const root = tmpDir(label);
  const dirs: HarnessDirs = {
    root,
    reportsDir: path.join(root, 'var', 'reports'),
    routingPath: path.join(root, 'var', 'routing.json'),
    markerPath: path.join(root, 'var', 'deploy-marker'),
    baselinePath: path.join(root, 'probes', 'baseline.json'),
    schedStatePath: path.join(root, 'var', 'sched', 'state.json'),
    corpusDir: path.join(root, 'corpus', 'canon'),
    inhibitionsPath: path.join(root, 'corpus', 'canon', 'inhibitions.yaml'),
    couplingPath: path.join(root, 'coupling.yaml'),
    personaDir: path.join(root, 'personas'),
  };

  // Minimal real inputs so the marker's hashes are hashes of bytes, not 'absent'.
  writeText(path.join(dirs.corpusDir, 'voice', 'late-server.md'), 'D: you there?\nT: always.\n');
  writeText(dirs.inhibitionsPath, 'rules: []\n');
  writeText(dirs.couplingPath, 'matrix: {}\n');
  writeText(path.join(dirs.personaDir, 'ledger.md'), 'fixture ledger seed\n');
  writeText(path.join(dirs.personaDir, 'nightingale.md'), 'fixture nightingale seed\n');
  if (over.routing !== undefined) writeText(dirs.routingPath, over.routing);
  if (over.schedState !== undefined) writeText(dirs.schedStatePath, over.schedState);
  if (over.baseline !== undefined) writeText(dirs.baselinePath, over.baseline);

  const clock = over.clock ?? new TestClock(T0);
  const model = over.model ?? new MockModel({ clock });
  const runner =
    over.runner ??
    scriptedRunner([probeResult({ probeId: 'voice-cold-open', judgeMedian: 4.5, drift: { voice: 0.95 } })]);
  const log = recordingLog(over.l0 ?? []);

  const deps: SiblingDeps = {
    model,
    events: log,
    sched: { statePath: dirs.schedStatePath },
    probes: runner,
    baselinePath: dirs.baselinePath,
    deployMarkerPath: dirs.markerPath,
    routingPath: dirs.routingPath,
    reportsDir: dirs.reportsDir,
    clock,
    rng: makeRng('siblings'),
    marker: over.marker ?? {
      codeVersion: 'test-1',
      inhibitionsPath: dirs.inhibitionsPath,
      couplingPath: dirs.couplingPath,
      corpusDir: dirs.corpusDir,
    },
    personaDir: dirs.personaDir,
  };
  return { dirs, deps, model, clock, log, runner };
};

/** The two-job sched state the Ledger reads as "what actually ran". */
export const schedStateJson = (now: number): string =>
  JSON.stringify({
    version: 1,
    jobs: {
      'ledger-report': { consecutiveFailures: 0, lastAttempt: now - 30 * MIN, lastCompleted: now - 30 * MIN },
      'probe-on-deploy': { consecutiveFailures: 2, lastAttempt: now - MIN },
    },
  });

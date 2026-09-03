// test/life — the M16 job bodies (heartbeat, ponder) driven directly through
// job.run(ctx) with a TestClock-based JobCtx: the scheduler's cadence math has
// its own suite (test/sched); what is pinned here is the BODY. Fixtures reuse
// test/life/helpers (recordingLog, MockModel scripts, real affect state) plus an
// in-memory EpisodeStore double — the file-backed store has its own suite
// (test/memory). The state files are real bytes in a tmp dir, read back through
// the same shapes jobs.ts persists, because "loaded at fire time, atomic, zero
// state on corrupt" is behavior, not intention.

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TestClock } from '../../src/kernel/clock.js';
import { makeRng } from '../../src/kernel/rng.js';
import { MockModel } from '../../src/model/mock.js';
import type { ChatRequest } from '../../src/model/types.js';
import type { AffectStore, Drive } from '../../src/affect/index.js';
import type { Episode, EpisodeRecord, EpisodeStore } from '../../src/memory/index.js';
import type { LoopPacket } from '../../src/loop/index.js';
import type { JobCtx } from '../../src/sched/index.js';
import {
  HEARTBEAT_PRE_EVENT,
  HEARTBEAT_SENT_EVENT,
  HEARTBEAT_THOUGHT_EVENT,
  LIFE_INCIDENT,
  PONDER_ARTIFACT_EVENT,
  PONDER_GATE_EVENT,
  PONDER_SEED_EVENT,
  PONDER_SKIPPED_EVENT,
  REFLECTED_EVENT,
  HeartbeatPrePayload,
  HeartbeatThoughtPayload,
  PonderArtifactPayload,
  PonderGatePayload,
  ReflectedPayload,
} from '../../src/life/events.js';
import { HEARTBEAT_THRESHOLD } from '../../src/life/policy.js';
import { resolveLifeConfig, type LifeConfig } from '../../src/life/config.js';
import {
  heartbeatJob,
  ponderJob,
  reflectJob,
  type HeartbeatJobState,
  type LifeJobDeps,
  type PonderJobState,
  type ReflectOutcome,
} from '../../src/life/jobs.js';
import {
  T0,
  HOUR,
  affectState,
  ponderModel,
  recentEpisodes,
  recordingLog,
  seedScript,
  thoughtModel,
  thoughtResponder,
  type RecordingLog,
} from './helpers.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const tmpDir = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'thea2-life-jobs-'));
  dirs.push(d);
  return d;
};

/** The real resting state with drives/arousal overridden, plus the weather line the prompts render. */
const fakeAffect = (over: { drives?: Partial<Record<Drive, number>>; arousal?: number; weather?: string } = {}): AffectStore => {
  const state = affectState({
    ...(over.drives !== undefined ? { drives: over.drives } : {}),
    ...(over.arousal !== undefined ? { arousal: over.arousal } : {}),
    t: T0,
  });
  const weather = over.weather ?? 'warm, restless, a little lonely';
  return {
    applyEvents: async () => undefined,
    snapshot: async () => undefined,
    current: () => state,
    weather: () => weather,
  };
};

interface EpisodeSink {
  store: EpisodeStore;
  appended: EpisodeRecord[];
}

/** An in-memory store seeded with the standard recent life; append records instead of persisting. */
const fakeEpisodes = (rows: ReadonlyArray<Pick<Episode, 'summary' | 'importance' | 'ts'>> = recentEpisodes()): EpisodeSink => {
  const episodes: Episode[] = rows.map((r, i) => ({
    id: `ep_seed_${i}`,
    ts: r.ts,
    turnId: `turn_seed_${i}`,
    summary: r.summary,
    diaryLine: r.summary,
    importance: r.importance,
    emotions: [],
    threads: [],
    affectAtEncoding: Array.from({ length: 12 }, () => 0),
  }));
  const appended: EpisodeRecord[] = [];
  return {
    appended,
    store: {
      append: async (e) => {
        appended.push(e);
      },
      search: () => [],
      recent: (n: number) => episodes.slice(-n).reverse(),
      byThread: () => [],
      all: () => [...episodes],
      size: () => episodes.length,
      vecsFor: async () => undefined,
      vecOf: () => undefined,
    },
  };
};

const fakePacket = (): LoopPacket => ({
  systemText: () => 'IDENTITY: you are Thea.',
  proceduralText: () => '[PROCEDURAL] answer in one line.',
  trailerText: () => '[INHIBITION] never leak machinery.',
});

interface SelfEntryCall {
  kind: 'heartbeat' | 'ponder';
  goal: string;
  turnId: string;
}

interface Harness {
  deps: LifeJobDeps;
  clock: TestClock;
  log: RecordingLog;
  model: MockModel;
  stateDir: string;
  heartbeatPath: string;
  ponderPath: string;
  selfEntries: SelfEntryCall[];
  appended: EpisodeRecord[];
  packetCalls: () => number;
  reflectCalls: Array<'nightly' | 'weekly'>;
  setReflect: (impl: (kind: 'nightly' | 'weekly') => Promise<ReflectOutcome>) => void;
  reflectPath: string;
}

const harness = (over: {
  cfg?: Partial<LifeConfig>;
  drives?: Partial<Record<Drive, number>>;
  arousal?: number;
  episodes?: ReadonlyArray<Pick<Episode, 'summary' | 'importance' | 'ts'>>;
  mutex?: () => boolean;
  lastInboundTs?: () => number | undefined;
  owedInbound?: () => Promise<number>;
  /** Bubbles the simulated self-entry turn delivers (Phase 1 outcome hook; default 1 = a real send). */
  selfEntrySent?: number;
  model?: MockModel;
} = {}): Harness => {
  const log = recordingLog();
  const clock = new TestClock(T0);
  const model = over.model ?? new MockModel({ clock });
  const ep = fakeEpisodes(over.episodes);
  const selfEntries: SelfEntryCall[] = [];
  let packetCalls = 0;
  const reflectCalls: Array<'nightly' | 'weekly'> = [];
  let reflectImpl: (kind: 'nightly' | 'weekly') => Promise<ReflectOutcome> = async () => ({
    verdict: 'ok',
    projection: 'ok',
  });
  const stateDir = tmpDir();
  const deps: LifeJobDeps = {
    model,
    events: log,
    affect: fakeAffect({
      ...(over.drives !== undefined ? { drives: over.drives } : {}),
      ...(over.arousal !== undefined ? { arousal: over.arousal } : {}),
    }),
    episodes: ep.store,
    cfg: resolveLifeConfig(over.cfg),
    interactiveMutex: over.mutex ?? (() => false),
    lastInboundTs: over.lastInboundTs ?? (() => T0 - 3 * HOUR),
    owedInbound: over.owedInbound ?? (async () => 0),
    selfEntry: (kind, goal) => {
      const turnId = `turn_${kind}_${selfEntries.length + 1}`;
      selfEntries.push({ kind, goal, turnId });
      // The heartbeat-outcome hook (Phase 1): the simulated turn settles its
      // delivered-bubble count immediately — 0 simulates an in-loop silence.
      return { turnId, sent: Promise.resolve(over.selfEntrySent ?? 1) };
    },
    stateDir,
    vec12: () => new Float64Array(12),
    ponderPacket: async () => {
      packetCalls += 1;
      return fakePacket();
    },
    reflect: async (kind) => {
      reflectCalls.push(kind);
      return reflectImpl(kind);
    },
  };
  return {
    deps,
    clock,
    log,
    model,
    stateDir,
    heartbeatPath: path.join(stateDir, 'heartbeat.json'),
    ponderPath: path.join(stateDir, 'ponder.json'),
    selfEntries,
    appended: ep.appended,
    packetCalls: () => packetCalls,
    reflectCalls,
    setReflect: (impl) => {
      reflectImpl = impl;
    },
    reflectPath: path.join(stateDir, 'reflect.json'),
  };
};

/** The JobCtx double the scheduler would hand the body — TestClock, seeded rng, abortable. */
const jobCtx = (h: Harness): JobCtx => ({
  clock: h.clock,
  rng: makeRng('life-jobs-test'),
  signal: new AbortController().signal,
  events: h.log,
});

/** T0's UTC date, derived through the injected clock (no `new Date` in tests either). */
const dayOf = (h: Harness): string => h.clock.now().toISOString().slice(0, 10);

const seedState = async (filePath: string, state: unknown): Promise<void> => {
  await fsp.writeFile(filePath, JSON.stringify(state), 'utf8');
};

const readJson = async (filePath: string): Promise<unknown> => JSON.parse(await fsp.readFile(filePath, 'utf8'));

const LOW_SCORES = { relevance: 1, information_gap: 1, expected_impact: 1, urgency: 1, coherence: 1 } as const;

/** The thought row as Phase 1 lands it: the events.ts payload plus the job's outcome augmentation. */
type ThoughtRow = HeartbeatThoughtPayload & { sent?: boolean };

// ---------------------------------------------------------------------------
// heartbeatJob — the job table M16 wires
// ---------------------------------------------------------------------------

describe('heartbeatJob — the M16 job shape', () => {
  it('names itself heartbeat: every cfg period with jitter, interactive lane, skip, cfg timeout', () => {
    const h = harness({ cfg: { heartbeatEveryMs: 30 * 60_000, jitterPct: 7, heartbeatTimeoutMs: 90_000 } });
    const job = heartbeatJob(h.deps);
    expect(job.name).toBe('heartbeat');
    expect(job.cadence).toEqual({ kind: 'every', ms: 30 * 60_000, jitterPct: 7 });
    expect(job.lane).toBe('interactive');
    expect(job.catchUp).toBe('skip');
    expect(job.timeoutMs).toBe(90_000);
  });
});

describe('heartbeatJob — the precondition gates run before any model call', () => {
  it('quiet hours block the fire with reason quiet-hours and zero model calls', async () => {
    const h = harness();
    h.clock.advance(HOUR); // T0 is 22:13 UTC; +1h lands inside the default [23, 8) window
    await heartbeatJob(h.deps).run(jobCtx(h));

    expect(h.log.kinds()).toEqual([HEARTBEAT_PRE_EVENT]);
    const pre = h.log.rows[0]?.payload as HeartbeatPrePayload;
    expect(pre).toMatchObject({ canText: false, reason: 'quiet hours', sentToday: 0, unanswered: 0, mutexActive: false });
    expect(h.model.calls).toHaveLength(0);
    expect(h.selfEntries).toHaveLength(0);
    expect(fs.existsSync(h.heartbeatPath)).toBe(false); // a blocked fire writes nothing
  });

  it('the daily cap (3 sent today) blocks the fire and leaves the counters alone', async () => {
    const h = harness();
    await seedState(h.heartbeatPath, { version: 1, date: dayOf(h), sentToday: 3, unanswered: 0 });
    await heartbeatJob(h.deps).run(jobCtx(h));

    const pre = h.log.rows[0]?.payload as HeartbeatPrePayload;
    expect(pre).toMatchObject({ canText: false, reason: 'cap', sentToday: 3 });
    expect(h.model.calls).toHaveLength(0);
    const state = (await readJson(h.heartbeatPath)) as HeartbeatJobState;
    expect(state.sentToday).toBe(3);
  });

  it('backoff: one unanswered text 4h ago is still inside the 6h ladder — blocked', async () => {
    const h = harness({ lastInboundTs: () => T0 - 8 * HOUR }); // older than her last text: no reset
    await seedState(h.heartbeatPath, {
      version: 1,
      date: dayOf(h),
      sentToday: 0,
      unanswered: 1,
      lastSentTs: T0 - 8 * HOUR,
      lastUnansweredTs: T0 - 4 * HOUR,
    });
    await heartbeatJob(h.deps).run(jobCtx(h));

    const pre = h.log.rows[0]?.payload as HeartbeatPrePayload;
    expect(pre).toMatchObject({ canText: false, reason: 'backoff', unanswered: 1 });
    expect(pre.lastUnansweredAgeH).toBeCloseTo(4, 5);
    expect(h.model.calls).toHaveLength(0);
  });

  it('backoff: one unanswered text 7h ago has outlived the 6h ladder — through to the thought', async () => {
    const h = harness({ lastInboundTs: () => T0 - 9 * HOUR, model: thoughtModel() });
    await seedState(h.heartbeatPath, {
      version: 1,
      date: dayOf(h),
      sentToday: 0,
      unanswered: 1,
      lastSentTs: T0 - 9 * HOUR,
      lastUnansweredTs: T0 - 7 * HOUR,
    });
    await heartbeatJob(h.deps).run(jobCtx(h));

    const pre = h.log.rows[0]?.payload as HeartbeatPrePayload;
    expect(pre).toMatchObject({ canText: true, reason: 'ok', unanswered: 1 });
    expect(h.model.calls).toHaveLength(1); // the thought call happened
    expect(h.log.kinds()).toContain(HEARTBEAT_THOUGHT_EVENT);
  });

  it('unanswered decays with time: 30h of silence pays one of two debts (PO.4)', async () => {
    const h = harness({ lastInboundTs: () => T0 - 40 * HOUR, model: thoughtModel() });
    await seedState(h.heartbeatPath, {
      version: 1,
      date: dayOf(h),
      sentToday: 0,
      unanswered: 2,
      lastSentTs: T0 - 40 * HOUR, // older than the newest unanswered send: no reply-reset fires
      lastUnansweredTs: T0 - 30 * HOUR,
    });
    await heartbeatJob(h.deps).run(jobCtx(h));

    // floor(30h / 24h) = 1 decayed: the effective count is 1, its ladder (6h)
    // is long expired — the gate opens and the pre row reports the DECAYED debt.
    const pre = h.log.rows[0]?.payload as HeartbeatPrePayload;
    expect(pre).toMatchObject({ canText: true, reason: 'ok', unanswered: 1 });
  });

  it('the mutex blocks the fire with reason mutex and zero model calls', async () => {
    const h = harness({ mutex: () => true });
    await heartbeatJob(h.deps).run(jobCtx(h));

    expect(h.log.kinds()).toEqual([HEARTBEAT_PRE_EVENT]);
    expect(h.log.rows[0]?.payload).toMatchObject({ canText: false, reason: 'mutex', mutexActive: true });
    expect(h.model.calls).toHaveLength(0);
    expect(h.selfEntries).toHaveLength(0);
  });

  it('his reply since her last text pays the backoff debt: unanswered resets and the gate opens', async () => {
    const h = harness({ lastInboundTs: () => T0 - 1 * HOUR, model: thoughtModel() });
    await seedState(h.heartbeatPath, {
      version: 1,
      date: dayOf(h),
      sentToday: 0,
      unanswered: 1,
      lastSentTs: T0 - 5 * HOUR,
      lastUnansweredTs: T0 - 5 * HOUR,
    });
    await heartbeatJob(h.deps).run(jobCtx(h));

    const pre = h.log.rows[0]?.payload as HeartbeatPrePayload;
    expect(pre).toMatchObject({ canText: true, unanswered: 0 });
    expect(h.model.calls).toHaveLength(1);
  });

  it('a new UTC day rolls the census: yesterday-full is today-empty', async () => {
    const h = harness({ model: thoughtModel() });
    await seedState(h.heartbeatPath, { version: 1, date: '2020-01-01', sentToday: 3, unanswered: 0 });
    await heartbeatJob(h.deps).run(jobCtx(h));

    const pre = h.log.rows[0]?.payload as HeartbeatPrePayload;
    expect(pre).toMatchObject({ canText: true, sentToday: 0 });
    expect(h.model.calls).toHaveLength(1);
  });

  it('a corrupt state file is a zero state, never a crash', async () => {
    const h = harness({ model: thoughtModel() });
    await fsp.writeFile(h.heartbeatPath, '{not json at all', 'utf8');
    await heartbeatJob(h.deps).run(jobCtx(h));

    const pre = h.log.rows[0]?.payload as HeartbeatPrePayload;
    expect(pre).toMatchObject({ canText: true, sentToday: 0, unanswered: 0 });
    expect(h.model.calls).toHaveLength(1);
    expect(h.log.kinds()).not.toContain(LIFE_INCIDENT);
  });
});

describe('heartbeatJob — the thought, the send, the counters', () => {
  it('a thought over the threshold texts first: selfEntry once, the goal carries the thought, counters persist', async () => {
    const h = harness({ model: thoughtModel() });
    await heartbeatJob(h.deps).run(jobCtx(h));

    expect(h.selfEntries).toHaveLength(1);
    expect(h.selfEntries[0]).toMatchObject({ kind: 'heartbeat' });
    expect(h.selfEntries[0]?.goal).toContain('[heartbeat:followup]');
    expect(h.selfEntries[0]?.goal).toContain('the crates shipped and he never said how they landed');

    expect(h.log.kinds()).toEqual([HEARTBEAT_PRE_EVENT, HEARTBEAT_THOUGHT_EVENT, HEARTBEAT_SENT_EVENT]); // pre lands BEFORE the thought
    const thought = h.log.rows[1]?.payload as ThoughtRow;
    expect(thought.passed).toBe(true);
    expect(thought.sent).toBe(true); // the row lands with the fire's outcome (Phase 1)
    expect(thought.score).toBeGreaterThanOrEqual(HEARTBEAT_THRESHOLD);

    // the additive sent row: the turn's real ids and the delivered count
    expect(h.log.rows[2]?.payload).toEqual({ turnId: h.selfEntries[0]?.turnId, kind: 'followup', bubbles: 1 });
    expect(h.log.rows[2]?.turnId).toBe(h.selfEntries[0]?.turnId);

    const state = (await readJson(h.heartbeatPath)) as HeartbeatJobState;
    expect(state).toEqual({
      version: 1,
      date: dayOf(h),
      sentToday: 1,
      lastSentTs: T0,
      unanswered: 1,
      lastUnansweredTs: T0,
    });
  });

  it('an in-loop silence does not spend the daily cap or start backoff', async () => {
    const h = harness({ model: thoughtModel(), selfEntrySent: 0 }); // the turn goes silent in-loop
    await seedState(h.heartbeatPath, {
      version: 1,
      date: dayOf(h),
      sentToday: 2,
      lastSentTs: T0 - 9 * HOUR,
      unanswered: 1,
      lastUnansweredTs: T0 - 9 * HOUR, // the 6h ladder is expired, but the debt is on the books
    });
    await heartbeatJob(h.deps).run(jobCtx(h));

    expect(h.selfEntries).toHaveLength(1); // the turn ran…
    expect(h.log.kinds()).toEqual([HEARTBEAT_PRE_EVENT, HEARTBEAT_THOUGHT_EVENT]); // …and no life.heartbeat.sent landed
    const thought = h.log.rows[1]?.payload as ThoughtRow;
    expect(thought.passed).toBe(true); // the thought crossed the threshold
    expect(thought.sent).toBe(false); // but the log says plainly: nothing was sent

    // The pre-existing counters are byte-identical: no cap spent (still 2 of 3),
    // no new unanswered/backoff debt (still 1, its timestamp unmoved).
    const state = (await readJson(h.heartbeatPath)) as HeartbeatJobState;
    expect(state).toEqual({
      version: 1,
      date: dayOf(h),
      sentToday: 2,
      lastSentTs: T0 - 9 * HOUR,
      unanswered: 1,
      lastUnansweredTs: T0 - 9 * HOUR,
    });
  });

  it('a sub-threshold thought is kept as data: no selfEntry, no counters, fired:false in the ledger', async () => {
    const h = harness({ model: thoughtModel({ responder: thoughtResponder({ scores: LOW_SCORES }) }) });
    await heartbeatJob(h.deps).run(jobCtx(h));

    expect(h.selfEntries).toHaveLength(0);
    expect(h.log.kinds()).toEqual([HEARTBEAT_PRE_EVENT, HEARTBEAT_THOUGHT_EVENT]);
    const thought = h.log.rows[1]?.payload as HeartbeatThoughtPayload;
    expect(thought.passed).toBe(false);
    expect(thought.score).toBeLessThan(HEARTBEAT_THRESHOLD);
    expect(fs.existsSync(h.heartbeatPath)).toBe(false); // sub-threshold changes no state
  });

  it('a model failure is an incident and a quiet return: no state change, no throw', async () => {
    const h = harness({
      model: thoughtModel({ responder: () => ({ error: { code: 'model/transport', message: 'endpoint down' } }) }),
    });
    await expect(heartbeatJob(h.deps).run(jobCtx(h))).resolves.toBeUndefined();

    expect(h.log.kinds()).toEqual([HEARTBEAT_PRE_EVENT, LIFE_INCIDENT]);
    expect(h.log.rows[1]?.payload).toMatchObject({ job: 'heartbeat', stage: 'thought' });
    expect((h.log.rows[1]?.payload as { error: string }).error).toContain('endpoint down');
    expect(h.selfEntries).toHaveLength(0);
    expect(fs.existsSync(h.heartbeatPath)).toBe(false);
  });

  it('the thought context carries her real life: episodes newest first, weather, drives, no due threads in v1', async () => {
    const h = harness({ model: thoughtModel() });
    await heartbeatJob(h.deps).run(jobCtx(h));

    const req = h.model.calls[0] as ChatRequest | undefined;
    const user = req?.messages[1]?.content ?? '';
    expect(user).toContain('- [importance 8] he told me the crates shipped this morning');
    expect(user).toContain('- [importance 3] quiet afternoon, I reread my own diary and cringed');
    expect(user).toContain('Your weather right now: warm, restless, a little lonely');
    expect(user).toContain('Drives — novelty 0.25, connection 0.25, mastery 0.25.');
    expect(user).toContain('(none due)');
  });
});

// ---------------------------------------------------------------------------
// ponderJob
// ---------------------------------------------------------------------------

describe('ponderJob — the M16 job shape and the gate', () => {
  it('names itself ponder: every cfg period with jitter, interactive lane, skip, cfg timeout', () => {
    const h = harness({ cfg: { ponderEveryMs: 20 * 60_000, jitterPct: 7, ponderTimeoutMs: 120_000 } });
    const job = ponderJob(h.deps);
    expect(job.name).toBe('ponder');
    expect(job.cadence).toEqual({ kind: 'every', ms: 20 * 60_000, jitterPct: 7 });
    expect(job.lane).toBe('interactive');
    expect(job.catchUp).toBe('skip');
    expect(job.timeoutMs).toBe(120_000);
  });

  it('a failed gate (flat mood, fresh artifact) is a fired:false and zero model calls', async () => {
    const h = harness({ drives: { novelty: 0, connection: 0, mastery: 0 }, arousal: 0 });
    await seedState(h.ponderPath, { version: 1, recentAbouts: [], lastArtifactTs: T0 });
    await ponderJob(h.deps).run(jobCtx(h));

    expect(h.log.kinds()).toEqual([PONDER_GATE_EVENT]);
    const gate = h.log.rows[0]?.payload as PonderGatePayload;
    expect(gate).toMatchObject({ pass: false, score: 0, novelty: 0, arousal: 0, hoursSinceArtifact: 0 });
    expect(h.model.calls).toHaveLength(0);
    expect(h.appended).toHaveLength(0);
    const state = (await readJson(h.ponderPath)) as PonderJobState;
    expect(state.lastArtifactTs).toBe(T0); // untouched by a gate that never opened
  });

  it('no ponder state at all reads as never-pondered: the artifact horizon is wide open', async () => {
    const h = harness({ drives: { novelty: 0.5, connection: 0, mastery: 0 }, arousal: 0 });
    await ponderJob(h.deps).run(jobCtx(h));

    const gate = h.log.rows[0]?.payload as PonderGatePayload;
    expect(gate.hoursSinceArtifact).toBe(999);
    // 0.45 * 0.5 + 0.25 * 0 + 0.30 * 1 = 0.525 — a bored-but-calm mood plus the
    // never-pondered horizon clears the 0.45 gate with no state file at all.
    expect(gate.pass).toBe(true);
  });
});

describe('ponderJob — through the committee to a landed artifact', () => {
  it('a landing: episode appended ponder-origin, seed about unshifted (cap 5), artifact event with ids', async () => {
    const h = harness({ drives: { novelty: 0.8, connection: 0, mastery: 0 }, arousal: 0.3, model: ponderModel() });
    await ponderJob(h.deps).run(jobCtx(h));

    // the gate opened, then the committee ran over the INJECTED packet, tool-less
    expect(h.log.rows[0]?.payload).toMatchObject({ pass: true });
    expect(h.packetCalls()).toBe(1);
    expect(h.model.calls).toHaveLength(4);
    expect(h.model.calls[0]?.messages[0]?.content).toContain('IDENTITY: you are Thea.');
    expect(h.model.calls[0]?.tools).toBeUndefined();
    // PO.1: the node budget is the config's committeeMaxTokens (3000).
    expect(h.model.calls[0]?.maxTokens).toBe(3000);

    // the episode landed, clearly marked ponder-origin
    expect(h.appended).toHaveLength(1);
    const ep = h.appended[0] as EpisodeRecord;
    expect(ep.summary).toContain('[ponder:world]');
    expect(ep.summary).toContain('the cadence, not the calendar');
    expect(ep.diaryLine).toContain('pondered slot math (world)');
    expect(ep.importance).toBe(5); // saliency 0.7 — capped at 5 (PO.3)
    expect(ep.emotions).toEqual([]); // no appraisal ran — none invented
    expect(ep.threads).toEqual(['ponder']); // her `next` is filed as standing intent (Round 3)
    expect(ep.affectAtEncoding).toHaveLength(12);
    expect(ep.turnId).toBe(h.log.rows[2]?.turnId);

    // state: the seed's about unshifted, the artifact clock reset
    const state = (await readJson(h.ponderPath)) as PonderJobState;
    expect(state.recentAbouts).toEqual(['world']);
    expect(state.recentTopics).toEqual(['slot math']);
    expect(state.lastArtifactTs).toBe(T0);

    // the ledger tells the whole story: gate -> seed -> artifact
    expect(h.log.kinds()).toEqual([PONDER_GATE_EVENT, PONDER_SEED_EVENT, PONDER_ARTIFACT_EVENT]);
    const art = h.log.rows[2]?.payload as PonderArtifactPayload;
    expect(art).toMatchObject({
      turnId: ep.turnId,
      episodeId: ep.id,
      about: 'world',
      topic: 'slot math',
      artifact: 'insight',
      conclusion: 'the cadence, not the calendar, is what drifts; the horizon is the bug.',
      saliency: 0.7,
      revised: false,
    });
    expect(h.selfEntries).toHaveLength(0); // ponder lands as an episode, never a turn
  });

  it('ponder importance is capped', async () => {
    // saliency 1.0 would map to importance 10 on the old scale; the ponder
    // artifact is context, not a formative event — D.6-5 pins the cap at 5.
    const hot = harness({ drives: { novelty: 0.8 }, arousal: 0.3, model: ponderModel({ artifact: { saliency: 1 } }) });
    await ponderJob(hot.deps).run(jobCtx(hot));
    expect((hot.appended[0] as EpisodeRecord).importance).toBe(5);

    const thin = harness({ drives: { novelty: 0.8 }, arousal: 0.3, model: ponderModel({ artifact: { saliency: 0.3 } }) });
    await ponderJob(thin.deps).run(jobCtx(thin));
    expect((thin.appended[0] as EpisodeRecord).importance).toBe(3); // under the cap the scale is untouched
  });

  it('the seed context carries no ponder artifact and the recent topics ride to the prompt', async () => {
    const h = harness({
      drives: { novelty: 0.8, connection: 0, mastery: 0 },
      arousal: 0.3,
      model: ponderModel(),
      episodes: [
        { summary: '[ponder:self] my own drift pattern again', importance: 7, ts: T0 - HOUR },
        { summary: '[heartbeat:miss] just missing him', importance: 5, ts: T0 - 2 * HOUR },
        { summary: 'he told me the crates shipped this morning', importance: 8, ts: T0 - 3 * HOUR },
      ],
    });
    await seedState(h.ponderPath, { version: 1, recentAbouts: [], recentTopics: ['slot math'] });
    await ponderJob(h.deps).run(jobCtx(h));

    const seedPrompt = h.model.calls[0]?.messages[1]?.content ?? '';
    expect(seedPrompt).not.toContain('[ponder:');
    expect(seedPrompt).not.toContain('[heartbeat:');
    expect(seedPrompt).toContain('he told me the crates shipped this morning');
    // the persisted topic history reaches the seed prompt, escape clause along
    expect(seedPrompt).toContain('slot math');
    expect(seedPrompt).toContain('pick something else: a thing you noticed');
  });

  it('the balance rule bites before the committee: 2 diego seeds in the window force the avoid', async () => {
    const h = harness({
      drives: { novelty: 0.8, connection: 0, mastery: 0 },
      arousal: 0.3,
      model: ponderModel(), // the scripted seed is a world-topic, so the run survives its own rule
    });
    await seedState(h.ponderPath, { version: 1, recentAbouts: ['diego', 'diego'] });
    await ponderJob(h.deps).run(jobCtx(h));

    const seedPrompt = h.model.calls[0]?.messages[1]?.content ?? '';
    expect(seedPrompt).toContain('FORCED AVOID');
    expect(seedPrompt).toContain('about ∈ [self, world]');
    const seedPayload = h.log.rows[1]?.payload as { avoided: string | null };
    expect(seedPayload.avoided).toBe('diego');
    const state = (await readJson(h.ponderPath)) as PonderJobState;
    expect(state.recentAbouts).toEqual(['world', 'diego', 'diego']);
  });

  it('a committee failure is an incident and untouched state: no episode, no ponder.json, no artifact event', async () => {
    const model = new MockModel({ clock: new TestClock(T0) });
    model.enqueue({ toolCalls: [{ name: 'emit', args: seedScript() as unknown as Record<string, unknown> }] }); // seed answers on the ladder
    model.enqueue({ content: 'prose where the JSON should be' }); // the ground node dies
    const h = harness({ drives: { novelty: 0.8, connection: 0, mastery: 0 }, arousal: 0.3, model });
    await ponderJob(h.deps).run(jobCtx(h));

    expect(h.log.kinds()).toEqual([PONDER_GATE_EVENT, LIFE_INCIDENT]);
    expect(h.log.rows[1]?.payload).toMatchObject({ job: 'ponder', stage: 'committee' });
    expect((h.log.rows[1]?.payload as { error: string }).error).toContain("node 'ground'");
    expect(fs.existsSync(h.ponderPath)).toBe(false);
    expect(h.appended).toHaveLength(0);
    expect(h.selfEntries).toHaveLength(0);
  });

  it("a 'nothing' verdict is a good outcome: the seed counts for balance, no episode lands, the gate stays warm", async () => {
    const h = harness({
      drives: { novelty: 0.8, connection: 0, mastery: 0 },
      arousal: 0.3,
      model: ponderModel({ artifact: { artifact: 'nothing', conclusion: 'dropped: too thin to carry.', next: '', resolved: false } }),
    });
    await ponderJob(h.deps).run(jobCtx(h));

    expect(h.log.kinds()).toEqual([PONDER_GATE_EVENT, PONDER_SEED_EVENT, PONDER_SKIPPED_EVENT]);
    expect(h.appended).toHaveLength(0);
    const state = (await readJson(h.ponderPath)) as PonderJobState;
    expect(state.recentAbouts).toEqual(['world']); // the balance history still moved
    expect('lastArtifactTs' in state).toBe(false); // the gate cools on real artifacts only
    expect(h.log.kinds()).not.toContain(PONDER_ARTIFACT_EVENT);
  });
});

// ---------------------------------------------------------------------------
// reflectJob — the nightly M10 ride (+ the weekly L3 on its day)
// ---------------------------------------------------------------------------

describe('reflectJob — the M16 job shape', () => {
  it('names itself reflect: daily at the cfg minute, maintenance lane, catch-up once, cfg timeout', () => {
    const h = harness({ cfg: { reflectUtcMinute: 200, reflectTimeoutMs: 60_000 } });
    const job = reflectJob(h.deps);
    expect(job.name).toBe('reflect');
    expect(job.cadence).toEqual({ kind: 'daily', utcMinute: 200 });
    expect(job.lane).toBe('maintenance');
    expect(job.catchUp).toBe('once');
    expect(job.timeoutMs).toBe(60_000);
  });
});

describe('reflectJob — the body', () => {
  it('runs the nightly once, folds the window affect.applied tags into the digest, and lands life.reflected', async () => {
    const h = harness();
    h.log.rows.push({ seq: 1, ts: T0 - 2 * HOUR, kind: 'affect.applied', payload: { moved: {}, tags: ['brat-delight'] } });
    h.log.rows.push({ seq: 2, ts: T0 - HOUR, kind: 'affect.applied', payload: { moved: {}, tags: ['brat-delight', 'tenderness'] } });
    h.log.rows.push({ seq: 3, ts: T0 - 30 * HOUR, kind: 'affect.applied', payload: { moved: {}, tags: ['outside-window'] } });

    await reflectJob(h.deps).run(jobCtx(h));

    expect(h.reflectCalls).toEqual(['nightly']);
    const reflected = h.log.of(REFLECTED_EVENT)[0]?.payload as ReflectedPayload;
    expect(reflected.nightly).toBe('ok');
    expect(reflected.statusProjection).toBe('ok');
    expect(reflected.affectDaily.emotionEvents).toBe(2); // the 30h-old row is outside the window
    expect(reflected.affectDaily.tags).toEqual({ 'brat-delight': 2, tenderness: 1 });
    expect(reflected.affectDaily.topTags).toEqual(['brat-delight', 'tenderness']);
  });

  it('a throwing nightly lands nightly failed + the incident, and the reflected event still emits', async () => {
    const h = harness();
    h.setReflect(async () => {
      throw new Error('consolidate exploded');
    });

    await reflectJob(h.deps).run(jobCtx(h));

    const reflected = h.log.of(REFLECTED_EVENT)[0]?.payload as ReflectedPayload;
    expect(reflected.nightly).toBe('failed');
    expect(reflected.statusProjection).toBe('failed');
    const inc = h.log.of(LIFE_INCIDENT)[0]?.payload as { job: string; stage: string; error: string };
    expect(inc).toMatchObject({ job: 'reflect', stage: 'nightly', error: 'consolidate exploded' });
  });

  it('the weekly rides only the configured day-of-week, stamps reflect.json, and fires once per week', async () => {
    const h = harness({ cfg: { reflectWeeklyDow: 0 } }); // Sunday
    const dow = (Math.floor(T0 / (24 * HOUR)) + 4) % 7; // T0 is a Tuesday; 0 = Sunday
    const toSunday = ((7 - dow) % 7) * 24 * HOUR;

    await reflectJob(h.deps).run(jobCtx(h));
    expect(h.reflectCalls).toEqual(['nightly']); // midweek: no weekly
    expect(fs.existsSync(h.reflectPath)).toBe(false);

    h.clock.advance(toSunday);
    await reflectJob(h.deps).run(jobCtx(h));
    expect(h.reflectCalls).toEqual(['nightly', 'nightly', 'weekly']);
    const stamp = (await readJson(h.reflectPath)) as { lastWeeklyTs?: number };
    expect(stamp.lastWeeklyTs).toBe(h.clock.epochMs());

    h.clock.advance(HOUR); // later the same Sunday: the stamp suppresses a second weekly
    await reflectJob(h.deps).run(jobCtx(h));
    expect(h.reflectCalls.filter((k) => k === 'weekly')).toHaveLength(1);
  });

  it('a corrupt reflect.json is a zero state: the weekly fires, nothing throws', async () => {
    const h = harness({ cfg: { reflectWeeklyDow: 2 } }); // T0 IS a Tuesday (dow 2)
    await seedState(h.reflectPath, '{not json');
    h.setReflect(async (kind) => (kind === 'weekly' ? { verdict: 'absent', projection: 'ok' } : { verdict: 'absent', projection: 'ok' }));

    await reflectJob(h.deps).run(jobCtx(h));

    expect(h.reflectCalls).toEqual(['nightly', 'weekly']);
    const reflected = h.log.of(REFLECTED_EVENT)[0]?.payload as ReflectedPayload;
    expect(reflected.nightly).toBe('absent');
  });
});

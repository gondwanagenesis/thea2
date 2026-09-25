// M20 app — the v8 composition root ("Nothing Told", plan thea2-v8-nothing-told.md).
//
// Same boot order and plumbing as compose.ts (events → embedder → stores →
// gate/coupling → model → channel/ledger → pipeline → scheduler), with the
// exemplar corpus replaced by the mind (src/mind). Two model clients: the
// primary voice door (OpenAI Sol, effort locked to none) and a fallback voice
// door (Neuralwatt glm-5.3) tried once when a turn fails outright. Thea1 is
// never touched: every path below lives under this process's var/.

import { readFileSync } from 'node:fs';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fail, makeRng, SystemClock, TestClock, type Clock, type Rng } from '../kernel/index.js';
import { openEventLog, type EventLog } from '../events/index.js';
import { chatCore, createModelClient, makeRouter, MockModel, zaiTransport, type ModelClient, type Transport } from '../model/index.js';
import { makeHashEmbedder, type Embedder } from '../embed/index.js';
import { openAffectStore, type AffectStore } from '../affect/index.js';
import { setDominanceBaseline } from '../affect/vocab.js';
import { compileCoupling, signature, COUPLING_BASELINES, type CompiledCoupling } from '../coupling/index.js';
import { openSessionWindow, type SessionWindow } from '../memory/index.js';
import { compileGate, type InhibitionGate } from '../inhibit/index.js';
import { createToolRegistry, resolveLoopConfig, type LoopConfig } from '../loop/index.js';
import { openMessageLedger, openOffsetStore, telegramChannel, FakeChannel, type Channel, type MessageLedger, type OffsetStore } from '../bridge/index.js';
import { startScheduler, type Job, type SchedulerHandle } from '../sched/index.js';
import {
  hourIn,
  makeMindPipeline,
  metabolism,
  openMindStore,
  sleepJob,
  wanderJob,
  type MindPipeline,
  type MindStore,
} from '../mind/index.js';
import { makeEmbedder } from './embedder.js';
import { withStderrMirror } from './compose.js';
import { affectSnapshotJob, reconcileJob, runReconcile, type RecoverLostDeps } from './maintenance-jobs.js';
import type { Thea2Config, ResolvedDoor } from './config.js';

export type ComposeV8Preset = 'prod' | 'hermetic' | 'probe-harness';

export interface ComposeV8Opts {
  varDir?: string | undefined;
  clock?: Clock | undefined;
  rng?: Rng | undefined;
  model?: ModelClient | undefined;
  fallbackModel?: ModelClient | undefined;
  channel?: Channel | undefined;
  embedder?: Embedder | undefined;
  fetchImpl?: typeof fetch | undefined;
  /** Scheduler jobs — hermetic tests inject their own (usually none). */
  jobs?: Job[] | undefined;
}

export interface V8System {
  cfg: Thea2Config;
  preset: ComposeV8Preset;
  clock: Clock;
  rng: Rng;
  events: EventLog;
  affect: AffectStore;
  window: SessionWindow;
  ledger: MessageLedger;
  offsets: OffsetStore;
  channel: Channel;
  gate: InhibitionGate;
  coupling: CompiledCoupling;
  mind: MindStore;
  loopCfg: LoopConfig;
  pipeline: MindPipeline;
  sched: SchedulerHandle;
  jobNames: readonly string[];
  reconcile: () => Promise<void>;
  stop(): Promise<void>;
}

const readRoot = (file: string): string => {
  try {
    return readFileSync(file, 'utf8');
  } catch (e) {
    return fail('app/boot-failed', `stage gates: cannot read ${file}`, e);
  }
};

/** His local hour → the UTC minute-of-day the daily job fires (DST drift of an hour is fine for sleep). */
export const utcMinuteForLocalHour = (localHour: number, now: number, timeZone: string): number => {
  const offset = (hourIn(now, timeZone) - hourIn(now, 'UTC') + 24) % 24;
  return (((localHour - offset) % 24) + 24) % 24 * 60;
};

export const composeV8 = async (cfg: Thea2Config, preset: ComposeV8Preset = 'prod', opts: ComposeV8Opts = {}): Promise<V8System> => {
  if (cfg.mind === undefined) return fail('app/config-invalid', 'composeV8 needs the mind block (mind.engine: v8)');
  const mindCfg = cfg.mind;
  const clock = opts.clock ?? (preset === 'prod' ? new SystemClock() : new TestClock(0));
  const rng = opts.rng ?? makeRng(preset === 'prod' ? 'thea2-v8-prod' : 'thea2-v8-hermetic');

  const base = opts.varDir ?? process.cwd();
  const v = (p: string): string => path.resolve(base, p);
  const paths = {
    events: v('var/events'),
    ledger: v('var/ledger'),
    memory: v('var/memory'),
    affectState: v(cfg.affect.statePath),
    schedState: v(cfg.sched.statePath),
    offsets: v('var/telegram-offset.json'),
    mind: v(mindCfg.dir),
  };
  for (const d of [paths.events, paths.ledger, paths.memory, path.dirname(paths.affectState), path.dirname(paths.schedState), path.dirname(paths.offsets), paths.mind]) {
    fs.mkdirSync(d, { recursive: true });
  }

  const rawEvents = openEventLog(paths.events, { clock });
  const events = preset === 'prod' ? withStderrMirror(rawEvents) : rawEvents;
  await events.emit('app.boot', { stage: 'events', preset, mind: 'v8' });

  const embedder =
    opts.embedder ??
    (preset === 'hermetic'
      ? makeHashEmbedder()
      : makeEmbedder(cfg.embedder, { baseUrl: cfg.models.endpoint, apiKey: cfg.models.apiKey, ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}) }));
  await events.emit('app.boot', { stage: 'embedder', embedder: embedder.id, dim: embedder.dim });

  const affect = openAffectStore(paths.affectState, { clock, rng, events });
  setDominanceBaseline(cfg.affect.dominanceBaseline ?? 0.0);
  await affect.snapshot();
  const mind = openMindStore(paths.mind, embedder.dim);
  await events.emit('app.boot', {
    stage: 'stores',
    moments: mind.moments().length,
    precedents: mind.precedents().length,
    concerns: mind.openConcerns().length,
    selfLines: mind.self().length,
  });

  const root = process.cwd();
  const tools = createToolRegistry();
  // v8 reads its own matrix (coupling-v8.yaml: the anti-escalation law made true
  // on real felt signatures); v7's coupling.yaml stays untouched for v7.
  const couplingPath = fs.existsSync(path.resolve(root, 'coupling-v8.yaml')) ? path.resolve(root, 'coupling-v8.yaml') : path.resolve(root, 'coupling.yaml');
  const coupling = compileCoupling(readRoot(couplingPath));
  const doors = cfg.models.doors;
  const gate = compileGate(readRoot(path.resolve(root, 'corpus', 'canon', 'inhibitions.yaml')), {
    ownerChatId: String(cfg.bridge.allowedChatIds[0]),
    secrets: [
      cfg.bridge.botToken,
      cfg.models.apiKey,
      doors.mind.apiKey,
      doors.judge.apiKey,
      ...(doors.voiceFallback !== undefined ? [doors.voiceFallback.apiKey] : []),
    ],
    knownTools: tools.names(),
  });
  await events.emit('app.boot', { stage: 'gates' });

  const doorTransport = (d: ResolvedDoor, name: string): Transport =>
    zaiTransport({
      apiKey: d.apiKey,
      endpoint: d.endpoint,
      protocol: d.protocol,
      clock,
      rng: rng.fork(`door-${name}`),
      ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
    });
  const clientFor = (voice: ResolvedDoor, voiceName: string): ModelClient =>
    createModelClient({
      log: events,
      clock,
      core: chatCore({
        router: makeRouter({ log: events, tiers: { main: voice.model, cheap: doors.mind.model, reasoning: doors.judge.model }, doors: { voice, mind: doors.mind, judge: doors.judge } }),
        doors: {
          main: { door: voice, send: doorTransport(voice, voiceName) },
          cheap: { door: doors.mind, send: doorTransport(doors.mind, 'mind') },
          reasoning: { door: doors.judge, send: doorTransport(doors.judge, 'judge') },
        },
      }),
    });
  let model: ModelClient;
  let fallbackModel: ModelClient | undefined;
  if (opts.model !== undefined) {
    model = opts.model;
    fallbackModel = opts.fallbackModel;
  } else if (preset === 'hermetic') {
    model = new MockModel({ clock });
    fallbackModel = opts.fallbackModel;
  } else {
    model = clientFor(doors.voice, 'voice');
    fallbackModel = doors.voiceFallback !== undefined ? clientFor(doors.voiceFallback, 'voiceFallback') : undefined;
  }

  const channel =
    opts.channel ??
    (preset === 'prod'
      ? telegramChannel({ token: cfg.bridge.botToken, clock, rng: rng.fork('bridge'), committedOffset: async () => (await offsets.read()).committed, log: events })
      : FakeChannel({ clock }));
  const ledger = openMessageLedger(paths.ledger, { clock, reconcileWindowMs: cfg.reconcile.lostReplyWindowMin * 60_000 });
  const offsets = openOffsetStore(paths.offsets);

  const loopCfg = resolveLoopConfig({ turnTokenBudget: cfg.budgets.turnTokens });
  const window = openSessionWindow(paths.memory, { model, clock, events });

  // First boot after the fork: her last conversation (written by the importer) becomes her window.
  const seedPath = path.join(paths.mind, 'window-seed.jsonl');
  if (fs.existsSync(seedPath)) {
    const lines = readFileSync(seedPath, 'utf8').split('\n').filter((l) => l.trim() !== '');
    for (const l of lines) {
      try {
        const msg = JSON.parse(l) as { role: 'user' | 'assistant'; content: string; ts: number; turnId: string };
        await window.push(msg);
      } catch {
        /* a bad seed line is skipped, never fatal */
      }
    }
    fs.renameSync(seedPath, `${seedPath}.done`);
    await events.emit('app.boot', { stage: 'window-seed', lines: lines.length });
  }

  const personLabel = (person: string): string | undefined => cfg.people[person]?.name;
  const budgetLeft = (): number => {
    const w = mind.state().wander;
    return mindCfg.thoughtsPerDay === 0 ? 0 : Math.max(0, 1 - w.thoughts / mindCfg.thoughtsPerDay);
  };

  const pipeline = makeMindPipeline({
    model,
    ...(fallbackModel !== undefined ? { fallbackModel } : {}),
    gate,
    tools,
    channel,
    ledger,
    affect,
    baselines: COUPLING_BASELINES,
    coupling,
    window,
    embedder,
    events,
    clock,
    rng,
    mind,
    loopCfg,
    allowedChatIds: cfg.bridge.allowedChatIds,
    reconcileWindowMs: cfg.reconcile.lostReplyWindowMin * 60_000,
    personLabel,
    timezone: cfg.timezone,
    budgetLeft,
  });
  await events.emit('app.boot', { stage: 'pipeline', mind: 'v8', fallback: fallbackModel !== undefined });

  const CONVERSATION_QUIET_MS = 10 * 60_000;
  const conversationActive = (): boolean =>
    pipeline.isBusy() || clock.epochMs() - (pipeline.lastInboundAtMs() ?? Number.NEGATIVE_INFINITY) < CONVERSATION_QUIET_MS;

  const reconcileRerun = new Set<number>();
  const reconcileDeps: RecoverLostDeps = {
    ledger,
    events,
    pipeline,
    window: {
      pushPending: async (msg) => {
        if (window.pushPending === undefined) return fail('app/boot-failed', 'stage pipeline: the session window lacks pushPending');
        await window.pushPending(msg);
      },
    },
    rerun: reconcileRerun,
  };

  let jobs: Job[] = opts.jobs ?? [];
  if (opts.jobs === undefined) {
    jobs = [
      reconcileJob(reconcileDeps),
      affectSnapshotJob({ affect }),
      wanderJob({
        mind,
        affect,
        model,
        embedder,
        events,
        clock,
        rng: rng.fork('wander'),
        cfg: () => ({
          thoughtsPerDay: mindCfg.thoughtsPerDay,
          textFirstPerDay: mindCfg.textFirstPerDay,
          quietHours: cfg.affect.quietHours,
          timeZone: cfg.timezone,
          patienceMin: metabolism(affect.current(), signature(affect.current(), COUPLING_BASELINES), {
            hourLocal: hourIn(clock.epochMs(), cfg.timezone),
            budgetLeft: budgetLeft(),
          }).patienceMin,
        }),
        conversationActive,
        selfEntry: (goal) => pipeline.selfEntry('heartbeat', goal).sent,
      }),
      sleepJob({ mind, model, events, clock, timeZone: cfg.timezone }, utcMinuteForLocalHour(mindCfg.sleepHourLocal, clock.epochMs(), cfg.timezone)),
    ];
  }
  const sched = startScheduler(jobs, { clock, rng, events, statePath: paths.schedState, interactiveMutex: conversationActive });
  await events.emit('app.boot', { stage: 'scheduler', jobs: jobs.map((j) => j.name) });

  let stopped = false;
  const system: V8System = {
    cfg,
    preset,
    clock,
    rng,
    events,
    affect,
    window,
    ledger,
    offsets,
    channel,
    gate,
    coupling,
    mind,
    loopCfg,
    pipeline,
    sched,
    jobNames: jobs.map((j) => j.name),
    reconcile: async () => {
      await runReconcile(reconcileDeps, clock.epochMs());
    },
    stop: async () => {
      if (stopped) return;
      stopped = true;
      await pipeline.drain();
      await mind.flush();
      await sched.stop();
      await events.emit('app.boot', { stage: 'stopped' });
    },
  };
  await events.emit('app.boot', { stage: 'bridge', channel: preset === 'prod' ? 'telegram' : 'fake', mind: 'v8' });
  return system;
};

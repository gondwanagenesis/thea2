// M20 app — the composition root. Boot order is the contract (spec §Boot):
// config (caller) → kernel → L0 event log → stores → gate+coupling compile →
// pipeline → scheduler → bridge, each stage emitting `app.boot {stage}` so a
// failed boot NAMES its stage. M20 is the only module that imports everything;
// every module below it staysComposition-blind by depcruise law.
//
// Presets:
//   prod          — real everything. Jobs of unlanded stages are absent (rule 5).
//   hermetic      — TestClock, seeded rng, MockModel, FakeChannel, hash embedder,
//                   var/ redirected under opts.varDir. The e2e proofs run here.
//   probe-harness — hermetic doubles EXCEPT the model, which is real. Never
//                   touches live stores, never Telegram (FakeChannel by law).

import { readFileSync } from 'node:fs';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fail, makeRng, SystemClock, TestClock, type Clock, type Rng } from '../kernel/index.js';
import { openEventLog, type EventLog } from '../events/index.js';
import { createZaiClient, makeRouter, MockModel, type ModelClient } from '../model/index.js';
import { makeHashEmbedder, type Embedder } from '../embed/index.js';
import { openAffectStore, type AffectStore } from '../affect/index.js';
import { compileCoupling, signature, COUPLING_BASELINES, type CompiledCoupling, type Vec12 } from '../coupling/index.js';
import { openCorpusIndex, type OpenedCorpus } from '../corpus/corpus-index.js';
import { loadControls } from '../corpus/controls.js';
import { corpusNominator } from '../corpus/nominator.js';
import {
  episodicNominator,
  openEpisodeStore,
  openProceduralStore,
  openSessionWindow,
  proceduralNominator,
  type EpisodeStore,
  type ProceduralStore,
  type SessionWindow,
} from '../memory/index.js';
import {
  assemble,
  assembleConfigFromControls,
  DEFAULT_ASSEMBLE_CONFIG,
  type AssembleConfig,
  type AssembleDeps,
  type Nominator,
  type Packet,
  type TurnQuery,
} from '../assemble/index.js';
import { compileGate, type InhibitionGate } from '../inhibit/index.js';
import { createToolRegistry, resolveLoopConfig, type LoopConfig, type ToolRegistry } from '../loop/index.js';
import type { FakeChannelExtras, Channel, MessageLedger, OffsetStore } from '../bridge/index.js';
import { openMessageLedger, openOffsetStore, telegramChannel, FakeChannel } from '../bridge/index.js';
import { startScheduler, type Job, type SchedulerHandle } from '../sched/index.js';
import { heartbeatJob, ponderJob, reflectJob, type LifeJobDeps } from '../life/jobs.js';
import { resolveLifeConfig } from '../life/config.js';
import { readRoutingTable } from '../siblings/index.js';
import {
  consolidateNightly,
  consolidateWeekly,
  nightlyConfig,
  WEEK_MS,
  type ConsolidateDeps,
} from '../consolidate/index.js';
import type { ProbeTarget } from '../probes/index.js';
import { makePipeline, type Pipeline } from './pipeline.js';
import { makeEmbedder } from './embedder.js';
import type { Thea2Config } from './config.js';

export type ComposePreset = 'prod' | 'hermetic' | 'probe-harness';

export interface ComposeOpts {
  /** Redirects every var/ path (tests use a tmp dir). Canon stays where the process cwd points. */
  varDir?: string | undefined;
  clock?: Clock | undefined;
  rng?: Rng | undefined;
  model?: ModelClient | undefined;
  channel?: Channel | undefined;
  embedder?: Embedder | undefined;
  fetchImpl?: typeof fetch | undefined;
  /** Scheduler jobs — hermetic tests inject their table; a real boot wires the life jobs by default. */
  jobs?: Job[] | undefined;
}

/** The wired system. Nothing here is optional: a composed system is a runnable system. */
export interface System {
  cfg: Thea2Config;
  preset: ComposePreset;
  clock: Clock;
  rng: Rng;
  events: EventLog;
  affect: AffectStore;
  episodes: EpisodeStore;
  procedures: ProceduralStore;
  corpus: OpenedCorpus;
  window: SessionWindow;
  ledger: MessageLedger;
  offsets: OffsetStore;
  channel: Channel;
  gate: InhibitionGate;
  coupling: CompiledCoupling;
  loopCfg: LoopConfig;
  pipeline: Pipeline;
  sched: SchedulerHandle;
  /** The wired job table — status reports it; thead boots it. */
  jobCount: number;
  paths: SystemPaths;
  probeTarget(): ProbeTarget;
  /** Settle in-flight turns + afterturns, stop the scheduler. Idempotent-ish: safe to call twice. */
  stop(): Promise<void>;
}

export interface SystemPaths {
  base: string;
  canon: string;
  events: string;
  ledger: string;
  memory: string;
  corpusCache: string;
  affectState: string;
  schedState: string;
  offsets: string;
}

const readCanon = (file: string): string => {
  try {
    return readFileSync(file, 'utf8');
  } catch (e) {
    return fail('app/boot-failed', `stage gates: cannot read ${file}`, e);
  }
};

export const compose = async (cfg: Thea2Config, preset: ComposePreset = 'prod', opts: ComposeOpts = {}): Promise<System> => {
  // ---- kernel ------------------------------------------------------------
  const clock = opts.clock ?? (preset === 'prod' ? new SystemClock() : new TestClock(0));
  const rng = opts.rng ?? makeRng(preset === 'prod' ? 'thea2-prod' : 'thea2-hermetic');

  const base = opts.varDir ?? process.cwd();
  const v = (p: string): string => path.resolve(base, p);
  // Canon lives with the process root — corpus/canon, coupling.yaml at the
  // repo/install root. It is NOT redirected by varDir: identity is not state.
  const canon = path.resolve(process.cwd(), 'corpus', 'canon');
  const paths: SystemPaths = {
    base,
    canon,
    events: v('var/events'),
    ledger: v('var/ledger'),
    memory: v('var/memory'),
    corpusCache: v('var/cache/corpus'),
    affectState: v(cfg.affect.statePath),
    schedState: v(cfg.sched.statePath),
    offsets: v('var/telegram-offset.json'),
  };
  for (const d of [paths.events, paths.ledger, paths.memory, paths.corpusCache, path.dirname(paths.affectState), path.dirname(paths.schedState), path.dirname(paths.offsets)]) {
    fs.mkdirSync(d, { recursive: true });
  }

  // ---- L0 event log ------------------------------------------------------
  const events = openEventLog(paths.events, { clock });
  await events.emit('app.boot', { stage: 'events', preset });

  // ---- embedder ----------------------------------------------------------
  const embedder =
    opts.embedder ??
    (preset === 'hermetic'
      ? makeHashEmbedder()
      : makeEmbedder(cfg.embedder, { baseUrl: cfg.models.endpoint, apiKey: cfg.models.apiKey, ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}) }));
  await events.emit('app.boot', { stage: 'embedder', embedder: embedder.id });

  // ---- stores ------------------------------------------------------------
  const affect = openAffectStore(paths.affectState, { clock, rng, events });
  // Boot barrier: the store boots async; snapshot() queues behind it, persists
  // the recovered state (crash-recovery's L0 copy) and proves current() safe.
  await affect.snapshot();
  const episodes = await openEpisodeStore(paths.memory, { embedder });
  const procedures = await openProceduralStore(paths.memory, { embedder });
  const corpus = await openCorpusIndex(
    { canon, derived: path.resolve(canon, '..', 'derived'), lived: path.resolve(canon, '..', 'lived') },
    { embedder, controls: loadControls(readCanon(path.join(canon, 'registers.yaml')), readCanon(path.join(canon, 'exclusions.yaml'))), cacheDir: paths.corpusCache },
  );
  await events.emit('app.boot', { stage: 'stores', exemplars: corpus.all().length, episodes: episodes.size() });

  // ---- gate + coupling compile (invalid files are STARTUP failures) ------
  const tools: ToolRegistry = createToolRegistry(); // v1: no I/O tools registered — absent capability, per rule 5
  const coupling = compileCoupling(readCanon(path.resolve(canon, '..', '..', 'coupling.yaml')));
  const gate = compileGate(readCanon(path.join(canon, 'inhibitions.yaml')), {
    ownerChatId: String(cfg.bridge.allowedChatIds[0]),
    secrets: [cfg.bridge.botToken, cfg.models.apiKey],
    knownTools: tools.names(),
  });
  await events.emit('app.boot', { stage: 'gates' });

  // ---- model (prod + probe-harness; hermetic is injected or MockModel) ---
  let model: ModelClient;
  if (opts.model !== undefined) {
    model = opts.model;
  } else if (preset === 'hermetic') {
    model = new MockModel({ clock });
  } else {
    const tiers = {
      main: cfg.models.tiers.main,
      cheap: cfg.models.tiers.cheap,
      reasoning: cfg.models.tiers.reasoning ?? cfg.models.tiers.main, // only two tiers configured: judge rides main
    };
    // M18's guarded reader: absent file = no overrides; a malformed file is a
    // typed throw (startup failure — silently ignoring a hand edit would make
    // the Ledger propose against a table it cannot see).
    const routing = await readRoutingTable(path.resolve(paths.base, 'var', 'routing.json'));
    model = createZaiClient({
      apiKey: cfg.models.apiKey,
      endpoint: cfg.models.endpoint,
      log: events,
      router: makeRouter({ log: events, ...(routing.length > 0 ? { routing } : {}), tiers }),
      clock,
      rng: rng.fork('model'),
      ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
    });
  }

  // ---- assemble ----------------------------------------------------------
  const controls = loadControls(readCanon(path.join(canon, 'registers.yaml')), readCanon(path.join(canon, 'exclusions.yaml')));
  const assembleCfg: AssembleConfig = {
    ...assembleConfigFromControls(controls),
    gravityG: cfg.gravity.seedWeight,
    budgets: { ...DEFAULT_ASSEMBLE_CONFIG.budgets, total: cfg.budgets.packetTokens },
  };
  const nominators: Nominator[] = [
    corpusNominator(corpus, { g: cfg.gravity.seedWeight }),
    episodicNominator(episodes, { clock }),
    proceduralNominator(procedures),
  ];
  const makeAssembleDeps = (): AssembleDeps => ({
    nominators,
    coupling,
    weatherLine: affect.weather(),
    inhibitionBlock: gate.renderPromptBlock(),
    cfg: assembleCfg,
    rng,
    identityBlock: readCanon(path.join(canon, 'identity.md')),
  });

  // ---- channel + ledger + offsets ---------------------------------------
  const channel =
    opts.channel ??
    (preset === 'prod'
      ? telegramChannel({
          token: cfg.bridge.botToken,
          clock,
          rng: rng.fork('bridge'),
          committedOffset: async () => (await offsets.read()).committed,
          log: events,
        })
      : FakeChannel({ clock }));
  const ledger = openMessageLedger(paths.ledger, { clock, reconcileWindowMs: cfg.reconcile.lostReplyWindowMin * 60_000 });
  const offsets = openOffsetStore(paths.offsets);

  // ---- pipeline ----------------------------------------------------------
  // budgetMs stays at the defaults (wall-clock tiers); the token budget is
  // config's say. The packet budget is honored in assembleCfg above.
  const loopCfg = resolveLoopConfig({ turnTokenBudget: cfg.budgets.turnTokens });
  // ONE window instance for the whole system — a second open over the same dir
  // would hold a divergent in-memory copy of the conversation.
  const window = openSessionWindow(paths.memory, { model, clock, events });
  const pipeline = makePipeline({
    model,
    gate,
    tools,
    channel,
    ledger,
    affect,
    baselines: COUPLING_BASELINES,
    episodes,
    procedures,
    window,
    embedder,
    events,
    clock,
    rng,
    assemble: async (q: TurnQuery, a: Vec12, deps: AssembleDeps): Promise<Packet> => assemble(q, a, deps),
    assembleDeps: makeAssembleDeps,
    loopCfg,
    allowedChatIds: cfg.bridge.allowedChatIds,
    reconcileWindowMs: cfg.reconcile.lostReplyWindowMin * 60_000,
  });
  await events.emit('app.boot', { stage: 'pipeline', model: model.constructor.name });

  // ---- scheduler (S6: life jobs; S8 adds siblings) ------------------------
  // The M17 conversation-active mutex — a turn in flight OR words from him in
  // the last 10 min — is one predicate shared by the scheduler (skip firing)
  // and the life jobs (their own precondition input).
  const CONVERSATION_QUIET_MS = 10 * 60_000;
  const conversationActive = (): boolean =>
    pipeline.isBusy() ||
    clock.epochMs() - (pipeline.lastInboundAtMs() ?? Number.NEGATIVE_INFINITY) < CONVERSATION_QUIET_MS;

  // Life jobs wire by default on a real boot (opts.jobs undefined — the cli's
  // thead path). Hermetic tests inject their own table explicitly.
  let jobs: Job[] = opts.jobs ?? [];
  if (opts.jobs === undefined) {
    const stateDir = path.resolve(paths.base, 'var', 'life');
    fs.mkdirSync(stateDir, { recursive: true });
    // M10's consolidators ride the nightly reflect job: same model client
    // (taskClass routes the tier), the composed corpus, and L0 itself as the
    // replay. Writes land in corpus/lived + corpus/proposals + var only —
    // the M10 prod-safety law, enforced by the paths handed in here.
    const consolidatePaths = {
      livedDir: path.resolve(canon, '..', 'lived'),
      proposalsDir: path.resolve(canon, '..', 'proposals'),
      reportsDir: v('var/reports'),
    };
    fs.mkdirSync(consolidatePaths.reportsDir, { recursive: true });
    fs.mkdirSync(v('var/credit'), { recursive: true });
    const consolidateDeps: ConsolidateDeps = {
      model,
      episodes,
      corpus,
      affectHistory: events,
      creditPath: v('var/credit/weights.json'),
      events,
      clock,
      rng: rng.fork('consolidate'),
      cfg: nightlyConfig(consolidatePaths, Math.floor(clock.epochMs() / WEEK_MS)),
    };
    const lifeCfg = resolveLifeConfig({ quietHours: cfg.affect.quietHours });
    const lifeDeps: LifeJobDeps = {
      model,
      events,
      affect,
      episodes,
      cfg: lifeCfg,
      interactiveMutex: conversationActive,
      lastInboundTs: () => pipeline.lastInboundAtMs(),
      selfEntry: (kind, goal) => pipeline.selfEntry(kind, goal),
      stateDir,
      vec12: () => signature(affect.current(), COUPLING_BASELINES),
      ponderPacket: async () => {
        const queryVec = (await embedder.embed(['what is worth thinking about now?']))[0] ?? new Float32Array(0);
        return assemble(
          {
            entry: 'ponder',
            speaker: { channel: 'telegram', person: `tg:${cfg.bridge.allowedChatIds[0] ?? 0}` },
            register: 'play',
            queryVec,
            recentTurnIds: [],
          },
          signature(affect.current(), COUPLING_BASELINES),
          makeAssembleDeps(),
        );
      },
      // M10's report maps to the life verdict vocabulary here, at the seam:
      // 'absent' when the window had no episodes, 'ok' when the run landed,
      // and the projection rides the report's own verdict.
      reflect: async (kind) => {
        const run = kind === 'nightly'
          ? consolidateNightly(consolidateDeps)
          : consolidateWeekly({ ...consolidateDeps, cfg: { ...consolidateDeps.cfg, windowMs: WEEK_MS } });
        const report = await run;
        return {
          verdict: report.episodesConsidered === 0 ? 'absent' : report.ok ? 'ok' : 'failed',
          projection: report.ok ? 'ok' : 'failed',
        };
      },
    };
    jobs = [heartbeatJob(lifeDeps), ponderJob(lifeDeps), reflectJob(lifeDeps)];
  }
  const sched = startScheduler(jobs, {
    clock,
    rng,
    events,
    statePath: paths.schedState,
    interactiveMutex: conversationActive,
  });
  await events.emit('app.boot', { stage: 'scheduler', jobs: jobs.length });

  // ---- system ------------------------------------------------------------
  let stopped = false;
  const system: System = {
    cfg,
    preset,
    clock,
    rng,
    events,
    affect,
    episodes,
    procedures,
    corpus,
    window,
    ledger,
    offsets,
    channel,
    gate,
    coupling,
    loopCfg,
    pipeline,
    sched,
    jobCount: jobs.length,
    paths,
    probeTarget: () => {
      const fake = channel as Channel & Partial<FakeChannelExtras>;
      return {
        inbound: async (m) => {
          const id = pipeline.inbound(m);
          if (id !== undefined) await pipeline.drain();
        },
        quiesce: () => pipeline.drain(),
        outbound: () => {
          if (fake.outbound === undefined) return fail('app/probe-target', 'probe target needs a FakeChannel (probe-harness/hermetic presets only)');
          return fake.outbound().map((s) => ({ text: s.text, msgId: s.msgId }));
        },
        decision: () => pipeline.lastDecision(),
        state: () => ({
          // probes' Vec12 is the readonly-number[] mirror of coupling's — same values, different array type.
          affect: Array.from(signature(affect.current(), COUPLING_BASELINES)),
          episodes: episodes.recent(20),
        }),
      };
    },
    stop: async () => {
      if (stopped) return;
      stopped = true;
      await pipeline.drain();
      await sched.stop();
      await events.emit('app.boot', { stage: 'stopped' });
    },
  };
  await events.emit('app.boot', { stage: 'bridge', channel: preset === 'prod' ? 'telegram' : 'fake' });
  return system;
};

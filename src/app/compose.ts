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
import { canonicalJson, fail, makeRng, SystemClock, TestClock, type Clock, type Rng } from '../kernel/index.js';
import { openEventLog, type EventLog } from '../events/index.js';
import {
  chatCore,
  createModelClient,
  makeRouter,
  MockModel,
  zaiTransport,
  type ModelClient,
  type Transport,
} from '../model/index.js';
import { makeHashEmbedder, type Embedder } from '../embed/index.js';
import { openAffectStore, type AffectStore } from '../affect/index.js';
import { setDominanceBaseline } from '../affect/vocab.js';
import { compileCoupling, signature, COUPLING_BASELINES, type CompiledCoupling, type Vec12 } from '../coupling/index.js';
import { openCorpusIndex, type OpenedCorpus } from '../corpus/corpus-index.js';
import { loadControls } from '../corpus/controls.js';
import { identityBody } from '../corpus/frontmatter.js';
import { corpusNominator } from '../corpus/nominator.js';
import {
  episodicNominator,
  openEpisodeStore,
  openProceduralStore,
  openSessionWindow,
  proceduralNominator,
  writeProjections,
  openPersistedThreadIndex,
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
import { readRoutingTable, ledgerJob, type SiblingDeps } from '../siblings/index.js';
import { gravityWeekOf } from '../consolidate/gravity.js';
import {
  consolidateNightly,
  consolidateWeekly,
  nightlyConfig,
  WEEK_MS,
  type ConsolidateDeps,
} from '../consolidate/index.js';
import type { ProbeTarget } from '../probes/index.js';
import { OpenCodeRunner, resolveSpineConfig } from '../spine/index.js';
import { makePipeline, type Pipeline } from './pipeline.js';
import { makeEmbedder } from './embedder.js';
import { affectSnapshotJob, reconcileJob, runReconcile, type RecoverLostDeps } from './maintenance-jobs.js';
import type { Thea2Config, ResolvedDoor } from './config.js';

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
  /**
   * The env the spine auth token resolves from (`spine.authTokenEnv` names the
   * variable; main.ts owns the process edge and injects it in prod; hermetic
   * tests pass their own map). Defaults to process.env — compose already sits
   * at the process boundary (cwd, stderr).
   */
  env?: Record<string, string | undefined> | undefined;
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
  /** The job names in registration order — the status line derives from these, never a hardcoded list. */
  jobNames: readonly string[];
  /**
   * One reconcile pass (ledger → alarms → lost-reply recovery), shared by the
   * 5-min job and thead's boot reconcile. The rerun-once set lives here, so a
   * loss re-run at boot is never re-run again by the job.
   */
  reconcile: () => Promise<void>;
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

// ---------------------------------------------------------------------------
// L0 stderr mirror (P-CLOSE CL.6): the events an operator must be able to find
// with `journalctl -u thea2 -p err` are mirrored ONE LINE to stderr as they
// emit. The `<3>` prefix is the syslog error priority systemd reads, so the
// journal files them at err without any journald configuration.
// ---------------------------------------------------------------------------

const STDERR_MIRROR_RE = /^(?:incident\.|bridge\.lost_reply$|sched\.alarm$)/;

export const withStderrMirror = (log: EventLog): EventLog => ({
  emit: async (kind, payload, turnId) => {
    if (STDERR_MIRROR_RE.test(kind)) {
      try {
        process.stderr.write(`<3>thea2 ${kind} ${canonicalJson(payload)}\n`);
      } catch {
        // stderr gone (journald restart): L0 still gets the event below.
      }
    }
    return log.emit(kind, payload, turnId);
  },
  replay: (filter) => log.replay(filter),
});

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
  // The launch-week epoch (ADR-005's glidepath counts from FIRST BOOT, not
  // 1970 - composed as weeks-since-this-stamp). Written once, read forever.
  const firstBootPath = v('var/first-boot');
  let firstBootMs = clock.epochMs();
  try {
    const stamp = Number(readFileSync(firstBootPath, 'utf8').trim());
    if (Number.isFinite(stamp) && stamp > 0) firstBootMs = stamp;
    else throw new Error('absent');
  } catch {
    fs.writeFileSync(firstBootPath, String(firstBootMs), { encoding: 'utf8' });
  }

  // ---- L0 event log ------------------------------------------------------
  // The stderr mirror rides prod only (P-CLOSE CL.6): hermetic suites emit
  // incidents deliberately and must not spam the captured stderr.
  const rawEvents = openEventLog(paths.events, { clock });
  const events = preset === 'prod' ? withStderrMirror(rawEvents) : rawEvents;
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
  // ADR-004a: the dominance resting home is config's say (default 0.0 = Thea1's
  // pinned zero, zero behavior change). Must run before any state is read.
  setDominanceBaseline(cfg.affect.dominanceBaseline ?? 0.0);
  // Boot barrier: the store boots async; snapshot() queues behind it, persists
  // the recovered state (crash-recovery's L0 copy) and proves current() safe.
  await affect.snapshot();
  const episodes = await openEpisodeStore(paths.memory, { embedder });
  const procedures = await openProceduralStore(paths.memory, { embedder });
  const corpus = await openCorpusIndex(
    { canon, derived: path.resolve(canon, '..', 'derived'), lived: v('var/lived') },
    { embedder, controls: loadControls(readCanon(path.join(canon, 'registers.yaml')), readCanon(path.join(canon, 'exclusions.yaml'))), cacheDir: paths.corpusCache },
  );
  await events.emit('app.boot', { stage: 'stores', exemplars: corpus.all().length, episodes: episodes.size() });

  // ---- gate + coupling compile (invalid files are STARTUP failures) ------
  const tools: ToolRegistry = createToolRegistry(); // v1: no I/O tools registered — absent capability, per rule 5
  const coupling = compileCoupling(readCanon(path.resolve(canon, '..', '..', 'coupling.yaml')));
  const gate = compileGate(readCanon(path.join(canon, 'inhibitions.yaml')), {
    ownerChatId: String(cfg.bridge.allowedChatIds[0]),
    // Every door key the process holds must be gate-invisible, not just the voice key.
    secrets: [
      cfg.bridge.botToken,
      cfg.models.apiKey,
      cfg.models.doors.mind.apiKey,
      cfg.models.doors.judge.apiKey,
      ...(cfg.models.doors.voiceFallback !== undefined ? [cfg.models.doors.voiceFallback.apiKey] : []),
    ],
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
    // P-DOOR: one transport per door, keyed by tier (main→voice, cheap→mind,
    // reasoning→judge). voiceFallback ships in config for the D.6-1 swap and
    // later packages; the tiers resolve through the router's door table.
    const doors = cfg.models.doors;
    const tiers = {
      main: doors.voice.model,
      cheap: doors.mind.model,
      reasoning: doors.judge.model,
    };
    // M18's guarded reader: absent file = no overrides; a malformed file is a
    // typed throw (startup failure — silently ignoring a hand edit would make
    // the Ledger propose against a table it cannot see).
    const routing = await readRoutingTable(path.resolve(paths.base, 'var', 'routing.json'));
    const doorTransport = (d: ResolvedDoor, name: string): Transport =>
      zaiTransport({
        apiKey: d.apiKey,
        endpoint: d.endpoint,
        protocol: d.protocol,
        clock,
        rng: rng.fork(`door-${name}`),
        ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
      });
    model = createModelClient({
      log: events,
      clock,
      core: chatCore({
        router: makeRouter({
          log: events,
          tiers,
          doors: { voice: doors.voice, mind: doors.mind, judge: doors.judge },
          ...(routing.length > 0 ? { routing } : {}),
        }),
        doors: {
          main: { door: doors.voice, send: doorTransport(doors.voice, 'voice') },
          cheap: { door: doors.mind, send: doorTransport(doors.mind, 'mind') },
          reasoning: { door: doors.judge, send: doorTransport(doors.judge, 'judge') },
        },
      }),
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
    // creditPath: the gamma term is live - the nightly weights file the
    // consolidator writes is the same one selection reads (Round 2).
    corpusNominator(corpus, { g: cfg.gravity.seedWeight, creditPath: v('var/credit/weights.json') }),
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
    // [IDENTITY] carries her words only - frontmatter and the author's draft
    // note are Diego's editing surface, never prompt (Round 3, review P0-4).
    identityBlock: identityBody(readCanon(path.join(canon, 'identity.md'))),
  });

  // The people registry (Round 3): [INTERLOCUTOR] says his name, not an id.
  const personLabel = (person: string): string | undefined => cfg.people[person]?.name;

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
  // Standing intent (Round 3): durable across restarts, folded by the
  // afterturn's appraisals, read by the heartbeat's due list.
  const threads = openPersistedThreadIndex(paths.memory);
  // P-SPINE wiring (M21/P-LOOP): on a real boot with the spine block in config,
  // Thea's turn rides the pinned OpenCode spine through the loop's runner seam.
  // Absent block (or a hermetic/probe preset) = no runner — the native loop
  // serves unchanged (rule 5). No test constructs a runner: the binary must
  // exist before the block does (M.6), and no test launches it (D.7-3). A bad
  // block or a missing token is a STARTUP failure (resolveSpineConfig throws) —
  // compose names the stage by failing here, never mid-turn.
  const spineCfg =
    preset === 'prod' && cfg.spine !== undefined
      ? resolveSpineConfig(
          // Her turns' model is the voice door (P-DOOR) — passed in from the
          // wiring site, never pinned in the yaml block.
          {
            ...cfg.spine,
            model: { providerID: 'voice', modelID: cfg.models.doors.voice.model, door: 'voice' },
          },
          opts.env ?? process.env,
        )
      : undefined;
  const spineRunner = spineCfg !== undefined ? new OpenCodeRunner(spineCfg, { clock, events }) : undefined;
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
    threads,
    personLabel,
    timezone: cfg.timezone,
    ...(spineRunner !== undefined ? { runner: spineRunner } : {}),
  });
  await events.emit('app.boot', { stage: 'pipeline', model: model.constructor.name, ...(spineCfg !== undefined ? { spine: spineCfg.version } : {}) });

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
  // The maintenance pair (ADR-003's 5-min reconcile + the 15-min affect
  // snapshot) wires on a real boot beside the life jobs. The rerun-once set is
  // shared with sys.reconcile (thead's boot pass) through the closure below.
  const reconcileRerun = new Set<number>();
  const reconcileDeps: RecoverLostDeps = {
    ledger,
    events,
    pipeline,
    // P-CLOSE CL.3: a moved-on loss's text lands in the window's pending span
    // (the [EARLIER] feedstock) when recovery abandons it. The capability is
    // optional in M09's type (old fakes stay valid); the real window always
    // provides it — absence is a boot failure, never a silent drop.
    window: {
      pushPending: async (m) => {
        if (window.pushPending === undefined) return fail('app/boot-failed', 'stage pipeline: the session window lacks pushPending');
        await window.pushPending(m);
      },
    },
    rerun: reconcileRerun,
  };
  if (opts.jobs === undefined) {
    const stateDir = path.resolve(paths.base, 'var', 'life');
    fs.mkdirSync(stateDir, { recursive: true });
    // M10's consolidators ride the nightly reflect job: same model client
    // (taskClass routes the tier), the composed corpus, and L0 itself as the
    // replay. Writes land in corpus/lived + corpus/proposals + var only —
    // the M10 prod-safety law, enforced by the paths handed in here.
    const consolidatePaths = {
      // Runtime state (Round 2): lived + proposals live in var/, the sandbox's
      // ReadWritePaths - consolidation can actually write them in prod now.
      livedDir: v('var/lived'),
      proposalsDir: v('var/proposals'),
      reportsDir: v('var/reports'),
    };
    fs.mkdirSync(consolidatePaths.reportsDir, { recursive: true });
    fs.mkdirSync(v('var/credit'), { recursive: true });
    fs.mkdirSync(v('var/lived'), { recursive: true });
    fs.mkdirSync(v('var/proposals'), { recursive: true });
    const consolidateDeps: ConsolidateDeps = {
      model,
      episodes,
      corpus,
      affectHistory: events,
      creditPath: v('var/credit/weights.json'),
      // The flywheel's closing link (Round 2): the moment a consolidation
      // lands, the corpus re-reads it and the projections are written - no
      // restart, no write-only learning loop. A rejecting hook fails the run
      // loudly AFTER the outputs are durable (M16 counts it; replay is safe).
      onConsolidated: async () => {
        await corpus.reload();
        await writeProjections(v('var'), episodes.all(), threads);
      },
      events,
      clock,
      rng: rng.fork('consolidate'),
      cfg: nightlyConfig(consolidatePaths, gravityWeekOf(clock.epochMs(), firstBootMs)),
    };
    // Quiet hours and the daily cap are HIS hours, not the server's (Phase 1).
    const lifeCfg = resolveLifeConfig({ quietHours: cfg.affect.quietHours, timeZone: cfg.timezone });
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
      threads,
      vec12: () => signature(affect.current(), COUPLING_BASELINES),
      // His unanswered messages come first: reconcile's LOST_REPLY count, read
      // straight off the ledger (a pure read — alarms are the reconcile job's
      // business, so this never double-alarms).
      owedInbound: async () => (await ledger.reconcile(clock.epochMs())).filter((d) => d.kind === 'LOST_REPLY').length,
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
    // M18's Ledger surfaces the day's truths (lost replies, failure silences,
    // spend) as a report + `sibling.report` - the ops line, minus channel
    // delivery (v1 reads it; Nightingale stays unregistered until the probe
    // suite is meaningful, Phase 4). Its ProbeRunner dependency is a loud
    // refusal: nothing registered can ever invoke it.
    const notBuiltProbe = {
      run: async () => fail('probes/not-built', 'Nightingale is not registered - the Phase 4 probe suite gates it'),
      runAll: async () => fail('probes/not-built', 'Nightingale is not registered - the Phase 4 probe suite gates it'),
    };
    const siblingDeps: SiblingDeps = {
      model,
      events,
      sched: { statePath: paths.schedState },
      clock,
      rng: rng.fork('siblings'),
      probes: notBuiltProbe,
      baselinePath: path.resolve(process.cwd(), 'probes', 'baseline.json'),
      deployMarkerPath: v('var/deploy-marker'),
      routingPath: v('var/routing.json'),
      reportsDir: v('var/reports'),
    };
    jobs = [
      heartbeatJob(lifeDeps),
      ponderJob(lifeDeps),
      reflectJob(lifeDeps),
      reconcileJob(reconcileDeps),
      affectSnapshotJob({ affect }),
      ledgerJob(siblingDeps),
    ];
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
    jobNames: jobs.map((j) => j.name),
    reconcile: async () => {
      await runReconcile(reconcileDeps, clock.epochMs());
    },
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
      await pipeline.drain(); // in-flight turns may still be mid-spine-POST
      await spineRunner?.stop(); // G3/ADR-002: thead never orphans the spine child
      await sched.stop();
      await events.emit('app.boot', { stage: 'stopped' });
    },
  };
  await events.emit('app.boot', { stage: 'bridge', channel: preset === 'prod' ? 'telegram' : 'fake' });
  return system;
};

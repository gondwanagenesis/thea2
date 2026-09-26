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
import { openMessageLedger, openOffsetStore, telegramChannel, FakeChannel, type Channel, type InboundMsg, type MessageLedger, type OffsetStore } from '../bridge/index.js';
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
import { brokerShell, describeWhere, loadWhere, makeBody, nightlyJob, remindersJob, type Body, type Exec, type Fal, type OpenAIBody, type ShellRunner, type WorkshopCall } from '../body/index.js';
import type { BodySeam } from '../mind/index.js';
import { makeLive, startFaceServer, type FaceServer } from '../face/index.js';
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
  /** v9 body seams — hermetic tests script ffmpeg/pdftotext and the OpenAI senses. */
  bodyExec?: Exec | undefined;
  bodyOpenAI?: OpenAIBody | undefined;
  bodyFal?: Fal | undefined;
  /** v10 hands, non-prod: the bash her local shell runs (Windows dev boxes point it at Git's bash). */
  bodyShellCmd?: string | undefined;
  /** v10 hands: a scripted shell (tests); wins over the broker and the local shell. */
  bodyShell?: ShellRunner | undefined;
  /** v10 workshop: the broker call (tests fake it); absent = the broker's socket, if it is there. */
  workshopCall?: WorkshopCall | undefined;
}

/** How fresh a shared location must be to stay a fact about his present. */
const WHERE_FRESH_MS = 3 * 24 * 3600_000;

/** The body, as the mind's BodySeam: plus the [now] facts it knows. */
export const bodySeam = (body: Body, clock: Clock): BodySeam => ({
  perceive: (m) => body.perceive(m),
  begin: (turnId, ctx) => body.begin(turnId, ctx),
  end: (turnId) => body.end(turnId),
  speak: (chatId, text, turnId, replyTo) => body.speak(chatId, text, turnId, replyTo),
  hisTimeZone: () => body.hisTimeZone(),
  onSkipped: (m) => body.onSkipped(m),
  jobOutcome: (id) => body.jobOutcome(id),
  skillFor: (text) => body.skillFor(text),
  nowFacts: () => {
    const w = loadWhere(body.house);
    const now = clock.epochMs();
    const where = w === undefined || now - w.at > WHERE_FRESH_MS ? [] : [`where he is: ${describeWhere(w, now)}.`];
    return [...where, ...body.worldFacts(now)];
  },
});

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
  /** v9 body (absent on a text-only config). */
  body?: Body | undefined;
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
  const channel =
    opts.channel ??
    (preset === 'prod'
      ? telegramChannel({ token: cfg.bridge.botToken, clock, rng: rng.fork('bridge'), committedOffset: async () => (await offsets.read()).committed, log: events })
      : FakeChannel({ clock }));
  const ledger = openMessageLedger(paths.ledger, { clock, reconcileWindowMs: cfg.reconcile.lostReplyWindowMin * 60_000 });
  const offsets = openOffsetStore(paths.offsets);

  const tools = createToolRegistry();
  // v9 body: senses + hands (plan thea2-v9-parity.md). Registered BEFORE the
  // gate compiles — the gate default-denies any tool it was not told about.
  const ownerChatId = cfg.bridge.allowedChatIds[0] ?? 0;
  const doors = cfg.models.doors;
  // Known secret values: the gate rejects them in tool args and plans; her hands redact them from every result.
  const secrets = [
    cfg.bridge.botToken,
    cfg.models.apiKey,
    doors.mind.apiKey,
    doors.judge.apiKey,
    ...(doors.voiceFallback !== undefined ? [doors.voiceFallback.apiKey] : []),
    ...(cfg.body !== undefined
      ? [cfg.body.openaiKey, cfg.body.falKey, cfg.body.braveKey, cfg.body.elevenKey, cfg.body.presentKey].filter((k): k is string => k !== undefined && k !== '')
      : []),
  ];
  const body: Body | undefined =
    cfg.body === undefined
      ? undefined
      : makeBody({
          cfg: { ...cfg.body, dir: v(cfg.body.dir), workspaceDir: v(cfg.body.workspaceDir) },
          secrets,
          // v10 hands (F1): in prod her shell runs through the exec broker as its own user
          // (thea2-hands), which cannot see her keys, her var, Thea1 or /root
          ...(preset === 'prod' ? { shell: brokerShell(path.join(path.dirname(v(cfg.body.dir)), 'run', 'exec.sock')) } : {}),
          ...(opts.bodyShellCmd !== undefined ? { shellCmd: opts.bodyShellCmd } : {}),
          ...(opts.bodyShell !== undefined ? { shell: opts.bodyShell } : {}),
          ...(opts.workshopCall !== undefined ? { workshopCall: opts.workshopCall } : {}),
          channel,
          clock,
          events,
          ownerChatId,
          timeZone: cfg.timezone,
          mind,
          embedder,
          affect,
          // her own browser service (thea2-browser, 127.0.0.1:8442) — prod only
          ...(preset === 'prod' ? { browserUrl: 'http://127.0.0.1:8442' } : {}),
          // casting reads the model late: it is built after the body (the gate needs the tools first)
          model: () => model,
          rng: rng.fork('body'),
          recent: () =>
            window
              .messages()
              .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
              .slice(-16)
              .map((m) => ({ who: m.role === 'user' ? ('him' as const) : ('her' as const), text: String(m.content) })),
          mood: () => {
            const s = affect.current();
            return { arousal: s.dials.arousal, pleasure: s.dials.pleasure };
          },
          recordOutbound: (turnId, msgId, text) => ledger.recordOutbound(turnId, msgId, text),
          ...(opts.bodyExec !== undefined ? { exec: opts.bodyExec } : {}),
          ...(opts.bodyOpenAI !== undefined ? { openai: opts.bodyOpenAI } : {}),
          ...(opts.bodyFal !== undefined ? { fal: opts.bodyFal } : {}),
          ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
        });
  const bodyTools = body?.register(tools) ?? [];
  if (body !== undefined) await events.emit('app.boot', { stage: 'body', tools: bodyTools, house: body.house.root });
  // v8 reads its own matrix (coupling-v8.yaml: the anti-escalation law made true
  // on real felt signatures); v7's coupling.yaml stays untouched for v7.
  const couplingPath = fs.existsSync(path.resolve(root, 'coupling-v8.yaml')) ? path.resolve(root, 'coupling-v8.yaml') : path.resolve(root, 'coupling.yaml');
  const coupling = compileCoupling(readRoot(couplingPath));
  const gate = compileGate(readRoot(path.resolve(root, 'corpus', 'canon', 'inhibitions.yaml')), {
    ownerChatId: String(cfg.bridge.allowedChatIds[0]),
    secrets,
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


  // v9 (found live 2026-09-26): 1536 output tokens cut off a long reply (he asked her to write
  // two prompts) — the turn failed twice before the keeper got it through. Sol runs without a
  // thinking trace here, so the cap is all words: room for a real piece of writing.
  const loopCfg = resolveLoopConfig({ turnTokenBudget: cfg.budgets.turnTokens, assessMaxTokens: 6000 });
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
    // v11: Diego is the person whose id matches his DM chat (in a Telegram DM, chatId == his user id).
    ownerPerson: `tg:${cfg.bridge.allowedChatIds[0] ?? 0}`,
    ...(cfg.bridge.selfAliases !== undefined ? { selfAliases: cfg.bridge.selfAliases } : {}),
    timezone: cfg.timezone,
    budgetLeft,
    ...(body !== undefined ? { body: bodySeam(body, clock) } : {}),
  });
  await events.emit('app.boot', { stage: 'pipeline', mind: 'v8', fallback: fallbackModel !== undefined, body: body !== undefined });
  body?.bind({
    // Things delivered after their turn ended (a selfie, a video) become lines she remembers sending.
    remember: (text, turnId) => void window.push({ role: 'assistant', content: text, ts: clock.epochMs(), turnId }),
    selfEntry: (goal) => void pipeline.selfEntry('heartbeat', goal),
  });

  // v9 face: the Mini App + voice mode, served from inside thead (it reads her live state).
  let face: FaceServer | undefined;
  if (cfg.face !== undefined && body !== undefined && cfg.body !== undefined && preset === 'prod') {
    const seam = bodySeam(body, clock);
    const recentLines = (): Array<{ who: 'him' | 'her'; text: string }> =>
      window
        .messages()
        .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
        .slice(-24)
        .map((m) => ({ who: m.role === 'user' ? ('him' as const) : ('her' as const), text: String(m.content) }));
    const live = makeLive({
      key: cfg.body.openaiKey,
      clock,
      rng: rng.fork('live'),
      events,
      mind,
      body,
      model: () => model,
      registry: tools,
      timeZone: cfg.timezone,
      recent: recentLines,
      nowFacts: () => seam.nowFacts?.() ?? [],
      absorb: (heard, said) => pipeline.absorb(heard, said, 'call'),
    });
    try {
      face = await startFaceServer({
        port: cfg.face.port,
        key: cfg.face.key,
        staticDir: path.resolve(root, cfg.face.staticDir),
        events,
        live,
        presentKey: cfg.body.presentKey,
        sources: {
          affect,
          mind,
          events,
          body,
          clock,
          timeZone: cfg.timezone,
          brain: { voice: doors.voice.model, fallback: doors.voiceFallback?.model, mind: doors.mind.model },
          live: { status: () => live.status() },
        },
      });
      await events.emit('app.boot', { stage: 'face', port: face.port });
    } catch (e) {
      await events.emit('incident.face_boot_failed', { error: e instanceof Error ? e.message : String(e) });
    }
  }

  const CONVERSATION_QUIET_MS = 10 * 60_000;
  const conversationActive = (): boolean =>
    pipeline.isBusy() || clock.epochMs() - (pipeline.lastInboundAtMs() ?? Number.NEGATIVE_INFINITY) < CONVERSATION_QUIET_MS;

  const reconcileRerun = new Set<number>();
  const reconcileDeps: RecoverLostDeps = {
    ledger,
    events,
    // v9: the answer keeper (pipeline.sweep) owns re-runs; reconcile keeps its alarms
    // but never re-enqueues, so nothing he sent can be answered twice.
    pipeline: { inbound: () => undefined, isBusy: () => pipeline.isBusy() },
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
      // v9 answer keeper: every 30 s, anything of his still unanswered is picked up again
      { name: 'answer-keeper', cadence: { kind: 'every', ms: 30_000 }, lane: 'maintenance', catchUp: 'skip', timeoutMs: 10_000, run: async () => void pipeline.sweep() },
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
      ...(body !== undefined ? [remindersJob(body.reminders, clock, (goal) => void pipeline.selfEntry('heartbeat', goal))] : []),
      // v10 workshop: the broker marks a deploy live ~45 s AFTER restarting her, so boot alone would miss it
      ...(body !== undefined
        ? [
            {
              name: 'workshop-news',
              cadence: { kind: 'every' as const, ms: 60_000 },
              lane: 'maintenance' as const,
              catchUp: 'skip' as const,
              timeoutMs: 10_000,
              run: async () => {
                const told = body.wake();
                if (told.length > 0) await events.emit('body.workshop_told', { ids: told });
              },
            },
          ]
        : []),
      ...(body !== undefined
        ? [nightlyJob({ mind, model: () => model, clock, events, house: body.house, timeZone: cfg.timezone, embedder }, (utcMinuteForLocalHour(mindCfg.sleepHourLocal, clock.epochMs(), cfg.timezone) + 30) % 1440)]
        : []),
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
    ...(body !== undefined ? { body } : {}),
    sched,
    jobNames: jobs.map((j) => j.name),
    reconcile: async () => {
      await runReconcile(reconcileDeps, clock.epochMs());
    },
    stop: async () => {
      if (stopped) return;
      stopped = true;
      await face?.close();
      await pipeline.drain();
      await mind.flush();
      await sched.stop();
      await events.emit('app.boot', { stage: 'stopped' });
    },
  };
  // v9 answer keeper, at boot: what the ledger shows unanswered in the last 6 h (a
  // restart, a crash, the old interruption path) is owed again, and swept now.
  {
    const since = clock.epochMs() - 6 * 3600_000;
    const ins = new Map<number, InboundMsg>();
    const turnsOf = new Map<number, string[]>();
    const sentTurns = new Set<string>();
    for await (const row of ledger.read()) {
      const r = row as { kind: string; ts?: number; msg?: InboundMsg; updateId?: number; turnId?: string };
      if (r.kind === 'inbound' && r.msg !== undefined && (r.ts ?? 0) >= since && r.msg.skipped === undefined && r.msg.reaction === undefined && r.msg.msgId > 0) ins.set(r.msg.updateId, r.msg);
      else if (r.kind === 'link' && r.updateId !== undefined && r.turnId !== undefined) turnsOf.set(r.updateId, [...(turnsOf.get(r.updateId) ?? []), r.turnId]);
      else if (r.kind === 'outbound' && r.turnId !== undefined) sentTurns.add(r.turnId);
    }
    const unanswered = [...ins.values()].filter((m) => !(turnsOf.get(m.updateId) ?? []).some((t) => sentTurns.has(t)));
    pipeline.adoptOwed(unanswered);
    if (unanswered.length > 0) {
      await events.emit('mind.answer_adopted', { updateIds: unanswered.map((m) => m.updateId) });
      pipeline.sweep(0);
    }
  }
  // v10 workshop: a change that went live (or was rolled back) restarted her — she hears how it went, once
  const toldWorkshop = body?.wake() ?? [];
  if (toldWorkshop.length > 0) await events.emit('body.workshop_told', { ids: toldWorkshop });
  await events.emit('app.boot', { stage: 'bridge', channel: preset === 'prod' ? 'telegram' : 'fake', mind: 'v8' });
  return system;
};

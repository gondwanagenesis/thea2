// M17 life — the M16 job bodies: heartbeat and ponder. Thin compositions over
// the pure policy (policy.ts) and the two model surfaces (thought.ts,
// ponder.ts): gather state → ask the policy → make the one model call → land
// the outcome as events + persisted counters + (ponder) an episode. Every
// fire/no-fire decision lands a `life.*` event — "why didn't she text today"
// must always have an answer in the log. A job body never throws out of run():
// every runtime failure becomes `incident.life_failed` and a state-preserving
// return (M09's appraisal law: runtime failures a turn can survive are values).
//
// State lives in {stateDir}/heartbeat.json and {stateDir}/ponder.json, written
// through the kernel's atomic write (temp+rename — two concurrent writes to one
// path throw EPERM on Windows, so each body awaits its own single write per
// run). State is loaded at FIRE time, not boot, so a TestClock day rollover is
// just the next fire reading a new date. A missing or corrupt file is a zero
// state, never a crash.
//
// Deliberate non-duplications (the thought call and the committee own their
// events): `life.heartbeat.thought` is emitted by thinkHeartbeatThought, but the
// job holds the row until the fire's OUTCOME is known and lands it once,
// augmented with `sent` (Phase 1, 2026-09-02: passed:true + sent:false is the
// log's answer to "the thought passed — why didn't she text?"). Its
// `life.heartbeat.sent` additive row is the job's alone (a heartbeat entry
// actually reached the channel), and the job adds the `life.heartbeat.pre`
// verdict and the selfEntry, not a second copy of either.

import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { atomicWriteJson, newId } from '../kernel/index.js';
import type { AffectStore } from '../affect/index.js';
import type { EventLog } from '../events/index.js';
import type { EpisodeStore } from '../memory/index.js';
import type { ModelClient } from '../model/index.js';
import type { CommitteeResult, LoopPacket, Vec12 } from '../loop/index.js';
import { runCommittee } from '../loop/index.js';
import type { Job, JobCtx } from '../sched/index.js';
import {
  HEARTBEAT_PRE_EVENT,
  HeartbeatPrePayload,
  HEARTBEAT_SENT_EVENT,
  HeartbeatSentPayload,
  HEARTBEAT_THOUGHT_EVENT,
  LIFE_INCIDENT,
  LifeIncidentPayload,
  PONDER_ARTIFACT_EVENT,
  PONDER_GATE_EVENT,
  PONDER_SEED_EVENT,
  PONDER_SKIPPED_EVENT,
  PonderArtifactPayload,
  PonderGatePayload,
  PonderSeedPayload,
  PonderSkippedPayload,
  REFLECTED_EVENT,
  ReflectedPayload,
  emitLife,
} from './events.js';
import type { LifeConfig } from './config.js';
import {
  HEARTBEAT_THRESHOLD,
  PONDER_ABOUTS,
  allowedAbouts,
  balanceAvoid,
  heartbeatPrecondition,
  ponderGate,
  ponderScore,
  silencePressure,
  localDateOf,
  localHourOfDay,
  type PonderAbout,
} from './policy.js';
import {
  GROUNDING_NONE,
  PONDER_COMMITTEE_NAME,
  PonderArtifactSchema,
  ponderCommittee,
  ponderContextBlock,
  ponderGroundQuery,
  ponderSeedSchemaFor,
  type GroundingObservation,
} from './ponder.js';
import { thinkHeartbeatThought, type HeartbeatThoughtContext } from './thought.js';

/** The deps M20 wires. The model/events/stores are shared with the turn path. */
export interface LifeJobDeps {
  model: ModelClient;
  events: EventLog;
  /**
   * Read-only in the single-writer sense: jobs never apply events. They DO call
   * `snapshot()` before reading — it only advances the decay engine to now and
   * persists (no semantic write; M05's ticker stays the only dial writer), so a
   * heartbeat sees the drives as they are, not as they were after the last turn.
   */
  affect: AffectStore;
  episodes: EpisodeStore;
  cfg: LifeConfig;
  /** True = skip this interactive firing (conversation active / turn in flight). */
  interactiveMutex: () => boolean;
  /** Epoch ms of Diego's last inbound message, or undefined if none. */
  lastInboundTs: () => number | undefined;
  /**
   * How many of his inbound messages reconcile currently reports as LOST_REPLY
   * (compose closes over the ledger). While > 0 the heartbeat refuses to text
   * about anything else and ponder stands down — a question of his comes
   * first, and M20's reconcile job is re-running it.
   */
  owedInbound: () => Promise<number>;
  /**
   * Enqueue a self-initiated turn; the handle carries its turnId and the
   * heartbeat-outcome hook. Fire-and-forget for ponder; the heartbeat AWAITS
   * `sent` (Phase 1, 2026-09-02): sentToday/unanswered move only when the
   * turn's realization actually delivered ≥ 1 bubble — never at enqueue time.
   */
  selfEntry: (kind: 'heartbeat' | 'ponder', goal: string) => SelfEntryHandle;
  /** Directory for the jobs' persisted state (files var/life/*.json). */
  stateDir: string;
  /**
   * Current coupling signature — the Vec12 the committee env needs. The type is
   * the loop's structural mirror (Float64Array, length 12): dependency-cruiser
   * forbids src/life → src/coupling, and the CommitteeEnv consumes the loop's
   * own Vec12, so the mirror is the honest edge.
   */
  vec12: () => Vec12;
  /** A minimal LoopPacket for the ponder committee env (compose closes over the real assembler — async, so the provider is). */
  ponderPacket: () => Promise<LoopPacket>;
  /**
   * The M10 consolidators, closed over their deps by compose. Life only needs
   * the verdict vocabulary of `life.reflected` — the full report stays M10's,
   * and this module never imports consolidate (the DAG stays a DAG).
   */
  reflect: (kind: 'nightly' | 'weekly') => Promise<ReflectOutcome>;
  /**
   * The durable thread index (Round 3), structurally mirrored - the heartbeat
   * reads its due list, ponder files her `next` into it. Optional for the same
   * reason the pipeline's is: hermetic tests that never touch threads omit it.
   */
  threads?:
    | {
        apply(
          updates: readonly { id: string; title?: string | undefined; status: 'open' | 'touched' | 'closed' }[],
          ts: number,
        ): void;
        dueThreads(now: number): Array<{ id: string; title?: string | undefined; status: 'open' | 'touched' | 'closed' }>;
      }
    | undefined;
}

/**
 * The pipeline's self-entry handle, mirrored structurally (life cannot import
 * app — the DAG runs one way; the same device as the Vec12 mirror below).
 * `sent` settles exactly once with the number of bubbles the turn delivered:
 * 0 on an in-loop silent/defer, an aborted send, or a dead turn — the pipeline
 * settles every exit path, so awaiting it cannot hang.
 */
export interface SelfEntryHandle {
  turnId: string;
  sent: Promise<number>;
}

/** The verdict vocabulary of `life.reflected`. 'absent' = the run had nothing
 * in its window — the flywheel had nothing to chew, which is not a failure. */
export type ReflectVerdict = 'ok' | 'failed' | 'absent';

export interface ReflectOutcome {
  verdict: ReflectVerdict;
  /** Whether the nightly status projection (var/reports/status.md) landed. */
  projection: 'ok' | 'failed';
}

const HOUR = 3_600_000;
/** The "alone with your thoughts" silence when he has never messaged: 72h saturates the pressure's time term. */
const NEVER_SILENCE_H = 72;
/** The "never pondered" age of the last artifact, in hours. */
const NEVER_ARTIFACT_H = 999;
/** The balance rule's window: the last 5 seeds. */
const MAX_ABOUT_HISTORY = 5;

const asErrorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The one loud failure shape — emitted, never rethrown, and itself allowed to fail quietly (M02 cries to stderr). */
const incident = async (events: EventLog, job: string, stage: string, error: string): Promise<void> => {
  try {
    await events.emit(LIFE_INCIDENT, { job, stage, error } satisfies LifeIncidentPayload);
  } catch {
    // L0 unwritable: the outcome stays a quiet return either way.
  }
};

// ---------------------------------------------------------------------------
// Heartbeat
// ---------------------------------------------------------------------------

export interface HeartbeatJobState {
  version: 1;
  /** LOCAL (cfg.timeZone) date the sentToday census belongs to (YYYY-MM-DD). */
  date: string;
  sentToday: number;
  lastSentTs?: number | undefined;
  unanswered: number;
  lastUnansweredTs?: number | undefined;
}

const readHeartbeatState = async (filePath: string, today: string): Promise<HeartbeatJobState> => {
  const fresh = (): HeartbeatJobState => ({ version: 1, date: today, sentToday: 0, unanswered: 0 });
  let text: string;
  try {
    text = await fsp.readFile(filePath, 'utf8');
  } catch {
    return fresh(); // missing = a first boot, not an error
  }
  try {
    const raw = JSON.parse(text) as unknown;
    if (typeof raw !== 'object' || raw === null) return fresh();
    const o = raw as Record<string, unknown>;
    const int = (v: unknown): number | undefined =>
      typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined;
    const sentToday = int(o['sentToday']);
    const unanswered = int(o['unanswered']);
    if (sentToday === undefined || unanswered === undefined || typeof o['date'] !== 'string') return fresh();
    const ts = (v: unknown): number | undefined =>
      typeof v === 'number' && Number.isFinite(v) ? v : undefined;
    const lastSentTs = ts(o['lastSentTs']);
    const lastUnansweredTs = ts(o['lastUnansweredTs']);
    return {
      version: 1,
      date: o['date'],
      sentToday,
      unanswered,
      ...(lastSentTs !== undefined ? { lastSentTs } : {}),
      ...(lastUnansweredTs !== undefined ? { lastUnansweredTs } : {}),
    };
  } catch {
    return fresh(); // corrupt = zero state, never a crash
  }
};

const heartbeatGoal = (t: { thought: string; reason: string; kind: string }): string =>
  `[heartbeat:${t.kind}] ${t.thought} — ${t.reason}`;

/**
 * Holds the `life.heartbeat.thought` row until the fire's OUTCOME is known, then
 * lands it exactly once — augmented with `sent` when an outcome was awaited
 * (passed:true + sent:false is the log's answer to "the thought passed, so why
 * didn't she text?": an in-loop silence, not a decision to speak). Every other
 * kind the thought call emits (its own incident on failure) forwards untouched,
 * and a fire that exits without landing still lands the row verbatim — the why
 * is never lost.
 */
const gateThoughtRow = (events: EventLog): { log: EventLog; land: (sent?: boolean) => Promise<void> } => {
  let held: { payload: unknown; turnId?: string } | null = null;
  const land = async (sent?: boolean): Promise<void> => {
    if (held === null) return;
    const row = held;
    held = null;
    // The payload is the thought call's already-validated payload plus one
    // boolean. `sent` rides a raw emit because HeartbeatThoughtPayload's wall
    // (events.ts, outside this package's Phase-1 surface) would strip an
    // unknown key instead of landing it.
    const payload =
      sent === undefined ? row.payload : { ...(row.payload as Record<string, unknown>), sent };
    await events.emit(HEARTBEAT_THOUGHT_EVENT, payload, row.turnId);
  };
  return {
    log: {
      emit: async (kind, payload, turnId) => {
        if (kind === HEARTBEAT_THOUGHT_EVENT && held === null && payload !== null && typeof payload === 'object') {
          held = { payload, ...(turnId !== undefined ? { turnId } : {}) };
          return;
        }
        await events.emit(kind, payload, turnId);
      },
      replay: (filter) => events.replay(filter),
    },
    land,
  };
};

const runHeartbeat = async (deps: LifeJobDeps, ctx: JobCtx): Promise<void> => {
  const now = ctx.clock.epochMs();
  const today = localDateOf(now, deps.cfg.timeZone);
  const statePath = path.join(deps.stateDir, 'heartbeat.json');

  let state = await readHeartbeatState(statePath, today);
  // A new LOCAL day resets the daily cap — his midnight, not Greenwich's.
  if (state.date !== today) state = { ...state, date: today, sentToday: 0 };
  // He replied since her last text — the no-reply backoff debt is paid.
  const inbound = deps.lastInboundTs();
  if (inbound !== undefined && state.unanswered > 0 && inbound > (state.lastSentTs ?? Number.NEGATIVE_INFINITY)) {
    state = { ...state, unanswered: 0 };
  }

  const nowH = localHourOfDay(now, deps.cfg.timeZone);
  const lastUnansweredAgeH =
    state.lastUnansweredTs !== undefined ? Math.max(0, (now - state.lastUnansweredTs) / HOUR) : 0;
  const mutexActive = deps.interactiveMutex();
  const owedInbound = await deps.owedInbound();
  const pre = heartbeatPrecondition({
    owedInbound,
    nowH,
    quietHours: deps.cfg.quietHours,
    sentToday: state.sentToday,
    unanswered: state.unanswered,
    lastUnansweredAgeH,
    mutexActive,
  });
  await emitLife(ctx.events, HEARTBEAT_PRE_EVENT, HeartbeatPrePayload, {
    nowH,
    canText: pre.canText,
    reason: pre.reason,
    owedInbound,
    sentToday: state.sentToday,
    unanswered: state.unanswered,
    lastUnansweredAgeH,
    mutexActive,
  });
  if (!pre.canText) return;

  // The gate is open: build the private monologue's inputs and make the call.
  const silenceH = inbound !== undefined ? (now - inbound) / HOUR : NEVER_SILENCE_H;
  // Tick decay to now before reading: current() alone hands back the state as
  // of the last write, which after a quiet afternoon is hours stale.
  await deps.affect.snapshot();
  const affect = deps.affect.current();
  const pressure = silencePressure(silenceH, affect.drives);
  const recent = deps.episodes.recent(deps.cfg.contextEpisodes).map((e) => ({
    summary: e.summary,
    importance: e.importance,
    ts: e.ts,
  }));
  const thoughtCtx: HeartbeatThoughtContext = {
    nowH,
    silenceH,
    sentToday: state.sentToday,
    unanswered: state.unanswered,
    weather: deps.affect.weather(),
    drives: affect.drives,
    recent,
    // Standing intent (Round 3): open threads older than the due window come
    // back here, unbidden - the whole point of the index.
    dueThreads:
      deps.threads !== undefined
        ? deps.threads.dueThreads(now).map((t) => ({ id: t.id, note: t.title ?? t.id }))
        : [],
  };
  const gate = gateThoughtRow(ctx.events);
  const outcome = await thinkHeartbeatThought(thoughtCtx, pressure, {
    model: deps.model,
    events: gate.log,
    maxTokens: deps.cfg.thoughtMaxTokens,
    temperature: deps.cfg.thoughtTemperature,
    tier: deps.cfg.thoughtTier,
  });
  // A failed thought already landed its own incident (stage 'thought'); the
  // counters stay untouched and the slot ends quietly — not with a second copy.
  if (!outcome.ok) {
    await gate.land(); // nothing can be held here; a no-op, kept as the structural guarantee
    return;
  }

  // Every path below lands the held thought row exactly once; the finally
  // covers an unexpected exit by landing it verbatim (outcome unknown).
  let landed = false;
  const landOnce = async (sent?: boolean): Promise<void> => {
    if (landed) return;
    landed = true;
    await gate.land(sent);
  };
  try {
    if (outcome.score >= HEARTBEAT_THRESHOLD) {
      const entry = deps.selfEntry('heartbeat', heartbeatGoal(outcome.thought));
      // Phase 1: the counters move on the OUTCOME, not the enqueue. An in-loop
      // silent/defer spends neither the daily cap nor the backoff ladder — the
      // pipeline settles every exit (0 = nothing sent), so this await ends.
      const sent = await entry.sent;
      await landOnce(sent > 0);
      if (sent > 0) {
        await emitLife(
          ctx.events,
          HEARTBEAT_SENT_EVENT,
          HeartbeatSentPayload,
          { turnId: entry.turnId, kind: outcome.thought.kind, bubbles: sent },
          entry.turnId,
        );
        const next: HeartbeatJobState = {
          version: 1,
          date: today,
          sentToday: state.sentToday + 1,
          lastSentTs: now,
          unanswered: state.unanswered + 1,
          lastUnansweredTs: now,
        };
        await atomicWriteJson(statePath, next);
      }
      // sent === 0: the thought row above landed {passed:true, sent:false} and
      // the counters stay as they were — the fire is fully accounted for.
    } else {
      // Sub-threshold: the thought call already kept the thought as data
      // (life.heartbeat.thought with passed:false) — nothing is sent, nothing owed.
      await landOnce();
    }
  } finally {
    await landOnce();
  }
};

export const heartbeatJob = (deps: LifeJobDeps): Job => ({
  name: 'heartbeat',
  cadence: { kind: 'every', ms: deps.cfg.heartbeatEveryMs, jitterPct: deps.cfg.jitterPct },
  lane: 'interactive',
  catchUp: 'skip', // 16 missed heartbeats must never become 16 texts
  timeoutMs: deps.cfg.heartbeatTimeoutMs,
  run: async (ctx) => {
    try {
      await runHeartbeat(deps, ctx);
    } catch (e) {
      await incident(ctx.events, 'heartbeat', 'run', asErrorMessage(e));
    }
  },
});

// ---------------------------------------------------------------------------
// Ponder
// ---------------------------------------------------------------------------

export interface PonderJobState {
  version: 1;
  /** The seed classes of the last ponder runs, newest first (balance-rule window). */
  recentAbouts: PonderAbout[];
  lastArtifactTs?: number | undefined;
}

const isPonderAbout = (v: unknown): v is PonderAbout =>
  typeof v === 'string' && (PONDER_ABOUTS as readonly string[]).includes(v);

const readPonderState = async (filePath: string): Promise<PonderJobState> => {
  const fresh = (): PonderJobState => ({ version: 1, recentAbouts: [] });
  let text: string;
  try {
    text = await fsp.readFile(filePath, 'utf8');
  } catch {
    return fresh();
  }
  try {
    const raw = JSON.parse(text) as unknown;
    if (typeof raw !== 'object' || raw === null) return fresh();
    const o = raw as Record<string, unknown>;
    const abouts = Array.isArray(o['recentAbouts']) ? o['recentAbouts'].filter(isPonderAbout) : [];
    const lastArtifactTs = typeof o['lastArtifactTs'] === 'number' && Number.isFinite(o['lastArtifactTs'])
      ? o['lastArtifactTs']
      : undefined;
    return {
      version: 1,
      recentAbouts: abouts.slice(0, MAX_ABOUT_HISTORY),
      ...(lastArtifactTs !== undefined ? { lastArtifactTs } : {}),
    };
  } catch {
    return fresh();
  }
};

/** saliency 0..1 → the episode's 1..10 importance, clamped at both rails. */
const importanceOf = (saliency: number): number => Math.max(1, Math.min(10, Math.round(saliency * 10)));

interface PonderSeed {
  thought: string;
  about: PonderAbout;
  topic: string;
  uncertainty: string;
  saliency: number;
}

/**
 * The seed node's validated output, re-read for the balance history and the
 * seed event. runCommittee already checked it against the same schema, so this
 * is a recovery of typed data, not a second verdict; undefined falls back to the
 * artifact's own about/topic/saliency.
 */
const seedFrom = (result: CommitteeResult, abouts: readonly PonderAbout[]): PonderSeed | undefined => {
  const raw = result.outputs.find((o) => o.id === 'seed');
  if (raw === undefined) return undefined;
  try {
    const parsed = ponderSeedSchemaFor(abouts).safeParse(JSON.parse(raw.output) as unknown);
    return parsed.success ? (parsed.data as PonderSeed) : undefined;
  } catch {
    return undefined;
  }
};

const runPonder = async (deps: LifeJobDeps, ctx: JobCtx): Promise<void> => {
  const now = ctx.clock.epochMs();
  const statePath = path.join(deps.stateDir, 'ponder.json');
  const state = await readPonderState(statePath);

  // A question of his is owed (reconcile says LOST_REPLY): pondering stands
  // down until it is answered — the same precondition the heartbeat holds.
  const owed = await deps.owedInbound();
  if (owed > 0) {
    await emitLife(ctx.events, PONDER_SKIPPED_EVENT, PonderSkippedPayload, { reason: 'owed', detail: String(owed) });
    return;
  }

  // The gate is a mood computed from state — pure, no model call in it. The
  // snapshot ticks decay to now first (see LifeJobDeps.affect).
  await deps.affect.snapshot();
  const affect = deps.affect.current();
  const novelty = affect.drives['novelty'];
  const arousal = affect.dials['arousal'];
  const hoursSinceArtifact =
    state.lastArtifactTs !== undefined ? (now - state.lastArtifactTs) / HOUR : NEVER_ARTIFACT_H;
  const features = { novelty, arousal, hoursSinceArtifact };
  const pass = ponderGate(features);
  await emitLife(ctx.events, PONDER_GATE_EVENT, PonderGatePayload, {
    score: ponderScore(features),
    pass,
    novelty,
    arousal,
    hoursSinceArtifact,
  });
  if (!pass) return;

  // Balance rule as structure: the seed schema is BUILT from the allowed
  // classes, so a violating seed dies at validation, not at persuasion.
  const avoid = balanceAvoid(state.recentAbouts);
  const abouts = allowedAbouts(state.recentAbouts);
  const recent = deps.episodes.recent(deps.cfg.contextEpisodes).map((e) => ({
    summary: e.summary,
    importance: e.importance,
  }));

  // No web tools exist in v1 (rule 5: absent capability = absent registration):
  // her own episodes ARE the grounding source — verbatim extracts, never a
  // paraphrase, with no cites to claim. An empty life gets the honest nothing.
  const query = ponderGroundQuery(recent);
  const grounding: GroundingObservation =
    recent.length === 0
      ? GROUNDING_NONE(query)
      : {
          source: 'none',
          query,
          evidence: recent.map((e) => `- [importance ${e.importance}] ${e.summary}`).join('\n'),
          cites: [],
        };
  const spec = ponderCommittee({
    context: ponderContextBlock(recent, affect, deps.affect.weather()),
    abouts,
    avoid,
    grounding,
  });
  const turnId = newId(ctx.clock, ctx.rng);

  let result: CommitteeResult;
  try {
    result = await runCommittee(spec, {
      name: PONDER_COMMITTEE_NAME,
      model: deps.model,
      packet: await deps.ponderPacket(),
      query: { entry: 'ponder', channels: { character: true, procedural: true } },
      affect: deps.vec12(),
      turnId,
      signal: ctx.signal,
      maxTokens: deps.cfg.committeeMaxTokens,
      temperature: deps.cfg.committeeTemperature,
      tier: deps.cfg.committeeTier,
    });
  } catch (e) {
    await incident(ctx.events, 'ponder', 'committee', asErrorMessage(e));
    return;
  }
  if (!result.ok) {
    await incident(ctx.events, 'ponder', 'committee', result.error ?? 'ponder committee failed without an error');
    return;
  }

  const artifact = PonderArtifactSchema.safeParse(result.artifact);
  if (!artifact.success) {
    // Unreachable while runCommittee re-validates spec.output; kept so a bad
    // landing is an incident, never a half-written state.
    const detail = artifact.error.issues.map((i) => `${i.path.map(String).join('.')}: ${i.message}`).join('; ');
    await incident(ctx.events, 'ponder', 'artifact', `the ponder artifact failed its schema: ${detail}`);
    return;
  }

  const seed = seedFrom(result, abouts);
  const about = seed?.about ?? artifact.data.about;
  const topic = seed?.topic ?? artifact.data.topic;
  const saliency = seed?.saliency ?? artifact.data.saliency;
  await emitLife(
    ctx.events,
    PONDER_SEED_EVENT,
    PonderSeedPayload,
    { about, topic, saliency, avoided: avoid },
    turnId,
  );

  // The seed counts for the balance rule even when the ponder is dropped as
  // thin — the rule is about what she chewed on, not what she kept.
  const recentAbouts = [about, ...state.recentAbouts].slice(0, MAX_ABOUT_HISTORY);
  if (artifact.data.artifact === 'nothing') {
    await atomicWriteJson(statePath, {
      version: 1,
      recentAbouts,
      ...(state.lastArtifactTs !== undefined ? { lastArtifactTs: state.lastArtifactTs } : {}),
    });
    // Dropping a thin ponder is a good outcome: no episode, and the gate stays
    // warm (lastArtifactTs untouched).
    await emitLife(ctx.events, PONDER_SKIPPED_EVENT, PonderSkippedPayload, { reason: 'nothing', detail: topic });
    return;
  }

  const episodeId = newId(ctx.clock, ctx.rng);
  await deps.episodes.append({
    id: episodeId,
    ts: now,
    turnId,
    summary: `[ponder:${artifact.data.about}] ${artifact.data.conclusion}`,
    diaryLine:
      `pondered ${artifact.data.topic} (${artifact.data.about}); ${artifact.data.conclusion}` +
      (artifact.data.next === '' ? '' : ` next: ${artifact.data.next}`),
    importance: importanceOf(artifact.data.saliency),
    emotions: [], // no appraisal ran — a ponder is not a turn, and no emotion is invented for it
    threads: artifact.data.next === '' ? [] : ['ponder'],
    affectAtEncoding: Array.from(deps.vec12()),
  });
  // Her own `next` is a standing intent (Round 3): filed so the heartbeat
  // can follow up unbidden. One id on purpose - a new ponder re-arms it.
  if (artifact.data.next !== '' && deps.threads !== undefined) {
    deps.threads.apply([{ id: 'ponder', title: artifact.data.next, status: 'open' }], now);
  }
  await atomicWriteJson(statePath, { version: 1, recentAbouts, lastArtifactTs: now });
  await emitLife(
    ctx.events,
    PONDER_ARTIFACT_EVENT,
    PonderArtifactPayload,
    {
      turnId,
      episodeId,
      about: artifact.data.about,
      topic: artifact.data.topic,
      artifact: artifact.data.artifact,
      conclusion: artifact.data.conclusion,
      saliency: artifact.data.saliency,
      revised: artifact.data.changed,
    },
    turnId,
  );
};

export const ponderJob = (deps: LifeJobDeps): Job => ({
  name: 'ponder',
  cadence: { kind: 'every', ms: deps.cfg.ponderEveryMs, jitterPct: deps.cfg.jitterPct },
  lane: 'interactive',
  catchUp: 'skip', // pondering is a mood, not an obligation
  timeoutMs: deps.cfg.ponderTimeoutMs,
  run: async (ctx) => {
    try {
      await runPonder(deps, ctx);
    } catch (e) {
      await incident(ctx.events, 'ponder', 'run', asErrorMessage(e));
    }
  },
});

// ---------------------------------------------------------------------------
// Reflect — the nightly L2 consolidation (+ the weekly L3 riding one pass)
// ---------------------------------------------------------------------------

export interface ReflectJobState {
  version: 1;
  /** When the weekly L3 last ran (epoch ms), so one day-of-week fires it once. */
  lastWeeklyTs?: number | undefined;
}

const readReflectState = async (filePath: string): Promise<ReflectJobState> => {
  try {
    const raw = JSON.parse(await fsp.readFile(filePath, 'utf8')) as unknown;
    if (typeof raw !== 'object' || raw === null) return { version: 1 };
    const o = raw as Record<string, unknown>;
    return {
      version: 1,
      ...(typeof o['lastWeeklyTs'] === 'number' && Number.isFinite(o['lastWeeklyTs'])
        ? { lastWeeklyTs: o['lastWeeklyTs'] }
        : {}),
    };
  } catch {
    return { version: 1 }; // corrupt = zero state, never a crash
  }
};

/** The day's affect digest: the tags applied by `affect.applied` over the window. */
const affectDailyDigest = async (
  events: EventLog,
  sinceTs: number,
  untilTs: number,
): Promise<ReflectedPayload['affectDaily']> => {
  const tags: Record<string, number> = {};
  let emotionEvents = 0;
  for await (const e of events.replay({ kinds: ['affect.applied'], sinceTs })) {
    emotionEvents += 1;
    for (const tag of (e.payload as { tags?: readonly string[] }).tags ?? []) {
      tags[tag] = (tags[tag] ?? 0) + 1;
    }
  }
  const topTags = Object.entries(tags)
    .sort((a, b) => (b[1] !== a[1] ? b[1] - a[1] : a[0] < b[0] ? -1 : 1))
    .slice(0, 3)
    .map(([tag]) => tag);
  return { sinceTs, untilTs, emotionEvents, tags, topTags };
};

const runReflect = async (deps: LifeJobDeps, ctx: JobCtx): Promise<void> => {
  const now = ctx.clock.epochMs();
  const statePath = path.join(deps.stateDir, 'reflect.json');
  let state = await readReflectState(statePath);

  // Nightly L2 — the credit pass, the pattern crystallizer, the status
  // projection. The provider maps M10's report to the verdict vocabulary;
  // a throw is a failed nightly, never a failed job.
  let nightly: ReflectVerdict = 'failed';
  let projection: 'ok' | 'failed' = 'failed';
  try {
    const outcome = await deps.reflect('nightly');
    nightly = outcome.verdict;
    projection = outcome.projection;
  } catch (e) {
    await incident(ctx.events, 'reflect', 'nightly', asErrorMessage(e));
  }

  // Weekly L3 — rides the configured day-of-week's pass, once per week even
  // across restarts (the persisted stamp, not process memory). Day-of-week is
  // arithmetic on the clock's epoch (day 0 was a Thursday), never a wall-clock
  // Date — the determinism law runs inside job bodies too.
  const DAY = HOUR * 24;
  const dow = (Math.floor(now / DAY) + 4) % 7; // 0 = Sunday
  const weeklyDue =
    dow === deps.cfg.reflectWeeklyDow &&
    (state.lastWeeklyTs === undefined || now - state.lastWeeklyTs >= 6 * DAY);
  if (weeklyDue) {
    try {
      await deps.reflect('weekly');
      state = { ...state, lastWeeklyTs: now };
      await atomicWriteJson(statePath, state);
    } catch (e) {
      await incident(ctx.events, 'reflect', 'weekly', asErrorMessage(e));
    }
  }

  await emitLife(ctx.events, REFLECTED_EVENT, ReflectedPayload, {
    nightly,
    statusProjection: projection,
    affectDaily: await affectDailyDigest(ctx.events, now - DAY, now),
  });
};

export const reflectJob = (deps: LifeJobDeps): Job => ({
  name: 'reflect',
  cadence: { kind: 'daily', utcMinute: deps.cfg.reflectUtcMinute },
  lane: 'maintenance', // an obligation, not a mood: catch-up passes do run
  catchUp: 'once',
  timeoutMs: deps.cfg.reflectTimeoutMs,
  run: async (ctx) => {
    try {
      await runReflect(deps, ctx);
    } catch (e) {
      await incident(ctx.events, 'reflect', 'run', asErrorMessage(e));
    }
  },
});

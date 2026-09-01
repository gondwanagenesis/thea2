// M10 consolidate — the run. One orchestration skeleton serves both
// consolidators the spec names: the L2 pattern-crystallizer (nightly, lived
// output) and the L3 canon-promotion-proposer (weekly, proposals output).
//
// The laws this file enforces, in order of enforcement:
//   1. EVIDENCE: nothing is generated below minEpisodes (gate is before the model).
//   2. PROVENANCE: lived stamps come from the episodes' own records; a missing
//      outcome grade is a GAP — the draft routes to proposals/, never lived/.
//   3. GATE: a draft only lands after validateLived() passes analyzeFile with
//      zero error issues and the judge scores >= judgeThreshold.
//   4. IDEMPOTENCE: the consolidation key is checked against BOTH manifests
//      before any model call, so a replay burns no tokens and writes no bytes.
//   5. ADR-007: prod never auto-promotes — 'lived' here means corpus/lived/,
//      not canon; canon is human-only and its lint rejects lived stamps.

import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import { asError, atomicWriteJson, atomicWriteText } from '../kernel/index.js';
import { AFFECT_DIMS, DIMENSIONS } from '../../schemas/exemplar.js';
import { derivedFileId, withFileId } from '../corpus/derived-id.js';
import { compareStrings } from '../corpus/types.js';
import { OUTCOME_PREV_KIND } from '../memory/index.js';
import {
  DAY_MS,
  MIN_PATTERN_EPISODES,
  PATTERN_SIMILARITY,
  WEEK_MS,
  clusterEpisodes,
  consolidationKeyOf,
  rollupAffect,
  rollupOutcome,
  sparseSignatureOf,
  type ClusterEpisode,
} from './cluster.js';
import {
  applyOutcome,
  decayWeights,
  emptyWeightsFile,
  loadWeightsFile,
  replayWeights,
  serializeWeightsFile,
  type CreditEventView,
  type WeightsFile,
} from './credit.js';
import {
  ALARM_TUNNEL_VISION_SHARE,
  ROLLING_WINDOW,
  TUNNEL_VISION_WINDOW_MS,
  dispositionTopShare,
  dimensionCoverage,
  gravityAlarms,
  lastNPackets,
  packetsWithin,
  renderStatus,
  seedRatio,
  slotCountOf,
  type StatusInput,
} from './gravity.js';
import {
  JUDGE_THRESHOLD,
  generateDraft,
  judgeDraft,
  renderLivedDraft,
  validateLived,
  type ConsolidatedDraft,
  type GenerateRequest,
} from './draft.js';
import {
  manifestPath,
  emptyConsolidateManifest,
  loadConsolidateManifest,
  notesFor,
  outputFileName,
  rebuildManifest,
  serializeConsolidateManifest,
  sortEntries,
  type ConsolidateManifest,
  type Destination,
  type ManifestEntry,
} from './state.js';
import { ConsolidateError } from './errors.js';
import {
  CONSOLIDATE_ALARM_EVENT,
  CONSOLIDATE_GRAVITY_EVENT,
  CONSOLIDATE_RUN_EVENT,
  CONSOLIDATE_STATE_INCIDENT,
  PACKET_RECORD_KIND,
  type Alarm,
  type ConsolidateConfig,
  type ConsolidateDeps,
  type ConsolidateFailure,
  type ConsolidateReport,
  type CreditPassSummary,
  type OutcomeGrade,
  type PacketRecordView,
  type PacketSlotView,
  type RunKind,
} from './types.js';

// ---------------------------------------------------------------------------
// Consolidators + config factories
// ---------------------------------------------------------------------------

export interface Consolidator {
  name: string;
  version: string;
  destination: Destination;
}

/** L2 — nightly: episodes that repeat become one lived scene. */
export const PATTERN_CRYSTALLIZER: Consolidator = {
  name: 'pattern-crystallizer',
  version: '1',
  destination: 'lived',
};

/** L3 — weekly: proposes the week's pattern for canon; the human decides. */
export const CANON_PROMOTION_PROPOSER: Consolidator = {
  name: 'canon-promotion-proposer',
  version: '1',
  destination: 'proposal',
};

export interface ConsolidatePaths {
  livedDir: string;
  proposalsDir: string;
  reportsDir: string;
}

/** Defaults for L2; `over` pins a knob per environment (tests use it for thresholds). */
export const nightlyConfig = (
  paths: ConsolidatePaths,
  gravityWeek: number,
  over: Partial<ConsolidateConfig> = {},
): ConsolidateConfig => ({
  ...paths,
  windowMs: DAY_MS,
  similarity: PATTERN_SIMILARITY,
  minEpisodes: MIN_PATTERN_EPISODES,
  judgeThreshold: JUDGE_THRESHOLD,
  gravityWeek,
  driftCosine: undefined,
  ...over,
});

/** L3 runs on the week's episodes, not the day's. */
export const weeklyConfig = (
  paths: ConsolidatePaths,
  gravityWeek: number,
  over: Partial<ConsolidateConfig> = {},
): ConsolidateConfig => ({ ...nightlyConfig(paths, gravityWeek, over), windowMs: WEEK_MS });

const MAX_ATTEMPTS = 2;

// ---------------------------------------------------------------------------
// L0 replay — packets + outcomes, in append order
// ---------------------------------------------------------------------------

const PacketSlotBoundary = z.object({
  exemplarId: z.string().min(1),
  tier: z.enum(['disposition', 'pattern', 'episode', 'memory', 'procedure']),
  channel: z.enum(['character', 'procedural']),
  baseScore: z.number(),
  modulation: z.number(),
  slot: z.literal('contrast').optional(),
});

const PacketRecordBoundary = z.object({
  turnId: z.string().min(1),
  slots: z.array(PacketSlotBoundary),
  affectSig: z.array(z.number()),
});

const OutcomeBoundary = z.object({
  turnId: z.string().min(1),
  sign: z.union([z.literal(-1), z.literal(0), z.literal(1)]),
  evidence: z.string().min(1),
});

export interface L0Replay {
  packets: PacketRecordView[];
  outcomes: Map<string, OutcomeGrade>;
  creditEvents: CreditEventView[];
  maxSeq: number;
  malformedRecords: number;
}

/** The packet-record + outcome half of L0, in append order. Malformed payloads
 * are skipped and COUNTED — a bad row degrades quietly into a number the report
 * carries, never into a crash or a silent loss. */
export const replayL0 = async (events: ConsolidateDeps['events']): Promise<L0Replay> => {
  const packets: PacketRecordView[] = [];
  const outcomes = new Map<string, OutcomeGrade>();
  const creditEvents: CreditEventView[] = [];
  let maxSeq = 0;
  let malformedRecords = 0;
  for await (const ev of events.replay({ kinds: [PACKET_RECORD_KIND, OUTCOME_PREV_KIND] })) {
    maxSeq = Math.max(maxSeq, ev.seq);
    if (ev.kind === PACKET_RECORD_KIND) {
      const parsed = PacketRecordBoundary.safeParse(ev.payload);
      if (!parsed.success) {
        malformedRecords += 1;
        continue;
      }
      const packet: PacketRecordView = {
        ts: ev.ts,
        turnId: parsed.data.turnId,
        slots: parsed.data.slots.map((s): PacketSlotView => ({ ...s })),
        affectSig: parsed.data.affectSig,
      };
      packets.push(packet);
      creditEvents.push({ seq: ev.seq, kind: 'packet', packet });
      continue;
    }
    const parsedOutcome = OutcomeBoundary.safeParse(ev.payload);
    if (!parsedOutcome.success) {
      malformedRecords += 1;
      continue;
    }
    const grade: OutcomeGrade = { sign: parsedOutcome.data.sign, evidence: parsedOutcome.data.evidence };
    outcomes.set(parsedOutcome.data.turnId, grade);
    // One outcome per TURN: the same grade can reach L0 through more than one
    // writer (memory's outcome.prev and the bridge's own emission), and the
    // credit pass must grade a turn once, not per row. Keep the LAST row —
    // the freshest observation — in append position; drop the stale one so
    // both this pass and replayWeights' fold apply it exactly once.
    const stale = creditEvents.findIndex(
      (c) => c.kind === 'outcome' && c.turnId === parsedOutcome.data.turnId,
    );
    const row: CreditEventView = { seq: ev.seq, kind: 'outcome', turnId: parsedOutcome.data.turnId, outcome: grade };
    if (stale >= 0) creditEvents.splice(stale, 1);
    creditEvents.push(row);
  }
  return { packets, outcomes, creditEvents, maxSeq, malformedRecords };
};

// ---------------------------------------------------------------------------
// Credit pass — nightly only
// ---------------------------------------------------------------------------

const applyCredit = async (
  deps: ConsolidateDeps,
  replay: L0Replay,
): Promise<{ summary: CreditPassSummary; file: WeightsFile; raw: string | undefined }> => {
  let raw: string | undefined;
  try {
    raw = await fsp.readFile(deps.creditPath, 'utf8');
  } catch {
    raw = undefined; // missing file = launch state, not an incident
  }
  let file: WeightsFile;
  let rebuilt = false;
  if (raw === undefined) {
    file = emptyWeightsFile();
  } else {
    try {
      file = loadWeightsFile(raw);
    } catch (e) {
      const err = asError(e);
      file = replayWeights(replay.creditEvents);
      rebuilt = true;
      await deps.events.emit(CONSOLIDATE_STATE_INCIDENT, {
        path: deps.creditPath,
        reason: err.message,
        recovery: 'replayed weights from L0',
        entries: Object.keys(file.weights).length,
      });
    }
  }

  let weights = { ...file.weights };
  let applied = 0;
  let skippedNoPacket = 0;
  const byTurn = new Map(replay.packets.map((p) => [p.turnId, p]));
  for (const ev of replay.creditEvents) {
    if (ev.kind !== 'outcome' || ev.seq <= file.lastSeq) continue;
    const packet = byTurn.get(ev.turnId);
    if (packet === undefined) {
      skippedNoPacket += 1;
      continue;
    }
    weights = applyOutcome(weights, packet, ev.outcome, packet.affectSig);
    applied += 1;
  }
  // Decay is once per DAY, not once per run: a same-day replay of this pass must
  // leave the file byte-identical (gate e), while a night that ran nothing still
  // pulls stale weights toward neutral on the next calendar day.
  const today = Math.floor(deps.clock.epochMs() / DAY_MS);
  const decayed = today > file.decayDay;
  if (decayed) weights = decayWeights(weights);
  const next: WeightsFile = {
    version: 1,
    lastSeq: Math.max(file.lastSeq, replay.maxSeq),
    decayDay: decayed ? today : file.decayDay,
    weights,
  };
  return { summary: { applied, skippedNoPacket, lastSeq: next.lastSeq, rebuilt, decayed }, file: next, raw };
};

// ---------------------------------------------------------------------------
// Affect weather + episode helpers
// ---------------------------------------------------------------------------

const AppliedBoundary = z.object({ tags: z.array(z.string()) });

/** Top applied emotion tags over the window, "tag N" pairs, deterministic order.
 * This is the window's emotional weather — context for the room the pattern
 * happened in, and the weekly baseline's affect line. */
export const affectWeather = async (
  deps: ConsolidateDeps,
  sinceTs: number,
): Promise<Array<{ tag: string; n: number }>> => {
  const counts = new Map<string, number>();
  for await (const ev of deps.affectHistory.replay({ kinds: ['affect.applied'], sinceTs })) {
    const parsed = AppliedBoundary.safeParse(ev.payload);
    if (!parsed.success) continue;
    for (const tag of parsed.data.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([tag, n]) => ({ tag, n }))
    .sort((a, b) => b.n - a.n || compareStrings(a.tag, b.tag));
};

const fmtWeather = (weather: ReadonlyArray<{ tag: string; n: number }>): string =>
  weather.slice(0, 5).map((w) => `${w.tag} ${w.n}`).join(' · ');

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** The episode's affect stamp, condensed for a prompt: the dims that moved. */
const describeAffect = (stamp: readonly number[], dims: readonly string[]): string => {
  const moved = stamp
    .map((v, i) => ({ v, dim: dims[i] ?? `dim${i}` }))
    .filter((x) => x.v !== 0)
    .sort((a, b) => Math.abs(b.v) - Math.abs(a.v) || compareStrings(a.dim, b.dim))
    .slice(0, 3);
  return moved.length === 0 ? 'flat' : moved.map((x) => `${x.dim} ${x.v}`).join(', ');
};

const describeOutcome = (grade: OutcomeGrade | undefined): string =>
  grade === undefined ? 'no outcome record' : `"${oneLine(grade.evidence)}" (sign ${grade.sign})`;

// ---------------------------------------------------------------------------
// Per-cluster consolidation — generate, validate, judge, write
// ---------------------------------------------------------------------------

interface ClusterResult {
  destination: Destination;
  id: string;
  evidenceGap: boolean;
}

type FailureBody = Omit<ConsolidateFailure, 'key' | 'consolidator'>;

interface FailureSink {
  push(f: FailureBody): void;
}

const makeSink = (
  key: string,
  consolidator: Consolidator,
  failures: ConsolidateFailure[],
): FailureSink => ({
  push: (f) => {
    failures.push({ key, consolidator: consolidator.name, ...f });
  },
});

/**
 * The proposal reason baked into `notes` — undefined means NO proposal marker:
 * a nightly lived draft with complete provenance is not a proposal, and marking
 * it "human merge required" would misstate what it is. Only genuine proposal
 * destinations and provenance gaps carry the marker.
 */
const proposalReasonFor = (consolidator: Consolidator, evidenceGap: boolean): string | undefined => {
  if (consolidator.destination === 'proposal') return 'canon promotion candidate';
  return evidenceGap ? 'incomplete provenance: a source episode has no outcome record' : undefined;
};

/**
 * One pattern → at most one written file. Order per attempt: generate (cheap
 * tier, seeded from the consolidation key so a replay would reproduce it),
 * emit as a lived file, validate through M07's analyzeFile, judge (reasoning
 * tier). Two strikes on any stage and the pattern is DROPPED with a failure
 * record — never half-written, never written unjudged.
 */
const consolidateCluster = async (
  deps: ConsolidateDeps,
  consolidator: Consolidator,
  key: string,
  clusterEpisodesList: ClusterEpisode[],
  outcomes: ReadonlyMap<string, OutcomeGrade>,
  failures: ConsolidateFailure[],
  weather: string,
): Promise<ClusterResult | undefined> => {
  const sink = makeSink(key, consolidator, failures);
  const roll = rollupOutcome(clusterEpisodesList.map((e) => outcomes.get(e.turnId)));
  const evidenceGap = !roll.ok;
  const outcome = roll.ok ? roll.outcome : 'mixed';
  const encodedAffect = rollupAffect(clusterEpisodesList.map((e) => e.affectAtEncoding));
  const affect = sparseSignatureOf(encodedAffect);
  const episodeIds = clusterEpisodesList.map((e) => e.id);

  const destination: Destination = evidenceGap ? 'proposal' : consolidator.destination;
  const notes = notesFor(consolidator, key, proposalReasonFor(consolidator, evidenceGap));
  const req: GenerateRequest = {
    episodes: clusterEpisodesList.map((e) => ({
      summary: e.summary,
      importance: e.importance,
      affect: describeAffect(e.affectAtEncoding, AFFECT_DIMS),
      outcome: describeOutcome(outcomes.get(e.turnId)),
    })),
    dimensionVocab: [...DIMENSIONS],
    registerVocab: deps.corpus.tags(),
    affectWeather: weather.length > 0 ? weather : undefined,
  };

  for (let attempt = 1 as 1 | 2; attempt <= MAX_ATTEMPTS; attempt = (attempt + 1) as 1 | 2) {
    // The seed is load-bearing: forked per (key, attempt), fed to the model as a
    // seedHint, and echoed by the test model — same store + seed ⇒ same draft.
    const rng = deps.rng.fork(`${key}::attempt-${attempt}`);
    let draft: ConsolidatedDraft;
    try {
      draft = await generateDraft(deps.model, req, rng.int(1, 2147483647));
    } catch (e) {
      const err = asError(e);
      sink.push({ attempt, stage: 'generate', code: err.code, message: err.message });
      continue;
    }

    if (!draft.register.every((r) => req.registerVocab.includes(r))) {
      sink.push({
        attempt,
        stage: 'validate',
        code: 'consolidate/draft-shape',
        message: `register tag outside corpus vocabulary: ${draft.register.filter((r) => !req.registerVocab.includes(r)).join(', ')}`,
      });
      continue;
    }

    const text = renderLivedDraft(
      { dimensions: draft.dimensions, register: draft.register, affect, context: draft.context, weight: 1, episodeIds, encodedAffect, outcome, notes },
      draft.body,
    );
    try {
      validateLived(text);
    } catch (e) {
      const err = asError(e);
      sink.push({ attempt, stage: 'validate', code: err.code, message: err.message });
      continue;
    }

    try {
      const verdict = await judgeDraft(deps.model, req, draft);
      if (verdict.score < deps.cfg.judgeThreshold) {
        sink.push({
          attempt,
          stage: 'judge',
          code: 'consolidate/judged-out',
          message: `judge scored ${verdict.score} < ${deps.cfg.judgeThreshold}: ${oneLine(verdict.reason)}`,
        });
        continue;
      }
    } catch (e) {
      const err = asError(e);
      sink.push({ attempt, stage: 'judge', code: err.code, message: err.message });
      continue;
    }

    // Accepted: stamp the id, write atomically. lived/ is named by content id,
    // proposals/ by consolidation key (stable and human-greppable).
    const id = derivedFileId(text);
    const final = withFileId(text, id);
    const file = path.join(
      destination === 'lived' ? deps.cfg.livedDir : deps.cfg.proposalsDir,
      outputFileName(destination, id, key),
    );
    await atomicWriteText(file, final);
    return { destination, id, evidenceGap };
  }
  return undefined;
};

// ---------------------------------------------------------------------------
// State — one manifest per output directory
// ---------------------------------------------------------------------------

interface OpenedState {
  manifest: ConsolidateManifest;
  /** The bytes on disk, if any — the write-skip comparison base. */
  raw: string | undefined;
}

const openState = async (
  deps: ConsolidateDeps,
  dir: string,
  destination: Destination,
): Promise<OpenedState> => {
  let raw: string | undefined;
  try {
    raw = await fsp.readFile(manifestPath(dir), 'utf8');
  } catch {
    return { manifest: emptyConsolidateManifest(), raw: undefined };
  }
  try {
    return { manifest: loadConsolidateManifest(raw), raw };
  } catch (e) {
    const err = asError(e);
    const rebuilt = await rebuildManifest(dir, destination);
    await deps.events.emit(CONSOLIDATE_STATE_INCIDENT, {
      path: manifestPath(dir),
      reason: err.message,
      recovery: 'rebuilt manifest from files',
      unrecoverable: rebuilt.unrecoverable,
    });
    return { manifest: rebuilt.manifest, raw: undefined }; // rebuilt state must persist
  }
};

const persistState = async (
  dir: string,
  state: OpenedState,
  fresh: ManifestEntry[],
): Promise<boolean> => {
  if (fresh.length === 0 && state.raw !== undefined) return false; // replay: touch nothing
  const manifest: ConsolidateManifest = {
    version: 1,
    entries: sortEntries([...state.manifest.entries, ...fresh]),
  };
  const serialized = serializeConsolidateManifest(manifest);
  if (serialized === state.raw) return false;
  await atomicWriteJson(manifestPath(dir), manifest);
  return true;
};

// ---------------------------------------------------------------------------
// Gravity + projection
// ---------------------------------------------------------------------------

const gravityPass = async (
  deps: ConsolidateDeps,
  packets: readonly PacketRecordView[],
  kind: RunKind,
  now: number,
  weather: ReadonlyArray<{ tag: string; n: number }>,
  windowEps: ReadonlyArray<{ threads: readonly string[]; importance: number }>,
): Promise<{ seedRatio: { pattern: number; episode: number }; alarms: Alarm[] }> => {
  // Seed membership is a corpus question, not a packet question: seed = canon + derived.
  const seedIds = new Set<string>(
    [...deps.corpus.bySource('canon'), ...deps.corpus.bySource('derived')].map((e) => e.id),
  );
  const dimensionOf = (id: string): string | undefined => deps.corpus.byId(id)?.dimensions[0];

  const rolling = lastNPackets(packets, ROLLING_WINDOW);
  const ratio = {
    pattern: seedRatio(rolling, 'pattern', seedIds),
    episode: seedRatio(rolling, 'episode', seedIds),
  };
  const disposition = dispositionTopShare(packetsWithin(packets, now, TUNNEL_VISION_WINDOW_MS), dimensionOf);
  const alarms = gravityAlarms({
    seedRatio: ratio,
    patternSlots: slotCountOf(rolling, 'pattern'),
    episodeSlots: slotCountOf(rolling, 'episode'),
    disposition,
    gravityWeek: deps.cfg.gravityWeek,
  });

  await deps.events.emit(CONSOLIDATE_GRAVITY_EVENT, { seedRatio: ratio, alarms });
  for (const alarm of alarms) {
    const detail =
      alarm === 'unmoored'
        ? `seedRatio pattern ${ratio.pattern.toFixed(3)} / episode ${ratio.episode.toFixed(3)} below ${0.25}`
        : alarm === 'not-integrating'
          ? `seedRatio above 0.90 past week ${deps.cfg.gravityWeek}`
          : `disposition slots concentrated on '${disposition.dimension}' at ${(disposition.share * 100).toFixed(0)}% (limit ${(ALARM_TUNNEL_VISION_SHARE * 100).toFixed(0)}%)`;
    await deps.events.emit(CONSOLIDATE_ALARM_EVENT, { alarm, detail });
  }

  const input: StatusInput = {
    kind,
    gravityWeek: deps.cfg.gravityWeek,
    windowPackets: rolling.length,
    seedRatio: ratio,
    coverage: dimensionCoverage(rolling, dimensionOf),
    disposition,
    driftCosine: deps.cfg.driftCosine,
    alarms,
  };
  if (kind === 'weekly') {
    const threads = new Set<string>();
    let importance = 0;
    for (const e of windowEps) {
      for (const t of e.threads) threads.add(t);
      importance += e.importance;
    }
    input.baseline = [
      `- episodes this window: ${windowEps.length}`,
      `- distinct threads: ${threads.size}`,
      `- mean importance: ${(windowEps.length === 0 ? 0 : importance / windowEps.length).toFixed(2)}`,
      `- top affect tags: ${weather.length === 0 ? '(none recorded)' : fmtWeather(weather)}`,
    ];
  }
  await atomicWriteText(path.join(deps.cfg.reportsDir, 'status.md'), renderStatus(input));
  return { seedRatio: ratio, alarms };
};

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

const runConsolidation = async (deps: ConsolidateDeps, kind: RunKind): Promise<ConsolidateReport> => {
  const startedAt = deps.clock.epochMs();
  const now = deps.clock.epochMs();
  const consolidator = kind === 'nightly' ? PATTERN_CRYSTALLIZER : CANON_PROMOTION_PROPOSER;

  const replay = await replayL0(deps.events);

  // Credit is the nightly batch's job (spec §2.1); the weekly proposal pass
  // reads the same weights but does not re-apply them.
  let credit: CreditPassSummary = {
    applied: 0,
    skippedNoPacket: 0,
    lastSeq: replay.maxSeq,
    rebuilt: false,
    decayed: false,
  };
  let creditRaw: string | undefined;
  let creditNext: WeightsFile | undefined;
  if (kind === 'nightly') {
    const pass = await applyCredit(deps, replay);
    credit = pass.summary;
    creditRaw = pass.raw;
    creditNext = pass.file;
  }

  // ---- episodes in the window, embedded
  const window = deps.episodes.all().filter((e) => e.ts >= now - deps.cfg.windowMs && e.ts <= now);
  await deps.episodes.vecsFor(window.map((e) => e.id));
  const episodes: ClusterEpisode[] = [];
  for (const e of window) {
    const vec = deps.episodes.vecOf(e.id);
    if (vec === undefined) {
      throw new ConsolidateError('consolidate/no-vector', `episode '${e.id}' has no embedding after vecsFor`);
    }
    episodes.push({
      id: e.id,
      ts: e.ts,
      turnId: e.turnId,
      summary: e.summary,
      importance: e.importance,
      affectAtEncoding: e.affectAtEncoding,
      vec,
    });
  }
  const clusters = clusterEpisodes(episodes, deps.cfg.similarity);
  const targets = clusters.filter((c) => c.episodes.length >= deps.cfg.minEpisodes);
  const belowThreshold = clusters.length - targets.length;

  const weather = await affectWeather(deps, now - deps.cfg.windowMs);
  const weatherLine = fmtWeather(weather);

  // ---- manifests first: the replay gate is checked BEFORE any model call
  const livedState = await openState(deps, deps.cfg.livedDir, 'lived');
  const proposalState = await openState(deps, deps.cfg.proposalsDir, 'proposal');
  const knownKeys = new Set<string>(
    [...livedState.manifest.entries, ...proposalState.manifest.entries].map((e) => e.key),
  );

  const failures: ConsolidateFailure[] = [];
  const freshLived: ManifestEntry[] = [];
  const freshProposals: ManifestEntry[] = [];
  let skippedExisting = 0;
  let writtenLived = 0;
  let writtenProposals = 0;
  let judgeFailed = 0;
  let parseFailed = 0;
  let evidenceGaps = 0;

  for (const cluster of targets) {
    const key = consolidationKeyOf(consolidator, cluster.episodes.map((e) => e.id));
    if (knownKeys.has(key)) {
      skippedExisting += 1;
      continue;
    }
    const before = failures.length;
    const result = await consolidateCluster(
      deps,
      consolidator,
      key,
      cluster.episodes,
      replay.outcomes,
      failures,
      weatherLine,
    );
    if (result === undefined) {
      // Two strikes: classify why (a judge rejection is a quality verdict, not a parse bug).
      const dropped = failures.slice(before);
      if (dropped.some((f) => f.stage === 'judge' && f.code === 'consolidate/judged-out')) judgeFailed += 1;
      else parseFailed += 1;
      continue;
    }
    const entry: ManifestEntry = {
      key,
      consolidator: consolidator.name,
      consolidatorVersion: consolidator.version,
      episodeIds: [...cluster.episodes.map((e) => e.id)].sort(compareStrings),
      destination: result.destination,
      id: result.id,
      createdAt: deps.clock.epochMs(),
    };
    if (result.destination === 'lived') {
      freshLived.push(entry);
      writtenLived += 1;
    } else {
      freshProposals.push(entry);
      writtenProposals += 1;
      if (result.evidenceGap) evidenceGaps += 1;
    }
  }

  await persistState(deps.cfg.livedDir, livedState, freshLived);
  await persistState(deps.cfg.proposalsDir, proposalState, freshProposals);

  if (creditNext !== undefined) {
    const serialized = serializeWeightsFile(creditNext);
    if (serialized !== creditRaw) await atomicWriteJson(deps.creditPath, creditNext);
  }

  const gravity = await gravityPass(deps, replay.packets, kind, now, weather, window);

  const report: ConsolidateReport = {
    // ok means: nothing was dropped, nothing was swallowed. The per-attempt
    // failure list stays as the audit trail even when a retry recovered.
    ok: replay.malformedRecords === 0 && judgeFailed === 0 && parseFailed === 0,
    kind,
    episodesConsidered: episodes.length,
    clusters: clusters.length,
    targets: targets.length,
    skippedExisting,
    writtenLived,
    writtenProposals,
    judgeFailed,
    parseFailed,
    belowThreshold,
    evidenceGaps,
    credit,
    gravity,
    failures,
    malformedRecords: replay.malformedRecords,
  };
  await deps.events.emit(CONSOLIDATE_RUN_EVENT, {
    kind,
    episodes: episodes.length,
    targets: targets.length,
    skippedExisting,
    writtenLived,
    writtenProposals,
    judgeFailed,
    parseFailed,
    belowThreshold,
    evidenceGaps,
    malformedRecords: replay.malformedRecords,
    creditApplied: credit.applied,
    alarms: gravity.alarms,
    durationMs: deps.clock.epochMs() - startedAt,
  });
  return report;
};

export const consolidateNightly = (deps: ConsolidateDeps): Promise<ConsolidateReport> =>
  runConsolidation(deps, 'nightly');

export const consolidateWeekly = (deps: ConsolidateDeps): Promise<ConsolidateReport> =>
  runConsolidation(deps, 'weekly');

// M10 consolidate — public contract types (docs/modules/M10-consolidate.md
// §Interfaces). The seam M20 composes (`consolidateNightly` / `consolidateWeekly`
// inside M16 job bodies) and the payload vocabulary M16/M18 re-use.
//
// Two shapes here are deliberate STRUCTURAL MIRRORS rather than imports:
//   * PacketRecordView mirrors M11's PacketRecord (+ the L0 envelope ts) —
//     `src/assemble` is not an allowed edge for this module, and the mirror is
//     exactly how M11 handled the same constraint with M15's SpeakerRef.
//   * CreditWeights is a plain index-signature record so it serializes to
//     var/credit/weights.json without a wrapper.

import type { EventLog } from '../events/index.js';
import type { Clock, Rng } from '../kernel/index.js';
import type { ModelClient } from '../model/index.js';
import type { CorpusIndex } from '../corpus/corpus-index.js';
import type { EpisodeStore } from '../memory/index.js';

// ---------------------------------------------------------------------------
// Shared vocabulary
// ---------------------------------------------------------------------------

export type RunKind = 'nightly' | 'weekly';

/** The three drift alarms (ADR-005). Emitted on `consolidate.alarm`. */
export type Alarm = 'unmoored' | 'not-integrating' | 'tunnel-vision';

/** Slot tiers as the packet record carries them (M11's CandidateTier). */
export type SlotTier = 'disposition' | 'pattern' | 'episode' | 'memory' | 'procedure';

/**
 * One filled slot of a packet record. `slot: 'contrast'` marks the contrast
 * slot — the record the assembler emits has no tier for it, so the marker is
 * the only way credit can honor "contrast is credited on +1 only". A slot
 * without the marker is credited at its tier's share.
 */
export interface PacketSlotView {
  exemplarId: string;
  tier: SlotTier;
  channel: 'character' | 'procedural';
  baseScore: number;
  modulation: number;
  slot?: 'contrast' | undefined;
}

/**
 * A PacketRecord as credit assignment and gravity metrics consume it: the
 * record itself is clock-free, so its timestamp rides on the L0 envelope of
 * the `packet.record` event it was emitted in.
 */
export interface PacketRecordView {
  ts: number;
  turnId: string;
  slots: PacketSlotView[];
  affectSig: readonly number[];
}

/** The grade M09's appraisal left on a turn's packet (`memory.outcome_prev`). */
export interface OutcomeGrade {
  sign: -1 | 0 | 1;
  evidence: string;
}

/** Exemplar id → credit weight. Absent id = 1.0; clamp [0.5, 2.0] everywhere. */
export interface CreditWeights {
  [exemplarId: string]: number;
}

// ---------------------------------------------------------------------------
// Config + deps
// ---------------------------------------------------------------------------

export interface ConsolidateConfig {
  /** corpus/lived — the only directory L2 may write exemplars into. */
  livedDir: string;
  /** corpus/proposals — drafts for the human; never canon, never auto-promoted. */
  proposalsDir: string;
  /** var/reports — the status.md projection (nightly) + relationship baseline. */
  reportsDir: string;
  /** How far back a run looks for episodes: DAY_MS (L2) / WEEK_MS (L3). */
  windowMs: number;
  /** Cosine above which an episode joins a pattern cluster. */
  similarity: number;
  /** Evidence threshold: episodes per pattern before consolidation fires. */
  minEpisodes: number;
  /** Minimum judge score (1-5) a draft needs to be written. */
  judgeThreshold: number;
  /** Weeks since launch — gates the not-integrating alarm (fires only after week 6). */
  gravityWeek: number;
  /** M19's latest drift cosine, injected for the projection's cross-check line. */
  driftCosine?: number | undefined;
}

/**
 * One model client serves both roles: generation is taskClass 'consolidate'
 * (cheap tier), judging is taskClass 'judge' (reasoning tier) — the tiers are a
 * routing decision (ADR-008), not two clients.
 */
export interface ConsolidateDeps {
  model: ModelClient;
  episodes: EpisodeStore;
  corpus: CorpusIndex;
  /** The affect half of L0 (`affect.applied`) — the day's emotional weather. */
  affectHistory: EventLog;
  /** var/credit/weights.json (kernel atomic writes; missing file = launch state). */
  creditPath: string;
  /** L0: packet.record + memory.outcome_prev in, consolidate.* out. */
  events: EventLog;
  clock: Clock;
  rng: Rng;
  cfg: ConsolidateConfig;
}

// ---------------------------------------------------------------------------
// Run report + L0 payloads
// ---------------------------------------------------------------------------

export interface ConsolidateFailure {
  key: string;
  consolidator: string;
  attempt: 1 | 2;
  stage: 'generate' | 'validate' | 'judge';
  code: string;
  message: string;
}

/** What the credit pass did this run. `rebuilt` = weights were recovered from L0. */
export interface CreditPassSummary {
  applied: number;
  skippedNoPacket: number;
  lastSeq: number;
  rebuilt: boolean;
  /** True when the once-per-day decay ran this pass. */
  decayed: boolean;
}

export interface ConsolidateReport {
  ok: boolean;
  kind: RunKind;
  episodesConsidered: number;
  clusters: number;
  /** Clusters at or above the evidence threshold — the run's consolidation targets. */
  targets: number;
  /** Targets whose consolidation key was already in the manifest — replays. */
  skippedExisting: number;
  writtenLived: number;
  writtenProposals: number;
  /** Targets dropped after the judge failed them twice. */
  judgeFailed: number;
  /** Targets dropped after two unparseable/unfaithful generations. */
  parseFailed: number;
  /** Clusters below the evidence threshold — nothing written, nothing generated. */
  belowThreshold: number;
  /** Accepted drafts routed to proposals/ because provenance was incomplete. */
  evidenceGaps: number;
  credit: CreditPassSummary;
  gravity: { seedRatio: { pattern: number; episode: number }; alarms: Alarm[] };
  failures: ConsolidateFailure[];
  /** L0 packet/outcome payloads that failed their boundary schema (skipped, counted). */
  malformedRecords: number;
}

/** `consolidate.run` payload — counts + durations, no content. */
export interface ConsolidateRunEvent {
  kind: RunKind;
  episodes: number;
  targets: number;
  skippedExisting: number;
  writtenLived: number;
  writtenProposals: number;
  judgeFailed: number;
  parseFailed: number;
  belowThreshold: number;
  evidenceGaps: number;
  malformedRecords: number;
  creditApplied: number;
  alarms: Alarm[];
  durationMs: number;
}

/** `consolidate.gravity` payload (mirrors schemas/events.ts GravityPayload). */
export interface GravityEvent {
  seedRatio: { pattern: number; episode: number };
  alarms: Alarm[];
}

/** `consolidate.alarm` payload — one per alarm, with the numbers that fired it. */
export interface ConsolidateAlarmEvent {
  alarm: Alarm;
  detail: string;
}

// ---------------------------------------------------------------------------
// L0 kinds owned/consumed here
// ---------------------------------------------------------------------------

/** The packet summary credit assignment consumes (emitted by M13/M20). */
export const PACKET_RECORD_KIND = 'packet.record';
/** Nightly/weekly run summary. */
export const CONSOLIDATE_RUN_EVENT = 'consolidate.run';
/** Rolling gravity metrics, per ADR-005's observability clause. */
export const CONSOLIDATE_GRAVITY_EVENT = 'consolidate.gravity';
/** One per alarm, evaluated nightly. */
export const CONSOLIDATE_ALARM_EVENT = 'consolidate.alarm';
/** consolidate-owned state (weights/manifest) was corrupt and was rebuilt. */
export const CONSOLIDATE_STATE_INCIDENT = 'incident.consolidate_state';

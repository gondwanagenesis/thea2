// M10 consolidate — public barrel. M16 composes `consolidateNightly` /
// `consolidateWeekly` into job bodies; M11/M20 consume the credit + gravity
// vocabulary. Everything else is module-internal.

export type {
  Alarm,
  ConsolidateAlarmEvent,
  ConsolidateConfig,
  ConsolidateDeps,
  ConsolidateFailure,
  ConsolidateReport,
  ConsolidateRunEvent,
  CreditPassSummary,
  CreditWeights,
  GravityEvent,
  OutcomeGrade,
  PacketRecordView,
  PacketSlotView,
  RunKind,
  SlotTier,
} from './types.js';
export {
  CONSOLIDATE_ALARM_EVENT,
  CONSOLIDATE_GRAVITY_EVENT,
  CONSOLIDATE_RUN_EVENT,
  CONSOLIDATE_STATE_INCIDENT,
  PACKET_RECORD_KIND,
} from './types.js';
export { ConsolidateError } from './errors.js';
export type { ConsolidateErrorCode } from './errors.js';

export type { Consolidator } from './run.js';
export {
  CANON_PROMOTION_PROPOSER,
  PATTERN_CRYSTALLIZER,
  consolidateNightly,
  consolidateWeekly,
  nightlyConfig,
  weeklyConfig,
} from './run.js';

export {
  DAY_MS,
  MIN_PATTERN_EPISODES,
  PATTERN_SIMILARITY,
  WEEK_MS,
  clusterEpisodes,
  consolidationKeyOf,
  cosine,
  rollupAffect,
  rollupOutcome,
  sparseSignatureOf,
} from './cluster.js';
export type { ClusterEpisode, PatternCluster } from './cluster.js';

export {
  CREDIT_ETA,
  CREDIT_CLAMP,
  CONTRAST_PLUS_SHARE,
  MOOD_GUARD,
  NIGHTLY_DECAY,
  SLOT_SHARE,
  applyOutcome,
  aversiveNorm,
  clampWeight,
  decayWeights,
  emptyWeightsFile,
  loadWeightsFile,
  moodGuardFor,
  replayWeights,
  serializeWeightsFile,
  shareFor,
} from './credit.js';
export type { CreditEventView, WeightsFile } from './credit.js';

export {
  ALARM_NOT_INTEGRATING_RATIO,
  ALARM_NOT_INTEGRATING_WEEK,
  ALARM_TUNNEL_VISION_SHARE,
  ALARM_UNMOORED_RATIO,
  ROLLING_WINDOW,
  TUNNEL_VISION_WINDOW_MS,
  dimensionCoverage,
  dispositionTopShare,
  gravityAlarms,
  lastNPackets,
  packetsWithin,
  renderStatus,
  seedRatio,
  slotCountOf,
} from './gravity.js';
export type { DispositionShare, GravityMetrics, StatusInput } from './gravity.js';

export {
  GENERATE_MAX_TOKENS,
  GENERATE_TEMPERATURE,
  JUDGE_THRESHOLD,
  JUDGE_VERSION,
  ConsolidatedDraft,
  JudgeVerdict,
  fileBaseName,
  generateDraft,
  generateSystemPrompt,
  generateUserPrompt,
  judgeDraft,
  judgeSystemPrompt,
  judgeUserPrompt,
  renderLivedDraft,
  validateLived,
} from './draft.js';
export type { GenerateRequest, LivedDraftMeta } from './draft.js';

export {
  MANIFEST_NAME,
  emptyConsolidateManifest,
  keyFromNotes,
  loadConsolidateManifest,
  manifestPath,
  notesFor,
  outputFileName,
  rebuildManifest,
  serializeConsolidateManifest,
  sortEntries,
} from './state.js';
export type { ConsolidateManifest, Destination, ManifestEntry, RecoveredKey } from './state.js';

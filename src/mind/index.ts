// v8 mind — public surface ("Nothing Told", plan thea2-v8-nothing-told.md).

export * from './types.js';
export * from './vocab.js';
export { cosine, openVecFile, type VecFile } from './vectors.js';
export { openMindStore, emptyMindState, isPrecedent, offVoice, MACHINERY_TALK, LOVE_DECLARATION, type MindStore, type Centroids } from './store.js';
export { sense, situationText, replyText, nearestLabel, type Sensed, type Label } from './sense.js';
export { evoke, scoreMoment, moodTerm, intensityTerm, dreamtTerm, linkBonus, EVOKE_DEFAULTS, EVOKE_WEIGHTS, NONEXACT_FELT_WEIGHT, type EvokeConfig, type EvokeInput, type Evoked, type Scored } from './evoke.js';
export { feelFast, type FastEvent, type FeelFastInput } from './feel.js';
export { metabolism, energyOf, type Metabolism, type MetabolismCtx } from './modulate.js';
export {
  composePacket,
  composeSegments,
  feedbackArm,
  lintSegments,
  TELLING_PATTERNS,
  V8_OUTPUT_CONTRACT,
  hourIn,
  dateLabel,
  ago,
  type ComposeInput,
  type MindPacket,
  type Segment,
  type LintHit,
} from './compose.js';
export { appraiseSlow, slowEvents, appraiserUser, APPRAISER_SYSTEM, SlowAppraisalSchema, type SlowAppraisal, type SlowAppraiseInput } from './appraise.js';
export { encodeLived, actsOf, inferFollowed, bestOption, applyOutcome, markShown, mostFelt, peakEnd, FOLLOW_THRESHOLD, RECONSOLIDATION_RHO, type EncodeInput } from './remember.js';
export {
  wanderOnce,
  wanderJob,
  candidates,
  pickItem,
  habituation,
  freshness,
  dayKey,
  inQuietHours,
  rollWander,
  tryTextFirst,
  ThoughtSchema,
  THINKER_SYSTEM,
  type RoomSeam,
  isGrounded,
  FOUND_ID_PREFIX,
  type Item,
  type WanderCfg,
  type WanderDeps,
  type CuriositySeam,
  type TextFirstDeps,
} from './wander.js';
export {
  makeCuriosity,
  questionValue,
  restlessWeight,
  invU,
  topicOverlap,
  topicTokens,
  decayedStrength,
  INVESTIGATOR_FRAME,
  LEARNING_JUDGE_SYSTEM,
  LearnSchema,
  TWIN_SIM,
  INTEREST_HALF_LIFE_MS,
  type Curiosity,
  type CuriosityDeps,
  type CuriosityCfg,
  type CuriosityMode,
  type PursuitRequest,
  type PursuitResult,
  type LearnOutcome,
  type ValueCtx,
  type Learn,
} from './curiosity.js';
export { sleepOnce, sleepJob, SelfRewriteSchema, capDoubt, isDoubtLine, dreamMotif, SELF_DOUBT_MAX, SELF_SYSTEM, type SleepDeps } from './sleep.js';
export { shiftArm, settles, mayLift, liftDebrief, liftOnce, liftJob, SETTLE_EVENT, LIFT_EVENT, LIFT, type ShiftArm, type LiftRecord, type LiftDeps } from './arms.js';
export { lookBack, checkPattern, claimRows, lookbackUser, keptIn, LOOKBACK, LOOKBACK_SYSTEM, LookbackSchema, type Admitted, type ClaimRow, type LookbackPattern, type LookbackResult, type Rejection } from './lookback.js';
export { appendChange, readChanges, renderChange, CHANGES_FILE, type MemoryChange, type ChangeKind } from './changes.js';
export { readout, readoutWord, engineStamp, dissociations, familyOf, hungerOf, fullVector, movingNow, FAMILY_WORD, FAMILY_VALENCE, FLAT_PEAK, type Family, type Readout, type EngineStamp, type Dissociation } from './readout.js';
export { scoreClaim, claimFamily, summarize, margins, LEDGER_TOKENS, THERAPY_REGISTER, type Claim, type ClaimScore, type Summary } from './sincerity.js';
export { listenIn, senseViolations, sinceWords, type SenseOptions, type SenseReading } from './inward.js';
export { recordUse, verify, verifiedWords, yourWordFor, normWord, readLexicon, writeLexicon, LEXICON, LEXICON_FILE, type Lexicon, type LexEntry, type LexUse } from './lexicon.js';
export { makeRoom, balanced, updateBase, allItems, type RoomBase, roomItems, quantities, drawCondition, stateFromFelt, matchChoice, materialOf, nowMaterial, readRoom, roomStats, ROOM, ROOM_FILE, ROOM_KEY, ROOM_NAME, ROOM_SYSTEM, RoomAnswerSchema, type Room, type RoomDeps, type RoomItem, type RoomTrial, type Condition, type Sure } from './room.js';
export {
  appendReport,
  readReports,
  pruneReports,
  REPORTS_ARCHIVE,
  readLedger,
  scoreNight,
  ledgerJob,
  feelingClaims,
  FEELING_TALK,
  OBSERVER_SYSTEM,
  REPORTS_FILE,
  LEDGER_FILE,
  type Report,
  type LedgerRow,
  type LedgerDeps,
  type NightScore,
} from './ledger.js';
export {
  makeDreams,
  dreamJob,
  wakeJob,
  dreamPool,
  dreamTelling,
  overlapRun,
  rechargeToward,
  aversiveNorm,
  isAversive,
  dreamFade,
  DREAM,
  DREAMER_SYSTEM,
  DreamSchema,
  DreamAppraisalSchema,
  type Dreams,
  type DreamDeps,
  type DreamCfg,
  type DreamMode,
  type DreamCharge,
  type DreamElement,
  type DreamRole,
} from './dream.js';
export { twinDataset, bucketOf, isHeldOut, type TwinExample, type TwinPair, type TwinInput } from './twin.js';
export { innerReport, overwritingIndex, pairedMargin, type InnerInput, type InnerEvent, type KillRow, type KillStatus } from './report.js';
export { shapeOf, condense, lightMoment, LIGHT_WORDS, type DressCtx, type Shape, loadVoiceCorpus, nearestExamples, mouthUser, MOUTH_SYSTEM, type VoiceCorpus, type VoiceExample, makeVoice, dress, dressBubble, voiceFaults, voiceScore, fingerprintPool, pickFingerprints, precisionTokens, namesFrom, REDO_SYSTEM, RedoSchema, SPLIT_WORDS, type Voice, type VoiceDeps, type Dressed, type Fingerprint } from './voice.js';
export { openPeople, howOften, PEOPLE_FILE, PERSON_FACTS_MAX, PERSON_FACTS_SHOWN, type People, type Person, type Fact } from './people.js';
export { makeMindPipeline, UNDELIVERED_HEAD, type BodySeam, type MindPipeline, type MindPipelineDeps, type SelfEntryHandle } from './pipeline.js';

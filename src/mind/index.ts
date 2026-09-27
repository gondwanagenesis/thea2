// v8 mind — public surface ("Nothing Told", plan thea2-v8-nothing-told.md).

export * from './types.js';
export * from './vocab.js';
export { cosine, openVecFile, type VecFile } from './vectors.js';
export { openMindStore, emptyMindState, isPrecedent, MACHINERY_TALK, LOVE_DECLARATION, type MindStore, type Centroids } from './store.js';
export { sense, situationText, replyText, nearestLabel, type Sensed, type Label } from './sense.js';
export { evoke, scoreMoment, moodTerm, EVOKE_DEFAULTS, EVOKE_WEIGHTS, type EvokeConfig, type EvokeInput, type Evoked, type Scored } from './evoke.js';
export { feelFast, type FastEvent, type FeelFastInput } from './feel.js';
export { metabolism, energyOf, type Metabolism, type MetabolismCtx } from './modulate.js';
export {
  composePacket,
  composeSegments,
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
export { encodeLived, actsOf, inferFollowed, bestOption, applyOutcome, markShown, FOLLOW_THRESHOLD, RECONSOLIDATION_RHO, type EncodeInput } from './remember.js';
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
export { sleepOnce, sleepJob, SelfRewriteSchema, type SleepDeps } from './sleep.js';
export { makeMindPipeline, UNDELIVERED_HEAD, type BodySeam, type MindPipeline, type MindPipelineDeps, type SelfEntryHandle } from './pipeline.js';

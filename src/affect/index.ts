// M05 affect — barrel. The vocabulary and the state shape are what M06 (coupling)
// and the schemas consume; M09 (appraisal) needs the event schemas; M11 (realize)
// needs weatherLine; M20 wires the store. The mechanics files stay importable for
// tests, but downstream modules should take what they need from here.

// ---- vocabulary, baselines, the tag tables ----
export {
  AVERSIVE,
  BASELINE_DIMS,
  DIALS,
  DIAL_BASELINE,
  EMOTION_DELTAS,
  EMOTION_DRIVES,
  EMOTION_PRIMARIES,
  EMOTION_TAGS,
  NEGATIVE_DIALS,
  PAD,
  POSITIVE_PRIM,
  PRIMARY_BASELINE,
  TAG_DRIVE_DELTAS,
  TAG_FEEDS,
  TAG_PRIMARY_DELTAS,
  baselineOf,
  isEmotionTag,
  type AffectDim,
  type Dial,
  type Drive,
  type EmotionTag,
  type Primary,
  type TagFeedTag,
} from './vocab.js';

// ---- state ----
export {
  HOURS,
  NEVER_MS,
  clamp01,
  cloneState,
  initialAffectState,
  rehydrateState,
  round3,
  round4,
  type AffectState,
  type CauseRecord,
  type ExposureTrace,
  type OpponentTrace,
} from './state.js';

// ---- event schemas ----
export {
  AffectEventSchema,
  EmotionEvent,
  EmotionTagSchema,
  SilenceTickEvent,
  TagFeedEvent,
  type AffectEvent,
  type EmotionEventInput,
} from './events.js';

// ---- mechanics (one per file) ----
export {
  HALF_LIFE_DIAL,
  HALF_LIFE_MOOD,
  HALF_LIFE_MOOD_HOME,
  HALF_LIFE_AROUSAL,
  MOOD_INERTIA,
  NEGATIVITY_BIAS,
  PRIM_HALF_LIFE,
  PRIM_HALF_LIFE_SURPRISE,
  PRIM_NEG_BIAS,
  AROUSAL_FLOOR,
  LONGING_GAIN,
  LONGING_TAU_H,
  NOISE,
  decayToward,
  dialHalfLife,
  primaryHalfLife,
} from './decay.js';
export { INTENSITY_EXP, PRIMARY_GAIN, intensityScale } from './intensity.js';
export {
  EXPO_GAIN,
  HALF_LIFE_EXPO,
  HABIT_WINDOW_H,
  HABITUATION,
  decayExposure,
  growExposure,
  isHabituated,
  recordTag,
} from './habituation.js';
export {
  HALF_LIFE_OPP,
  OPP_GAIN,
  OPP_LAG_H,
  PRIM_OPP_GAIN,
  PRIM_OPP_LAG_H,
  decayOpponent,
  growOpponent,
  opponentPull,
} from './opponent.js';
export {
  PEAK_HI,
  PRIM_REFRACTORY_DAMP,
  REFRACTORY_DAMP,
  REFRACTORY_DECAY_MULT,
  REFRACTORY_H,
  isInRefractory,
  recordPeakIf,
} from './refractory.js';
export {
  CAP_DAMP,
  CAP_SOFT,
  PEAK_INTENSITY,
  PRIM_CAP_SOFT,
  SATURATE_EXP,
  ceilingDamp,
  saturate,
  toleranceDivisor,
} from './ceiling.js';
export { PRIM_INHIBIT, foesOf, inhibitFoe } from './inhibition.js';
export {
  ATTRIB_CLEAR,
  ATTRIB_MIN,
  ATTRIB_STALE_H,
  CAUSE_MIN_I,
  attributionWins,
  causeIsStale,
  makeCause,
} from './attribution.js';
export {
  DRIVE_FEED_SCALE,
  DRIVE_FLOOR,
  HALF_LIFE_DRIVE,
  SET_POINT,
  STARVE_PER_HOUR,
  driveTarget,
  wasFed,
} from './drives.js';
export {
  DN,
  HI,
  LANDMARKS,
  LANDMARK_SIGMA,
  LO,
  MD,
  OVERSHOOT_W,
  SPECIFICITY,
  landmarkBlend,
  norm,
  topCause,
  weatherLine,
  type BlendWord,
} from './landmarks.js';

// ---- engine ----
export { apply, applyInto, tick, type AppliedBatch, type Moved } from './engine.js';

// ---- store (the single writer) ----
export { openAffectStore, type AffectStore, type UnknownTagSource } from './store.js';

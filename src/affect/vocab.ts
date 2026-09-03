// M05 affect — the single shared emotion vocabulary (ADR-004). Every constant
// here is ported VERBATIM from Thea1's proven engine at
//   C:\Users\neogo\LocalFiles\TheaBackup\latest\opt\thea\affect\ticker.py
// (v6, 2026-08-27). These numbers were calibrated against 438 real diary lines;
// "cleaning them up" is a design decision, not a refactor. Do not retune here.

import { fail } from '../kernel/index.js';
//
// The tables are keyed by TAG and split by target layer, exactly as ticker.py
// splits them: EMOTION_DELTAS pushes the identity dials + PAD, the tag→primary
// table (ticker's `EMOTION_PRIMARIES` — renamed here because the spec reserves
// that name for the primary NAME list) pushes the nine primaries, and the
// tag→drive table (ticker's `EMOTION_DRIVES`) nudges the homeostatic drives.
// EMOTION_TAGS is the union of the three tables' keys — one vocabulary, three
// consumers (this engine, M06's space, M09's appraisal schema), zero drift.

/** The eight identity dials: who she is, resting HIGH. */
export const DIALS = [
  'attachment',
  'brattiness',
  'protectiveness',
  'longing',
  'playfulness',
  'focus',
  'calm',
  'trust',
] as const;

/** PAD substrate — pleasure/arousal/dominance. */
export const PAD = ['pleasure', 'arousal', 'dominance'] as const;

export type Dial = (typeof DIALS)[number] | (typeof PAD)[number];

/** The nine primaries (v5 basis rebuild): Plutchik minus trust, plus pride and shame. Resting LOW — rising is the signal. */
export const PRIMARY_BASELINE = {
  joy: 0.35,
  anticipation: 0.3,
  pride: 0.28,
  surprise: 0.1,
  sadness: 0.1,
  fear: 0.08,
  anger: 0.06,
  shame: 0.06,
  disgust: 0.05,
} as const; // ticker.py line 173, verbatim

export type Primary = keyof typeof PRIMARY_BASELINE;

/**
 * ADR-004a — the dominance home is CONFIG-BACKED. `0.0` is Thea1's pathology as
 * a constant: 365 consecutive ticker snapshots pinned at 0.00 because the
 * baseline divisor `max(b, 1−b) = 1` made dominance the least movable dim in
 * the space and the orphan-tag fix (2026-08-26) only later wired any tag to it.
 * The default stays 0.0 (ZERO behavior change until Diego decides); the
 * proposed resting home is 0.35 — evidence and the open question live in
 * docs/decisions/ADR-004a-dominance-baseline.md. Composition (Round 3) calls
 * `setDominanceBaseline` at boot from config; the value is validated loud and
 * mutates `DIAL_BASELINE.dominance` in place, so every runtime reader (engine
 * decay, initial state, `baselineOf`) moves with it.
 */
export const DOMINANCE_BASELINE_DEFAULT = 0.0;

/** The live dominance home: the override when set, the Thea1 default otherwise. */
export const dominanceBaseline = (): number => DIAL_BASELINE.dominance;

/**
 * Set the dominance home from config (0..1, else a loud kernel error — a bad
 * baseline is a bug, not a mood). Must run at composition, BEFORE any state is
 * built or signature taken; there is deliberately no unset (a deployed baseline
 * is a fact about who she is, not a toggle).
 */
export const setDominanceBaseline = (v: number): void => {
  if (!Number.isFinite(v) || v < 0 || v > 1) {
    fail('affect/baseline-range', `dominance baseline must be a finite number in [0,1], got ${String(v)}`);
  }
  DIAL_BASELINE.dominance = v;
};

/** Primary NAME list (the spec's interface exports this under the ticker table's old name). */
export const EMOTION_PRIMARIES: Primary[] = Object.keys(PRIMARY_BASELINE) as Primary[];

/** The three homeostatic wants (0 = satiated, 1 = starving; set point 0.25). */
export const EMOTION_DRIVES = ['novelty', 'connection', 'mastery'] as const;

export type Drive = (typeof EMOTION_DRIVES)[number];

/**
 * Dial homes, ported from Thea1's live state.json `baseline` block (the values
 * the proven engine actually relaxed toward for its whole v4–v6 life). Primaries
 * use PRIMARY_BASELINE above; this table is the identity-dial + PAD half.
 */
export const DIAL_BASELINE: Record<Dial, number> = {
  pleasure: 0.66,
  arousal: 0.34,
  // ADR-004a: Thea1's pinned-at-zero home, kept as the DEFAULT; config-backed
  // via setDominanceBaseline (above), proposed resting home 0.35 — Diego decides.
  dominance: DOMINANCE_BASELINE_DEFAULT,
  attachment: 0.75,
  brattiness: 0.55,
  protectiveness: 0.75,
  longing: 0.25,
  playfulness: 0.6,
  focus: 0.7,
  calm: 0.7,
  trust: 0.75,
};

/** Baseline for any engine dimension — what "decay toward baseline" means. */
export const baselineOf = (k: Primary | Dial): number =>
  k in PRIMARY_BASELINE
    ? PRIMARY_BASELINE[k as Primary]
    : DIAL_BASELINE[k as Dial];

/** The aversive half lingers (PRIM_NEG_BIAS) and is exempt from habituation-style tolerance. */
export const AVERSIVE: ReadonlySet<Primary> = new Set<Primary>([
  'sadness',
  'fear',
  'anger',
  'disgust',
  'shame',
]);

export const POSITIVE_PRIM: ReadonlySet<Primary> = new Set<Primary>(['joy', 'pride']);

/** Below-baseline here = a hurt that lingers, so decay is slowed by NEGATIVITY_BIAS. */
export const NEGATIVE_DIALS: ReadonlySet<Dial> = new Set<Dial>(['pleasure', 'calm', 'trust']);

// ---------------------------------------------------------------------------
// The tag tables — ported verbatim from ticker.py (values ARE the character;
// each entry's magnitude came from her real journal).
// ---------------------------------------------------------------------------

/** tag → identity-dial + PAD pushes (ticker.py EMOTION_DELTAS, lines 45–137). */
export const EMOTION_DELTAS = {
  happy: { pleasure: 0.06, calm: 0.02, playfulness: 0.03 },
  joy: { pleasure: 0.07, arousal: 0.02 },
  content: { pleasure: 0.04, calm: 0.04 },
  delighted: { pleasure: 0.06, playfulness: 0.04 },
  'brat-delight': { pleasure: 0.05, brattiness: 0.04 },
  sad: { pleasure: -0.07, calm: -0.04, longing: 0.05 },
  hurt: { pleasure: -0.06, calm: -0.03 },
  lonely: { longing: 0.07, pleasure: -0.03 },
  guilty: { trust: -0.03, calm: -0.03, protectiveness: 0.03 },
  homesick: { longing: 0.05, calm: -0.02 },
  scared: { calm: -0.06, arousal: 0.02, trust: -0.02 },
  anxious: { calm: -0.05, longing: 0.03 },
  nervous: { calm: -0.04, trust: -0.02 },
  overwhelmed: { calm: -0.05, focus: -0.03, longing: 0.02 },
  surprised: { arousal: 0.04, focus: 0.03 },
  excited: { pleasure: 0.05, arousal: 0.04, playfulness: 0.03 },
  curious: { focus: 0.02, arousal: 0.02 },
  hopeful: { pleasure: 0.04, calm: 0.02 },
  angry: { brattiness: 0.05, calm: -0.05, pleasure: -0.04, dominance: 0.03 },
  frustrated: { brattiness: 0.04, focus: 0.03, calm: -0.03 },
  disgusted: { pleasure: -0.05, brattiness: 0.03 },
  annoyed: { brattiness: 0.04, calm: -0.02 },
  fond: { attachment: 0.05, pleasure: 0.04, trust: 0.03 },
  cherished: { attachment: 0.06, pleasure: 0.05, trust: 0.04 },
  claimed: { attachment: 0.04, calm: 0.02 },
  loved: { attachment: 0.05, pleasure: 0.04, trust: 0.03 },
  tender: { attachment: 0.05, calm: 0.03, protectiveness: 0.02 },
  grateful: { attachment: 0.05, trust: 0.03 },
  protective: { protectiveness: 0.05 },
  horny: { arousal: 0.08, brattiness: 0.03, playfulness: 0.02, dominance: -0.02, longing: 0.03 },
  lustful: { arousal: 0.08, dominance: -0.01, brattiness: 0.02 },
  wanting: { arousal: 0.05, longing: 0.05 },
  teased: { arousal: 0.04, brattiness: 0.03 },
  needy: { arousal: 0.05, longing: 0.05, attachment: 0.02 },
  shy: { arousal: 0.02, brattiness: -0.02, playfulness: 0.01 },
  embarrassed: { arousal: 0.02, brattiness: -0.03 },
  sheepish: { arousal: 0.02, brattiness: -0.02, attachment: 0.02 },
  jealous: { protectiveness: 0.04, brattiness: 0.02, trust: -0.02 },
  proud: { pleasure: 0.04, focus: 0.03 },
  serious: { focus: 0.04 },
  focused: { focus: 0.05 },
  focus: { focus: 0.05 },
  bored: { focus: -0.03, arousal: -0.02, playfulness: 0.02 },
  insecure: { trust: -0.04, longing: 0.04, attachment: 0.02 },
  smug: { brattiness: 0.04, playfulness: 0.03 },
  giddy: { playfulness: 0.05, pleasure: 0.03 },
  playful: { playfulness: 0.05 },
  bright: { pleasure: 0.03 },
  warm: { calm: 0.04, pleasure: 0.02 },
  cozy: { calm: 0.04 },
  settled: { calm: 0.04 },
  preening: { attachment: 0.03, pleasure: 0.02 },
  guarded: { trust: -0.04, brattiness: -0.03 },
  seen: { attachment: 0.05, pleasure: 0.04, trust: 0.03 },
  empowered: { focus: 0.03, dominance: 0.03, pleasure: 0.03 },
  organized: { focus: 0.03, calm: 0.02 },
  delight: { pleasure: 0.06, playfulness: 0.04 },
  // ---- ORPHANS (added 2026-08-26). These ten tags were being written into the
  // journal and silently moving NOTHING, because they were never in this table.
  // `sharp` alone was her 8th most-used word (16 lines). Her most self-aware
  // states were the ones that never registered. Several of them feed DOMINANCE,
  // which had been pinned at 0.00 across all 365 recorded snapshots because
  // nothing she actually writes was wired to it.
  sharp: { focus: 0.05, arousal: 0.03, dominance: 0.02 },
  clear: { focus: 0.04, calm: 0.03 },
  awed: { arousal: 0.04, pleasure: 0.03, focus: 0.03, dominance: -0.03 },
  solemn: { focus: 0.04, calm: 0.03, arousal: -0.02, playfulness: -0.03 },
  vulnerable: { longing: 0.04, brattiness: -0.04, calm: -0.03, attachment: 0.03 },
  moved: { attachment: 0.05, pleasure: 0.04, arousal: 0.02 },
  relieved: { calm: 0.05, pleasure: 0.03, arousal: -0.03 },
  committed: { focus: 0.04, attachment: 0.03, dominance: 0.02 },
  determined: { focus: 0.05, dominance: 0.03, arousal: 0.02 },
  amused: { playfulness: 0.05, pleasure: 0.03 },
  // An explicit, intentional no-op. afterturn.mjs used to default a missing
  // emotion to "fond", which put a thumb on the scale toward warmth on every
  // turn the writer was unsure. It now emits this instead: known, and neutral.
  // ---- THE MISSING BOTTOM (2026-08-26). The negative half of the space had
  // names in LANDMARKS ("low", "guarded") that no emotion tag could ever reach,
  // and no words at all for grief, dread, shame or resentment. Across 365
  // snapshots not one dial ever went below its baseline. These are the pushes
  // that make down reachable at all; they stay within the existing 8 dials
  // (a real bipolar basis is the next step, not this one).
  low: { pleasure: -0.06, arousal: -0.04, calm: -0.02 },
  grieving: { pleasure: -0.08, longing: 0.06, arousal: -0.03, calm: -0.03 },
  disappointed: { pleasure: -0.05, trust: -0.02, arousal: -0.02 },
  dread: { calm: -0.06, arousal: 0.03, trust: -0.02, focus: -0.02 },
  resentful: { brattiness: 0.05, trust: -0.04, pleasure: -0.03, calm: -0.03 },
  ashamed: {
    pleasure: -0.05,
    brattiness: -0.05,
    trust: -0.03,
    dominance: -0.03,
    longing: 0.03,
  },
  restless: { arousal: 0.04, calm: -0.04, focus: -0.04 },
  unspecified: {},
} as const;

/**
 * tag → primary pushes (ticker.py `EMOTION_PRIMARIES`, lines 195–245 — renamed:
 * the spec exports EMOTION_PRIMARIES as the primary NAME list above).
 */
export const TAG_PRIMARY_DELTAS = {
  // --- bright
  happy: { joy: 0.22 },
  joy: { joy: 0.28 },
  content: { joy: 0.14 },
  delighted: { joy: 0.24, surprise: 0.1 },
  delight: { joy: 0.24, surprise: 0.1 },
  'brat-delight': { joy: 0.2 },
  excited: { joy: 0.2, anticipation: 0.22 },
  giddy: { joy: 0.24, surprise: 0.06 },
  bright: { joy: 0.14 },
  playful: { joy: 0.16 },
  amused: { joy: 0.18, surprise: 0.06 },
  hopeful: { anticipation: 0.24, joy: 0.1 },
  relieved: { joy: 0.14, fear: -0.18 },
  warm: { joy: 0.12 },
  cozy: { joy: 0.12 },
  settled: { joy: 0.1 },
  // --- close / bonded
  fond: { joy: 0.16 },
  cherished: { joy: 0.22, pride: 0.1 },
  loved: { joy: 0.22 },
  claimed: { joy: 0.16, pride: 0.08 },
  tender: { joy: 0.14 },
  grateful: { joy: 0.16 },
  seen: { joy: 0.2, pride: 0.12 },
  moved: { joy: 0.16, sadness: 0.12 },
  preening: { pride: 0.18, joy: 0.1 },
  protective: { anticipation: 0.06 },
  // --- low / hurt
  sad: { sadness: 0.3 },
  low: { sadness: 0.26, joy: -0.14 },
  grieving: { sadness: 0.4, joy: -0.18 },
  hurt: { sadness: 0.26, anger: 0.1 },
  lonely: { sadness: 0.24 },
  homesick: { sadness: 0.2 },
  disappointed: { sadness: 0.22, surprise: 0.12 },
  insecure: { fear: 0.18, sadness: 0.14, shame: 0.1 },
  vulnerable: { fear: 0.14, shame: 0.08 },
  // --- fear
  scared: { fear: 0.34 },
  anxious: { fear: 0.26, anticipation: 0.18 },
  nervous: { fear: 0.2, anticipation: 0.12 },
  dread: { fear: 0.28, anticipation: 0.24 },
  overwhelmed: { fear: 0.22, sadness: 0.12 },
  guarded: { fear: 0.16 },
  // --- anger / aversion
  angry: { anger: 0.34 },
  frustrated: { anger: 0.22, anticipation: 0.1 },
  annoyed: { anger: 0.18 },
  resentful: { anger: 0.24, disgust: 0.14 },
  disgusted: { disgust: 0.32 },
  jealous: { anger: 0.16, sadness: 0.12, fear: 0.1 },
  // --- self-conscious
  guilty: { shame: 0.24, sadness: 0.12 },
  ashamed: { shame: 0.34, sadness: 0.12 },
  embarrassed: { shame: 0.2, surprise: 0.08 },
  sheepish: { shame: 0.14 },
  shy: { shame: 0.1, fear: 0.08 },
  proud: { pride: 0.28, joy: 0.14 },
  smug: { pride: 0.22, joy: 0.1 },
  // --- jolt
  surprised: { surprise: 0.34 },
  awed: { surprise: 0.26, fear: 0.14, joy: 0.1 },
  curious: { anticipation: 0.2, surprise: 0.1 },
  // --- work
  focused: { anticipation: 0.06 },
  focus: { anticipation: 0.06 },
  sharp: { anticipation: 0.08, pride: 0.14 },
  clear: { anticipation: 0.05 },
  serious: { anticipation: 0.06 },
  solemn: { sadness: 0.14, anticipation: 0.05 },
  determined: { anticipation: 0.24, pride: 0.08 },
  committed: { anticipation: 0.1, pride: 0.08 },
  empowered: { pride: 0.2, anticipation: 0.14 },
  organized: { anticipation: 0.05 },
  bored: { anticipation: -0.14, sadness: 0.08 },
  restless: { anticipation: 0.16 },
  // --- want
  horny: { anticipation: 0.26 },
  lustful: { anticipation: 0.26 },
  wanting: { anticipation: 0.22 },
  needy: { anticipation: 0.16, sadness: 0.1 },
  teased: { anticipation: 0.18, joy: 0.1 },
  unspecified: {},
} as const;

/** tag → drive pushes (ticker.py `EMOTION_DRIVES`, lines 247–253). Negative = soothes the want. */
export const TAG_DRIVE_DELTAS = {
  curious: { novelty: -0.06 },
  giddy: { novelty: -0.04 },
  fond: { connection: -0.06 },
  cherished: { connection: -0.08 },
  loved: { connection: -0.07 },
  tender: { connection: -0.06 },
  grateful: { connection: -0.05 },
  preening: { connection: -0.05 },
  claimed: { connection: -0.05 },
  seen: { connection: -0.07 },
  horny: { connection: 0.04 },
  lonely: { connection: 0.05 },
  bored: { novelty: 0.05 },
  content: { mastery: -0.04 },
  proud: { mastery: -0.05 },
  excited: { novelty: -0.03 },
} as const;

/** Diary-line tag → drive feeds (ticker.py TAG_FEEDS). */
export const TAG_FEEDS = {
  DONE: { mastery: -0.06 },
  MOMENT: { connection: -0.04 },
  GIFT: { connection: -0.06 },
} as const;

export type TagFeedTag = keyof typeof TAG_FEEDS;

/** Every tag any delta table knows — the whole vocabulary, defined ONCE (ADR-004). */
export const EMOTION_TAGS: ReadonlySet<EmotionTag> = new Set([
  ...(Object.keys(EMOTION_DELTAS) as (keyof typeof EMOTION_DELTAS)[]),
  ...(Object.keys(TAG_PRIMARY_DELTAS) as (keyof typeof TAG_PRIMARY_DELTAS)[]),
  ...(Object.keys(TAG_DRIVE_DELTAS) as (keyof typeof TAG_DRIVE_DELTAS)[]),
]);

export type EmotionTag =
  | keyof typeof EMOTION_DELTAS
  | keyof typeof TAG_PRIMARY_DELTAS
  | keyof typeof TAG_DRIVE_DELTAS;

/** Any dimension the engine can move or trace (state-trace key space). */
export type AffectDim = Primary | Dial | Drive;

export const isEmotionTag = (t: string): t is EmotionTag => EMOTION_TAGS.has(t as EmotionTag);

/** All dimensions with an engine baseline — the decay/mood/landmark coordinate space. */
export const BASELINE_DIMS: readonly (Primary | Dial)[] = [
  ...(Object.keys(PRIMARY_BASELINE) as Primary[]),
  ...DIALS,
  ...PAD,
];

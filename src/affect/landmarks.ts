// M05 affect — fuzzy landmarks: named regions of the continuous space, the words
// for the [AFFECT] line. Centres are written in NORMALISED DEVIATION units
// (+1.0 = pinned at the top of its range; 0 = exactly at her baseline; −1 =
// pinned at the bottom), because raw levels failed twice: her identity dials
// rest high and barely travel, so any region centred near attachment 0.90 won
// everything and "protective" ended up in 100% of blends.
//
// Threshold semantics, not point distance (2026-08-26): a region is a condition
// on how she is. Being angrier than the threshold for anger cannot make her less
// angry — so positive centres only punish undershoot, negative centres only
// punish overshoot. Pure one-sided threshold semantics was tried and ALSO
// failed (every low-bar multi-key region hit a perfect zero), so overshoot must
// hurt a little: OVERSHOOT_W. Recorded honestly so nobody re-derives it.

import { CAUSE_MIN_I } from './attribution.js';
import { clamp01, HOURS, round3, type AffectState } from './state.js';
import { baselineOf, type Dial, type Primary } from './vocab.js';

export const OVERSHOOT_W = 0.8; // how much being MORE than a region asks for counts against it
export const SPECIFICITY = 0.0; // swept 0.0 vs 0.12 and it HURT at every other setting — kept at zero, kept visible

export const HI = 0.52; // this feeling is the dominant one
export const MD = 0.3; // clearly present
export const LO = 0.14; // a trace of it
export const DN = -0.28; // conspicuously absent

export const LANDMARK_SIGMA = 0.3;

/** Region centres on the primaries (Plutchik's dyads) plus her own named states. */
export const LANDMARKS: Record<string, Partial<Record<Dial | Primary, number>>> = {
  // --- single primaries
  happy: { joy: HI, sadness: DN },
  sad: { sadness: HI, joy: DN },
  grieving: { sadness: 0.8, joy: -0.45 },
  afraid: { fear: HI },
  angry: { anger: HI },
  disgusted: { disgust: HI },
  startled: { surprise: HI },
  eager: { anticipation: HI, joy: MD },
  ashamed: { shame: HI },
  proud: { pride: HI, joy: MD },
  // --- Plutchik dyads: two primaries co-active
  love: { joy: HI, trust: MD },
  submissive: { trust: MD, fear: MD },
  awed: { surprise: HI, fear: MD },
  disappointed: { surprise: MD, sadness: MD },
  remorseful: { sadness: MD, disgust: MD },
  contemptuous: { disgust: MD, anger: MD },
  aggressive: { anger: MD, anticipation: MD },
  optimistic: { anticipation: MD, joy: MD },
  // guilty asks for HI, not MD. At MD it won 102 of 438 real lines — 23% of her
  // life — off the back of NINE guilty diary entries, because shame is slow to
  // decay and the bar was low enough to keep clearing for two days afterwards.
  // A word that fires ten times more often than the feeling does is not a reading.
  guilty: { shame: HI, sadness: LO },
  curious: { anticipation: MD, surprise: MD },
  despairing: { fear: MD, sadness: HI },
  envious: { sadness: MD, anger: MD },
  cynical: { disgust: MD, anticipation: MD },
  hopeful: { anticipation: HI, trust: MD },
  anxious: { anticipation: MD, fear: HI },
  outraged: { surprise: MD, anger: HI },
  sentimental: { trust: MD, sadness: MD },
  delighted: { joy: HI, surprise: MD },
  pessimistic: { sadness: MD, anticipation: DN },
  // --- her own regions. Kept, because these are HER and no generic chart has them.
  warm: { joy: MD, attachment: MD, calm: LO },
  tender: { joy: LO, attachment: HI, protectiveness: MD },
  giddy: { joy: HI, playfulness: HI, arousal: MD },
  bratty: { brattiness: HI, playfulness: MD, joy: LO },
  longing: { longing: MD, sadness: MD, anticipation: LO },
  needy: { longing: HI, attachment: HI, sadness: MD },
  protective: { protectiveness: HI, anticipation: LO, focus: MD },
  settled: { calm: HI, joy: LO, arousal: DN },
  restless: { arousal: MD, calm: DN, anticipation: MD },
  focused: { focus: MD, anticipation: MD },
  guarded: { trust: DN, fear: MD },
  smug: { pride: HI, brattiness: MD },
  low: { joy: DN, sadness: MD, arousal: DN },
  'keyed up': { arousal: HI, anticipation: MD },
};

/** Map a raw level onto headroom-normalised deviation from her own baseline. */
export const norm = (v: number, base: number): number =>
  v >= base ? (v - base) / Math.max(1e-6, 1.0 - base) : (v - base) / Math.max(1e-6, base);

const blendFeature = (s: AffectState, k: Dial | Primary): number => {
  const now = k in s.dials ? s.dials[k as Dial] : s.primaries[k as Primary];
  return clamp01(0.7 * now + 0.3 * s.mood[k]);
};

export interface BlendWord {
  word: string;
  weight: number;
}

/** Soft membership of the current state in each named region (fuzzy, not bins). Sorted by weight desc. */
export const landmarkBlend = (s: AffectState): BlendWord[] => {
  const scores: Array<BlendWord & { raw: number }> = [];
  for (const [name, center] of Object.entries(LANDMARKS)) {
    const keys = Object.keys(center) as (Dial | Primary)[];
    let d2 = 0;
    for (const k of keys) {
      const c = center[k]!;
      const nv = norm(blendFeature(s, k), baselineOf(k));
      // positive centre = "at least this present" -> only undershoot counts;
      // negative centre = "at least this absent" -> only overshoot counts.
      const diff = c >= 0 ? c - nv : nv - c;
      const d = diff > 0 ? diff : OVERSHOOT_W * -diff;
      d2 += d * d;
    }
    d2 /= keys.length;
    const raw = Math.exp(-d2 / LANDMARK_SIGMA ** 2) * (1.0 + SPECIFICITY * (keys.length - 1));
    scores.push({ word: name, weight: 0, raw });
  }
  const total = scores.reduce((acc, x) => acc + x.raw, 0) || 1.0;
  for (const x of scores) x.weight = x.raw / total;
  scores.sort((a, b) => b.weight - a.weight);
  // Always keep the nearest regions even if the field is flat: "no word for it"
  // is never the right answer. Ticker keeps top-4 above 4% else top-2.
  const strong = scores.slice(0, 4).filter((x) => x.weight > 0.04);
  const picked = strong.length >= 2 ? strong : scores.slice(0, 2);
  return picked.map(({ word, weight }) => ({ word, weight: round3(weight) }));
};

const phrase = (weight: number, regions: number, word: string): string => {
  const confident = weight * regions; // 1.0 = no opinion at all vs a flat field
  if (confident >= 1.8) return `mostly ${word}`;
  if (confident >= 1.1) return `some ${word}`;
  return `a hint of ${word}`;
};

/**
 * The largest headroom-normalised deviation anywhere in the field (blend units
 * — the same norm() the landmark centres live on). Every dim the landmarks read
 * is a dial or primary, so walking dials + primaries covers the space.
 */
const peakDeviation = (s: AffectState): number => {
  const keys = [...(Object.keys(s.dials) as Dial[]), ...(Object.keys(s.primaries) as Primary[])];
  return keys.reduce((max, k) => Math.max(max, Math.abs(norm(blendFeature(s, k), baselineOf(k)))), 0);
};

/**
 * Deviation below which the field IS her baseline — a place she rests in, not
 * weather. Snapshot rounding keeps stored states well clear of float dust, but
 * the comparison is inclusive-with-tolerance so an exact baseline never
 * flickers a line in.
 */
export const RESTING_EPSILON = 1e-9;

/**
 * The [AFFECT] line: blend words + top cause clause, one line, ≤ ~30 tokens.
 * A PROJECTION — coupling (M06) always reads the numeric state, never this
 * string. AT REST IT IS '': a baseline field has nothing to report, and the
 * assembler's render-if-nonempty logic keeps the [AFFECT] block out of the
 * packet (description of the ordinary is noise; only unusual weather renders).
 * A cause clause still renders on its own when the field is flat — a named
 * reason (applied emotion, long silence) is unusual even when she is resting.
 */
export const weatherLine = (s: AffectState): string => {
  const regions = Object.keys(LANDMARKS).length;
  const resting = peakDeviation(s) <= RESTING_EPSILON;
  const words = resting
    ? []
    : landmarkBlend(s)
      .slice(0, 3)
      .map((b) => phrase(b.weight, regions, b.word));
  const head = words.join(', '); // '' at rest — the old 'steady' fallback kept the block in 100% of packets
  const cause = topCause(s);
  if (head === '' && cause === null) return '';
  if (head === '') return cause ?? '';
  return cause === null ? head : `${head} — ${cause}`;
};

/** The reason she is still carrying: the biggest attributed rise, quotable only if it was about something. */
export const topCause = (s: AffectState): string | null => {
  let best: { text: string; moved: number; i: number } | undefined;
  for (const rec of Object.values(s.causes)) {
    if (rec === undefined) continue;
    if (best === undefined || rec.moved > best.moved) best = rec;
  }
  if (best !== undefined && best.i >= CAUSE_MIN_I) return best.text;
  const silenceH = (s.t - s.lastContactAt) / HOURS;
  if (silenceH > 6) return `he's been gone ${Math.floor(silenceH)} hours`;
  return null;
};

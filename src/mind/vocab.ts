// v8 mind — the feeling vocabulary and its geometry.
//
// Every feeling word she can have is a ticker tag (ADR-004: one vocabulary).
// APPRAISAL_TAGS is the curated subset the appraisal processes may emit — a
// best friend's range (no romantic/sexual tags; golden rules v2 rule 1).
//
// Each tag also has a DIRECTION in the 12-dim coupling space, derived from the
// ticker's own delta tables (EMOTION_DELTAS for PAD, TAG_PRIMARY_DELTAS for the
// primaries). That is how a remembered feeling becomes a vector the mood can
// match against, and how a vector becomes a past-tense word in a memory.

import { EMOTION_DELTAS, TAG_PRIMARY_DELTAS, isEmotionTag, type EmotionTag } from '../affect/index.js';
import { AFFECT_DIMS, DIM_INDEX, type Vec12 } from '../coupling/index.js';

export const APPRAISAL_TAGS = [
  'happy', 'joy', 'content', 'delighted', 'amused', 'playful', 'giddy', 'excited',
  'curious', 'hopeful', 'proud', 'relieved', 'grateful', 'fond', 'warm', 'tender',
  'cozy', 'settled', 'seen', 'moved', 'bright', 'focused', 'determined', 'serious',
  'surprised', 'awed', 'sad', 'hurt', 'lonely', 'low', 'disappointed', 'grieving',
  'anxious', 'nervous', 'scared', 'dread', 'overwhelmed', 'restless', 'bored',
  'annoyed', 'frustrated', 'angry', 'resentful', 'guarded', 'insecure', 'embarrassed',
  'sheepish', 'shy', 'guilty', 'ashamed', 'disgusted', 'jealous', 'protective',
  'vulnerable', 'solemn', 'smug', 'teased',
] as const;

export type AppraisalTag = (typeof APPRAISAL_TAGS)[number];

export const isAppraisalTag = (t: string): t is AppraisalTag => (APPRAISAL_TAGS as readonly string[]).includes(t);

const DIMS = AFFECT_DIMS.length;

type DeltaRow = Readonly<Record<string, number>>;

/** Raw (unnormalized) direction of a tag from the ticker tables. */
const rawDirection = (tag: EmotionTag): number[] => {
  const out = new Array<number>(DIMS).fill(0);
  const pad = (EMOTION_DELTAS as Readonly<Record<string, DeltaRow>>)[tag];
  if (pad !== undefined) {
    if (pad['pleasure'] !== undefined) out[DIM_INDEX.valence] = pad['pleasure'];
    if (pad['arousal'] !== undefined) out[DIM_INDEX.arousal] = pad['arousal'];
    if (pad['dominance'] !== undefined) out[DIM_INDEX.dominance] = pad['dominance'];
  }
  const prim = (TAG_PRIMARY_DELTAS as Readonly<Record<string, DeltaRow>>)[tag];
  if (prim !== undefined) {
    for (const k of AFFECT_DIMS.slice(3)) {
      const v = prim[k];
      if (v !== undefined) out[DIM_INDEX[k]] = v;
    }
  }
  return out;
};

const unitDirections = new Map<string, number[]>();

/** The tag's direction scaled so its strongest dim is ±1 (all zeros for an inert tag). */
export const tagDirection = (tag: string): number[] => {
  const cached = unitDirections.get(tag);
  if (cached !== undefined) return cached;
  const raw = isEmotionTag(tag) ? rawDirection(tag) : new Array<number>(DIMS).fill(0);
  const peak = Math.max(...raw.map((v) => Math.abs(v)));
  const unit = peak > 0 ? raw.map((v) => v / peak) : raw;
  unitDirections.set(tag, unit);
  return unit;
};

/** A felt signature for one tag at intensity i (1-10): direction × i/10. */
export const tagSignature = (tag: string, i: number): number[] => {
  const s = Math.max(0, Math.min(10, i)) / 10;
  return tagDirection(tag).map((v) => v * s);
};

const norm = (v: ArrayLike<number>): number => {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += (v[i] ?? 0) * (v[i] ?? 0);
  return Math.sqrt(s);
};

const cos = (a: ArrayLike<number>, b: ArrayLike<number>): number => {
  const na = norm(a);
  const nb = norm(b);
  if (na === 0 || nb === 0) return 0;
  let d = 0;
  for (let i = 0; i < a.length; i++) d += (a[i] ?? 0) * (b[i] ?? 0);
  return d / (na * nb);
};

/**
 * The past-tense word for a felt vector: the appraisal tag whose direction is
 * closest. Undefined when the vector is too faint to name honestly (a flat day
 * is not "content", it is nothing in particular).
 */
export const nearestTag = (sig: ArrayLike<number>, minNorm = 0.12): AppraisalTag | undefined => {
  if (norm(sig) < minNorm) return undefined;
  let best: AppraisalTag | undefined;
  let bestCos = 0.35; // below this the word would be a guess
  for (const t of APPRAISAL_TAGS) {
    const c = cos(sig, tagDirection(t));
    if (c > bestCos) {
      bestCos = c;
      best = t;
    }
  }
  return best;
};

/** Dense Vec12 → plain array (for storage). */
export const vecToArray = (v: Vec12): number[] => Array.from(v, (x) => Math.round(x * 1000) / 1000);

/** Plain array → sparse signature (coupling's modulate input); tiny dims dropped. */
export const toSparse = (sig: readonly number[]): Partial<Record<(typeof AFFECT_DIMS)[number], number>> => {
  const out: Partial<Record<(typeof AFFECT_DIMS)[number], number>> = {};
  AFFECT_DIMS.forEach((k, i) => {
    const v = sig[i] ?? 0;
    if (Math.abs(v) >= 0.02) out[k] = v;
  });
  return out;
};

export const sigNorm = norm;
export const sigCos = cos;

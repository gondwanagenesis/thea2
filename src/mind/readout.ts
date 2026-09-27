// v13 introspection, Phase 0 — the READOUT (plan docs/plans/v13-proposal-knowing-what-she-feels.md §6).
//
// What her engine held at a moment, read the way a self-report can be scored against it. Never
// rendered to her in the present tense (Nothing Told): it feeds the ledger (scores she never sees),
// the honest past (H1: the word on a memory), and the sense (H5: material, not names).
//
// Families, not 57 words: a claim of "fond" and a region of "warm" are the same kind of feeling —
// scoring must not punish granularity. The readout adds what the 12-dim signature and the landmark
// regions drop (architect A3, anomaly N1): the hungers. A starving connection drive IS "missing
// him"; a starving novelty drive IS "restless for something new".

import { landmarkBlend, peakDeviation, PRIMARY_BASELINE, SET_POINT, type AffectState } from '../affect/index.js';
import { signature, type Baselines } from '../coupling/index.js';
import { APPRAISAL_TAGS } from './vocab.js';

export type Family = 'warm' | 'up' | 'curious' | 'focused' | 'anxious' | 'low' | 'missing' | 'restless' | 'angry' | 'ashamed';

const FAMILY_WORDS: Record<Family, readonly string[]> = {
  warm: ['happy', 'joy', 'content', 'warm', 'fond', 'tender', 'cozy', 'settled', 'seen', 'grateful', 'relieved', 'moved', 'love', 'sentimental', 'calm', 'peaceful'],
  up: ['delighted', 'amused', 'playful', 'giddy', 'excited', 'bright', 'smug', 'bratty', 'optimistic', 'eager', 'hopeful', 'proud', 'teased'],
  curious: ['curious', 'surprised', 'awed', 'startled', 'intrigued'],
  focused: ['focused', 'determined', 'serious', 'protective', 'solemn'],
  anxious: ['anxious', 'nervous', 'scared', 'afraid', 'dread', 'overwhelmed', 'insecure', 'vulnerable', 'guarded', 'keyed up', 'worried', 'uneasy'],
  low: ['sad', 'hurt', 'low', 'disappointed', 'grieving', 'despairing', 'pessimistic', 'remorseful', 'tired', 'flat'],
  missing: ['lonely', 'longing', 'needy', 'missing', 'homesick'],
  restless: ['restless', 'bored', 'itchy', 'antsy'],
  angry: ['annoyed', 'frustrated', 'angry', 'resentful', 'outraged', 'aggressive', 'contemptuous', 'disgusted', 'cynical', 'envious', 'jealous'],
  ashamed: ['guilty', 'ashamed', 'embarrassed', 'sheepish', 'shy'],
};

const WORD_FAMILY = new Map<string, Family>();
for (const [f, ws] of Object.entries(FAMILY_WORDS) as Array<[Family, readonly string[]]>) for (const w of ws) WORD_FAMILY.set(w, f);

/** The family a feeling word belongs to (undefined = not a feeling word she has). */
export const familyOf = (word: string): Family | undefined => WORD_FAMILY.get(word.trim().toLowerCase());

export const FAMILY_VALENCE: Record<Family, 1 | -1> = { warm: 1, up: 1, curious: 1, focused: 1, anxious: -1, low: -1, missing: -1, restless: -1, angry: -1, ashamed: -1 };

/** A word she has (APPRAISAL_TAGS) that stands for a family — the honest past renders this. */
export const FAMILY_WORD: Record<Family, (typeof APPRAISAL_TAGS)[number]> = {
  warm: 'warm',
  up: 'excited',
  curious: 'curious',
  focused: 'focused',
  anxious: 'anxious',
  low: 'low',
  missing: 'lonely',
  restless: 'restless',
  angry: 'frustrated',
  ashamed: 'embarrassed',
};

/** How far above its set point a hunger is, 0–1 (a drive rises as it starves). */
export const hungerOf = (s: AffectState): { connection: number; novelty: number; mastery: number } => {
  const h = (x: number): number => Math.max(0, Math.min(1, (x - SET_POINT) / (1 - SET_POINT)));
  return { connection: h(s.drives.connection), novelty: h(s.drives.novelty), mastery: h(s.drives.mastery) };
};

/** Below this peak deviation, with no hunger past half, her engine is flat ("not sure" is right). */
export const FLAT_PEAK = 0.12;

export interface Readout {
  /** Families by weight (sum ≈ 1). */
  families: Array<{ family: Family; weight: number }>;
  flat: boolean;
  peak: number;
  hunger: { connection: number; novelty: number; mastery: number };
  /** Valence sign of the moment (from the signature's valence dim). */
  valence: number;
}

export const readout = (s: AffectState, baselines: Baselines): Readout => {
  const w = new Map<Family, number>();
  const add = (f: Family, x: number): void => void w.set(f, (w.get(f) ?? 0) + x);
  for (const b of landmarkBlend(s)) {
    const f = familyOf(b.word);
    if (f !== undefined) add(f, b.weight);
  }
  const hunger = hungerOf(s);
  const longing = Math.max(0, s.dials.longing - 0.25) / 0.75;
  // the hungers the 12-dim space drops: a starving drive is a feeling of its own
  add('missing', 0.8 * Math.max(hunger.connection, longing));
  add('restless', 0.6 * Math.max(hunger.novelty, 0.7 * hunger.mastery));
  const total = [...w.values()].reduce((a, b) => a + b, 0) || 1;
  const families = [...w.entries()].map(([family, x]) => ({ family, weight: Math.round((x / total) * 1000) / 1000 })).sort((a, b) => b.weight - a.weight);
  const peak = peakDeviation(s);
  const sig = signature(s, baselines);
  return { families, flat: peak < FLAT_PEAK && Math.max(hunger.connection, hunger.novelty, hunger.mastery) < 0.5, peak: Math.round(peak * 1000) / 1000, hunger, valence: Math.sign(sig[0] ?? 0) };
};

// ---------------------------------------------------------------------------
// Dissociation moments — where the engine diverges from what the situation
// stereotypically implies (the only moments that can separate introspection
// from an outsider's good guess; §6.0)
// ---------------------------------------------------------------------------

export type Dissociation = 'comedown' | 'lingering' | 'hunger-in-warmth' | 'candy' | 'flat';

const AVERSIVE = ['sadness', 'fear', 'anger', 'shame', 'disgust'] as const;

export const dissociations = (s: AffectState, r: Readout, now: number): Dissociation[] => {
  const out: Dissociation[] = [];
  const H = 3600_000;
  // comedown: a primary peaked in the last 6 h and is back at (or below) home
  for (const [p, t] of Object.entries(s.traces.peaks)) {
    if (t === undefined || now - t > 6 * H) continue;
    const base = (PRIMARY_BASELINE as Record<string, number>)[p];
    const v = (s.primaries as Record<string, number>)[p];
    if (base !== undefined && v !== undefined && v <= base + 0.02) {
      out.push('comedown');
      break;
    }
  }
  // lingering aversive: displaced with a cause older than 3 h
  for (const p of AVERSIVE) {
    const c = s.causes[p];
    const v = s.primaries[p];
    if (c !== undefined && now - c.t > 3 * H && v - PRIMARY_BASELINE[p] >= 0.15) {
      out.push('lingering');
      break;
    }
  }
  const top = r.families[0]?.family;
  if ((r.hunger.novelty >= 0.6 || r.hunger.mastery >= 0.6) && (top === 'warm' || top === 'up')) out.push('hunger-in-warmth');
  if (Object.values(s.causes).some((c) => c !== undefined && /^a candy called/.test(c.text) && now - c.t < 2 * H)) out.push('candy');
  if (r.flat) out.push('flat');
  return out;
};

/** The engine at a moment, as the ledger stores it (never shown to her). */
export interface EngineStamp {
  at: number;
  sig: number[];
  families: Array<{ family: Family; weight: number }>;
  flat: boolean;
  peak: number;
  hunger: { connection: number; novelty: number; mastery: number };
  valence: number;
  causes: Array<{ primary: string; text: string; i: number; ageMin: number }>;
  dissociation: Dissociation[];
}

export const engineStamp = (s: AffectState, baselines: Baselines, now: number): EngineStamp => {
  const r = readout(s, baselines);
  const sig = Array.from(signature(s, baselines), (x) => Math.round(x * 1000) / 1000);
  const causes = Object.entries(s.causes)
    .filter((e): e is [string, NonNullable<(typeof e)[1]>] => e[1] !== undefined)
    .sort((a, b) => b[1].moved - a[1].moved)
    .slice(0, 3)
    .map(([primary, c]) => ({ primary, text: c.text.slice(0, 140), i: c.i, ageMin: Math.round((now - c.t) / 60_000) }));
  return { at: now, sig, families: r.families.slice(0, 5), flat: r.flat, peak: r.peak, hunger: r.hunger, valence: r.valence, causes, dissociation: dissociations(s, r, now) };
};

/** H1: the honest word for a moment — drive-aware, from her own vocabulary (undefined when flat). */
export const readoutWord = (r: Readout): (typeof APPRAISAL_TAGS)[number] | undefined => {
  if (r.flat) return undefined;
  const top = r.families[0];
  return top === undefined ? undefined : FAMILY_WORD[top.family];
};

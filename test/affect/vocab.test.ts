// The vocabulary is law (ADR-004, M05's reason to exist). The golden list below
// is transcribed from Thea1's ticker.py exports — the tables in src/affect/vocab.ts
// must match it exactly. Any table edit has to land here too, loudly, because a
// tag that silently misses the vocabulary is the pathology this module exists to
// kill (Thea1 orphaned ten tags this way, `sharp` among them).

import { describe, expect, it } from 'vitest';
import {
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
  isEmotionTag,
  type AffectDim,
  type Dial,
  type Drive,
  type EmotionTag,
  type Primary,
} from '../../src/affect/index.js';

/** ticker.py's vocabulary, verbatim — the union of its three delta tables. */
const TICKER_TAGS: readonly string[] = [
  // ticker.py EMOTION_DELTAS
  'happy', 'joy', 'content', 'delighted', 'brat-delight', 'sad', 'hurt', 'lonely',
  'guilty', 'homesick', 'scared', 'anxious', 'nervous', 'overwhelmed', 'surprised',
  'excited', 'curious', 'hopeful', 'angry', 'frustrated', 'disgusted', 'annoyed',
  'fond', 'cherished', 'claimed', 'loved', 'tender', 'grateful', 'protective',
  'horny', 'lustful', 'wanting', 'teased', 'needy', 'shy', 'embarrassed',
  'sheepish', 'jealous', 'proud', 'serious', 'focused', 'focus', 'bored',
  'insecure', 'smug', 'giddy', 'playful', 'bright', 'warm', 'cozy', 'settled',
  'preening', 'guarded', 'seen', 'empowered', 'organized', 'delight',
  // the ten orphans (2026-08-26) — `sharp` was her 8th most-used word
  'sharp', 'clear', 'awed', 'solemn', 'vulnerable', 'moved', 'relieved',
  'committed', 'determined', 'amused',
  // the missing bottom (2026-08-26) — the negative half of the space
  'low', 'grieving', 'disappointed', 'dread', 'resentful', 'ashamed', 'restless',
  // the documented intentional no-op
  'unspecified',
];

const asRecord = (t: unknown): Record<string, Record<string, number>> =>
  t as Record<string, Record<string, number>>;

describe('EMOTION_TAGS — the one vocabulary (ADR-004)', () => {
  it('matches the ticker.py exports exactly, no more and no fewer', () => {
    expect([...EMOTION_TAGS].sort()).toEqual([...TICKER_TAGS].sort());
  });

  it('is the union of the three delta tables — and nothing else', () => {
    const keys = new Set<string>([
      ...Object.keys(EMOTION_DELTAS),
      ...Object.keys(TAG_PRIMARY_DELTAS),
      ...Object.keys(TAG_DRIVE_DELTAS),
    ]);
    expect([...EMOTION_TAGS].sort()).toEqual([...keys].sort());
  });

  it('membership predicate agrees with the set', () => {
    for (const tag of TICKER_TAGS) expect(isEmotionTag(tag)).toBe(true);
    for (const alien of ['flurbo', '', 'HAPPY', 'cherished ', 'orphan-tag-x']) {
      expect(isEmotionTag(alien)).toBe(false);
    }
  });

  it('the orphans and the missing bottom are all present — pathology 2 can never regrow', () => {
    for (const tag of ['sharp', 'clear', 'awed', 'solemn', 'vulnerable', 'moved', 'relieved', 'committed', 'determined', 'amused', 'low', 'grieving', 'disappointed', 'dread', 'resentful', 'ashamed', 'restless']) {
      expect(EMOTION_TAGS.has(tag as EmotionTag), tag).toBe(true);
    }
  });
});

describe('delta tables are well-formed against the dimension space', () => {
  it('every EMOTION_DELTAS key is a dial or PAD dimension', () => {
    const dials = new Set<string>([...DIALS, ...PAD]);
    for (const deltas of Object.values(asRecord(EMOTION_DELTAS))) {
      for (const k of Object.keys(deltas)) expect(dials.has(k), k).toBe(true);
    }
  });

  it('every TAG_PRIMARY_DELTAS key is a primary', () => {
    const prims = new Set<string>(EMOTION_PRIMARIES);
    for (const deltas of Object.values(asRecord(TAG_PRIMARY_DELTAS))) {
      for (const k of Object.keys(deltas)) expect(prims.has(k), k).toBe(true);
    }
  });

  it('every TAG_DRIVE_DELTAS key is a drive', () => {
    const drives = new Set<string>(EMOTION_DRIVES);
    for (const deltas of Object.values(asRecord(TAG_DRIVE_DELTAS))) {
      for (const k of Object.keys(deltas)) expect(drives.has(k), k).toBe(true);
    }
  });

  it('every delta magnitude is a sane push (|v| <= 0.5, never zero)', () => {
    for (const table of [asRecord(EMOTION_DELTAS), asRecord(TAG_PRIMARY_DELTAS), asRecord(TAG_DRIVE_DELTAS)]) {
      for (const deltas of Object.values(table)) {
        for (const v of Object.values(deltas)) {
          expect(v).not.toBe(0);
          expect(Math.abs(v)).toBeLessThanOrEqual(0.5);
        }
      }
    }
  });

  it('the feed table is exactly ticker.py TAG_FEEDS', () => {
    expect(TAG_FEEDS).toEqual({ DONE: { mastery: -0.06 }, MOMENT: { connection: -0.04 }, GIFT: { connection: -0.06 } });
  });
});

describe('baselines, verbatim from ticker.py / Thea1 state.json', () => {
  it('PRIMARY_BASELINE is ticker.py line 173', () => {
    expect(PRIMARY_BASELINE).toEqual({
      joy: 0.35, anticipation: 0.3, pride: 0.28, surprise: 0.1,
      sadness: 0.1, fear: 0.08, anger: 0.06, shame: 0.06, disgust: 0.05,
    });
    expect(EMOTION_PRIMARIES).toEqual(Object.keys(PRIMARY_BASELINE));
  });

  it('dial homes come from the Thea1 live state.json baseline block', () => {
    expect(DIAL_BASELINE).toEqual({
      pleasure: 0.66, arousal: 0.34, dominance: 0.0,
      attachment: 0.75, brattiness: 0.55, protectiveness: 0.75,
      longing: 0.25, playfulness: 0.6, focus: 0.7, calm: 0.7, trust: 0.75,
    });
  });

  it('valence sets: AVERSIVE / POSITIVE_PRIM / NEGATIVE_DIALS, disjoint where it matters', () => {
    expect([...AVERSIVE].sort()).toEqual(['anger', 'disgust', 'fear', 'sadness', 'shame']);
    expect([...POSITIVE_PRIM].sort()).toEqual(['joy', 'pride']);
    expect([...NEGATIVE_DIALS].sort()).toEqual(['calm', 'pleasure', 'trust']);
    for (const p of AVERSIVE) expect(POSITIVE_PRIM.has(p)).toBe(false);
  });

  it('BASELINE_DIMS covers every dial and primary exactly once', () => {
    expect(new Set(BASELINE_DIMS).size).toBe(BASELINE_DIMS.length);
    for (const d of [...DIALS, ...PAD] as Dial[]) expect(BASELINE_DIMS).toContain(d);
    for (const p of EMOTION_PRIMARIES as Primary[]) expect(BASELINE_DIMS).toContain(p);
  });

  it('every dimension the engine traces has a baseline (AffectDim ⊆ BASELINE_DIMS ∪ drives)', () => {
    const dims = new Set<AffectDim>([
      ...(Object.keys(PRIMARY_BASELINE) as Primary[]),
      ...DIALS,
      ...PAD,
      ...EMOTION_DRIVES,
    ]);
    expect(dims.size).toBe(BASELINE_DIMS.length + EMOTION_DRIVES.length);
  });

  it('the drive set is exactly the three homeostatic wants', () => {
    expect([...EMOTION_DRIVES].sort()).toEqual(['connection', 'mastery', 'novelty']);
    for (const d of EMOTION_DRIVES as readonly Drive[]) expect(typeof d).toBe('string');
  });
});

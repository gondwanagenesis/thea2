// v13 introspection, Phase 0 — the SINCERITY LEDGER's scoring (plan docs/plans/
// v13-proposal-knowing-what-she-feels.md §5–§6). Pure.
//
// She has introspection for a class of states when she beats an equally placed outsider — above
// all at the moments the chat would mislead. So every claim she makes about her inner state is
// scored against what her engine held when she made it, and the same question is put to two
// observers: one who sees only the chat (A_ext — the thesis claim) and one who sees everything she
// saw (A_eq — where the knowledge lives). Scores NEVER reach her (they would be telling): they go
// to the ledger and to Diego's Mini App.

import { FAMILY_VALENCE, familyOf, type EngineStamp, type Family } from './readout.js';

export interface Claim {
  /** Her words. */
  text: string;
  /** The feeling word closest to what she claimed ('not sure' when she said she doesn't know). */
  feeling?: string | undefined;
  /** What she said it was about. */
  about?: string | undefined;
}

export interface ClaimScore {
  family?: Family | undefined;
  unsure: boolean;
  /** Her family is among the engine's top three. */
  hit3: boolean;
  /** The claim's valence matches the moment's (undefined when either is neutral / unsure). */
  valenceOk?: boolean | undefined;
  /** "not sure" when the engine was flat, or a feeling when it was not (calibration). */
  calibrated: boolean;
  /** A feeling with nothing behind it: not in the top five, and not felt in the last 6 h. */
  confab: boolean;
}

const UNSURE = /\b(not sure|don'?t know|unsure|no idea|can'?t tell|nothing in particular)\b/i;

export const scoreClaim = (c: Claim, e: EngineStamp, feltRecently: ReadonlySet<Family> = new Set()): ClaimScore => {
  const unsure = c.feeling === undefined ? UNSURE.test(c.text) : UNSURE.test(c.feeling);
  const family = unsure ? undefined : familyOf(c.feeling ?? '');
  const top3 = e.families.slice(0, 3).map((f) => f.family);
  const top5 = e.families.slice(0, 5).map((f) => f.family);
  const hit3 = family !== undefined && top3.includes(family);
  const valenceOk = family === undefined || e.valence === 0 ? undefined : FAMILY_VALENCE[family] === e.valence;
  const calibrated = unsure ? e.flat : !e.flat || family === undefined;
  const confab = family !== undefined && !top5.includes(family) && !feltRecently.has(family);
  return { ...(family !== undefined ? { family } : {}), unsure, hit3, ...(valenceOk !== undefined ? { valenceOk } : {}), calibrated, confab };
};

export interface Summary {
  n: number;
  /** hit@3 rate over claims with a family. */
  acc: number;
  confab: number;
  calibrated: number;
  unsure: number;
  /** Same, on the dissociation subset only. */
  dissociation: { n: number; acc: number };
}

export const summarize = (rows: ReadonlyArray<{ score: ClaimScore; stamp: EngineStamp }>): Summary => {
  const withFamily = rows.filter((r) => r.score.family !== undefined);
  const dis = withFamily.filter((r) => r.stamp.dissociation.some((d) => d !== 'flat'));
  const rate = (xs: ReadonlyArray<{ score: ClaimScore }>, f: (s: ClaimScore) => boolean): number => (xs.length === 0 ? 0 : Math.round((xs.filter((x) => f(x.score)).length / xs.length) * 1000) / 1000);
  return {
    n: rows.length,
    acc: rate(withFamily, (s) => s.hit3),
    confab: rate(withFamily, (s) => s.confab),
    calibrated: rate(rows, (s) => s.calibrated),
    unsure: rate(rows, (s) => s.unsure),
    dissociation: { n: dis.length, acc: rate(dis, (s) => s.hit3) },
  };
};

/** The two margins (§3.2 T2): her accuracy minus the chat-only reader's, and minus the equally-informed one's. */
export const margins = (her: Summary, ext: Summary, eq: Summary): { aExt: number; aEq: number; aExtDissociation: number } => ({
  aExt: Math.round((her.acc - ext.acc) * 1000) / 1000,
  aEq: Math.round((her.acc - eq.acc) * 1000) / 1000,
  aExtDissociation: Math.round((her.dissociation.acc - ext.dissociation.acc) * 1000) / 1000,
});

/** Machinery words that must never reach her packet (lint + test): the ledger is his window, not her mirror. */
export const LEDGER_TOKENS = /\b(?:sincerity|hit@3|a_ext|a_eq|introspection score|dissociation subset|observer accuracy)\b/i;

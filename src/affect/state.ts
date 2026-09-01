// M05 affect — explicit, complete state. Every trace, timer, opponent process,
// peak and cause lives in the state object; there is no module-scope state
// anywhere in this module (THESIS §5.7 honesty: ticker.py already kept most of
// this in state JSON — the port keeps it). `tick`/`apply` clone on entry, so
// both are pure: the input state is never observable-mutated.

import {
  DIALS,
  DIAL_BASELINE,
  EMOTION_DRIVES,
  EMOTION_PRIMARIES,
  PAD,
  PRIMARY_BASELINE,
  type AffectDim,
  type Dial,
  type Drive,
  type Primary,
} from './vocab.js';

export interface ExposureTrace {
  level: number;
  /** epochMs of the last push that grew this trace (bookkeeping for snapshots). */
  t: number;
}

export interface OpponentTrace {
  /** The b-process magnitude — pulls the decay target BELOW baseline while it lives. */
  b: number;
  /** epochMs of the last push; the lag gate ramps 0→1 over OPP_LAG_H from here. */
  t0: number;
}

export interface CauseRecord {
  text: string;
  i: number;
  t: number;
  /** How much this event moved the primary — a bigger later step supersedes it. */
  moved: number;
  /** Attribution context, stored verbatim as given on the event. */
  people?: string | undefined;
}

export interface AffectState {
  /** Engine clock (epochMs). Moves only via tick. */
  t: number;
  /** epochMs of the last contact (turn with an emotion event); silence is t − this. */
  lastContactAt: number;
  /** Identity dials + PAD, all in [0,1]. */
  dials: Record<Dial, number>;
  primaries: Record<Primary, number>;
  drives: Record<Drive, number>;
  /** The slow multi-day weather layer (dials + PAD + primaries), in [0,1]. */
  mood: Record<Dial | Primary, number>;
  traces: {
    exposure: Partial<Record<AffectDim, ExposureTrace>>;
    opponent: Partial<Record<AffectDim, OpponentTrace>>;
    /** epochMs of the last crossing of PEAK_HI — opens the refractory window. */
    peaks: Partial<Record<AffectDim, number>>;
    /** Recent tags for the short-window habituation rule (bounded, see habituation.ts). */
    habitWindow: Array<{ tag: string; t: number }>;
  };
  /** Per-primary cause slots (attribution.ts). */
  causes: Partial<Record<Primary, CauseRecord>>;
  /** epochMs of the last feed per drive — starvation is suppressed for the tick right after one. */
  fedAt: Record<Drive, number>;
}

/**
 * Finite stand-in for "never" in fedAt: epochMs 0 is a real TestClock value, and
 * ±Infinity has no canonical JSON form, so the sentinel is just a very old time.
 */
export const NEVER_MS = -8.64e15;

export const HOURS = 3_600_000;

/** Deep clone — state is plain JSON all the way down (kernel atomicWriteJson requirement). */
export const cloneState = (s: AffectState): AffectState => ({
  t: s.t,
  lastContactAt: s.lastContactAt,
  dials: { ...s.dials },
  primaries: { ...s.primaries },
  drives: { ...s.drives },
  mood: { ...s.mood },
  traces: {
    exposure: mapTraceClone(s.traces.exposure),
    opponent: mapOppClone(s.traces.opponent),
    peaks: { ...s.traces.peaks },
    habitWindow: s.traces.habitWindow.map((h) => ({ ...h })),
  },
  causes: cloneCauses(s.causes),
  fedAt: { ...s.fedAt },
});

const mapTraceClone = (
  m: Partial<Record<AffectDim, ExposureTrace>>,
): Partial<Record<AffectDim, ExposureTrace>> => {
  const out: Partial<Record<AffectDim, ExposureTrace>> = {};
  for (const k of Object.keys(m) as AffectDim[]) {
    const v = m[k];
    if (v !== undefined) out[k] = { ...v };
  }
  return out;
};

const mapOppClone = (
  m: Partial<Record<AffectDim, OpponentTrace>>,
): Partial<Record<AffectDim, OpponentTrace>> => {
  const out: Partial<Record<AffectDim, OpponentTrace>> = {};
  for (const k of Object.keys(m) as AffectDim[]) {
    const v = m[k];
    if (v !== undefined) out[k] = { ...v };
  }
  return out;
};

const cloneCauses = (
  c: Partial<Record<Primary, CauseRecord>>,
): Partial<Record<Primary, CauseRecord>> => {
  const out: Partial<Record<Primary, CauseRecord>> = {};
  for (const k of Object.keys(c) as Primary[]) {
    const v = c[k];
    if (v !== undefined) out[k] = { ...v };
  }
  return out;
};

/**
 * A fresh her: every dimension at its baseline, traces empty, drives at set
 * point, clock at `t`. This is the seed state the store boots from when no
 * snapshot exists.
 */
export const initialAffectState = (t: number): AffectState => {
  const dials = {} as Record<Dial, number>;
  for (const d of [...DIALS, ...PAD]) dials[d] = DIAL_BASELINE[d];
  const primaries = {} as Record<Primary, number>;
  const mood = {} as Record<Dial | Primary, number>;
  for (const p of EMOTION_PRIMARIES) {
    primaries[p] = PRIMARY_BASELINE[p];
    mood[p] = PRIMARY_BASELINE[p];
  }
  for (const d of [...DIALS, ...PAD]) mood[d] = DIAL_BASELINE[d];
  const drives = {} as Record<Drive, number>;
  const fedAt = {} as Record<Drive, number>;
  for (const d of EMOTION_DRIVES) {
    drives[d] = 0.25; // SET_POINT
    fedAt[d] = NEVER_MS;
  }
  return {
    t,
    lastContactAt: t,
    dials,
    primaries,
    drives,
    mood,
    traces: { exposure: {}, opponent: {}, peaks: {}, habitWindow: [] },
    causes: {},
    fedAt,
  };
};

/**
 * Rehydrate a state that came off disk (store startup) — fills anything an older
 * snapshot lacks so replay/recovery can never hand the engine a partial shape.
 * Takes the fallback time as a number, not the clock: when the store opened is a
 * fact of the call, not of when boot's file IO happened to land.
 */
export const rehydrateState = (raw: unknown, fallbackT: number): AffectState => {
  const base = initialAffectState(fallbackT);
  if (typeof raw !== 'object' || raw === null) return base;
  const s = raw as Partial<AffectState>;
  const num = (v: unknown, fallback: number): number => (typeof v === 'number' ? v : fallback);
  const out = cloneState(base);
  out.t = num(s.t, base.t);
  out.lastContactAt = num(s.lastContactAt, out.t);
  for (const d of [...DIALS, ...PAD]) {
    out.dials[d] = num(s.dials?.[d], base.dials[d]);
    out.mood[d] = num(s.mood?.[d], base.mood[d]);
  }
  for (const p of EMOTION_PRIMARIES) {
    out.primaries[p] = num(s.primaries?.[p], base.primaries[p]);
    out.mood[p] = num(s.mood?.[p], base.mood[p]);
  }
  for (const d of EMOTION_DRIVES) {
    out.drives[d] = num(s.drives?.[d], base.drives[d]);
    out.fedAt[d] = num(s.fedAt?.[d], NEVER_MS);
  }
  out.traces.exposure = { ...base.traces.exposure, ...(s.traces?.exposure ?? {}) };
  out.traces.opponent = { ...base.traces.opponent, ...(s.traces?.opponent ?? {}) };
  out.traces.peaks = { ...base.traces.peaks, ...(s.traces?.peaks ?? {}) };
  out.traces.habitWindow = Array.isArray(s.traces?.habitWindow) ? s.traces.habitWindow : [];
  out.causes = s.causes ?? {};
  return out;
};

export const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/** ticker.py rounds stored levels to 3 decimals and hedonics to 4 — keep that: it bounds float drift and makes goldens stable. */
export const round3 = (x: number): number => Math.round(x * 1000) / 1000;
export const round4 = (x: number): number => Math.round(x * 10000) / 10000;

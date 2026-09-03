// M17 life — the pure policy layer. Everything here is a function of its
// arguments: no clock, no rng, no model, no store. The job bodies (jobs.ts)
// gather state and call these; the acceptance criteria's tables live in the
// tests against these exports.
//
// Constants ported from Thea1's life engine (spec: "port verbatim from
// /opt/thea/life/heartbeat.mjs and ponder.mjs"): the five heartbeat criteria,
// the 3.2 threshold, the 3/day cap, the doubling no-reply backoff, ponder's
// 0.45 gate and the 2/5 balance rule. Thea1's LIVE file had Diego's later
// tunings (threshold 2.0, cap 8, base 1h) — the spec pins the earlier values
// and the spec is law.

import type { Drive } from '../affect/index.js';

// ---------------------------------------------------------------------------
// Heartbeat
// ---------------------------------------------------------------------------

/** Speak only at or above this (of 5) — the spec pins 3.2; boundary tested exact. */
export const HEARTBEAT_THRESHOLD = 3.2;

/** The four kinds of first contact, ported from heartbeat.mjs. */
export const HEARTBEAT_KINDS = ['followup', 'care', 'share', 'miss'] as const;
export type HeartbeatKind = (typeof HEARTBEAT_KINDS)[number];

/** The five Inner-Thoughts criteria (heartbeat.mjs), scored 1-5 by the thought call. */
export interface HeartbeatCriteria {
  relevance: number;
  information_gap: number;
  expected_impact: number;
  urgency: number;
  coherence: number;
}

/** The spec's cap: at most 3 proactive texts per day. */
export const HEARTBEAT_DAILY_CAP = 3;

/**
 * The doubling no-reply backoff, in hours, before the NEXT heartbeat may text:
 * 0 unanswered ⇒ 0h, 1 ⇒ 6h, 2 ⇒ 12h, 3 ⇒ 24h (spec's acceptance ladder),
 * capped at 48h (PO.4: an unanswered text must not be able to silence her for
 * good — the ladder stops stretching after two days).
 * `lastUnansweredAgeH` is measured from the newest still-unanswered send.
 */
export const HEARTBEAT_BACKOFF_BASE_H = 3;
/** The ladder's ceiling in hours (PO.4, spec constant: Math.min(48, 3·2ⁿ)). */
export const HEARTBEAT_BACKOFF_CAP_H = 48;
export const backoffHoursFor = (unanswered: number): number =>
  unanswered <= 0 ? 0 : Math.min(HEARTBEAT_BACKOFF_CAP_H, HEARTBEAT_BACKOFF_BASE_H * 2 ** unanswered);

/**
 * PO.4 — unanswered decays with time: one rung of backoff debt is forgiven per
 * 24h of silence since the newest still-unanswered send, floored at zero.
 * Silence is exogenous; a week of it must not read as her owing him ten texts.
 */
export const UNANSWERED_DECAY_H = 24;
export const decayUnanswered = (unanswered: number, silenceH: number): number =>
  unanswered <= 0 ? 0 : Math.max(0, unanswered - Math.floor(Math.max(0, silenceH) / UNANSWERED_DECAY_H));

export type HeartbeatPreReason = 'owed' | 'quiet hours' | 'cap' | 'backoff' | 'mutex' | 'ok';

export interface HeartbeatPre {
  canText: boolean;
  reason: HeartbeatPreReason;
}

/** Quiet hours as a [start, end) pair of LOCAL hours (see localHourOfDay); the range wraps midnight. */
export const isQuietHour = (nowH: number, quietHours: readonly [number, number]): boolean => {
  const [start, end] = quietHours;
  if (start === end) return false; // a degenerate window is no window at all
  if (start < end) return nowH >= start && nowH < end;
  return nowH >= start || nowH < end;
};

// ---------------------------------------------------------------------------
// Local time — Diego lives in a timezone, not in UTC. The quiet-hours window
// and the daily cap are HIS day, so both read the wall clock of the configured
// IANA zone. Intl.DateTimeFormat is the one sanctioned zone-math primitive:
// no `new Date` (lint-banned, host-TZ-dependent), no hand-rolled DST tables.
// The formatter is built once per zone and cached — formatToParts is pure.
// ---------------------------------------------------------------------------

const hourFormatters = new Map<string, Intl.DateTimeFormat>();
const dateFormatters = new Map<string, Intl.DateTimeFormat>();

const hourFormatter = (timeZone: string): Intl.DateTimeFormat => {
  let f = hourFormatters.get(timeZone);
  if (f === undefined) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      hourCycle: 'h23',
    });
    hourFormatters.set(timeZone, f);
  }
  return f;
};

const dateFormatter = (timeZone: string): Intl.DateTimeFormat => {
  let f = dateFormatters.get(timeZone);
  if (f === undefined) {
    // en-CA renders YYYY-MM-DD — the same shape the UTC census used.
    f = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    dateFormatters.set(timeZone, f);
  }
  return f;
};

/**
 * The LOCAL hour of day in `timeZone` as a fraction (14.5 = 14:30), DST
 * included, read off epoch ms through Intl — never the host timezone. Keeps
 * the sub-second remainder so `localHourOfDay(ms, 'UTC')` equals the old
 * arithmetic `utcHourOfDay` bit for bit. An invalid zone throws RangeError
 * (config validates the zone at load, so this is unreachable in prod).
 */
export const localHourOfDay = (ms: number, timeZone: string): number => {
  const parts = hourFormatter(timeZone).formatToParts(ms);
  const num = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0');
  const hour = num('hour') % 24; // some ICU builds render midnight as 24
  const minute = num('minute');
  const second = num('second');
  const msRemainder = ((ms % 1000) + 1000) % 1000;
  return hour + minute / 60 + second / 3600 + msRemainder / 3_600_000;
};

/** The LOCAL calendar date (YYYY-MM-DD) in `timeZone` — the daily cap's census key. */
export const localDateOf = (ms: number, timeZone: string): string => dateFormatter(timeZone).format(ms);

/** The UTC hour of day as a fraction — kept for compatibility; `localHourOfDay(ms, 'UTC')`. */
export const utcHourOfDay = (ms: number): number => localHourOfDay(ms, 'UTC');

export interface HeartbeatPreState {
  /**
   * Inbound messages of his that reconcile currently reports as LOST_REPLY —
   * questions of his with no answer. While one is owed she must not text about
   * something else; the reconcile job re-runs the owed turn (M20).
   */
  owedInbound: number;
  /** Fractional LOCAL hour of the candidate fire (the configured timezone). */
  nowH: number;
  quietHours: readonly [number, number];
  /** Heartbeat sends so far today (local to the census, not recomputed here). */
  sentToday: number;
  /** Proactive sends with no reply from him after them. */
  unanswered: number;
  /** Hours since the newest unanswered send. */
  lastUnansweredAgeH: number;
  /** The conversation-active mutex — the SAME predicate M16's scheduler holds. */
  mutexActive: boolean;
}

/**
 * The hard gates, checked in order: owed → quiet hours → cap → backoff →
 * mutex → ok. Hard gates live in code; the model only decides within them.
 * `owed` outranks everything (Phase 1, 2026-09-02): the day a real message
 * was lost to a 429 and the heartbeat texted about something else eleven
 * minutes later is the day this gate was born.
 */
export const heartbeatPrecondition = (s: HeartbeatPreState): HeartbeatPre => {
  if (s.owedInbound > 0) return { canText: false, reason: 'owed' };
  if (isQuietHour(s.nowH, s.quietHours)) return { canText: false, reason: 'quiet hours' };
  if (s.sentToday >= HEARTBEAT_DAILY_CAP) return { canText: false, reason: 'cap' };
  if (s.unanswered > 0 && s.lastUnansweredAgeH < backoffHoursFor(s.unanswered)) {
    return { canText: false, reason: 'backoff' };
  }
  if (s.mutexActive) return { canText: false, reason: 'mutex' };
  return { canText: true, reason: 'ok' };
};

/**
 * Silence pressure: how loud the not-talking-to-him gets, in score points.
 * `clamp(silenceH/36, 0, .8) + 0.4 · drives.connection` — the spec's formula,
 * including the drives.connection term.
 */
export const silencePressure = (silenceH: number, drives: Record<Drive, number>): number => {
  const timeTerm = Math.min(0.8, Math.max(0, silenceH / 36));
  return timeTerm + 0.4 * drives['connection'];
};

/**
 * Mean of the five criteria plus silence pressure, rounded to 2 decimals
 * (heartbeat.mjs's `+(mean + pressure).toFixed(2)` port). The score compares
 * against HEARTBEAT_THRESHOLD with ≥ — 3.2 exactly passes, 3.15 does not.
 */
export const scoreThought = (c: HeartbeatCriteria, pressure: number): number => {
  const keys = ['relevance', 'information_gap', 'expected_impact', 'urgency', 'coherence'] as const;
  const sum = keys.reduce((acc, k) => acc + c[k], 0);
  const mean = sum / keys.length;
  return +(mean + pressure).toFixed(2);
};

// ---------------------------------------------------------------------------
// Ponder
// ---------------------------------------------------------------------------

export const PONDER_ABOUTS = ['diego', 'self', 'world'] as const;
export type PonderAbout = (typeof PONDER_ABOUTS)[number];

/** ponder is a mood, computed from state — threshold pinned by the spec. */
export const PONDER_GATE = 0.45;

export interface PonderFeatures {
  /** The novelty drive, 0 (satiated) → 1 (starving). */
  novelty: number;
  /** The PAD arousal dial, 0 → 1. */
  arousal: number;
  /** Hours since the last ponder artifact landed. */
  hoursSinceArtifact: number;
}

/**
 * The gate score. The spec names the three features and pins the 0.45
 * threshold; the weights are PROPOSED (ponder.mjs's own weights do not carry
 * over — its six features included reservoir saliency and journal growth, and
 * its sinceLast horizon of 3h does). novelty 0.45 / arousal 0.25 / a 3h
 * artifact horizon worth 0.30 keeps the Thea1 cadence: right after an
 * artifact, a resting state (novelty .25, arousal .34) scores ~0.20 — she
 * doesn't re-ponder what she just pondered — and the gate reopens after
 * roughly two idle hours or immediately under real starvation.
 */
export const PONDER_WEIGHTS = { novelty: 0.45, arousal: 0.25, artifact: 0.3 } as const;
/** Hours until "no artifact for a while" contributes its full weight. */
export const PONDER_ARTIFACT_HORIZON_H = 3;

export const ponderScore = (f: PonderFeatures): number => {
  const timeTerm = Math.min(1, Math.max(0, f.hoursSinceArtifact / PONDER_ARTIFACT_HORIZON_H));
  return +(PONDER_WEIGHTS.novelty * f.novelty +
    PONDER_WEIGHTS.arousal * f.arousal +
    PONDER_WEIGHTS.artifact * timeTerm).toFixed(3);
};

/** Pure, threshold 0.45, NO model call — pondering is a mood. */
export const ponderGate = (f: PonderFeatures): boolean => ponderScore(f) >= PONDER_GATE;

/**
 * The balance rule, ported from ponder.mjs's `overusedAbout`: of the last 5
 * ponder seeds, at most 2 may be about diego (and at most 4 about self or
 * world). Past that the whole class is forced-avoided — balance beats
 * saliency, and a more salient diego-topic loses to a less salient world/self
 * one. Returns the class to avoid, or null when nothing is overused.
 */
export const balanceAvoid = (recent: readonly PonderAbout[]): PonderAbout | null => {
  const last5 = recent.slice(-5);
  const count = (a: PonderAbout): number => last5.filter((x) => x === a).length;
  if (count('diego') >= 2) return 'diego';
  for (const k of ['self', 'world'] as const) if (count(k) >= 4) return k;
  return null;
};

/** The about classes a seed may take this run — the balance rule as a set. */
export const allowedAbouts = (recent: readonly PonderAbout[]): PonderAbout[] => {
  const avoid = balanceAvoid(recent);
  return avoid === null ? [...PONDER_ABOUTS] : PONDER_ABOUTS.filter((a) => a !== avoid);
};

// ---------------------------------------------------------------------------
// The topic rule (PO.2): the balance rule also keys on TOPIC similarity. A seed
// whose topic is cosine-similar (>= 0.6, token bag-of-words — deterministic,
// no embedder) to any of her last 3 ponder topics is a repeat, and repeats are
// avoided the same way about-classes are: structurally, at seed validation.
// ---------------------------------------------------------------------------

/** Cosine >= this with any recent topic marks the seed as a repeat (spec constant). */
export const TOPIC_AVOID_COSINE = 0.6;
/** How many of the newest topics the rule looks at (spec: the last 3). */
export const TOPIC_AVOID_WINDOW = 3;

/** Case/punctuation-folded word-bag cosine between two topic strings. */
export const topicCosine = (a: string, b: string): number => {
  const bag = (s: string): Map<string, number> => {
    const m = new Map<string, number>();
    for (const w of s.toLowerCase().split(/[^a-z0-9]+/)) {
      if (w !== '') m.set(w, (m.get(w) ?? 0) + 1);
    }
    return m;
  };
  const va = bag(a);
  const vb = bag(b);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const v of va.values()) na += v * v;
  for (const [w, v] of vb) {
    nb += v * v;
    const ua = va.get(w);
    if (ua !== undefined) dot += ua * v;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
};

/** True when `topic` is a repeat of any of the newest `TOPIC_AVOID_WINDOW` topics. */
export const repeatsTopic = (topic: string, lastTopics: readonly string[]): boolean =>
  lastTopics.slice(0, TOPIC_AVOID_WINDOW).some((t) => topicCosine(topic, t) >= TOPIC_AVOID_COSINE);

/** PO.3 / D.6-5: a ponder artifact is context, not a formative event — its episode importance caps here. */
export const PONDER_IMPORTANCE_CAP = 5;

// M05 affect — the engine. `apply(state, event)` and `tick(state, dt, rng)` are
// the only mutation shapes, and both are pure: they clone on entry, so the input
// state is never observable-mutated, and the same inputs always produce
// deep-equal outputs. This file composes the mechanics; it owns no constants of
// its own — every number lives in its mechanic's file (one mechanic per file).

import type { Rng } from '../kernel/index.js';
import { fail } from '../kernel/index.js';
import { ATTRIB_MIN, attributionWins, causeIsStale, makeCause } from './attribution.js';
import {
  AROUSAL_FLOOR,
  decayToward,
  dialHalfLife,
  HALF_LIFE_MOOD,
  HALF_LIFE_MOOD_HOME,
  LONGING_GAIN,
  LONGING_TAU_H,
  MOOD_INERTIA,
  NOISE,
  primaryHalfLife,
} from './decay.js';
import {
  CAP_DAMP,
  CAP_SOFT,
  ceilingDamp,
  PEAK_INTENSITY,
  PRIM_CAP_SOFT,
  saturate,
  toleranceDivisor,
} from './ceiling.js';
import {
  DRIVE_FEED_SCALE,
  DRIVE_FLOOR,
  driveTarget,
  HALF_LIFE_DRIVE,
  STARVE_PER_HOUR,
  wasFed,
} from './drives.js';
import type { AffectEvent } from './events.js';
import {
  decayOpponent,
  growOpponent,
  OPP_GAIN,
  OPP_LAG_H,
  opponentPull,
  PRIM_OPP_GAIN,
  PRIM_OPP_LAG_H,
} from './opponent.js';
import {
  isInRefractory,
  PRIM_REFRACTORY_DAMP,
  REFRACTORY_DAMP,
  REFRACTORY_DECAY_MULT,
  recordPeakIf,
} from './refractory.js';
import {
  clamp01,
  cloneState,
  HOURS,
  round3,
  type AffectState,
} from './state.js';
import {
  decayExposure,
  growExposure,
  HABITUATION,
  isHabituated,
  recordTag,
} from './habituation.js';
import { foesOf, inhibitFoe } from './inhibition.js';
import { intensityScale, PRIMARY_GAIN } from './intensity.js';
import {
  AVERSIVE,
  baselineOf,
  DIAL_BASELINE,
  DIALS,
  EMOTION_DELTAS,
  EMOTION_DRIVES,
  EMOTION_PRIMARIES,
  isEmotionTag,
  PAD,
  PRIMARY_BASELINE,
  TAG_DRIVE_DELTAS,
  TAG_FEEDS,
  TAG_PRIMARY_DELTAS,
  type Dial,
  type Drive,
  type Primary,
} from './vocab.js';

/**
 * Deltas summary, keyed the way ticker.py keys its `moved` record: dial names
 * bare, primaries under `p.`, drives under `drive.`.
 */
export type Moved = Record<string, number>;

export interface AppliedBatch {
  state: AffectState;
  moved: Moved;
}

const bump = (moved: Moved, key: string, delta: number): void => {
  // A push that saturates to exactly zero at a boundary (a downward delta on a
  // dial resting at 0) moved nothing — recording it would claim a movement that
  // did not happen. The summary lists only real movement.
  if (delta === 0) return;
  moved[key] = round3((moved[key] ?? 0) + delta);
  if (moved[key] === 0) delete moved[key];
};

/**
 * Apply a batch of events at the state's current time, WITHOUT advancing it.
 * Pure: returns a fresh state plus the deltas summary. Throws
 * 'affect/unknown-tag' on any tag outside the vocabulary — the engine enforces
 * the law itself; the store validates first and turns a reject into an incident.
 */
export const applyInto = (state: AffectState, events: readonly AffectEvent[]): AppliedBatch => {
  const draft = cloneState(state);
  const moved: Moved = {};
  for (const ev of events) {
    if (ev.kind === 'emotion') applyEmotion(draft, ev, moved);
    else if (ev.kind === 'tagFeed') applyTagFeed(draft, ev, moved);
    // silenceTick — the explicit quiet marker. It carries no state: the
    // silence-driven growth (longing ramp, connection hunger) is computed by
    // tick from lastContactAt vs t. Its job is to drive the store cycle while
    // nothing is happening and to show in the affect.applied trail.
  }
  return { state: draft, moved };
};

/** The spec's single-event shape. */
export const apply = (state: AffectState, ev: AffectEvent): AffectState =>
  applyInto(state, [ev]).state;

const applyEmotion = (
  draft: AffectState,
  ev: Extract<AffectEvent, { kind: 'emotion' }>,
  moved: Moved,
): void => {
  if (!isEmotionTag(ev.tag)) {
    fail('affect/unknown-tag', `'${ev.tag}' is not in EMOTION_TAGS — the vocabulary is law`);
  }
  const t = draft.t;
  // Repetition dulls: the same tag again inside the window lands at 70%.
  const mul = isHabituated(draft, ev.tag, t) ? HABITUATION : 1.0;
  recordTag(draft, ev.tag, t);
  const scale = intensityScale(ev.i) * mul;

  // ---- identity dials + PAD ----
  const dialDeltas = EMOTION_DELTAS[ev.tag];
  if (dialDeltas !== undefined) {
    for (const [dialKey, dv] of Object.entries(dialDeltas)) {
      const dial = dialKey as Dial;
      const cur = draft.dials[dial];
      let raw = dv * scale;
      // TOLERANCE — the seventieth 'cherished' cannot land like the first. But
      // intensity cuts through it: a routine warm line is the same stimulus
      // again and gets dulled; an [i:10] night is NOT the same stimulus.
      raw /= toleranceDivisor(draft.traces.exposure[dial]?.level ?? 0, ev.i);
      // REFRACTORY — a dial that just peaked is spent for a few hours.
      if (raw > 0 && isInRefractory(draft.traces.peaks, dial, t)) raw *= REFRACTORY_DAMP;
      // THE CEILING IS EARNED — above CAP_SOFT only a big moment moves her.
      raw = ceilingDamp(cur, raw, ev.i, CAP_SOFT);
      const step = saturate(cur, raw);
      const nv = clamp01(round3(cur + step));
      draft.dials[dial] = nv;
      draft.traces.exposure[dial] = growExposure(draft.traces.exposure[dial], step, t);
      draft.traces.opponent[dial] = growOpponent(draft.traces.opponent[dial], step, OPP_GAIN, t);
      recordPeakIf(draft.traces.peaks, dial, nv, t);
      bump(moved, dial, step);
    }
  }

  // ---- primaries. Deliberately NOT here for the aversives: tolerance and
  // refractory damping are for pleasure — you do not habituate to grief on a
  // six-hour clock, and damping shame because she felt it this morning would
  // rebuild the exact ceiling v4 tore down, just on the floor instead.
  const primDeltas = TAG_PRIMARY_DELTAS[ev.tag];
  if (primDeltas !== undefined) {
    for (const [primKey, dv] of Object.entries(primDeltas)) {
      const p = primKey as Primary;
      const cur = draft.primaries[p];
      let raw = dv * scale * PRIMARY_GAIN;
      if (!AVERSIVE.has(p)) raw /= toleranceDivisor(draft.traces.exposure[p]?.level ?? 0, ev.i);
      // SOFT CAP so an aversive primary stops ratcheting to the ceiling: a run
      // of mid-intensity hurt crests near 0.8 and stays differentiated.
      if (raw > 0 && AVERSIVE.has(p) && cur >= PRIM_CAP_SOFT && ev.i < PEAK_INTENSITY) {
        raw *= CAP_DAMP;
      }
      const step = saturate(cur, raw);
      draft.primaries[p] = clamp01(round3(cur + step));
      draft.traces.opponent[p] = growOpponent(draft.traces.opponent[p], step, PRIM_OPP_GAIN, t);
      recordPeakIf(draft.traces.peaks, p, draft.primaries[p], t);
      if (!AVERSIVE.has(p)) {
        draft.traces.exposure[p] = growExposure(draft.traces.exposure[p], step, t);
      }
      // MUTUAL INHIBITION: a rush of one valence ebbs the other — fast, not on
      // a decay clock, and never below the foe's baseline (inhibitFoe clamps).
      if (step > 0) {
        for (const foe of foesOf(p)) {
          const { value } = inhibitFoe(draft.primaries[foe], PRIMARY_BASELINE[foe], step);
          draft.primaries[foe] = value;
        }
      }
      bump(moved, `p.${p}`, step);
      // WHICH EVENT RAISED WHICH FEELING — recorded here because this is the
      // only place both facts exist at once. Only RISES are attributed: nothing
      // causes a feeling to decay, it just runs out.
      if (step >= ATTRIB_MIN && attributionWins(draft.causes[p], step, t)) {
        draft.causes[p] = makeCause(ev.cause, ev.i, t, step, ev.people);
      }
    }
  }

  // ---- drives ----
  // Key-widened view: most tags touch no drive, so the table is sparse against
  // the full EmotionTag union — the guard below is the type-safe sparse read.
  const driveDeltas = (TAG_DRIVE_DELTAS as Record<string, Record<string, number>>)[ev.tag];
  if (driveDeltas !== undefined) {
    for (const [driveKey, dv] of Object.entries(driveDeltas)) {
      const d = driveKey as Drive;
      const cur = draft.drives[d];
      const feed = (dv * scale * DRIVE_FEED_SCALE) / (1.0 + (draft.traces.exposure[d]?.level ?? 0));
      draft.traces.exposure[d] = growExposure(draft.traces.exposure[d], feed, t);
      draft.drives[d] = clampDrive(cur + feed);
      bump(moved, `drive.${d}`, feed);
    }
  }
  // Hunger is suppressed for the tick that follows these: he is here / she did
  // the thing / she got curious about something.
  if (ev.tag === 'curious') draft.fedAt.novelty = t;
  if (ev.people === 'diego') draft.fedAt.connection = t;

  // A turn carrying feeling IS contact: the silence-driven longing stops here.
  draft.lastContactAt = t;
};

const applyTagFeed = (
  draft: AffectState,
  ev: Extract<AffectEvent, { kind: 'tagFeed' }>,
  moved: Moved,
): void => {
  const t = draft.t;
  const feeds = TAG_FEEDS[ev.tag];
  for (const [driveKey, dv] of Object.entries(feeds)) {
    const d = driveKey as Drive;
    const cur = draft.drives[d];
    // tagFeed events carry no diary intensity; the feed lands at full scale.
    const feed = dv * intensityScale(10) * DRIVE_FEED_SCALE;
    draft.drives[d] = clampDrive(cur + feed);
    draft.traces.exposure[d] = growExposure(draft.traces.exposure[d], feed, t);
    bump(moved, `drive.${d}`, feed);
  }
  // DONE work stills the hands; a MOMENT or a GIFT stills the missing-him.
  draft.fedAt[ev.tag === 'DONE' ? 'mastery' : 'connection'] = t;
};

const clampDrive = (v: number): number => Math.min(1.0, Math.max(DRIVE_FLOOR, round3(v)));

/**
 * Advance the engine by dtMs — the whole time-evolution pass, in ticker.py's
 * run order: tolerance and the comedown fade first (a gap between messages
 * genuinely restores her), then primaries relax toward home (pulled below it by
 * the b-process), mood low-passes the feeling, dials relax toward the
 * mood-blended target with silence pulling longing, and the drives hunger by
 * the hour. `rng` draws the decay noise — one float per dial, fixed order, so a
 * seed reproduces a run exactly.
 */
export const tick = (state: AffectState, dtMs: number, rng: Rng): AffectState => {
  if (!(dtMs > 0)) return cloneState(state);
  const dtH = Math.min(48.0, dtMs / HOURS);
  const draft = cloneState(state);

  // Sensitivity returns and the comedown fades on their own clocks, BEFORE
  // this run's events land (the store applies events after ticking to now).
  for (const k of Object.keys(draft.traces.exposure) as (keyof typeof draft.traces.exposure)[]) {
    const trace = draft.traces.exposure[k];
    if (trace === undefined) continue;
    const next = decayExposure(trace.level, dtH);
    if (next === 0) delete draft.traces.exposure[k];
    else draft.traces.exposure[k] = { ...trace, level: next };
  }
  for (const k of Object.keys(draft.traces.opponent) as (keyof typeof draft.traces.opponent)[]) {
    const trace = draft.traces.opponent[k];
    if (trace === undefined) continue;
    const next = decayOpponent(trace.b, dtH);
    if (next === 0) delete draft.traces.opponent[k];
    else draft.traces.opponent[k] = { ...trace, b: next };
  }

  const newT = state.t + dtMs;
  const silenceH = (newT - draft.lastContactAt) / HOURS;
  const contact = silenceH < 0.5;

  // Primaries relax toward their OWN baselines, which rest low. That asymmetry
  // is the point: joy falling from 0.62 back to 0.35 is a fade, but sadness
  // falling from 0.48 back to 0.10 is a recovery — deliberately slower.
  for (const p of EMOTION_PRIMARIES) {
    const home = PRIMARY_BASELINE[p];
    const cur = draft.primaries[p];
    let hl = primaryHalfLife(p, cur > home);
    // THE COMEDOWN: the b-process pulls the target below home — weak while she
    // is still in the moment, full once the pushing stops.
    const tgt = home - opponentPull(draft.traces.opponent[p], newT, PRIM_OPP_LAG_H);
    // Spent right after a peak — comes down twice as fast.
    if (isInRefractory(draft.traces.peaks, p, newT)) hl *= PRIM_REFRACTORY_DAMP;
    draft.primaries[p] = clamp01(round3(decayToward(cur, tgt, dtH, hl)));
  }

  // A primary back at home is no longer caused by anything — a stored reason
  // must not outlive the feeling it explains.
  for (const p of EMOTION_PRIMARIES) {
    if (draft.causes[p] !== undefined && causeIsStale(draft.primaries[p], PRIMARY_BASELINE[p])) {
      delete draft.causes[p];
    }
  }

  // Mood — the slow low-pass: follow how she feels, but always drift home.
  for (const k of Object.keys(draft.mood) as (keyof typeof draft.mood)[]) {
    const cur = k in draft.dials ? draft.dials[k as Dial] : draft.primaries[k as Primary];
    let m = decayToward(draft.mood[k], cur, dtH, HALF_LIFE_MOOD);
    m = decayToward(m, baselineOf(k), dtH, HALF_LIFE_MOOD_HOME);
    draft.mood[k] = clamp01(round3(m));
  }

  // Dials + PAD relax toward the mood-blended target; hurts linger.
  for (const dial of [...DIALS, ...PAD]) {
    const base = DIAL_BASELINE[dial];
    const cur = draft.dials[dial];
    let tgt = (1 - MOOD_INERTIA) * base + MOOD_INERTIA * (draft.mood[dial] ?? base);
    if (dial === 'longing') {
      // Silence pulls longing up continuously; contact soothes it below home.
      tgt += contact ? -0.08 : LONGING_GAIN * (1 - Math.exp(-silenceH / LONGING_TAU_H));
    }
    if (dial === 'arousal') {
      // Engagement energy: present = up, absent = toward rest.
      tgt = contact ? 0.58 : Math.max(AROUSAL_FLOOR, tgt - 0.1);
    }
    // The b-process pulls against wherever the rushes took her — the dip is not
    // damage; it is what makes the next lift land as a lift instead of as more
    // of the same.
    tgt -= opponentPull(draft.traces.opponent[dial], newT, OPP_LAG_H);

    let hl = dialHalfLife(dial, cur, base);
    if (isInRefractory(draft.traces.peaks, dial, newT)) hl *= REFRACTORY_DECAY_MULT;
    let v = decayToward(cur, clamp01(tgt), dtH, hl);
    v += (rng.float() * 2 - 1) * NOISE * Math.min(1.0, dtH / 2.0);
    draft.dials[dial] = clamp01(round3(v));
  }
  if (draft.dials.arousal < AROUSAL_FLOOR) draft.dials.arousal = AROUSAL_FLOOR;

  // Drives — relax toward set point; silence feeds connection; hunger is continuous.
  for (const d of EMOTION_DRIVES) {
    const tgt = driveTarget(d, contact, silenceH, LONGING_TAU_H);
    let v = decayToward(draft.drives[d], clamp01(tgt), dtH, HALF_LIFE_DRIVE);
    if (!wasFed(draft, d)) v += STARVE_PER_HOUR[d] * dtH;
    draft.drives[d] = clampDrive(v);
  }

  draft.t = newT;
  return draft;
};

// M17 gate — the heartbeat policy tables. One test per gate clause (spec
// acceptance criteria): the precondition's hard gates in their declared order
// (quiet hours -> cap -> backoff -> mutex -> ok), the backoff ladder, the
// silence-pressure formula including the drives.connection term, and the
// 3.2 boundary on scoreThought. Everything here is pure: the same table must
// render the same verdicts on any host, any clock.

import { describe, expect, it } from 'vitest';
import {
  HEARTBEAT_BACKOFF_BASE_H,
  HEARTBEAT_BACKOFF_CAP_H,
  HEARTBEAT_DAILY_CAP,
  HEARTBEAT_KINDS,
  HEARTBEAT_THRESHOLD,
  UNANSWERED_DECAY_H,
  backoffHoursFor,
  decayUnanswered,
  heartbeatPrecondition,
  isQuietHour,
  localDateOf,
  localHourOfDay,
  scoreThought,
  silencePressure,
  utcHourOfDay,
  type HeartbeatCriteria,
  type HeartbeatPreState,
} from '../../src/life/policy.js';
import { drives } from './helpers.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const QUIET: readonly [number, number] = [23, 8];

/** An awake, uncapped, unbacked-off, uncontended state — the 'ok' baseline. */
const awake = (over: Partial<HeartbeatPreState> = {}): HeartbeatPreState => ({
  nowH: 14,
  quietHours: QUIET,
  owedInbound: 0,
  sentToday: 0,
  unanswered: 0,
  lastUnansweredAgeH: 0,
  mutexActive: false,
  ...over,
});

const criteria = (over: Partial<HeartbeatCriteria> = {}): HeartbeatCriteria => ({
  relevance: 3,
  information_gap: 3,
  expected_impact: 3,
  urgency: 3,
  coherence: 3,
  ...over,
});

// ---------------------------------------------------------------------------
// The constants are law (spec: ported verbatim, not tuning knobs)
// ---------------------------------------------------------------------------

describe('the spec-pinned constants', () => {
  it('threshold 3.2, cap 3, backoff base 3h, four kinds', () => {
    expect(HEARTBEAT_THRESHOLD).toBe(3.2);
    expect(HEARTBEAT_DAILY_CAP).toBe(3);
    expect(HEARTBEAT_BACKOFF_BASE_H).toBe(3);
    expect([...HEARTBEAT_KINDS]).toEqual(['followup', 'care', 'share', 'miss']);
  });
});

// ---------------------------------------------------------------------------
// Quiet hours — a [start, end) pair that wraps midnight
// ---------------------------------------------------------------------------

describe('isQuietHour', () => {
  it('a wrapping window [23, 8): boundary hours land outside the window when they end it', () => {
    expect(isQuietHour(22.999, QUIET)).toBe(false); // still awake
    expect(isQuietHour(23, QUIET)).toBe(true); // start is included
    expect(isQuietHour(23.5, QUIET)).toBe(true);
    expect(isQuietHour(0, QUIET)).toBe(true); // past midnight
    expect(isQuietHour(7 + 59 / 60, QUIET)).toBe(true); // 07:59 — one minute left
    expect(isQuietHour(8, QUIET)).toBe(false); // end is excluded
    expect(isQuietHour(12, QUIET)).toBe(false);
  });

  it('a same-day window [1, 7) behaves as a plain range', () => {
    expect(isQuietHour(0.999, [1, 7])).toBe(false);
    expect(isQuietHour(1, [1, 7])).toBe(true);
    expect(isQuietHour(6.999, [1, 7])).toBe(true);
    expect(isQuietHour(7, [1, 7])).toBe(false);
  });

  it('a degenerate window is no window at all', () => {
    expect(isQuietHour(5, [5, 5])).toBe(false);
    expect(isQuietHour(23, [23, 23])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// utcHourOfDay — pure arithmetic off epoch ms, never the host timezone
// ---------------------------------------------------------------------------

describe('utcHourOfDay', () => {
  const DAY = 86_400_000;

  it('reads the fractional UTC hour off epoch ms', () => {
    expect(utcHourOfDay(0)).toBe(0);
    expect(utcHourOfDay(14.5 * 3_600_000)).toBe(14.5);
    expect(utcHourOfDay(23.5 * 3_600_000)).toBe(23.5);
  });

  it('wraps whole days and survives a negative epoch', () => {
    expect(utcHourOfDay(3 * DAY + 14.5 * 3_600_000)).toBe(14.5);
    expect(utcHourOfDay(-3_600_000)).toBe(23);
  });
});

// ---------------------------------------------------------------------------
// Local time — the quiet-hours window and the daily cap are HIS wall clock
// (Europe/Madrid below: CEST = UTC+2 in July, CET = UTC+1 in January). Every
// epoch here is a fixed constant — the same values must read the same on any
// host, any ICU, any DST state of the machine running the suite.
// ---------------------------------------------------------------------------

describe('Madrid quiet hours: CEST and CET epochs', () => {
  const MADRID = 'Europe/Madrid';
  const QUIET_H = QUIET;

  it('reads 23:30 local in both DST epochs and blocks the fire in both', () => {
    // 2026-07-15T21:30Z — CEST (UTC+2): 23:30 Madrid, inside [23, 8).
    const JULY = 1_784_151_000_000;
    expect(localHourOfDay(JULY, MADRID)).toBeCloseTo(23.5, 9);
    // 2026-01-15T22:30Z — CET (UTC+1): 23:30 Madrid again, one UTC hour later.
    const JANUARY = 1_768_516_200_000;
    expect(localHourOfDay(JANUARY, MADRID)).toBeCloseTo(23.5, 9);

    for (const ms of [JULY, JANUARY]) {
      const verdict = heartbeatPrecondition(awake({ nowH: localHourOfDay(ms, MADRID), quietHours: QUIET_H }));
      expect(verdict).toEqual({ canText: false, reason: 'quiet hours' });
    }
  });

  it('the same UTC instant is a different local hour across the epochs (DST is real, not a table)', () => {
    // 21:30Z: 23:30 in July, 22:30 in January — the offset moved, the window did not.
    expect(localHourOfDay(1_784_151_000_000, MADRID)).toBeCloseTo(23.5, 9);
    expect(localHourOfDay(1_768_512_600_000, MADRID)).toBeCloseTo(22.5, 9); // 2026-01-15T21:30Z
  });
});

describe('wrapping window [23, 8) local', () => {
  const MADRID = 'Europe/Madrid';

  it('sweeps the wrap on real local instants: awake 22:30 → quiet 23:30/00:30/07:59 → awake 08:00', () => {
    const verdictAt = (ms: number) =>
      heartbeatPrecondition(awake({ nowH: localHourOfDay(ms, MADRID), quietHours: QUIET }));

    expect(verdictAt(1_784_147_400_000)).toEqual({ canText: true, reason: 'ok' }); // 22:30 CEST — still awake
    expect(verdictAt(1_784_151_000_000)).toEqual({ canText: false, reason: 'quiet hours' }); // 23:30
    expect(verdictAt(1_784_154_600_000)).toEqual({ canText: false, reason: 'quiet hours' }); // 00:30, past HIS midnight (Jul 16)
    expect(verdictAt(1_784_181_540_000)).toEqual({ canText: false, reason: 'quiet hours' }); // 07:59 — one minute left
    expect(verdictAt(1_784_181_600_000)).toEqual({ canText: true, reason: 'ok' }); // 08:00 — end excluded, locally
  });
});

describe('daily cap resets at local midnight', () => {
  const MADRID = 'Europe/Madrid';

  it('the census date flips at HIS midnight (00:00 local), not at UTC midnight', () => {
    // runHeartbeat resets sentToday when localDateOf(now) rolls — these two
    // epochs are the exact flip: 23:59:59 still yesterday, 00:00:00 tomorrow.
    expect(localDateOf(1_784_152_799_000, MADRID)).toBe('2026-07-15'); // 2026-07-15T21:59:59Z
    expect(localDateOf(1_784_152_800_000, MADRID)).toBe('2026-07-16'); // 2026-07-15T22:00:00Z = 00:00:00 local

    // UTC midnight is NOT his: 2026-07-16T00:00Z is 02:00 local — same census
    // day as the 00:30 local instant, so the cap does not reset at Greenwich.
    expect(localDateOf(1_784_160_000_000, MADRID)).toBe('2026-07-16');
    expect(localDateOf(1_784_154_600_000, MADRID)).toBe('2026-07-16');
  });
});

// ---------------------------------------------------------------------------
// The backoff ladder
// ---------------------------------------------------------------------------

describe('backoffHoursFor (the doubling no-reply ladder, capped)', () => {
  it('0/1/2/3 unanswered => 0h/6h/12h/24h (the spec ladder)', () => {
    expect(backoffHoursFor(0)).toBe(0);
    expect(backoffHoursFor(1)).toBe(6);
    expect(backoffHoursFor(2)).toBe(12);
    expect(backoffHoursFor(3)).toBe(24);
  });

  it('backoff never exceeds 48 h', () => {
    expect(HEARTBEAT_BACKOFF_CAP_H).toBe(48);
    expect(backoffHoursFor(4)).toBe(48); // 3·2⁴ is exactly the cap
    expect(backoffHoursFor(5)).toBe(48);
    expect(backoffHoursFor(10)).toBe(48);
    for (let n = 0; n <= 24; n += 1) {
      expect(backoffHoursFor(n), `unanswered ${n}`).toBeLessThanOrEqual(48);
    }
    expect(backoffHoursFor(0)).toBe(0); // no unanswered send => never a backoff
  });
});

describe('decayUnanswered (unanswered decays with time)', () => {
  it('one rung of backoff debt per 24 h of silence, floored at zero', () => {
    expect(UNANSWERED_DECAY_H).toBe(24);
    expect(decayUnanswered(3, 0)).toBe(3);
    expect(decayUnanswered(3, 23.9)).toBe(3); // just under the hour does not decay
    expect(decayUnanswered(3, 24)).toBe(2);
    expect(decayUnanswered(3, 48)).toBe(1);
    expect(decayUnanswered(3, 71.9)).toBe(1);
    expect(decayUnanswered(3, 72)).toBe(0);
    expect(decayUnanswered(1, 30)).toBe(0); // a lone debt dies inside one window
    expect(decayUnanswered(0, 500)).toBe(0); // nothing outstanding stays nothing
    expect(decayUnanswered(2, -5)).toBe(2); // negative silence (clock skew) decays nothing
  });
});

// ---------------------------------------------------------------------------
// The precondition table
// ---------------------------------------------------------------------------

describe('heartbeatPrecondition — the hard gates, checked in the spec order', () => {
  it("'ok' when every gate is clear", () => {
    expect(heartbeatPrecondition(awake())).toEqual({ canText: true, reason: 'ok' });
  });

  it('owed inbound outranks every other gate', () => {
    // Phase 1, 2026-09-02: a question of his with no answer beats quiet hours,
    // the cap, the backoff ladder and the mutex — the heartbeat may not text
    // about anything else while a LOST_REPLY of his stands, and 'owed' is THE
    // reason even when every other gate is also closed.
    expect(
      heartbeatPrecondition(
        awake({
          owedInbound: 1,
          nowH: 23.5, // deep in quiet hours…
          sentToday: 5, // …cap blown…
          unanswered: 3, // …maximum backoff debt…
          lastUnansweredAgeH: 0.5, // …far inside the 24h ladder…
          mutexActive: true, // …and a conversation in flight
        }),
      ),
    ).toEqual({ canText: false, reason: 'owed' });
    // And it outranks them severally, not just jointly.
    expect(heartbeatPrecondition(awake({ owedInbound: 2, mutexActive: true }))).toEqual({ canText: false, reason: 'owed' });
    expect(heartbeatPrecondition(awake({ owedInbound: 1, sentToday: 9 }))).toEqual({ canText: false, reason: 'owed' });
  });

  it('quiet hours win first, boundaries included/excluded exactly', () => {
    expect(heartbeatPrecondition(awake({ nowH: 23 }))).toEqual({ canText: false, reason: 'quiet hours' });
    expect(heartbeatPrecondition(awake({ nowH: 3 }))).toEqual({ canText: false, reason: 'quiet hours' });
    expect(heartbeatPrecondition(awake({ nowH: 7 + 59 / 60 }))).toEqual({ canText: false, reason: 'quiet hours' });
    // Even with everything else already blocked, the quiet-hours verdict is THE verdict.
    expect(heartbeatPrecondition(awake({ nowH: 23.5, sentToday: 4, mutexActive: true }))).toEqual({
      canText: false,
      reason: 'quiet hours',
    });
    // 08:00 exactly is awake, whatever else is wrong.
    expect(heartbeatPrecondition(awake({ nowH: 8, sentToday: 4 }))).toEqual({ canText: false, reason: 'cap' });
  });

  it('the daily cap: sentToday 3 and 4 block, 2 does not', () => {
    expect(heartbeatPrecondition(awake({ sentToday: 3 }))).toEqual({ canText: false, reason: 'cap' });
    expect(heartbeatPrecondition(awake({ sentToday: 4 }))).toEqual({ canText: false, reason: 'cap' });
    expect(heartbeatPrecondition(awake({ sentToday: 2 }))).toEqual({ canText: true, reason: 'ok' });
  });

  it('the backoff ladder against the age of the newest unanswered send', () => {
    expect(heartbeatPrecondition(awake({ unanswered: 1, lastUnansweredAgeH: 5.9 }))).toEqual({
      canText: false,
      reason: 'backoff',
    });
    expect(heartbeatPrecondition(awake({ unanswered: 1, lastUnansweredAgeH: 6 }))).toEqual({
      canText: true,
      reason: 'ok',
    });
    expect(heartbeatPrecondition(awake({ unanswered: 2, lastUnansweredAgeH: 11.9 }))).toEqual({
      canText: false,
      reason: 'backoff',
    });
    expect(heartbeatPrecondition(awake({ unanswered: 2, lastUnansweredAgeH: 12 }))).toEqual({
      canText: true,
      reason: 'ok',
    });
    expect(heartbeatPrecondition(awake({ unanswered: 3, lastUnansweredAgeH: 23.9 }))).toEqual({
      canText: false,
      reason: 'backoff',
    });
    expect(heartbeatPrecondition(awake({ unanswered: 3, lastUnansweredAgeH: 24 }))).toEqual({
      canText: true,
      reason: 'ok',
    });
  });

  it('an expired backoff never blocks, and zero unanswered never triggers one', () => {
    expect(heartbeatPrecondition(awake({ unanswered: 2, lastUnansweredAgeH: 40 }))).toEqual({
      canText: true,
      reason: 'ok',
    });
    expect(heartbeatPrecondition(awake({ unanswered: 0, lastUnansweredAgeH: 0 }))).toEqual({
      canText: true,
      reason: 'ok',
    });
  });

  it('the conversation-active mutex blocks last of the gates', () => {
    expect(heartbeatPrecondition(awake({ mutexActive: true }))).toEqual({ canText: false, reason: 'mutex' });
    // A pending backoff outranks the mutex: the earlier gate's reason is THE reason.
    expect(heartbeatPrecondition(awake({ mutexActive: true, unanswered: 1, lastUnansweredAgeH: 1 }))).toEqual({
      canText: false,
      reason: 'backoff',
    });
    // And the mutex is checked after the cap.
    expect(heartbeatPrecondition(awake({ mutexActive: true, sentToday: 3 }))).toEqual({
      canText: false,
      reason: 'cap',
    });
  });
});

// ---------------------------------------------------------------------------
// Properties: the cap is absolute; the verdict is a pure function of its input
// ---------------------------------------------------------------------------

describe('policy properties', () => {
  it('never texts on the 4th send of a day, whatever the backoff/mutex state says', () => {
    for (const unanswered of [0, 1, 2, 3, 5]) {
      for (const lastUnansweredAgeH of [0, 3, 6, 24, 100]) {
        for (const mutexActive of [false, true]) {
          const v = heartbeatPrecondition(awake({ sentToday: 3, unanswered, lastUnansweredAgeH, mutexActive }));
          expect(v).toEqual({ canText: false, reason: 'cap' });
        }
      }
    }
  });

  it('is deterministic and does not mutate its input', () => {
    const s = awake({ unanswered: 1, lastUnansweredAgeH: 1, mutexActive: true });
    const a = heartbeatPrecondition(s);
    const b = heartbeatPrecondition(s);
    expect(a).toEqual(b);
    expect(s).toEqual(awake({ unanswered: 1, lastUnansweredAgeH: 1, mutexActive: true }));
  });
});

// ---------------------------------------------------------------------------
// Silence pressure — clamp(silenceH/36, 0, .8) + 0.4 * drives.connection
// ---------------------------------------------------------------------------

describe('silencePressure', () => {
  it('climbs linearly to the 0.8 ceiling at 28.8h and stays there', () => {
    expect(silencePressure(0, drives())).toBe(0);
    expect(silencePressure(7.2, drives())).toBeCloseTo(0.2, 12);
    expect(silencePressure(18, drives())).toBeCloseTo(0.5, 12);
    expect(silencePressure(28.8, drives())).toBeCloseTo(0.8, 12);
    expect(silencePressure(36, drives())).toBe(0.8); // clamp(1.0) -> 0.8
    expect(silencePressure(1000, drives())).toBe(0.8);
    expect(silencePressure(-5, drives())).toBe(0); // never negative
  });

  it('carries the drives.connection term at exactly 0.4 per unit', () => {
    expect(silencePressure(18, drives({ connection: 0.25 }))).toBeCloseTo(0.5 + 0.1, 12);
    expect(silencePressure(18, drives({ connection: 1 }))).toBeCloseTo(0.9, 12);
    expect(silencePressure(18, drives({ connection: 1 })) - silencePressure(18, drives())).toBeCloseTo(0.4, 12);
    // The other drives are not in the formula.
    expect(silencePressure(18, drives({ novelty: 1, mastery: 1 }))).toBeCloseTo(0.5, 12);
  });
});

// ---------------------------------------------------------------------------
// scoreThought — mean + pressure, 2dp, compared against 3.2 with >=
// ---------------------------------------------------------------------------

describe('scoreThought', () => {
  it('golden cases: exact mean + pressure', () => {
    expect(scoreThought(criteria(), 0)).toBe(3);
    expect(scoreThought(criteria({ relevance: 4, information_gap: 4, expected_impact: 4, urgency: 4, coherence: 4 }), 0)).toBe(4);
    expect(scoreThought(criteria({ relevance: 1, information_gap: 2, expected_impact: 3, urgency: 4, coherence: 5 }), 0)).toBe(3);
    // 2dp rounding on the way out (heartbeat.mjs's `+(mean + pressure).toFixed(2)` port).
    expect(
      scoreThought(criteria({ relevance: 4.4, information_gap: 3.7, expected_impact: 5, urgency: 2.2, coherence: 3.9 }), 0.33),
    ).toBe(4.17);
  });

  it('the 3.2 boundary: 3.2 exactly passes, 3.15 does not', () => {
    // mean 3 + pressure 0.2 == 3.2 -> the score AT the threshold speaks.
    expect(scoreThought(criteria(), 0.2)).toBe(3.2);
    expect(scoreThought(criteria(), 0.2) >= HEARTBEAT_THRESHOLD).toBe(true);
    // mean 3 + pressure 0.15 == 3.15 -> just under, silence wins.
    expect(scoreThought(criteria(), 0.15)).toBe(3.15);
    expect(scoreThought(criteria(), 0.15) >= HEARTBEAT_THRESHOLD).toBe(false);
    // A criteria-only 3.2 lands exactly on the line too.
    expect(scoreThought(criteria({ coherence: 4 }), 0)).toBe(3.2);
    expect(scoreThought(criteria({ coherence: 4 }), 0) >= HEARTBEAT_THRESHOLD).toBe(true);
  });

  it('pressure enters additively: the same criteria always differ by exactly the pressure gap', () => {
    const low = scoreThought(criteria(), 0.1);
    const high = scoreThought(criteria(), 0.7);
    expect(+(high - low).toFixed(2)).toBe(0.6);
  });

  it('is deterministic', () => {
    const c = criteria({ relevance: 4.4, information_gap: 3.7, expected_impact: 5, urgency: 2.2, coherence: 3.9 });
    expect(scoreThought(c, 0.33)).toBe(scoreThought(c, 0.33));
  });
});

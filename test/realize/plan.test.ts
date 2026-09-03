// planDelivery — the S4 realizer gate, planning half: the exact spec constants,
// the monotonicity properties, the 12 s cap, determinism per seed, and the
// verbatim invariant. Cadence here is caused by (reluctance, arousal, valence,
// bubble lengths) and NOTHING else — every property below is written so a
// restyle or a re-timing would have to break it to pass. Constants are v6
// CA.1 (SNAPPY AND TRUE): bubble 1 leaves at the lock instant, and the whole
// delivery lands inside 12 s.

import { describe, expect, it } from 'vitest';
import { makeRng } from '../../src/kernel/index.js';
import { TELEGRAM_LIMITS, type ChannelLimits } from '../../src/bridge/index.js';
import {
  MAX_BUBBLES,
  TOTAL_CAP_MS,
  planDelivery,
  shapeBubbles,
  typingCps,
  type DeliveryPlan,
} from '../../src/realize/index.js';
import { decision, firstSendOffset, fixedRng, sendsOf, squash, timedSteps, vec } from './helpers.js';

const SYNTHETIC: ChannelLimits = { maxMsgChars: 60, minSendGapMs: 200, typingRefreshMs: 400 };

const typingMsOf = (p: DeliveryPlan): number =>
  timedSteps(p).find((s) => s.kind === 'typing')?.ms ?? -1;

const gapMsOf = (p: DeliveryPlan): number =>
  timedSteps(p).filter((s) => s.kind === 'pause')[1]?.ms ?? -1;

describe('planDelivery — the spec constants are exact (v6 CA.1)', () => {
  it('AC: pre-delay is 0 below the reluctance gate (0.5) and 1500·reluctance from the gate up', () => {
    for (const [r, want] of [
      [0, 0],
      [0.25, 0],
      [0.49, 0],
      [0.5, 750],
      [0.75, 1125],
      [1, 1500],
    ] as const) {
      const p = planDelivery(decision({ reluctance: r, bubbles: ['hola'] }), vec(), TELEGRAM_LIMITS, makeRng('pre-delay'));
      expect(p.steps[0], `reluctance ${r}`).toEqual({ kind: 'pause', ms: want });
    }
  });

  it('first bubble sends within 200 ms of lock when not reluctant', () => {
    // The pause before typing is zero on the whole low-reluctance side, so even
    // the slowest typing rail puts a short first bubble on the wire under 200 ms.
    for (const arousal of [-1, 0, 1]) {
      const p = planDelivery(decision({ reluctance: 0, bubbles: ['hola'] }), vec({ arousal }), TELEGRAM_LIMITS, makeRng('first-bubble'));
      expect(timedSteps(p)[0]).toEqual({ kind: 'pause', ms: 0 }); // no pre-delay: the plan starts at the lock
      expect(firstSendOffset(p), `arousal ${arousal}`).toBeLessThanOrEqual(200);
    }
    // The gate is sharp: 0.49 is still immediate, 0.5 carries the delay.
    const justUnder = planDelivery(decision({ reluctance: 0.49, bubbles: ['hola'] }), vec(), TELEGRAM_LIMITS, makeRng('gate'));
    const atGate = planDelivery(decision({ reluctance: 0.5, bubbles: ['hola'] }), vec(), TELEGRAM_LIMITS, makeRng('gate'));
    expect(firstSendOffset(justUnder)).toBeLessThanOrEqual(200);
    expect(firstSendOffset(atGate)).toBeGreaterThan(200);
  });

  it('AC: typing duration = chars / cps with cps = lerp(25→45) over the arousal deviation', () => {
    // 12-char bubble → 1000·12/cps: arousal −1 ⇒ cps 25 ⇒ 480 ms, 0 ⇒ cps 35 ⇒ 343, +1 ⇒ cps 45 ⇒ 267.
    const typingAt = (arousal: number): number =>
      typingMsOf(planDelivery(decision({ bubbles: ['hola que tal'] }), vec({ arousal }), TELEGRAM_LIMITS, makeRng('cps')));
    expect(typingAt(-1)).toBe(480);
    expect(typingAt(0)).toBe(343);
    expect(typingAt(1)).toBe(267);
  });

  it('AC: low valence (a[valence] < 0) slows cps by 15%', () => {
    // 4 chars at valence 0 → cps 35 → 114 ms; at any negative valence → cps 29.75 → 134.45 → 134.
    const typingAt = (valence: number): number =>
      typingMsOf(planDelivery(decision({ bubbles: ['hola'] }), vec({ valence }), TELEGRAM_LIMITS, makeRng('valence')));
    expect(typingAt(0)).toBe(114);
    expect(typingAt(0.5)).toBe(114); // positive valence changes nothing
    expect(typingAt(-0.5)).toBe(134);
    expect(typingAt(-1)).toBe(134); // one flat −15%, not a second lerp
  });

  it('AC: inter-bubble gap is 400–1500 ms, shrinking with arousal (jitter drawn at its neutral 0)', () => {
    const gapAt = (arousal: number): number =>
      gapMsOf(planDelivery(decision({ bubbles: ['uno', 'dos'] }), vec({ arousal }), TELEGRAM_LIMITS, fixedRng(0.5)));
    expect(gapAt(-1)).toBe(1500);
    expect(gapAt(0)).toBe(950);
    expect(gapAt(1)).toBe(400);
  });

  it('arousal still shortens gaps', () => {
    // Strictly, across the whole span, with the same seed at every grid point so
    // the comparison tests the law and not luck in the jitter.
    const gapSumAt = (arousal: number): number =>
      timedSteps(planDelivery(decision({ bubbles: ['una', 'dos', 'tres'] }), vec({ arousal }), TELEGRAM_LIMITS, makeRng('arousal-gaps')))
        .filter((s) => s.kind === 'pause')
        .slice(1) // the pre-delay is not a gap
        .reduce((acc, s) => acc + s.ms, 0);
    let prev = gapSumAt(-1);
    for (let k = 1; k <= 10; k++) {
      const arousal = -1 + k * 0.2;
      const next = gapSumAt(arousal);
      expect(next, `gap sum at arousal ${arousal.toFixed(1)}`).toBeLessThanOrEqual(prev);
      prev = next;
    }
    expect(gapSumAt(-1)).toBeGreaterThan(gapSumAt(1)); // the calm rail is strictly the slowest
  });

  it('AC: silence and deferral ignore the affect state entirely', () => {
    for (const plan of ['silent', 'defer'] as const) {
      const p = planDelivery(decision({ plan, bubbles: ['¡espera!'], reluctance: 1 }), vec({ arousal: 1 }), TELEGRAM_LIMITS, makeRng('silent'));
      expect(p).toEqual({ steps: [], totalMs: 0 });
    }
  });
});

describe('planDelivery — monotonicity (the S4 property gate)', () => {
  const bubbles3 = ['primera palabra', 'segunda palabra', 'tercera palabra'];

  it('AC: below the reluctance gate the plan is identical; above it the pre-delay strictly increases and the total never shortens', () => {
    const rng = makeRng('realize/monotone-reluctance');
    for (let trial = 0; trial < 40; trial++) {
      const a = vec({ valence: rng.float() * 2 - 1, arousal: rng.float() * 2 - 1 });
      // Same seed at every grid point ⇒ identical jitter draws ⇒ the
      // comparison tests the law, not luck in the jitter.
      const at = (r: number): DeliveryPlan =>
        planDelivery(decision({ reluctance: r, bubbles: bubbles3 }), a, TELEGRAM_LIMITS, makeRng('reluctance-grid'));
      // Under the gate every reluctance plans the exact same timeline.
      const under = at(0.4);
      expect(firstSendOffset(under)).toBe(firstSendOffset(at(0)));
      expect(under.totalMs).toBe(at(0).totalMs);
      // From the gate up, the pre-delay (and with it the first send) strictly grows.
      let prevFirst = firstSendOffset(under);
      let prevTotal = under.totalMs;
      for (let k = 5; k <= 10; k++) {
        const r = k / 10;
        const p = at(r);
        const first = firstSendOffset(p);
        expect(first, `first-send offset at reluctance ${r.toFixed(2)}`).toBeGreaterThan(prevFirst);
        expect(p.totalMs, `total at reluctance ${r.toFixed(2)}`).toBeGreaterThanOrEqual(prevTotal);
        prevFirst = first;
        prevTotal = p.totalMs;
      }
    }
  });

  it('AC: higher arousal never lengthens the plan, and strictly tightens it across the span', () => {
    const rng = makeRng('realize/arousal-shortens');
    for (let trial = 0; trial < 40; trial++) {
      const valence = rng.float() * 2 - 1;
      const planAt = (arousal: number): DeliveryPlan =>
        planDelivery(decision({ bubbles: bubbles3 }), vec({ valence, arousal }), TELEGRAM_LIMITS, makeRng('arousal-grid'));

      let prevTotal = Number.POSITIVE_INFINITY;
      for (let k = 0; k <= 10; k++) {
        const arousal = -1 + k * 0.2;
        // Same seed ⇒ identical jitter draws; the cps lerp and the gap curve
        // both shrink in arousal, so ms rounding preserves the order.
        const total = planAt(arousal).totalMs;
        expect(total, `total at arousal ${arousal.toFixed(1)}`).toBeLessThanOrEqual(prevTotal);
        prevTotal = total;
      }
      // Strictly: the calm-rail plan is slower than the excited-rail plan.
      expect(planAt(-1).totalMs).toBeGreaterThan(planAt(1).totalMs);
    }
  });

  it('the tightening lands on the pauses, not the text: sends are arousal-invariant', () => {
    for (let k = 0; k <= 10; k++) {
      const p = planDelivery(decision({ bubbles: bubbles3 }), vec({ arousal: -1 + k * 0.2 }), TELEGRAM_LIMITS, makeRng('arousal-sends'));
      expect(sendsOf(p)).toEqual(bubbles3);
    }
  });
});

describe('planDelivery — pacing comes from the decision, not from the text alone (v6 CA.3)', () => {
  it('pacing is computed from the decision not from text length alone', () => {
    const bubbles = ['primer mensaje', 'segundo mensaje'];
    // Same text, different affect ⇒ the gaps move: pacing is not a hash of the
    // text. fixedRng(0.5) holds the jitter draw at its neutral 0 so the exact
    // envelope values show.
    const gapAt = (arousal: number): number =>
      gapMsOf(planDelivery(decision({ bubbles }), vec({ arousal }), TELEGRAM_LIMITS, fixedRng(0.5)));
    expect(gapAt(-1)).toBe(1500);
    expect(gapAt(1)).toBe(400);
    // Same text, different reluctance ⇒ the first bubble's timing moves.
    const firstAt = (r: number): number =>
      firstSendOffset(planDelivery(decision({ reluctance: r, bubbles }), vec(), TELEGRAM_LIMITS, makeRng('pacing-r')));
    expect(firstAt(0.9)).toBeGreaterThan(firstAt(0.4));
    // Same decision + affect, different text ⇒ typing moves: length is one
    // input among many, never the whole law.
    const typingOf = (text: string): number =>
      typingMsOf(planDelivery(decision({ bubbles: [text] }), vec(), TELEGRAM_LIMITS, makeRng('pacing-t')));
    expect(typingOf('x')).toBe(29);
    expect(typingOf('x'.repeat(30))).toBe(857);
  });
});

describe('planDelivery — caps hold (the S4 property gate)', () => {
  it('AC: extreme inputs clamp; the timeline never explodes past 12 s', () => {
    const huge = ['x'.repeat(4000), 'y'.repeat(4000), 'z'.repeat(4000), 'w'.repeat(4000), 'v'.repeat(4000)];
    const p = planDelivery(
      decision({ reluctance: 42, bubbles: huge }), // out of range → clamps to 1 (≥ gate ⇒ the 1500·reluctance rail)
      vec({ arousal: -17, valence: -9 }), // out of range → clamps to the rails
      TELEGRAM_LIMITS,
      makeRng('caps-extreme'),
    );
    expect(p.totalMs).toBeLessThanOrEqual(TOTAL_CAP_MS);
    expect(p.totalMs).toBe(timedSteps(p).reduce((acc, s) => acc + s.ms, 0)); // reported total IS the step sum
    expect(sendsOf(p)).toEqual(huge); // sends are never dropped
    for (const s of timedSteps(p)) expect(Number.isFinite(s.ms) && s.ms >= 0).toBe(true);
  });

  it('AC: past the cap every pause/typing scales down by ONE shared factor (± rounding + trim)', () => {
    const bubbles = ['a'.repeat(3000)]; // single bubble ⇒ no gaps: the raw steps are exactly computable
    // The raw timeline, from the spec constants themselves: reluctance 1 (at the
    // gate) ⇒ pre-delay 1500; arousal −1 + valence < 0 ⇒ cps 21.25 ⇒ typing per bubble.
    const cps = typingCps(-1, -1);
    const typing = Math.round((3000 / cps) * 1000);
    const rawSteps = [1500, typing];
    const rawTotal = rawSteps.reduce((a, b) => a + b, 0);
    expect(rawTotal).toBeGreaterThan(TOTAL_CAP_MS); // the fixture really is past the cap

    const squeezed = planDelivery(decision({ reluctance: 1, bubbles }), vec({ arousal: -1, valence: -1 }), TELEGRAM_LIMITS, makeRng('compression'));
    expect(squeezed.totalMs).toBeLessThanOrEqual(TOTAL_CAP_MS);

    const squeezedTimed = timedSteps(squeezed);
    expect(squeezedTimed.map((s) => s.kind)).toEqual(['pause', 'typing']);
    const scale = TOTAL_CAP_MS / rawTotal;
    for (let i = 0; i < rawSteps.length; i++) {
      const r = rawSteps[i]!;
      const c = squeezedTimed[i]!.ms;
      // One shared factor, then floor + (at most one ms of shave per step) to
      // keep the sum under the cap — each step stays within a couple of ms of
      // its exact share, and strictly below its raw duration.
      expect(Math.abs(c - r * scale), `step ${i} (${squeezedTimed[i]!.kind})`).toBeLessThanOrEqual(rawSteps.length);
      expect(c).toBeLessThan(r);
    }
    expect(sendsOf(squeezed)).toEqual(bubbles);
  });

  it('realizer total under 12 s for six bubbles', () => {
    const six = Array.from({ length: 6 }, () => 'x'.repeat(25)); // shaping merges six → five (one '\n' join)
    // A lively state stays under the cap uncompressed: typing 1133 + 4·556 and
    // the excited rail parks every gap at GAP_MIN 400 ⇒ 4957.
    const lively = planDelivery(decision({ bubbles: six }), vec({ arousal: 1 }), TELEGRAM_LIMITS, fixedRng(0.5));
    expect(lively.totalMs).toBe(4957);
    // The dead-slow rail (reluctant, cold arousal, low valence, max jitter) is
    // far past it raw — the cap holds the line and drops no send.
    const slow = planDelivery(
      decision({ reluctance: 1, bubbles: six }),
      vec({ arousal: -1, valence: -1 }),
      TELEGRAM_LIMITS,
      fixedRng(1), // jitter +1 ⇒ every gap clamps to GAP_MAX_MS
    );
    expect(slow.totalMs).toBeLessThanOrEqual(TOTAL_CAP_MS);
    expect(sendsOf(slow)).toEqual(sendsOf(lively)); // compression never drops or reorders sends
  });

  it('a fast plan passes through untouched — the cap compresses, it never stretches to fill 12 s', () => {
    const p = planDelivery(decision({ bubbles: ['hola'] }), vec(), TELEGRAM_LIMITS, makeRng('no-stretch'));
    expect(p).toEqual({
      steps: [
        { kind: 'pause', ms: 0 },
        { kind: 'typing', ms: 114 },
        { kind: 'send', text: 'hola' },
      ],
      totalMs: 114,
    });
  });
});

describe('planDelivery — silent / defer and determinism', () => {
  it('AC: silent and defer produce empty plans', () => {
    for (const plan of ['silent', 'defer'] as const) {
      expect(planDelivery(decision({ plan, bubbles: ['hola'] }), vec(), TELEGRAM_LIMITS, makeRng('silent'))).toEqual({
        steps: [],
        totalMs: 0,
      });
    }
  });

  it('a reply with no bubbles is an empty plan too — nothing to send, nothing to time', () => {
    expect(planDelivery(decision({ bubbles: [] }), vec(), TELEGRAM_LIMITS, makeRng('empty'))).toEqual({ steps: [], totalMs: 0 });
  });

  it('AC: deterministic per seed — same (decision, affect, limits, seed) ⇒ byte-identical plan', () => {
    const d = decision({ bubbles: ['una', 'dos', 'tres'], reluctance: 0.4 });
    const a = vec({ arousal: 0.3, valence: -0.2 });
    expect(planDelivery(d, a, TELEGRAM_LIMITS, makeRng('realize/seed-probe'))).toEqual(
      planDelivery(d, a, TELEGRAM_LIMITS, makeRng('realize/seed-probe')),
    );
  });

  it('different seeds jitter the gaps but never the structure or the text', () => {
    const d = decision({ bubbles: ['una', 'dos', 'tres', 'cuatro'] });
    const a = vec({ arousal: 0.25 });
    const p1 = planDelivery(d, a, TELEGRAM_LIMITS, makeRng('seed-a'));
    const p2 = planDelivery(d, a, TELEGRAM_LIMITS, makeRng('seed-b'));
    expect(p2.steps.map((s) => s.kind)).toEqual(p1.steps.map((s) => s.kind));
    expect(sendsOf(p2)).toEqual(sendsOf(p1));
    const gaps = (p: DeliveryPlan): number[] => timedSteps(p).filter((s) => s.kind === 'pause').slice(1).map((s) => s.ms);
    expect(gaps(p2)).not.toEqual(gaps(p1)); // the jitter stream is real, not decorative
    for (const g of [...gaps(p1), ...gaps(p2)]) {
      expect(g).toBeGreaterThanOrEqual(400);
      expect(g).toBeLessThanOrEqual(1500);
    }
  });

  it('a wrong-length affect vector is a loud bug, not a silent NaN timeline', () => {
    const short = new Float64Array(11);
    expect(() => planDelivery(decision(), short, TELEGRAM_LIMITS, makeRng('vec'))).toThrowError(/Vec12/);
  });
});

describe('planDelivery — the verbatim invariant (zero character-level rewrites)', () => {
  const PHRASES = [
    'estaba pensando en lo que dijiste',
    'no sé por qué me acordé de eso',
    'va a llover toda la semana',
    'el café de hoy salió amargo',
    'cuando era chica hacía lo mismo',
  ];

  it('AC: concatenated sends ≡ concatenated bubbles, modulo merge joins and boundary splits', () => {
    const rng = makeRng('realize/verbatim');
    for (let trial = 0; trial < 300; trial++) {
      const bubbles = Array.from({ length: rng.int(1, 9) }, () =>
        Array.from({ length: rng.int(1, 6) }, () => `${rng.pick(PHRASES)}${rng.pick(['.', '!', '?', '…'])}`).join(' '),
      );
      const limits = rng.int(0, 1) === 0 ? TELEGRAM_LIMITS : SYNTHETIC;
      const a = vec({ arousal: rng.float() * 2 - 1, valence: rng.float() * 2 - 1 });
      const sent = sendsOf(planDelivery(decision({ bubbles }), a, limits, makeRng(`verbatim/${trial}`)));

      // The only legal wiggle is whitespace at merge/split boundaries, so the
      // squashed concatenations must be identical — no word gained, lost, or
      // respelled anywhere in 300 random plans.
      expect(squash(sent.join(' ')), `trial ${trial}`).toEqual(squash(bubbles.join(' ')));
      for (const s of sent) expect(s.length).toBeLessThanOrEqual(limits.maxMsgChars);
      // When the count cap loses to the char cap, no join could have fit either.
      if (sent.length > MAX_BUBBLES) {
        for (let i = 0; i + 1 < sent.length; i++) {
          expect(`${sent[i] ?? ''}\n${sent[i + 1] ?? ''}`.length, `trial ${trial} join ${i}`).toBeGreaterThan(limits.maxMsgChars);
        }
      }
    }
  });

  it('a plan that needs no shaping sends the decision bubbles byte-identically', () => {
    const bubbles = ['hola que tal', '¿cómo amaneciste?'];
    const p = planDelivery(decision({ bubbles }), vec(), TELEGRAM_LIMITS, makeRng('verbatim-exact'));
    expect(sendsOf(p)).toEqual(bubbles);
    expect(shapeBubbles(bubbles, TELEGRAM_LIMITS.maxMsgChars, MAX_BUBBLES)).toEqual(bubbles);
  });
});

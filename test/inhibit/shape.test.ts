// checkBubbleShape — the P-CADENCE CA.4 bubble-shape gate rule (class 'shape',
// soft): one thought per bubble — short enough for one glance, few enough to
// stay a ripple, no newline-squashed paragraphs, and no run of the same
// sign-off emoji. Every violation gets the ONE neutral reason ("split shorter")
// so the rephrase pass is told what to do, not argued with. Imported deep from
// compile.js on purpose: the rule is additive to the compiled gate (a clearly
// delimited section at the end of src/inhibit/compile.ts) that the loop
// composes beside `checkPlan`; its canon yaml entry merges at landing.

import { describe, expect, it } from 'vitest';
import {
  SHAPE_MAX_BUBBLE_CHARS,
  SHAPE_MAX_BUBBLES,
  SHAPE_MIN_SAME_EMOJI,
  SHAPE_RULE,
  SHAPE_RULE_ID,
  checkBubbleShape,
} from '../../src/inhibit/compile.js';

describe('checkBubbleShape — the bubble-shape gate rule (class shape, soft)', () => {
  it('a 300-char bubble is rejected-and-rephrased', () => {
    const v = checkBubbleShape({ bubbles: ['x'.repeat(300)] });
    expect(v).toEqual({
      allow: false,
      code: 'forbidden-pattern',
      ruleId: SHAPE_RULE_ID,
      // The neutral reason the loop re-injects — the rephrase is the loop's
      // re-entry ladder (soft: fail open after MAX_GATE_REENTRIES).
      hint: '[INHIBITION:bubble-shape] split shorter',
    });
    // Exactly at the cap is still one glance — only over it rejects.
    expect(checkBubbleShape({ bubbles: ['x'.repeat(SHAPE_MAX_BUBBLE_CHARS)] }).allow).toBe(true);
    expect(checkBubbleShape({ bubbles: ['x'.repeat(SHAPE_MAX_BUBBLE_CHARS + 1)] }).allow).toBe(false);
    // Soft: the rule announces rephrase-not-silence.
    expect(SHAPE_RULE.severity).toBe('soft');
    expect(SHAPE_RULE.ruleClass).toBe('plan');
  });

  it('a five-bubble reply with weight 0.8 passes', () => {
    const five = ['uno', 'dos', 'tres', 'cuatro', 'cinco'];
    expect(checkBubbleShape({ bubbles: five, weight: 0.8 }).allow).toBe(true);
    // The weight gate exists only past five: six heavy bubbles may pass, six
    // light ones may not, and absent weight counts as light.
    const six = [...five, 'seis'];
    expect(checkBubbleShape({ bubbles: six, weight: 0.8 }).allow).toBe(true);
    expect(checkBubbleShape({ bubbles: six, weight: 0.5 }).allow).toBe(false);
    expect(checkBubbleShape({ bubbles: six }).allow).toBe(false);
    // Five is never a crowd, whatever the weight.
    expect(checkBubbleShape({ bubbles: five, weight: 0.1 }).allow).toBe(true);
    expect(SHAPE_MAX_BUBBLES).toBe(5);
  });

  it('emoji sign-off kit is rejected', () => {
    expect(checkBubbleShape({ bubbles: ['va a llover 😊', 'te lo dejo 😊', 'hablamos 😊'] }).allow).toBe(false);
    // Two is a tic; three is a kit.
    expect(checkBubbleShape({ bubbles: ['va 😊', 'va 😊'] }).allow).toBe(true);
    expect(SHAPE_MIN_SAME_EMOJI).toBe(3);
    // Different emoji do not band together.
    expect(checkBubbleShape({ bubbles: ['va 😊', 'va 😂', 'va 🙂'] }).allow).toBe(true);
    // A run split across tails does not count: only tails are sign-offs.
    expect(checkBubbleShape({ bubbles: ['😊 va', '😊 va', '😊 va'] }).allow).toBe(true);
    // ASCII keycap bases (#, *, 0-9) are pictographic in Unicode's tables but
    // are not sign-offs.
    expect(checkBubbleShape({ bubbles: ['le toca 5', 'va por 5', 'van 5'] }).allow).toBe(true);
  });

  it('a newline inside a bubble is rejected — a paragraph is a bubble, not a smuggled second one', () => {
    expect(checkBubbleShape({ bubbles: ['primera línea\nsegunda línea'] }).allow).toBe(false);
    expect(checkBubbleShape({ bubbles: ['sin líneas raras', 'tampoco aquí'] }).allow).toBe(true);
  });

  it('a clean short reply passes with everything at once', () => {
    expect(
      checkBubbleShape({ bubbles: ['sí', 'pero cuéntame más', 'luego lo hablamos'], weight: 0.4 }).allow,
    ).toBe(true);
  });
});

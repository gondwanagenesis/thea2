// shapeBubbles — the only text surgery the realizer is allowed to perform, held
// to exactly that: paragraph/sentence splits at the char cap, newline joins at
// the count cap, and nothing else. Every case here is a boundary the spec draws.

import { describe, expect, it } from 'vitest';
import { TELEGRAM_LIMITS } from '../../src/bridge/index.js';
import { MAX_BUBBLES, shapeBubbles } from '../../src/realize/index.js';
import { squash } from './helpers.js';

const SHAPE = (bubbles: readonly string[], maxChars = TELEGRAM_LIMITS.maxMsgChars): string[] =>
  shapeBubbles(bubbles, maxChars, MAX_BUBBLES);

describe('shapeBubbles — merging at the count cap', () => {
  it('AC: more than 5 bubbles merge adjacent ones with newline joins until 5 remain', () => {
    const bubbles = ['uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete'];
    const out = SHAPE(bubbles);
    // The join is literally '\n' between original bubbles, in order, left-packed.
    expect(out).toEqual(['uno\ndos\ntres', 'cuatro', 'cinco', 'seis', 'siete']);
    expect(squash(out.join(' '))).toEqual(squash(bubbles.join(' ')));
  });

  it('AC: 5 bubbles or fewer come back byte-identically', () => {
    const bubbles = ['uno', 'dos', 'tres', 'cuatro', 'cinco'];
    expect(SHAPE(bubbles)).toEqual(bubbles);
    expect(SHAPE(['solo una'])).toEqual(['solo una']);
  });

  it('merging chains and skips: a join that would not fit is skipped, never forced', () => {
    // 7 pieces of 45 chars under a 100-char limit: the first join fits (91),
    // the chained one does not (137), the next pair does — landing on 5 pieces.
    const chunk = 'a'.repeat(45);
    const bubbles = [chunk, chunk, chunk, chunk, chunk, chunk, chunk];
    expect(SHAPE(bubbles, 100)).toEqual([`${chunk}\n${chunk}`, `${chunk}\n${chunk}`, chunk, chunk, chunk]);
  });

  it('AC: the char cap outranks the count cap — a join that would breach it is skipped', () => {
    // 6 pieces of 40 chars under a 60-char limit: every join is 81 chars, so nothing may merge.
    const chunk = 'a'.repeat(40);
    const bubbles = [chunk, chunk, chunk, chunk, chunk, chunk];
    expect(SHAPE(bubbles, 60)).toEqual(bubbles);
  });
});

describe('shapeBubbles — splitting at the char cap', () => {
  const para = (ch: string): string => `${ch}${'x'.repeat(2999)}`; // 3000 chars

  it('AC: an oversized bubble splits on paragraph boundaries first', () => {
    const bubble = `${para('a')}\n\n${para('b')}\n\n${para('c')}`;
    const out = SHAPE([bubble]);
    expect(out).toEqual([para('a'), para('b'), para('c')]); // cut AT the boundary, terminator-side
    for (const piece of out) expect(piece.length).toBeLessThanOrEqual(TELEGRAM_LIMITS.maxMsgChars);
  });

  it('AC: with no paragraph break it falls to sentence boundaries, keeping the terminator', () => {
    const sentence = 'no sé por qué me acordé de eso hoy'; // 34 chars
    const bubble = `${sentence}. `.repeat(130).trim(); // 4679 chars, single paragraph
    const out = SHAPE([bubble]);
    expect(out.length).toBeGreaterThan(1);
    for (const piece of out) {
      expect(piece.length).toBeLessThanOrEqual(TELEGRAM_LIMITS.maxMsgChars);
      expect(piece.endsWith('.')).toBe(true); // cuts land after a terminator, never mid-sentence
    }
    expect(squash(out.join(' '))).toEqual(squash(bubble));
  });

  it('AC: a paragraph longer than the limit gets a sentence cut inside it', () => {
    const longPara = `${'va a llover toda la semana.'} `.repeat(200).trim(); // 5599 chars, ONE paragraph
    const bubble = `${longPara}\n\nfinal corto`;
    const out = SHAPE([bubble]);
    // The paragraph's own boundary sits past the cut window, so the first cut
    // is a sentence cut; the trailing paragraph travels with the remainder and
    // stays inside the cap.
    expect(out).toHaveLength(2);
    expect(out[0]!.length).toBeLessThanOrEqual(TELEGRAM_LIMITS.maxMsgChars);
    expect(out[0]!.endsWith('.')).toBe(true);
    expect(out[1]!.length).toBeLessThanOrEqual(TELEGRAM_LIMITS.maxMsgChars);
    expect(out[1]!.endsWith('final corto')).toBe(true);
    expect(squash(out.join(' '))).toEqual(squash(bubble));
  });

  it('AC: a bubble under the char cap is never split — even one char of headroom is untouched', () => {
    const atCap = 'q'.repeat(TELEGRAM_LIMITS.maxMsgChars);
    expect(SHAPE([atCap])).toEqual([atCap]);
  });

  it('the split only ever consumes the whitespace at the boundary', () => {
    const over = `no. ${'q'.repeat(TELEGRAM_LIMITS.maxMsgChars)}`; // 4100 chars
    expect(SHAPE([over])).toEqual(['no.', 'q'.repeat(TELEGRAM_LIMITS.maxMsgChars)]);
  });

  it('AC: a sentence longer than the channel accepts has no legal cut — loud, typed failure', () => {
    const unsplittable = `${'q'.repeat(TELEGRAM_LIMITS.maxMsgChars)}.`; // terminator, but no boundary inside the cap
    expect(() => SHAPE([unsplittable])).toThrowError(/no paragraph\/sentence boundary/);
  });

  it('whitespace-only bubbles drop out — they carry no words and no timing', () => {
    expect(SHAPE(['   ', '\n\n', 'hola', ''])).toEqual(['hola']);
  });
});

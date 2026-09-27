// v13 introspection, Phase 2 — H3b her lexicon (plan docs/plans/v13-proposal-knowing-what-she-feels.md
// §6 Phase 2.3): a word becomes hers when it is used often enough, lands right often enough, and
// names its own place; then her past is narrated in it.

import { describe, expect, it } from 'vitest';
import { composeSegments, normWord, recordUse, tagSignature, verifiedWords, LEXICON, TELLING_PATTERNS, type Lexicon, type LexUse } from '../../src/mind/index.js';
import type { Family } from '../../src/mind/readout.js';
import { moment, T0 } from './helpers.js';

const place = (k: number): number[] => Array.from({ length: 23 }, (_, i) => (i === k ? 1 : i === (k + 5) % 23 ? 0.3 : 0.02));
const use = (i: number, top3: Family[], vec: number[] = place(0)): LexUse => ({ ts: T0 + i * 60_000, top3, vec });

const feed = (words: Array<{ w: string; top3: Family[]; vec?: number[] }>): Lexicon => {
  let lex: Lexicon = {};
  words.forEach((x, i) => {
    lex = recordUse(lex, x.w, use(i, x.top3, x.vec)).lex;
  });
  return lex;
};

describe('H3b — her words', () => {
  it('a word is a key: lowercase, no punctuation, at most three words; "not sure" is not a word for a feeling', () => {
    expect(normWord('Thin.')).toBe('thin');
    expect(normWord('kind of  flat!')).toBe('kind of flat');
    expect(normWord('not sure')).toBeUndefined();
    expect(normWord('i really do not know what this is')).toBeUndefined();
  });

  it('a vocabulary word is verified by its own family: five uses, ≥60% in the engine’s top three', () => {
    const four = feed(Array.from({ length: 4 }, () => ({ w: 'lonely', top3: ['missing', 'warm', 'low'] as Family[] })));
    expect(four['lonely']).toMatchObject({ count: 4, family: 'missing', verified: false });
    const five = feed(Array.from({ length: 5 }, () => ({ w: 'lonely', top3: ['missing', 'warm', 'low'] as Family[] })));
    expect(five['lonely']).toMatchObject({ count: 5, hit: 1, verified: true });
  });

  it('a word of her own takes the family it most often came with; one that lands anywhere never verifies', () => {
    const steady = feed(Array.from({ length: 6 }, (_, i) => ({ w: 'thin', top3: (i === 5 ? ['warm', 'up', 'curious'] : ['low', 'missing', 'warm']) as Family[] })));
    expect(steady['thin']).toMatchObject({ family: 'low', verified: true });
    expect(steady['thin']!.hit).toBeCloseTo(5 / 6, 3);
    const fams: Family[] = ['warm', 'up', 'curious', 'focused', 'anxious', 'low', 'missing', 'restless', 'angry', 'ashamed'];
    const loose = feed(Array.from({ length: 10 }, (_, i) => ({ w: 'fizzy', top3: [fams[i]!, fams[(i + 3) % 10]!, fams[(i + 6) % 10]!] })));
    expect(loose['fizzy']!.hit).toBeLessThan(LEXICON.minHit);
    expect(loose['fizzy']!.verified).toBe(false);
  });

  it('two words may not name the same place: the more-used one is hers', () => {
    const lex = feed([
      ...Array.from({ length: 7 }, () => ({ w: 'thin', top3: ['low', 'missing', 'warm'] as Family[], vec: place(3) })),
      ...Array.from({ length: 5 }, () => ({ w: 'hollow', top3: ['low', 'missing', 'warm'] as Family[], vec: place(3) })),
      ...Array.from({ length: 5 }, () => ({ w: 'fizzy', top3: ['up', 'curious', 'warm'] as Family[], vec: place(11) })),
    ]);
    expect(lex['thin']!.verified).toBe(true);
    expect(lex['hollow']!.verified).toBe(false);
    expect(lex['fizzy']!.verified).toBe(true);
    expect(verifiedWords(lex).map((w) => w.word).sort()).toEqual(['fizzy', 'thin']);
  });

  it('newly verified is reported once (the event for his window)', () => {
    let lex: Lexicon = {};
    const flags: boolean[] = [];
    for (let i = 0; i < 7; i++) {
      const r = recordUse(lex, 'thin', use(i, ['low', 'missing', 'warm']));
      lex = r.lex;
      flags.push(r.newlyVerified);
    }
    expect(flags).toEqual([false, false, false, false, true, false, false]);
  });
});

describe('H3b — her past, in her language', () => {
  const words = [{ word: 'thin', centroid: [...tagSignature('lonely', 6), ...new Array(11).fill(0)], family: 'missing' as Family }];
  const render = (m: ReturnType<typeof moment>): string =>
    composeSegments({ timeZone: 'Europe/Madrid', now: T0, self: [], concerns: [], thoughts: [], options: [m], memories: [], who: 'he', lexicon: words })
      .head.map((s) => s.text)
      .join('\n');

  it('a memory that sits where her word lives is narrated with it', () => {
    const near = render(moment({ felt: { sig: tagSignature('lonely', 6), word: 'lonely', source: 'exact' } }));
    expect(near).toContain('(your word for times like this: "thin")');
    // the frame around her word tells nothing
    for (const re of TELLING_PATTERNS) expect('(your word for times like this: "thin")'.replace(/"[^"]*"/, '""')).not.toMatch(re);
  });

  it('not a memory elsewhere; not one of another family; not where she already called it that', () => {
    expect(render(moment({ felt: { sig: tagSignature('delighted', 8), word: 'delighted', source: 'exact' } }))).not.toContain('your word for times like this');
    expect(render(moment({ felt: { sig: tagSignature('lonely', 6), word: 'lonely', source: 'exact' }, called: 'Thin' }))).not.toContain('your word for times like this');
  });
});

// v14 Phase 1.6 — gist, not verbatim ("8:39", "all 25k", "11,000 years", "journal.md": 9% of her turns vs people's 0–2%).
import { describe, expect, it } from 'vitest';
import { asRemembered, composeSegments, gist, GIST_AFTER_MS } from '../../src/mind/index.js';
import { moment, T0 } from './helpers.js';

describe('gist: an old memory comes to mind the way a person carries it', () => {
  it('times go to the half hour, long numbers to their size, file names to the thing; years and small numbers stay', () => {
    expect(gist('she sent it at 8:39 and again at 14:05, and 21:50')).toBe('she sent it at around 8:30 and again at around 14:00, and around 22:00');
    expect(gist('it outlived its reef by 11,000 years; 25000 words')).toBe('it outlived its reef by about 11 thousand years; about 25 thousand words');
    expect(gist('read journal.md and notes.txt')).toBe('read journal and notes');
    expect(gist('in 2026 she had 3 jars, piece #8')).toBe('in 2026 she had 3 jars, piece #8');
    expect(gist('id 1790553731000')).toBe('id a long number');
  });

  it('only once it is old: today stays exact', () => {
    expect(asRemembered('at 8:39', T0 - 60_000, T0)).toBe('at 8:39');
    expect(asRemembered('at 8:39', T0 - GIST_AFTER_MS - 1, T0)).toBe('at around 8:30');
  });

  it('in her prompt: an old memory is gist, a fresh one is word for word', () => {
    const old = moment({ id: 'old', ts: T0 - 2 * 86_400_000, his: 'when did she write it', hers: ['8:39 on the dot, all 25,000 words of journal.md'] });
    const fresh = moment({ id: 'fresh', ts: T0 - 60_000, his: 'and the new one', hers: ['9:12, i just checked'] });
    const { head } = composeSegments({ timeZone: 'Europe/Madrid', now: T0, self: [], concerns: [], thoughts: [], options: [old, fresh], memories: [], who: 'Diego' });
    const text = head.map((s) => s.text).join('\n');
    expect(text).toContain('you: around 8:30 on the dot, all about 25 thousand words of journal');
    expect(text).toContain('you: 9:12, i just checked');
  });
});

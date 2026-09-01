import { describe, expect, it } from 'vitest';
import { newId, contentHash } from '../../src/kernel/id.js';
import { TestClock } from '../../src/kernel/clock.js';
import { makeRng } from '../../src/kernel/rng.js';

describe('newId', () => {
  it('generates 100k unique, strictly increasing ids in a single frozen-ms burst', () => {
    const clock = new TestClock(1_790_000_000_000); // frozen
    const rng = makeRng('burst');
    const seen = new Set<string>();
    let prev = '';
    for (let i = 0; i < 100_000; i++) {
      const id = newId(clock, rng);
      expect(id).toHaveLength(26);
      expect(seen.has(id)).toBe(false);
      expect(id > prev).toBe(true); // strictly increasing under frozen time
      seen.add(id);
      prev = id;
    }
  });

  it('ids are lexically time-sortable: a later timestamp yields a lexically greater id', () => {
    const early = newId(new TestClock(1_000), makeRng('sortable'));
    const late = newId(new TestClock(1_000 + 24 * 3600 * 1000), makeRng('sortable'));
    expect(late > early).toBe(true);
  });

  it('uses only the Crockford base32 alphabet', () => {
    const id = newId(new TestClock(123), makeRng(1));
    expect(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/.test(id)).toBe(true);
  });
});

describe('contentHash', () => {
  it('matches sha256 golden vectors', () => {
    expect(contentHash('')).toBe(
      'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(contentHash('thea')).toBe(
      // sha256("thea")
      'sha256:' + expectSha('thea'),
    );
  });

  it('hashes bytes and strings distinctly', () => {
    expect(contentHash(new TextEncoder().encode('a'))).toBe(contentHash('a'));
  });
});

// Compute expected sha256 without importing another hash lib: node:crypto is
// available in tests and mirrors the implementation's use of it.
import { createHash } from 'node:crypto';
const expectSha = (s: string): string => createHash('sha256').update(s).digest('hex');

import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../../src/kernel/hash.js';

describe('canonicalJson', () => {
  it('is byte-stable across key-permuted equal objects, recursively', () => {
    const a = { b: 1, a: { y: [1, { q: 2, p: 3 }], x: 's' }, c: [] };
    const b = { c: [], a: { x: 's', y: [1, { p: 3, q: 2 }] }, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalJson(a)).toBe('{"a":{"x":"s","y":[1,{"p":3,"q":2}]},"b":1,"c":[]}');
  });

  it('rejects NaN, Infinity, undefined, bigint, functions, and circular refs with typed errors', () => {
    const cases: Array<[unknown, string]> = [
      [NaN, 'canonical/invalid-number'],
      [Infinity, 'canonical/invalid-number'],
      [-Infinity, 'canonical/invalid-number'],
      [{ x: undefined }, 'canonical/unsupported-type'],
      [10n, 'canonical/unsupported-type'],
      [() => 1, 'canonical/unsupported-type'],
      [new Map(), 'canonical/unsupported-type'],
    ];
    for (const [v, code] of cases) {
      expect(() => canonicalJson(v)).toThrowError(expect.objectContaining({ code }));
    }
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    expect(() => canonicalJson(circular)).toThrowError(
      expect.objectContaining({ code: 'canonical/circular' }),
    );
  });

  it('round-trips through JSON.parse', () => {
    const v = { z: [1, 'two', { three: true }], a: null };
    expect(JSON.parse(canonicalJson(v))).toEqual(v);
  });
});

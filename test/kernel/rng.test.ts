import { describe, expect, it } from 'vitest';
import { makeRng } from '../../src/kernel/rng.js';

describe('makeRng', () => {
  it('same seed yields identical float/int/pick/shuffle sequences across runs', () => {
    const run = (): number[] => {
      const r = makeRng('determinism-check');
      const xs = [1, 2, 3, 4, 5, 6, 7, 8];
      return [
        r.float(),
        r.float(),
        r.int(0, 100),
        r.int(0, 100),
        r.pick(xs),
        r.shuffle(xs)[0]!,
        r.shuffle(xs)[7]!,
      ];
    };
    expect(run()).toEqual(run());
    expect(run()).toEqual(run());
    // Numeric seeds agree with their string forms.
    expect([...gen(makeRng(42), 5)]).toEqual([...gen(makeRng('42'), 5)]);
  });

  it('forked streams are pairwise independent', () => {
    const parent = makeRng('fork-independence');
    const a = parent.fork('a');
    const b = parent.fork('b');

    const aAlone = [...gen(a, 10)];
    const bAlone = [...gen(b, 10)];

    // Interleave draws on a fresh pair — sequences unchanged.
    const a2 = makeRng('fork-independence').fork('a');
    const b2 = makeRng('fork-independence').fork('b');
    const interleavedA: number[] = [];
    const interleavedB: number[] = [];
    for (let i = 0; i < 10; i++) {
      interleavedA.push(a2.float());
      interleavedB.push(b2.float());
    }
    expect(interleavedA).toEqual(aAlone);
    expect(interleavedB).toEqual(bAlone);
    // Sibling streams differ from each other.
    expect(aAlone).not.toEqual(bAlone);
  });

  it('int bounds are inclusive, shuffle returns a permutation, pick rejects empty', () => {
    const r = makeRng(7);
    for (let i = 0; i < 500; i++) {
      const v = r.int(3, 3);
      expect(v).toBe(3);
    }
    const xs = [1, 2, 3, 4, 5];
    const shuffled = r.shuffle(xs);
    expect([...shuffled].sort()).toEqual(xs);
    expect(xs).toEqual([1, 2, 3, 4, 5]); // input untouched
    expect(() => r.pick([])).toThrow();
  });
});

function* gen(r: ReturnType<typeof makeRng>, n: number): Generator<number> {
  for (let i = 0; i < n; i++) yield r.float();
}

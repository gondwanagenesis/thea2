import { describe, expect, it } from 'vitest';
import { makeFixedEmbedder } from '../../src/embed/fixed-embedder.js';
import { cosineSimilarity } from '../../src/embed/l2.js';

describe('FixedEmbedder', () => {
  it('AC: normalizes on read — handcrafted geometry comes back unit-length', async () => {
    const emb = makeFixedEmbedder({ love: [3, 4], lust: [0.6, 0.8] });
    expect(emb.dim).toBe(2);
    const [love, lust] = await emb.embed(['love', 'lust']);
    // Vectors are Float32Array by contract — precision 6, not 12 (f32 epsilon at
    // 0.6 is ~6e-8; demanding 5e-13 asserts a float64 world that cannot exist).
    expect(love![0]).toBeCloseTo(0.6, 6);
    expect(love![1]).toBeCloseTo(0.8, 6);
    // Same direction as a hand-normalized entry ⇒ exactly the intended geometry.
    expect(cosineSimilarity(love!, lust!)).toBeCloseTo(1, 6);
  });

  it('AC: unknown strings throw with a typed error naming the string', async () => {
    const emb = makeFixedEmbedder({ a: [1, 0] });
    await expect(emb.embed(['nope'])).rejects.toThrowError(
      expect.objectContaining({ code: 'embed/fixed-unknown' }),
    );
    // Batch stays batch: a known key among unknown ones still fails loudly.
    await expect(emb.embed(['a', 'nope'])).rejects.toThrowError(
      expect.objectContaining({ code: 'embed/fixed-unknown' }),
    );
  });

  it('batch is order-preserving and zero-vector entries are legal', async () => {
    const emb = makeFixedEmbedder({ a: [1, 0], zero: [0, 0], b: [0, 2] });
    const [a, zero, b] = await emb.embed(['a', 'zero', 'b']);
    expect(a![0]).toBe(1);
    expect(a![1]).toBe(0);
    expect([...zero!]).toEqual([0, 0]);
    expect(b![1]).toBe(1);
    expect(cosineSimilarity(zero!, a!)).toBe(0);
  });

  it('identity is content-derived: same map ⇒ same id, different map ⇒ different id', () => {
    const map = { red: [1, 0, 0], blue: [0, 1, 0] };
    expect(makeFixedEmbedder(map).id).toBe(makeFixedEmbedder({ blue: [0, 1, 0], red: [1, 0, 0] }).id);
    expect(makeFixedEmbedder(map).id).not.toBe(makeFixedEmbedder({ red: [1, 0, 0], blue: [0, 0, 1] }).id);
  });

  it('each read returns a fresh copy — mutating a result cannot corrupt the fixture', async () => {
    const emb = makeFixedEmbedder({ a: [1, 0] });
    const v = (await emb.embed(['a']))[0]!;
    v[0] = 99;
    expect((await emb.embed(['a']))[0]![0]).toBe(1);
  });

  it('malformed maps fail at construction with typed config errors', () => {
    expect(() => makeFixedEmbedder({})).toThrowError(expect.objectContaining({ code: 'embed/config' }));
    expect(() => makeFixedEmbedder({ a: [] })).toThrowError(
      expect.objectContaining({ code: 'embed/config' }),
    );
    expect(() => makeFixedEmbedder({ a: [1, 0], b: [1, 0, 0] })).toThrowError(
      expect.objectContaining({ code: 'embed/config' }),
    );
    expect(() => makeFixedEmbedder({ a: [1, Number.NaN] })).toThrowError(
      expect.objectContaining({ code: 'embed/config' }),
    );
    expect(() => makeFixedEmbedder({ a: [1, Number.POSITIVE_INFINITY] })).toThrowError(
      expect.objectContaining({ code: 'embed/config' }),
    );
  });
});

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { contentHash, makeRng } from '../../src/kernel/index.js';
import { cosineSimilarity } from '../../src/embed/l2.js';
import { makeHashEmbedder } from '../../src/embed/hash-embedder.js';
import { DEFAULT_EMBED_DIM } from '../../src/embed/types.js';

/** Bit-level identity of a vector: sha256 over its exact Float32 bytes. Two
 * vectors are "the same vector" iff these match — element-wise toEqual would
 * hide a last-ulp platform drift. */
const bits = (v: Float32Array): string =>
  contentHash(Buffer.from(v.buffer as ArrayBuffer, v.byteOffset, v.byteLength));

const GOLDEN = JSON.parse(
  readFileSync(new URL('./fixtures/hash-golden.json', import.meta.url), 'utf8'),
) as { embedderId: string; dim: number; vectors: Record<string, string> };

describe('HashEmbedder', () => {
  it('AC: same text yields a bit-identical vector across runs, against committed golden bits', async () => {
    const emb = makeHashEmbedder();
    const texts = Object.keys(GOLDEN.vectors);
    expect(texts.length).toBeGreaterThanOrEqual(4);
    expect(emb.id).toBe(GOLDEN.embedderId);
    expect(emb.dim).toBe(GOLDEN.dim);

    const first = await emb.embed(texts);
    const second = await emb.embed(texts);
    texts.forEach((t, i) => {
      expect(bits(first[i]!)).toBe(GOLDEN.vectors[t]);
      expect(bits(first[i]!)).toBe(bits(second[i]!));
    });
  });

  it('AC: output is 384-d by default and L2-normalized; custom dim is honored', async () => {
    expect(DEFAULT_EMBED_DIM).toBe(384);
    const emb = makeHashEmbedder();
    expect(emb.dim).toBe(384);
    expect(emb.id).toBe('hash:384');

    const v = (await emb.embed(['one two three']))[0]!;
    expect(v.length).toBe(384);
    let sumSq = 0;
    for (const x of v) sumSq += x * x;
    expect(sumSq).toBeCloseTo(1, 6);

    const small = makeHashEmbedder(64);
    expect(small.dim).toBe(64);
    expect(small.id).toBe('hash:64');
    expect((await small.embed(['x']))[0]!.length).toBe(64);
    expect((await small.embed(['x', 'y', 'z'])).map((v2) => v2.length)).toEqual([64, 64, 64]);
  });

  it('rejects non-positive and non-integer dims with a typed config error', () => {
    for (const dim of [0, -4, 12.5, Number.NaN]) {
      expect(() => makeHashEmbedder(dim)).toThrowError(expect.objectContaining({ code: 'embed/config' }));
    }
  });

  it('cosine self-similarity is 1; distinct texts give distinct vectors', async () => {
    const emb = makeHashEmbedder(256);
    const [a, b] = await emb.embed(['the red door remembers', 'an entirely different sentence about ledgers']);
    expect(cosineSimilarity(a!, a!)).toBeCloseTo(1, 12);
    expect(bits(a!)).not.toBe(bits(b!));
  });

  it('normalizes case and whitespace: same tokens, same bits', async () => {
    const emb = makeHashEmbedder();
    const [a, b, c] = await emb.embed(['Hello World', 'hello world', '  HELLO   world ']);
    expect(bits(a!)).toBe(bits(b!));
    expect(bits(a!)).toBe(bits(c!));
  });

  it('tokenizes unigrams AND bigrams: order matters, but shared tokens stay near', async () => {
    const emb = makeHashEmbedder();
    const [ab, reversed, unrelated] = await emb.embed([
      'alpha beta gamma',
      'gamma beta alpha',
      'zulu yankee xray',
    ]);
    // Same token set, different order → different bigrams → not the same vector.
    expect(bits(ab!)).not.toBe(bits(reversed!));
    // But the three shared unigrams dominate the two disagreeing bigrams.
    const anagram = cosineSimilarity(ab!, reversed!);
    const stranger = cosineSimilarity(ab!, unrelated!);
    expect(anagram).toBeGreaterThan(stranger);
    expect(anagram).toBeGreaterThan(0.5);
  });

  it('empty and punctuation-only texts embed to the exact zero vector (never NaN)', async () => {
    const emb = makeHashEmbedder();
    const vs = await emb.embed(['', '  ', '!!! ???']);
    for (const v of vs) {
      expect(v.length).toBe(384);
      expect(Math.sqrt(v.reduce((s, x) => s + x * x, 0))).toBe(0);
      for (const x of v) expect(x).toBe(0);
    }
  });

  it('AC: shared-token property — pairs sharing >=1 token score strictly higher than disjoint pairs (seeded)', async () => {
    const emb = makeHashEmbedder();
    const rng = makeRng('embed/shared-token-property');
    const vocab = Array.from({ length: 64 }, (_, i) => `tok${i}`);
    const say = (words: string[]): string => rng.shuffle([...words]).join(' ');

    const left: string[] = [];
    const right: string[] = [];
    // 40 overlapping pairs: 2-5 shared tokens plus 2-4 private ones each.
    for (let i = 0; i < 40; i++) {
      const shared = rng.shuffle([...vocab]).slice(0, rng.int(2, 5));
      const rest = vocab.filter((w) => !shared.includes(w));
      const aOnly = rng.shuffle([...rest]).slice(0, rng.int(2, 4));
      const bOnly = rng.shuffle([...rest]).slice(0, rng.int(2, 4));
      left.push(say([...shared, ...aOnly]));
      right.push(say([...shared, ...bOnly]));
    }
    // 40 disjoint pairs: no token in common.
    for (let i = 0; i < 40; i++) {
      const a = rng.shuffle([...vocab]).slice(0, rng.int(4, 8));
      const rest = vocab.filter((w) => !a.includes(w));
      const b = rng.shuffle([...rest]).slice(0, rng.int(4, 8));
      left.push(say(a));
      right.push(say(b));
    }

    const va = await emb.embed(left);
    const vb = await emb.embed(right);
    const shared: number[] = [];
    const disjoint: number[] = [];
    for (let i = 0; i < 80; i++) {
      const c = cosineSimilarity(va[i]!, vb[i]!);
      (i < 40 ? shared : disjoint).push(c);
    }

    const minShared = Math.min(...shared);
    const maxDisjoint = Math.max(...disjoint);
    // The AC: every overlapping pair ranks strictly above every disjoint one.
    expect(minShared).toBeGreaterThan(maxDisjoint);
    // Separation is positive but modest BY CONSTRUCTION: at dim 384 over a 64-token
    // vocab with 4-9-token texts, hash collisions and bigram dilution leave the worst
    // shared pair only a few hundredths above the best disjoint pair (measured
    // ~0.035 on this seed). Claiming a bigger margin asserts a property the geometry
    // does not have; M09 planted-fact recall needs exactly this strict ordering.
    expect(minShared - maxDisjoint).toBeGreaterThan(0.005);
    // Every overlapping pair is positively similar.
    expect(minShared).toBeGreaterThan(0);
  });

  it('batch embed is order-preserving vs single-text embed', async () => {
    const emb = makeHashEmbedder();
    const texts = ['alpha beta', 'gamma delta epsilon', '', 'alpha beta'];
    const batch = await emb.embed(texts);
    for (let i = 0; i < texts.length; i++) {
      const single = (await emb.embed([texts[i]!]))[0]!;
      expect(bits(batch[i]!)).toBe(bits(single));
    }
  });
});

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TestClock } from '../../src/kernel/clock.js';
import { openVectorIndex } from '../../src/embed/vector-index.js';
import type { SavedIndexMeta } from '../../src/embed/types.js';

const dirs: string[] = [];
const fresh = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'thea2-embed-index-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  while (dirs.length > 0) {
    const d = dirs.pop()!;
    fs.rmSync(d, { recursive: true, force: true });
  }
});

/**
 * Golden ordering corpus — 20 entries over unit vectors in the x/y plane, so every
 * score against the fixed query q=[1,0,0,0] is hand-derivable (it is simply the x
 * component: 3-4-5 triples give exact 0.28/0.6/0.8/0.96 cosines). Duplicate
 * geometries produce bit-identical scores, which is what exercises the documented
 * tie rule: score descending, ties by id ascending.
 */
const GOLDEN_IDS = [
  'a-01', // 1.0
  'b-02', // 0.96
  'q-17', // 0.96  tie with b-02 → id ascending
  'c-03', // 0.8
  'd-04', // 0.8   tie with c-03
  's-19', // 0.8   tie with c-03/d-04 (0.8,-0.6 has the same x and norm)
  'e-05', // 0.6
  'p-16', // 0.6   tie with e-05
  'f-06', // 0.28
  'o-15', // 0.28  tie with f-06
  'g-07', // 0
  'h-08', // 0     tie with g-07
  'i-09', // 0     zero vector scores 0 — joins the tie, id-ordered inside it
  't-20', // 0
  'j-10', // -0.28
  'k-11', // -0.6
  'l-12', // -0.8
  'r-18', // -0.8  tie with l-12
  'm-13', // -0.96
  'n-14', // -1.0
] as const;

const GOLDEN_VECS: Record<string, number[]> = {
  'a-01': [1, 0, 0, 0],
  'b-02': [0.96, 0.28, 0, 0],
  'c-03': [0.8, 0.6, 0, 0],
  'd-04': [0.8, 0.6, 0, 0],
  'e-05': [0.6, 0.8, 0, 0],
  'f-06': [0.28, 0.96, 0, 0],
  'g-07': [0, 1, 0, 0],
  'h-08': [0, 0, 1, 0],
  'i-09': [0, 0, 0, 0],
  'j-10': [-0.28, 0.96, 0, 0],
  'k-11': [-0.6, 0.8, 0, 0],
  'l-12': [-0.8, 0.6, 0, 0],
  'm-13': [-0.96, 0.28, 0, 0],
  'n-14': [-1, 0, 0, 0],
  'o-15': [0.28, 0.96, 0, 0],
  'p-16': [0.6, 0.8, 0, 0],
  'q-17': [0.96, 0.28, 0, 0],
  'r-18': [-0.8, -0.6, 0, 0],
  's-19': [0.8, -0.6, 0, 0],
  't-20': [0, 1, 0, 0],
};

const QUERY = new Float32Array([1, 0, 0, 0]);
const EXPECTED_SCORE: Record<string, number> = {
  'a-01': 1,
  'b-02': 0.96,
  'q-17': 0.96,
  'c-03': 0.8,
  'd-04': 0.8,
  's-19': 0.8,
  'e-05': 0.6,
  'p-16': 0.6,
  'f-06': 0.28,
  'o-15': 0.28,
  'g-07': 0,
  'h-08': 0,
  'i-09': 0,
  't-20': 0,
  'j-10': -0.28,
  'k-11': -0.6,
  'l-12': -0.8,
  'r-18': -0.8,
  'm-13': -0.96,
  'n-14': -1,
};

/** Insert in a deliberately non-sorted order: insertion order must not matter. */
const buildGoldenIndex = () => {
  const index = openVectorIndex({ embedderId: 'fixture:golden', dim: 4 });
  for (const id of ['t-20', 'k-11', 'b-02', 'n-14', 'g-07', 's-19', 'o-15', 'c-03', 'r-18', 'e-05',
    'm-13', 'i-09', 'q-17', 'h-08', 'd-04', 'l-12', 'p-16', 'a-01', 'j-10', 'f-06']) {
    index.upsert(id, new Float32Array(GOLDEN_VECS[id]!), { group: Number(id.slice(2)) % 2 === 0 ? 'even' : 'odd' });
  }
  return index;
};

describe('VectorIndex — golden ordering', () => {
  it('AC: the 20-entry corpus ranks exactly as committed, ties broken by id', () => {
    const index = buildGoldenIndex();
    const hits = index.search(QUERY, 20);
    expect(hits.map((h) => h.id)).toEqual([...GOLDEN_IDS]);
    for (const h of hits) {
      // f32 vectors ⇒ f32-attainable precision only (see fixed-embedder note).
      expect(h.score).toBeCloseTo(EXPECTED_SCORE[h.id]!, 6);
      expect(h.meta).toBeDefined();
    }
    // Monotone non-increasing by construction.
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i - 1]!.score).toBeGreaterThanOrEqual(hits[i]!.score);
    }
  });

  it('the same query on an unchanged index returns the identical order, every time', () => {
    const index = buildGoldenIndex();
    const run = (): string[] => index.search(QUERY, 20).map((h) => h.id);
    expect(run()).toEqual(run());
    expect(run()).toEqual([...GOLDEN_IDS]);
    // k truncation is a prefix of the same ranking, never a reshuffle.
    expect(index.search(QUERY, 5).map((h) => h.id)).toEqual([...GOLDEN_IDS].slice(0, 5));
  });
});

describe('VectorIndex — geometry edges', () => {
  it('AC: k larger than the set returns the whole set; empty index and k<=0 return []', () => {
    const empty = openVectorIndex();
    expect(empty.search(QUERY, 10)).toEqual([]);
    expect(empty.dim).toBe(0);

    const index = buildGoldenIndex();
    expect(index.search(QUERY, 1000)).toHaveLength(20);
    expect(index.search(QUERY, 0)).toEqual([]);
    expect(index.search(QUERY, -3)).toEqual([]);
  });

  it('AC: a zero vector query is legal — all scores 0, ties resolve by id ascending', () => {
    const index = openVectorIndex();
    index.upsert('zeta', new Float32Array([1, 0]));
    index.upsert('alpha', new Float32Array([0, 1]));
    index.upsert('mid', new Float32Array([0, 0]));
    const hits = index.search(new Float32Array([0, 0]), 10);
    expect(hits.map((h) => h.id)).toEqual(['alpha', 'mid', 'zeta']);
    for (const h of hits) expect(h.score).toBe(0);
  });

  it('AC: filter runs before ranking — a filtered-out entry never consumes a top-k slot', () => {
    const index = buildGoldenIndex();
    const survivors = index.search(QUERY, 50, (meta) => (meta as { group: string }).group === 'even');
    // 10 of the 20 survive; k=50 far exceeds the surviving set.
    expect(survivors).toHaveLength(10);
    for (const h of survivors) expect((h.meta as { group: string }).group).toBe('even');
    const evenIds = GOLDEN_IDS.filter((id) => Number(id.slice(2)) % 2 === 0);
    expect(survivors.map((h) => h.id)).toEqual([...evenIds]);
    // Order within the filtered ranking matches the global ranking's relative order.
    const global = new Map(index.search(QUERY, 20).map((h, i) => [h.id, i]));
    const rank = survivors.map((h) => global.get(h.id)!);
    expect([...rank].sort((a, b) => a - b)).toEqual(rank);
  });

  it('upsert replaces vec and meta for an existing id (re-embed path)', () => {
    const index = openVectorIndex();
    index.upsert('doc', new Float32Array([1, 0]), { v: 1 });
    index.upsert('doc', new Float32Array([0, 1]), { v: 2 });
    expect(index.size()).toBe(1);
    const hits = index.search(new Float32Array([1, 0]), 5);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.score).toBeCloseTo(0, 12);
    expect(hits[0]!.meta).toEqual({ v: 2 });
  });

  it('dimension mismatches on upsert and search are typed, and raw magnitudes still cosine correctly', () => {
    const index = openVectorIndex({ dim: 3 });
    expect(() => index.upsert('x', new Float32Array([1, 0]))).toThrowError(
      expect.objectContaining({ code: 'embed/dim-mismatch' }),
    );
    expect(() => index.search(new Float32Array([1, 0, 0, 0]), 5)).toThrowError(
      expect.objectContaining({ code: 'embed/dim-mismatch' }),
    );
    // Unnormalized vectors: score is true cosine, not a raw dot.
    index.upsert('unit', new Float32Array([1, 0, 0]));
    index.upsert('long', new Float32Array([5, 0, 0]));
    const hits = index.search(new Float32Array([2, 0, 0]), 2);
    expect(hits[0]!.score).toBeCloseTo(1, 12);
    expect(hits[1]!.score).toBeCloseTo(1, 12);
  });

  it('meta comes back through search untouched, and absent meta stays absent', () => {
    const index = openVectorIndex();
    index.upsert('with-meta', new Float32Array([1, 0]), { scene: 'door', turn: 7 });
    index.upsert('bare', new Float32Array([0, 1]));
    const hits = index.search(new Float32Array([1, 0]), 5);
    expect(hits[0]!.meta).toEqual({ scene: 'door', turn: 7 });
    expect(Object.prototype.hasOwnProperty.call(hits[0]!, 'meta')).toBe(true);
    const bare = index.search(new Float32Array([0, 1]), 5)[0]!;
    expect(bare.meta).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(bare, 'meta')).toBe(false);
  });
});

describe('VectorIndex — save/load', () => {
  it('AC: roundtrip — reload then search returns the identical order; sidecar carries the contract fields', async () => {
    const filePath = path.join(fresh(), 'idx');
    const clock = new TestClock(1_700_000_000_000);

    const source = buildGoldenIndex();
    await source.save(filePath, { savedAtTs: clock.epochMs() });
    expect(fs.existsSync(`${filePath}.bin`)).toBe(true);
    expect(fs.existsSync(`${filePath}.meta.json`)).toBe(true);
    const sidecar = JSON.parse(fs.readFileSync(`${filePath}.meta.json`, 'utf8')) as SavedIndexMeta;
    expect(sidecar).toEqual({
      embedderId: 'fixture:golden',
      dim: 4,
      count: 20,
      savedAtTs: 1_700_000_000_000,
    });
    expect('model' in sidecar).toBe(false);

    const before = source.search(QUERY, 20);
    const reloaded = openVectorIndex({ embedderId: 'fixture:golden', dim: 4 });
    await reloaded.load(filePath);
    const after = reloaded.search(QUERY, 20);
    expect(after.map((h) => h.id)).toEqual(before.map((h) => h.id));
    expect(after.map((h) => h.score)).toEqual(before.map((h) => h.score));
    expect(after.map((h) => h.meta)).toEqual(before.map((h) => h.meta));
  });

  it('an unbound index roundtrips too: dim and meta survive, load adopts the sidecar geometry', async () => {
    const filePath = path.join(fresh(), 'unbound');
    const index = openVectorIndex({ model: 'fixture-model' });
    index.upsert('a', new Float32Array([1, 2, 3]), { tag: 'x' });
    await index.save(filePath);

    const sidecar = JSON.parse(fs.readFileSync(`${filePath}.meta.json`, 'utf8')) as SavedIndexMeta;
    expect(sidecar.embedderId).toBe('');
    expect(sidecar.model).toBe('fixture-model');
    expect(sidecar.dim).toBe(3);
    expect(sidecar.count).toBe(1);

    const target = openVectorIndex();
    await target.load(filePath);
    expect(target.dim).toBe(3);
    expect(target.size()).toBe(1);
    expect(target.search(new Float32Array([1, 2, 3]), 1)[0]!.meta).toEqual({ tag: 'x' });
  });

  it('AC: dim mismatch on load refuses with a typed error naming both sides, and loads nothing', async () => {
    const filePath = path.join(fresh(), 'four-d');
    const source = openVectorIndex({ embedderId: 'hash:384', dim: 4 });
    source.upsert('a', new Float32Array([1, 0, 0, 0]), { keep: true });
    await source.save(filePath);

    const target = openVectorIndex({ embedderId: 'hash:384', dim: 8 });
    target.upsert('pre-existing', new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]));
    await expect(target.load(filePath)).rejects.toThrowError(
      expect.objectContaining({
        code: 'embed/dim-mismatch',
        // Both sides named: what is on disk and what this index is bound to.
        message: expect.stringMatching(/4-d[\s\S]*8-d/),
      }),
    );
    // Nothing was partially loaded: the index is exactly as it was.
    expect(target.size()).toBe(1);
    expect(target.search(new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]), 5).map((h) => h.id)).toEqual([
      'pre-existing',
    ]);
  });

  it('AC: embedderId mismatch on load refuses with a typed error naming both embedders', async () => {
    const filePath = path.join(fresh(), 'hash-embedded');
    const source = openVectorIndex({ embedderId: 'hash:384', dim: 4 });
    source.upsert('a', new Float32Array([1, 0, 0, 0]));
    await source.save(filePath);

    const target = openVectorIndex({ embedderId: 'api:api.example.com/bge-small-en-v1.5', dim: 4 });
    await expect(target.load(filePath)).rejects.toThrowError(
      expect.objectContaining({
        code: 'embed/embedder-mismatch',
        message: expect.stringMatching(/hash:384[\s\S]*api:api\.example\.com\/bge-small-en-v1\.5/),
      }),
    );
  });

  it('an unbound index may load anything bound or unbound (binding is an opt-in contract)', async () => {
    const filePath = path.join(fresh(), 'bound');
    const bound = openVectorIndex({ embedderId: 'hash:64', dim: 2 });
    bound.upsert('a', new Float32Array([1, 0]));
    await bound.save(filePath);
    await expect(openVectorIndex().load(filePath)).resolves.toBeUndefined();
  });

  it('missing and corrupt artifacts are refused with typed errors', async () => {
    const filePath = path.join(fresh(), 'gone');
    await expect(openVectorIndex().load(filePath)).rejects.toThrowError(
      expect.objectContaining({ code: 'embed/index-missing' }),
    );

    const partial = path.join(fresh(), 'partial');
    const index = openVectorIndex({ embedderId: 'e', dim: 2 });
    index.upsert('a', new Float32Array([1, 0]));
    await index.save(partial);
    fs.rmSync(`${partial}.bin`);
    await expect(openVectorIndex({ embedderId: 'e', dim: 2 }).load(partial)).rejects.toThrowError(
      expect.objectContaining({ code: 'embed/index-missing' }),
    );

    // Corrupt payload: wrong magic.
    const corrupt = path.join(fresh(), 'corrupt');
    await index.save(corrupt);
    const buf = fs.readFileSync(`${corrupt}.bin`);
    buf.write('XXXXXXXX', 0, 'ascii');
    fs.writeFileSync(`${corrupt}.bin`, buf);
    await expect(openVectorIndex({ embedderId: 'e', dim: 2 }).load(corrupt)).rejects.toThrowError(
      expect.objectContaining({ code: 'embed/index-corrupt' }),
    );

    // Truncated payload: header says 1 entry, bytes stop early.
    const truncated = path.join(fresh(), 'truncated');
    await index.save(truncated);
    fs.writeFileSync(`${truncated}.bin`, fs.readFileSync(`${truncated}.bin`).subarray(0, 24));
    await expect(openVectorIndex({ embedderId: 'e', dim: 2 }).load(truncated)).rejects.toThrowError(
      expect.objectContaining({ code: 'embed/index-corrupt' }),
    );
  });

  it('sidecar/payload disagreement is corrupt, not silently trusted', async () => {
    const filePath = path.join(fresh(), 'disagree');
    const index = openVectorIndex({ embedderId: 'e', dim: 2 });
    index.upsert('a', new Float32Array([1, 0]));
    await index.save(filePath);
    const sidecar = JSON.parse(fs.readFileSync(`${filePath}.meta.json`, 'utf8')) as SavedIndexMeta;
    sidecar.count = 7;
    fs.writeFileSync(`${filePath}.meta.json`, JSON.stringify(sidecar));
    await expect(openVectorIndex({ embedderId: 'e', dim: 2 }).load(filePath)).rejects.toThrowError(
      expect.objectContaining({ code: 'embed/index-corrupt' }),
    );
  });

  it('nested meta survives the roundtrip byte-for-byte as canonical JSON', async () => {
    const filePath = path.join(fresh(), 'meta');
    const index = openVectorIndex();
    index.upsert('a', new Float32Array([1, 0]), { z: 1, a: { deep: [3, 'two', true] } });
    await index.save(filePath);
    const target = openVectorIndex();
    await target.load(filePath);
    expect(target.search(new Float32Array([1, 0]), 1)[0]!.meta).toEqual({
      z: 1,
      a: { deep: [3, 'two', true] },
    });
  });
});

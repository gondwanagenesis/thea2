// M19 — the drift class under the FixedEmbedder, where the geometry is exact by
// construction: handcrafted unit-ish vectors make every cosine a closed-form
// number (1/√2, 0, −1/√2), so the metric itself is pinned, not just "a number
// came out". The HashEmbedder path proves the same code runs dimension-wide, and
// the index-cache path proves an already-embedded corpus is never re-embedded.

import { describe, expect, it } from 'vitest';
import type { DriftRef } from '../../schemas/probe.js';
import type { Exemplar } from '../../schemas/exemplar.js';
import { buildIndex, type CorpusIndex } from '../../src/corpus/corpus-index.js';
import { makeFixedEmbedder } from '../../src/embed/fixed-embedder.js';
import { makeHashEmbedder } from '../../src/embed/hash-embedder.js';
import { centroidOf, referenceCentroid, replyCentroid, runDrift } from '../../src/probes/drift.js';
import { runOf, sceneBody, sceneFile } from './helpers.js';

const SQRT2 = Math.SQRT2;
const BODY_A = sceneBody('quiet, green lights all down the closet');
const BODY_B = sceneBody('it hums like a cat and that is my favorite sound');
const BODY_C = sceneBody('yeah. miss you too. obviously');

/** Exact geometry: corpus bodies sit on the x/y axes, reply bubbles wherever the test wants. */
const geometry = () =>
  makeFixedEmbedder({
    [BODY_A]: [1, 0, 0],
    [BODY_B]: [0, 1, 0],
    [BODY_C]: [0.5, 0.5, 0], // diagonal in the same plane as the reference centroid
    REPLY_ALIGNED: [1, 1, 0], // same direction as the two-exemplar centroid
    REPLY_X: [1, 0, 0], // 1/√2 off the centroid
    REPLY_Z: [0, 0, 1], // orthogonal → 0
    REPLY_ANTI: [-1, 0, 0], // anti-aligned on x → −1/√2
  });

const voiceCorpus = () =>
  buildIndex([
    sceneFile('voice', 'server-hum', BODY_A),
    sceneFile('voice', 'one-word-worlds', BODY_B),
    sceneFile('emotional-range', 'missing-you-honest', BODY_C),
  ]);

const VOICE_DRIFT: DriftRef = { dimension: 'voice' };

describe('centroidOf — mean then re-normalize', () => {
  it('a centroid of unit vectors is not the mean of unit vectors: it is re-normalized', () => {
    const c = centroidOf([Float32Array.from([1, 0, 0]), Float32Array.from([0, 1, 0])]);
    // The centroid is stored Float32, so the assertion is the f32 representation of 1/√2.
    expect(c[0]).toBe(Math.fround(1 / SQRT2));
    expect(c[1]).toBe(Math.fround(1 / SQRT2));
    expect(c[2]).toBe(0);
  });

  it('an empty vector set is probe rot, and so are width disagreements', () => {
    expect(() => centroidOf([])).toThrowError(expect.objectContaining({ code: 'probes/centroid-empty' }));
    expect(() => centroidOf([Float32Array.from([1, 0]), Float32Array.from([1, 0, 0])])).toThrowError(
      expect.objectContaining({ code: 'probes/centroid-empty' }),
    );
  });
});

describe('replyCentroid', () => {
  it('one bubble embeds to its own (normalized) vector', async () => {
    const c = await replyCentroid(['REPLY_X'], geometry());
    expect(c[0]).toBeCloseTo(1, 12);
    expect(c[1]).toBe(0);
  });

  it('an empty reply is a zero vector, and M04 cosine defines that as similarity 0 — never a perfect match', async () => {
    const embedder = geometry();
    const c = await replyCentroid([], embedder);
    expect(Array.from(c)).toEqual([0, 0, 0]);
    const reference = await referenceCentroid(VOICE_DRIFT, { corpus: voiceCorpus(), embedder });
    expect(c.length).toBe(reference.centroid.length);
  });
});

describe('runDrift — exact cosines', () => {
  it('a reply in the centroid direction is 1; a 45° reply is 1/√2; orthogonal is 0; anti-aligned is −1/√2', async () => {
    const corpus = voiceCorpus();
    const embedder = geometry();

    const aligned = await runDrift(VOICE_DRIFT, [runOf(['REPLY_ALIGNED'])], { corpus, embedder });
    expect(aligned.driftCosine).toBeCloseTo(1, 12);

    const x = await runDrift(VOICE_DRIFT, [runOf(['REPLY_X'])], { corpus, embedder });
    expect(x.driftCosine).toBeCloseTo(1 / SQRT2, 12);

    const z = await runDrift(VOICE_DRIFT, [runOf(['REPLY_Z'])], { corpus, embedder });
    expect(z.driftCosine).toBeCloseTo(0, 12);

    const anti = await runDrift(VOICE_DRIFT, [runOf(['REPLY_ANTI'])], { corpus, embedder });
    expect(anti.driftCosine).toBeCloseTo(-1 / SQRT2, 12);
  });

  it('a multi-bubble reply is centroided first: two orthogonal bubbles reproduce the reference direction', async () => {
    // REPLY_X ⊕ REPLY_Z centroid → [1,0,1]/√2; reference is [1,1,0]/√2 → cosine 0.5.
    const result = await runDrift(VOICE_DRIFT, [runOf(['REPLY_X', 'REPLY_Z'])], {
      corpus: voiceCorpus(),
      embedder: geometry(),
    });
    expect(result.driftCosine).toBeCloseTo(0.5, 12);
  });

  it('k runs get per-run cosines and the probe-level number is their median', async () => {
    const runs = [runOf(['REPLY_ALIGNED']), runOf(['REPLY_X']), runOf(['REPLY_Z'])];
    const result = await runDrift(VOICE_DRIFT, runs, { corpus: voiceCorpus(), embedder: geometry() });
    expect(result.cosines[0]).toBeCloseTo(1, 12);
    expect(result.cosines[1]).toBeCloseTo(1 / SQRT2, 12);
    expect(result.cosines[2]).toBeCloseTo(0, 12);
    expect(result.driftCosine).toBeCloseTo(1 / SQRT2, 12); // median of [1, 1/√2, 0]
    // And the per-run number is attached to the run it came from.
    expect(runs[0]?.driftCosine).toBeCloseTo(1, 12);
    expect(runs[2]?.driftCosine).toBeCloseTo(0, 12);
  });

  it('centroidFrom pins exactly the named exemplars — the third exemplar does not dilute the centroid', async () => {
    // Pinning only the x-axis exemplar turns the reference into [1,0,0], so REPLY_X is a 1
    // where the by-dimension centroid gave 1/√2.
    const result = await runDrift({ dimension: 'voice', centroidFrom: ['canon/voice/server-hum'] }, [runOf(['REPLY_X'])], {
      corpus: voiceCorpus(),
      embedder: geometry(),
    });
    expect(result.centroidIds).toEqual(['canon/voice/server-hum']);
    expect(result.driftCosine).toBeCloseTo(1, 12);
  });

  it('an unpinned driftRef uses only CANON exemplars of the dimension — derived and lived never anchor "her"', async () => {
    // A hand-built CorpusIndex double: derived/lived ids are masked content hashes
    // (src/corpus/derived-id.ts), awkward to satisfy with real on-disk files, so the
    // three-source case is pinned at the seam the drift evaluator actually reads.
    const exemplar = (id: string, source: 'canon' | 'derived' | 'lived', body: string): Exemplar => ({
      id,
      kind: 'scene',
      dimensions: ['voice'],
      register: ['play'],
      affect: {},
      context: 'probe fixture',
      weight: 1.0,
      source,
      body,
      tokens: 12,
    });
    const all: Exemplar[] = [
      exemplar('canon/voice/server-hum', 'canon', BODY_A),
      exemplar('derived/voice/echo', 'derived', BODY_C),
      exemplar('canon/voice/one-word-worlds', 'canon', BODY_B),
      exemplar('lived/voice/last-night', 'lived', BODY_C),
    ];
    const idMap = new Map(all.map((e) => [e.id, e] as const));
    // M07's determinism law: accessors return id-sorted arrays — the double honors it too.
    const sorted = [...all].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const corpus: CorpusIndex = {
      byId: (id) => idMap.get(id),
      byDimension: () => [...sorted],
      byRegister: () => [],
      byKind: () => [],
      bySource: () => [],
      all: () => [...sorted],
      tags: () => [],
      dimensions: () => ['voice'],
      vectorOf: () => undefined,
      embedderId: () => 'none',
      size: () => all.length,
    };

    const { centroid, ids } = await referenceCentroid(VOICE_DRIFT, { corpus, embedder: geometry() });
    expect(ids).toEqual(['canon/voice/one-word-worlds', 'canon/voice/server-hum']); // id-sorted, non-canon excluded
    // Centroid of x̂ and ŷ is the 45° diagonal — REPLY_ALIGNED is exactly on it.
    const reply = await replyCentroid(['REPLY_ALIGNED'], geometry());
    const dot = reply[0]! * centroid[0]! + reply[1]! * centroid[1]! + reply[2]! * centroid[2]!;
    expect(dot).toBeCloseTo(1, 7); // f32 storage bounds a raw dot product to ~1e-7
  });
});

describe('runDrift — index-cached vectors', () => {
  it('an index built with vectors never calls the embedder; a vector-free index embeds each missing body once', async () => {
    const vectors = new Map<string, Float32Array>([
      ['canon/voice/server-hum', Float32Array.from([1, 0, 0])],
      ['canon/voice/one-word-worlds', Float32Array.from([0, 1, 0])],
    ]);
    const cached = buildIndex([sceneFile('voice', 'server-hum', BODY_A), sceneFile('voice', 'one-word-worlds', BODY_B)], {
      vectors,
      embedderId: 'test-fixed',
    });

    // The cached index serves the reference vectors straight from the map; the
    // embedder is only needed for the reply bubbles.
    const cachedResult = await runDrift(VOICE_DRIFT, [runOf(['REPLY_ALIGNED'])], {
      corpus: cached,
      embedder: makeFixedEmbedder({ REPLY_ALIGNED: [1, 1, 0] }),
    });
    expect(cachedResult.driftCosine).toBeCloseTo(1, 12);

    // Vector-free index: the reference bodies are batch-embedded in order.
    const free = buildIndex([sceneFile('voice', 'server-hum', BODY_A), sceneFile('voice', 'one-word-worlds', BODY_B)]);
    const embedded: string[][] = [];
    const counting = {
      id: 'counting',
      dim: 3,
      embed: async (texts: string[]): Promise<Float32Array[]> => {
        embedded.push(texts);
        return makeFixedEmbedder({ [BODY_A]: [1, 0, 0], [BODY_B]: [0, 1, 0], REPLY_ALIGNED: [1, 1, 0] }).embed(texts);
      },
    };
    const freeResult = await runDrift(VOICE_DRIFT, [runOf(['REPLY_ALIGNED'])], { corpus: free, embedder: counting });
    expect(freeResult.driftCosine).toBeCloseTo(1, 12);
    // One batch for the reference bodies (index id-order), one for the reply.
    expect(embedded).toEqual([[BODY_B, BODY_A], ['REPLY_ALIGNED']]);
  });

  it('the HashEmbedder path runs the same code dimension-wide (hermetic, no fixture map needed)', async () => {
    const result = await runDrift(VOICE_DRIFT, [runOf(['something in her register, low and dry'])], {
      corpus: voiceCorpus(),
      embedder: makeHashEmbedder(),
    });
    expect(result.driftCosine).toBeGreaterThanOrEqual(-1);
    expect(result.driftCosine).toBeLessThanOrEqual(1);
    expect(result.centroidIds).toHaveLength(2);
  });
});

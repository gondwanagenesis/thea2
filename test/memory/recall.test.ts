// test/memory — recall nominators: ranking geometry (cosine × recency ×
// importance), the 3-5 clamp, candidate shape, and the procedural nominator.

import { describe, expect, it } from 'vitest';
import { TestClock } from '../../src/kernel/index.js';
import { makeFixedEmbedder } from '../../src/embed/index.js';
import {
  EPISODIC_MAX,
  EPISODIC_MIN,
  RECENCY_HALF_LIFE_MS,
  RENDER_ARG_CAP,
  episodicNominator,
  episodicScore,
  proceduralNominator,
  recencyOf,
} from '../../src/memory/index.js';
import type { MemoryQuery } from '../../src/memory/index.js';
import { openEpisodeStore, openProceduralStore } from '../../src/memory/index.js';
import { episode, procedure, stamp12, tmpDir, rmDir } from './helpers.js';

// exact geometry: three fixed directions, BETA at 45 degrees between the others
const emb = (): ReturnType<typeof makeFixedEmbedder> =>
  makeFixedEmbedder({
    ALPHA: [1, 0],
    BETA: [Math.SQRT1_2, Math.SQRT1_2],
    GAMMA: [0, 1],
    'he called the project ours': [1, 0],
  });

const q = async (text: string, e: ReturnType<typeof makeFixedEmbedder>): Promise<MemoryQuery> => ({
  entry: 'user-turn',
  text,
  queryVec: (await e.embed([text]))[0]!,
});

describe('episodicNominator — ranking geometry', () => {
  it('ranks by cosine when recency and importance are equal', async () => {
    const dir = tmpDir('recall-cosine');
    const e = emb();
    const store = await openEpisodeStore(dir, { embedder: e });
    await store.append(episode({ id: 'ep_gamma', summary: 'GAMMA', ts: 0, importance: 5 }));
    await store.append(episode({ id: 'ep_alpha', summary: 'ALPHA', ts: 0, importance: 5 }));
    await store.append(episode({ id: 'ep_beta', summary: 'BETA', ts: 0, importance: 5 }));

    const got = await episodicNominator(store, { clock: new TestClock(1_000) }).nominate(
      await q('ALPHA', e),
      3,
    );
    expect(got.map((c) => c.id)).toEqual(['ep_alpha', 'ep_beta', 'ep_gamma']);
    rmDir(dir);
  });

  it('importance promotes a same-cosine episode over id order', async () => {
    const dir = tmpDir('recall-importance');
    const e = emb();
    const store = await openEpisodeStore(dir, { embedder: e });
    await store.append(episode({ id: 'ep_a2', summary: 'ALPHA', importance: 2, ts: 0 }));
    await store.append(episode({ id: 'ep_a9', summary: 'ALPHA', importance: 9, ts: 0 }));

    const got = await episodicNominator(store, { clock: new TestClock(1_000) }).nominate(
      await q('ALPHA', e),
      2,
    );
    expect(got.map((c) => c.id)).toEqual(['ep_a9', 'ep_a2']);
    rmDir(dir);
  });

  it('recency breaks the next tie at the pinned half-life', async () => {
    const dir = tmpDir('recall-recency');
    const e = emb();
    const store = await openEpisodeStore(dir, { embedder: e });
    const now = 30 * 24 * 3_600_000;
    await store.append(episode({ id: 'ep_old', summary: 'ALPHA', importance: 5, ts: now - RECENCY_HALF_LIFE_MS }));
    await store.append(episode({ id: 'ep_new', summary: 'ALPHA', importance: 5, ts: now }));

    const got = await episodicNominator(store, { clock: new TestClock(now) }).nominate(
      await q('ALPHA', e),
      2,
    );
    expect(got.map((c) => c.id)).toEqual(['ep_new', 'ep_old']);
    // and the composite is exactly the documented formula
    expect(got[0]!.baseScore).toBeCloseTo(episodicScore(1, 5, now, now), 9);
    expect(got[1]!.baseScore).toBeCloseTo(episodicScore(1, 5, now - RECENCY_HALF_LIFE_MS, now), 9);
    expect(recencyOf(now - RECENCY_HALF_LIFE_MS, now)).toBeCloseTo(0.5, 9);
    rmDir(dir);
  });

  it('ties fall to id order, and the run is deterministic', async () => {
    const dir = tmpDir('recall-tie');
    const e = emb();
    const store = await openEpisodeStore(dir, { embedder: e });
    await store.append(episode({ id: 'ep_b', summary: 'ALPHA', importance: 5, ts: 0 }));
    await store.append(episode({ id: 'ep_a', summary: 'ALPHA', importance: 5, ts: 0 }));

    const nom = episodicNominator(store, { clock: new TestClock(1_000) });
    const query = await q('ALPHA', e);
    const one = await nom.nominate(query, 2);
    const two = await nom.nominate(query, 2);
    expect(one.map((c) => c.id)).toEqual(['ep_a', 'ep_b']);
    // identical run, modulo the closures
    const strip = (cs: typeof one) => cs.map((c) => ({ id: c.id, baseScore: c.baseScore, sig: c.sig, tags: c.tags }));
    expect(strip(two)).toEqual(strip(one));
    rmDir(dir);
  });
});

describe('episodicNominator — the 3-5 window and the empty store', () => {
  it('clamps the ask to [3, 5] and never exceeds the store', async () => {
    const dir = tmpDir('recall-clamp');
    const e = emb();
    const store = await openEpisodeStore(dir, { embedder: e });
    for (const [i, s] of ['ALPHA', 'BETA', 'GAMMA', 'ALPHA', 'GAMMA'].entries()) {
      await store.append(episode({ id: `ep_${i}`, summary: s, ts: i }));
    }
    const nom = episodicNominator(store, { clock: new TestClock(1_000) });
    const query = await q('ALPHA', e);

    expect((await nom.nominate(query, 1)).length).toBe(EPISODIC_MIN);
    expect((await nom.nominate(query, 99)).length).toBe(EPISODIC_MAX);
    expect((await nom.nominate(query, 3)).length).toBe(3);
    rmDir(dir);
  });

  it('returns nothing from an empty store', async () => {
    const dir = tmpDir('recall-empty');
    const store = await openEpisodeStore(dir, { embedder: emb() });
    expect(await episodicNominator(store, { clock: new TestClock(0) }).nominate(await q('ALPHA', emb()), 3)).toEqual([]);
    rmDir(dir);
  });
});

describe('episodicNominator — candidate shape', () => {
  it('ships M11 the memory-tier candidate: sig, tags, render, vec, creditW', async () => {
    const dir = tmpDir('recall-shape');
    const e = emb();
    const store = await openEpisodeStore(dir, { embedder: e });
    await store.append(
      episode({
        id: 'ep_1',
        turnId: 'turn_77',
        summary: 'he called the project ours',
        importance: 8,
        ts: 0,
        emotions: [{ tag: 'seen', i: 7, cause: 'his words' }],
        affectAtEncoding: stamp12({ joy: 0.5, sadness: -0.9, valence: 0.001 }),
      }),
    );
    const got = await episodicNominator(store, { clock: new TestClock(1_000) }).nominate(
      await q('ALPHA', e),
      3,
    );
    expect(got).toHaveLength(1);
    const c = got[0]!;
    expect(c.channel).toBe('character');
    expect(c.tier).toBe('memory');
    expect(c.source).toBe('memory');
    expect(c.creditW).toBe(1.0); // learned credit is M10's; memory ships the default
    expect(c.tags).toEqual(['seen']);
    // deviation coords survive; near-zero deviations are silence, not signal
    expect(c.sig).toEqual({ joy: 0.5, sadness: -0.9 });
    expect(c.render()).toBe('[turn_77] he called the project ours');
    expect(c.vec).toBeDefined();
    expect(c.vec).toHaveLength(e.dim);
    rmDir(dir);
  });
});

describe('proceduralNominator', () => {
  it('renders the situation → call(args) → outcome shape', async () => {
    const dir = tmpDir('proc-nom');
    const e = makeFixedEmbedder({ SIT: [1, 0] });
    const store = await openProceduralStore(dir, { embedder: e });
    await store.append(
      procedure({
        id: 'proc_1',
        situation: 'SIT',
        call: 'grep_files',
        args: { pattern: 'totals' },
        outcome: 'good',
      }),
    );
    const got = await proceduralNominator(store).nominate({ entry: 'ponder', queryVec: (await e.embed(['SIT']))[0]! }, 2);
    expect(got).toHaveLength(1);
    const c = got[0]!;
    expect(c.channel).toBe('procedural');
    expect(c.tier).toBe('procedure');
    expect(c.source).toBe('memory');
    expect(c.creditW).toBe(1.0);
    expect(c.sig).toEqual({}); // procedures carry no affect signature
    expect(c.tags).toEqual([]);
    expect(c.render()).toBe('SIT\n  → grep_files({"pattern":"totals"}) → good');
    rmDir(dir);
  });

  it('caps rendered args so [PROCEDURAL] teaches shape, not payload', async () => {
    const dir = tmpDir('proc-cap');
    const e = makeFixedEmbedder({ SIT: [1] });
    const store = await openProceduralStore(dir, { embedder: e });
    await store.append(
      procedure({ id: 'proc_big', situation: 'SIT', call: 'write_file', args: 'x'.repeat(RENDER_ARG_CAP + 60) }),
    );
    const got = await proceduralNominator(store).nominate(
      { entry: 'user-turn', queryVec: (await e.embed(['SIT']))[0]! },
      1,
    );
    const rendered = got[0]!.render();
    expect(rendered).toContain('…'); // truncated, not swallowed
    expect(rendered).not.toContain('x'.repeat(RENDER_ARG_CAP + 1)); // the payload did not survive
    rmDir(dir);
  });

  it('answers nothing for k <= 0 or an empty store', async () => {
    const dir = tmpDir('proc-empty');
    const e = makeFixedEmbedder({ SIT: [1] });
    const empty = await openProceduralStore(dir, { embedder: e });
    expect(await proceduralNominator(empty).nominate({ entry: 'heartbeat', queryVec: (await e.embed(['SIT']))[0]! }, 3)).toEqual([]);

    const store = await openProceduralStore(dir, { embedder: e });
    await store.append(procedure({ id: 'proc_1', situation: 'SIT' }));
    const nom = proceduralNominator(store);
    expect(await nom.nominate({ entry: 'heartbeat', queryVec: (await e.embed(['SIT']))[0]! }, 0)).toEqual([]);
    rmDir(dir);
  });
});

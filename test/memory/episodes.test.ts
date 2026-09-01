// test/memory — the EpisodeStore: boundary schema, JSONL+index persistence with
// its self-heal and orphan refusal, the draft builder, and planted-fact search.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeHashEmbedder } from '../../src/embed/index.js';
import {
  draftEpisode,
  openEpisodeStore,
} from '../../src/memory/index.js';
import type { Clock, Rng } from '../../src/kernel/index.js';
import { TestClock, makeRng } from '../../src/kernel/index.js';
import { episode, stamp12, tmpDir, rmDir } from './helpers.js';

const embedder = (): ReturnType<typeof makeHashEmbedder> => makeHashEmbedder();

describe('EpisodeStore — the store boundary', () => {
  it('refuses a malformed episode with memory/bad-episode and writes nothing', async () => {
    const dir = tmpDir('bad-episode');
    const store = await openEpisodeStore(dir, { embedder: embedder() });
    await expect(
      store.append(episode({ importance: 11 })),
    ).rejects.toMatchObject({ code: 'memory/bad-episode' });
    await expect(store.append(episode({ summary: '' }))).rejects.toMatchObject({ code: 'memory/bad-episode' });
    expect(store.size()).toBe(0);
    expect(fs.existsSync(path.join(dir, 'episodes.jsonl'))).toBe(false);
  });

  it('refuses a duplicate id', async () => {
    const dir = tmpDir('dup');
    const store = await openEpisodeStore(dir, { embedder: embedder() });
    await store.append(episode({ id: 'ep_x', summary: 'first' }));
    await expect(store.append(episode({ id: 'ep_x', summary: 'second' }))).rejects.toMatchObject({
      code: 'memory/duplicate-id',
    });
    expect(store.size()).toBe(1);
    rmDir(dir);
  });

  it('accepts a well-formed episode and answers search over it', async () => {
    const dir = tmpDir('accept');
    const emb = embedder();
    const store = await openEpisodeStore(dir, { embedder: emb });
    const rec = episode({ id: 'ep_a', summary: 'we planned the jazz night', importance: 8 });
    await store.append(rec);
    expect(store.size()).toBe(1);
    const q = (await emb.embed(['we planned the jazz night']))[0]!;
    const hits = store.search(q, 1);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.e.id).toBe('ep_a');
    expect(hits[0]!.score).toBeGreaterThan(0.99);
    rmDir(dir);
  });
});

describe('EpisodeStore — persistence', () => {
  it('round-trips: a reopened store replays the log and the index', async () => {
    const dir = tmpDir('roundtrip');
    const emb = embedder();
    const first = await openEpisodeStore(dir, { embedder: emb });
    await first.append(episode({ id: 'ep_1', summary: 'he called me at midnight' }));
    await first.append(episode({ id: 'ep_2', summary: 'we argued about the movie', ts: 5 }));

    const second = await openEpisodeStore(dir, { embedder: emb });
    expect(second.size()).toBe(2);
    expect(second.all().map((e) => e.id)).toEqual(['ep_1', 'ep_2']); // log order, oldest first
    const q = (await emb.embed(['he called me at midnight']))[0]!;
    expect(second.search(q, 1)[0]!.e.id).toBe('ep_1');
    rmDir(dir);
  });

  it('self-heals a lost index by re-embedding from the log', async () => {
    const dir = tmpDir('self-heal');
    const emb = embedder();
    const first = await openEpisodeStore(dir, { embedder: emb });
    await first.append(episode({ id: 'ep_1', summary: 'theplantedsentence one' }));
    await first.append(episode({ id: 'ep_2', summary: 'another sentence entirely', ts: 5 }));

    // crash between the row write and the index save, at the crudest level
    fs.rmSync(path.join(dir, 'embeddings.bin'), { force: true });
    fs.rmSync(path.join(dir, 'embeddings.meta.json'), { force: true });

    const reopened = await openEpisodeStore(dir, { embedder: emb });
    expect(reopened.size()).toBe(2);
    const q = (await emb.embed(['theplantedsentence one']))[0]!;
    expect(reopened.search(q, 2)[0]!.e.id).toBe('ep_1');
    rmDir(dir);
  });

  it('refuses an index that holds ids the log does not (memory/index-orphan)', async () => {
    const dir = tmpDir('orphan');
    const emb = embedder();
    const first = await openEpisodeStore(dir, { embedder: emb });
    await first.append(episode({ id: 'ep_1', summary: 'kept' }));
    await first.append(episode({ id: 'ep_2', summary: 'row deleted behind the index' }));

    // the log loses a row (the record of truth), the index still knows both ids
    const logPath = path.join(dir, 'episodes.jsonl');
    const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter((l) => l !== '');
    fs.writeFileSync(logPath, lines.slice(1).join('\n') + '\n', 'utf8');

    await expect(openEpisodeStore(dir, { embedder: emb })).rejects.toMatchObject({
      code: 'memory/index-orphan',
    });
    rmDir(dir);
  });

  it('skips garbage log lines instead of failing boot', async () => {
    const dir = tmpDir('garbage');
    const emb = embedder();
    const first = await openEpisodeStore(dir, { embedder: emb });
    await first.append(episode({ id: 'ep_1', summary: 'kept' }));
    fs.appendFileSync(path.join(dir, 'episodes.jsonl'), '{"id": "ep_2", "half a row\n', 'utf8');
    await first.append(episode({ id: 'ep_3', summary: 'also kept', ts: 9 }));

    const reopened = await openEpisodeStore(dir, { embedder: emb });
    expect(reopened.size()).toBe(2);
    expect(reopened.all().map((e) => e.id)).toEqual(['ep_1', 'ep_3']);
    rmDir(dir);
  });

  it('produces vectors on demand: vecOf is a cache, vecsFor fills it in one batch', async () => {
    const dir = tmpDir('vecs');
    const emb = embedder();
    const store = await openEpisodeStore(dir, { embedder: emb });
    await store.append(episode({ id: 'ep_1', summary: 'alpha' }));

    // a reopened store has no vectors cached until something asks for them
    const reopened = await openEpisodeStore(dir, { embedder: emb });
    expect(reopened.vecOf('ep_1')).toBeUndefined();
    // an id the store does not hold is a caller bug, not a silent skip
    await expect(reopened.vecsFor(['ep_1', 'ep_missing'])).rejects.toMatchObject({ code: 'memory/unknown-id' });
    await reopened.vecsFor(['ep_1']);
    const vec = reopened.vecOf('ep_1');
    expect(vec).toBeDefined();
    expect(vec).toHaveLength(emb.dim);
    expect(vec!.some((v) => v !== 0)).toBe(true);
    expect(reopened.vecOf('ep_missing')).toBeUndefined();
    expect(reopened.search((await emb.embed(['alpha']))[0]!, 1)[0]!.e.vec).toBeDefined();
    rmDir(dir);
  });
});

describe('EpisodeStore — slices', () => {
  it('recent() is newest-first and byThread() filters newest-first', async () => {
    const dir = tmpDir('slices');
    const store = await openEpisodeStore(dir, { embedder: embedder() });
    await store.append(episode({ id: 'ep_1', ts: 1, threads: ['jazz'] }));
    await store.append(episode({ id: 'ep_2', ts: 2, threads: ['thesis'] }));
    await store.append(episode({ id: 'ep_3', ts: 3, threads: ['jazz'] }));

    expect(store.recent(2).map((e) => e.id)).toEqual(['ep_3', 'ep_2']);
    expect(store.recent(0)).toEqual([]);
    expect(store.byThread('jazz').map((e) => e.id)).toEqual(['ep_3', 'ep_1']);
    expect(store.byThread('nothing')).toEqual([]);
    rmDir(dir);
  });
});

describe('draftEpisode', () => {
  const deps = (stamp: readonly number[]): { clock: Clock; rng: Rng; affectAt: () => readonly number[] } => ({
    clock: new TestClock(1_700_000_000_000),
    rng: makeRng('episode-draft'),
    affectAt: () => stamp,
  });

  it('maps an appraisal onto the durable record, stamp frozen at encoding', () => {
    const stamp = stamp12({ joy: 0.4, sadness: -0.3 });
    const mutable = [...stamp];
    const rec = draftEpisode(deps(mutable), {
      turnId: 'turn_9',
      ts: 1_700_000_000_000,
      appraisal: {
        importance: 8,
        emotions: [{ tag: 'fond', i: 6, cause: 'he wrote' }],
        diaryLine: 'he remembered',
        threads: [{ id: 'jazz', title: 'Jazz', status: 'open' }, { id: 'thesis', status: 'touched' }],
        outcomePrev: null,
      },
    });
    // the live state moves on; the episode keeps the room it was formed in
    mutable[2] = 0.99;
    expect(rec.summary).toBe('he remembered');
    expect(rec.diaryLine).toBe('he remembered');
    expect(rec.importance).toBe(8);
    expect(rec.emotions).toEqual([{ tag: 'fond', i: 6, cause: 'he wrote' }]);
    expect(rec.threads).toEqual(['jazz', 'thesis']); // ids only
    expect(rec.affectAtEncoding).toEqual(stamp);
    expect(rec.id).toMatch(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/); // kernel newId: ULID-shape
    expect(rec.ts).toBe(1_700_000_000_000);
    expect(rec.turnId).toBe('turn_9');
  });

  it('refuses a truncated affect stamp — mood congruence needs the full Vec12', () => {
    expect(() =>
      draftEpisode(deps([0, 0, 0]), {
        turnId: 't',
        ts: 0,
        appraisal: {
          importance: 1,
          emotions: [],
          diaryLine: 'x',
          threads: [],
          outcomePrev: null,
        },
      }),
    ).toThrowError(/12-dim/);
  });
});

describe('planted-fact recall over the store (deterministic HashEmbedder)', () => {
  it('finds the planted fact first, and finds it again identically', async () => {
    const dir = tmpDir('planted');
    const emb = embedder();
    const store = await openEpisodeStore(dir, { embedder: emb });
    await store.append(episode({ id: 'ep_jazz', summary: 'we are going to the jazz concert on friday' }));
    await store.append(episode({ id: 'ep_oven', summary: 'the oven broke and repair comes tuesday', ts: 10 }));
    await store.append(episode({ id: 'ep_thesis', summary: 'his thesis chapter two needs figures', ts: 20 }));

    const q = (await emb.embed(['friday jazz concert plans']))[0]!;
    const first = store.search(q, 3);
    expect(first[0]!.e.id).toBe('ep_jazz');

    const second = store.search(q, 3);
    expect(second.map((h) => [h.e.id, h.score])).toEqual(first.map((h) => [h.e.id, h.score]));
    rmDir(dir);
  });
});

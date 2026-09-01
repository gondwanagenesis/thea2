// test/memory — the ProceduralStore: the separation gate (a tool episode never
// surfaces from the episodic channel and vice versa), outcome-weighted ranking,
// and the delegation feedstock mapping.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TestClock, makeRng } from '../../src/kernel/index.js';
import { makeFixedEmbedder, makeHashEmbedder } from '../../src/embed/index.js';
import {
  OUTCOME_WEIGHT,
  openEpisodeStore,
  openProceduralStore,
  procedureFromDelegation,
  proceduralNominator,
  episodicNominator,
} from '../../src/memory/index.js';
import type { DelegationPayload } from '../../schemas/events.js';
import type { MemoryQuery } from '../../src/memory/index.js';
import { episode, procedure, tmpDir, rmDir } from './helpers.js';

const delegation = (over: Partial<DelegationPayload> = {}): DelegationPayload => ({
  kind: 'task',
  spawnId: 'spawn_1',
  situation: 'find where the ledger writes end-of-day totals',
  call: 'grep_files',
  argsSummary: 'pattern=totals dir=var/',
  resultSummary: '12 hits in 3 files',
  outcome: 'good',
  ...over,
});

describe('the separation gate — episodic and procedural never leak', () => {
  it('a procedure is invisible to the episodic channel and an episode to the procedural one, even at identical text', async () => {
    const dir = tmpDir('separation');
    const emb = makeFixedEmbedder({ 'identical words': [1, 0, 0] });
    const episodes = await openEpisodeStore(dir, { embedder: emb });
    const procedures = await openProceduralStore(dir, { embedder: emb });

    // SAME text, SAME vector — only the store boundary can tell them apart
    await episodes.append(episode({ id: 'ep_1', summary: 'identical words' }));
    await procedures.append(procedure({ id: 'proc_1', situation: 'identical words' }));

    const clock = new TestClock(1_000);
    const q: MemoryQuery = {
      entry: 'user-turn',
      text: 'identical words',
      queryVec: (await emb.embed(['identical words']))[0]!,
    };

    const fromEpisodic = await episodicNominator(episodes, { clock }).nominate(q, 3);
    expect(fromEpisodic.map((c) => c.id)).toEqual(['ep_1']);

    const fromProcedural = await proceduralNominator(procedures).nominate(q, 3);
    expect(fromProcedural.map((c) => c.id)).toEqual(['proc_1']);

    // and at the store layer, below the nominators
    expect(episodes.search(q.queryVec, 10).map((h) => h.e.id)).toEqual(['ep_1']);
    expect(procedures.search(q.queryVec, 10).map((h) => h.p.id)).toEqual(['proc_1']);
    rmDir(dir);
  });

  it('keeps two separate file pairs on disk', async () => {
    const dir = tmpDir('files');
    const emb = makeHashEmbedder();
    const episodes = await openEpisodeStore(dir, { embedder: emb });
    const procedures = await openProceduralStore(dir, { embedder: emb });
    await episodes.append(episode({ id: 'ep_1', summary: 'an experience' }));
    await procedures.append(procedure({ id: 'proc_1', situation: 'a situation' }));

    const readLines = (name: string): string =>
      fs.readFileSync(path.join(dir, name), 'utf8').split('\n').filter((l) => l !== '').join('\n');
    expect(readLines('episodes.jsonl')).toContain('an experience');
    expect(readLines('episodes.jsonl')).not.toContain('a situation');
    expect(readLines('procedural.jsonl')).toContain('a situation');
    expect(readLines('procedural.jsonl')).not.toContain('an experience');
    // each channel owns its index
    expect(fs.existsSync(path.join(dir, 'embeddings.meta.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'procedural-embeddings.meta.json'))).toBe(true);
    rmDir(dir);
  });
});

describe('ProceduralStore — the boundary and the ranking', () => {
  it('refuses malformed records, including undefined args/result', async () => {
    const dir = tmpDir('bad-proc');
    const store = await openProceduralStore(dir, { embedder: makeHashEmbedder() });
    await expect(store.append(procedure({ outcome: 'fine' as never }))).rejects.toMatchObject({
      code: 'memory/bad-procedure',
    });
    await expect(store.append(procedure({ args: undefined }))).rejects.toMatchObject({
      code: 'memory/bad-procedure',
    });
    await expect(store.append(procedure({ result: undefined }))).rejects.toMatchObject({
      code: 'memory/bad-procedure',
    });
    await expect(store.append(procedure({ situation: '' }))).rejects.toMatchObject({
      code: 'memory/bad-procedure',
    });
    expect(store.size()).toBe(0);
    rmDir(dir);
  });

  it('ranks good above mixed above bad on equal geometry', async () => {
    const dir = tmpDir('weights');
    const emb = makeFixedEmbedder({ 'one situation': [0, 1] });
    const store = await openProceduralStore(dir, { embedder: emb });
    await store.append(procedure({ id: 'proc_bad', situation: 'one situation', outcome: 'bad', ts: 1 }));
    await store.append(procedure({ id: 'proc_good', situation: 'one situation', outcome: 'good', ts: 2 }));
    await store.append(procedure({ id: 'proc_mixed', situation: 'one situation', outcome: 'mixed', ts: 3 }));

    const q = (await emb.embed(['one situation']))[0]!;
    const hits = store.search(q, 3);
    expect(hits.map((h) => h.p.outcome)).toEqual(['good', 'mixed', 'bad']);
    expect(hits[0]!.score / hits[2]!.score).toBeCloseTo(OUTCOME_WEIGHT.good / OUTCOME_WEIGHT.bad, 6);
    rmDir(dir);
  });

  it('round-trips through disk and re-ranks identically', async () => {
    const dir = tmpDir('proc-roundtrip');
    const emb = makeHashEmbedder();
    const first = await openProceduralStore(dir, { embedder: emb });
    await first.append(procedure({ id: 'proc_1', situation: 'restart the bridge service' }));
    await first.append(procedure({ id: 'proc_2', situation: 'reset the telegram webhook', outcome: 'bad' }));

    const second = await openProceduralStore(dir, { embedder: emb });
    expect(second.size()).toBe(2);
    const q = (await emb.embed(['restart the bridge service']))[0]!;
    expect(second.search(q, 1)[0]!.p.id).toBe('proc_1');
    rmDir(dir);
  });
});

describe('procedureFromDelegation', () => {
  it('maps the M13 delegation event onto the record shape, summaries stored as evidence', () => {
    const rec = procedureFromDelegation(
      { clock: new TestClock(5_000), rng: makeRng('delegation') },
      delegation(),
      { ts: 5_000 },
    );
    expect(rec.situation).toBe('find where the ledger writes end-of-day totals');
    expect(rec.call).toBe('grep_files');
    expect(rec.args).toBe('pattern=totals dir=var/');
    expect(rec.result).toBe('12 hits in 3 files');
    expect(rec.outcome).toBe('good');
    expect(rec.ts).toBe(5_000);
    expect(rec.id).toMatch(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/);
  });
});

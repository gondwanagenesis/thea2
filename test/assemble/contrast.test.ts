// M11 contrast tests — the slot takes the MAX-DISSIMILAR candidate that still
// passes register constraints: Euclidean distance in the 12-dim deviation space
// from the packet's mean signature, score only breaking ties. Score never buys
// this slot; eligibility always gates it.

import { describe, expect, it } from 'vitest';
import { fillCharacter, type Selection } from '../../src/assemble/quota.js';
import type { Scored } from '../../src/assemble/score.js';
import type { AssembleConfig, Candidate } from '../../src/assemble/index.js';
import { neutralCoherenceCfg } from './helpers.js';
import { cand } from './helpers.js';
import { query } from './helpers.js';

const cfg = (over: Partial<AssembleConfig> = {}): AssembleConfig =>
  neutralCoherenceCfg({
    quotas: { disposition: 0, pattern: 1, episodeMemoryMin: 0, episodeMemoryMax: 1, contrast: 1, proceduralMax: 0 },
    ...over,
  });

const sc = (id: string, score: number, sig: Candidate['sig'], tags: string[] = ['play']): Scored => ({
  c: cand({ id, tier: 'pattern', baseScore: score, sig, tags, render: () => `body ${id}` }),
  score,
  modulation: 0,
});

const contrastId = (sel: Selection): string | undefined =>
  sel.groups.find((g) => g.kind === 'contrast')?.members[0]?.c.id;

describe('the contrast slot', () => {
  it('takes the max-dissimilar leftover — score cannot buy it', () => {
    const q = query({});
    const pool = [
      sc('p/joy-high', 5, { joy: 0.5, arousal: 0.5 }),
      sc('p/joy-mid', 4, { joy: 0.4 }),
      sc('p/joy-near', 3, { joy: 0.3 }),
      sc('far/weak', 0.1, { sadness: 1.0, valence: -1.0 }),
      sc('far2/weak', 0.2, { sadness: 0.8 }),
    ];
    const sel = fillCharacter(pool, q, cfg());
    // pattern and episodeMemory take the high scorers; the far, low-scoring
    // signature is the one leftover the packet actually needs.
    expect(contrastId(sel)).toBe('far/weak');
    expect(sel.scarcity).toBe(false);
  });

  it('computes distance from the packet mean, not from the query', () => {
    // All candidates share one query embedding, so an embedding-space metric
    // could not tell them apart; the signature-space metric can.
    const q = query({});
    const pool = [
      sc('p/a', 5, { joy: 0.5, arousal: 0.5 }),
      sc('on-mean', 3, { joy: 0.45, arousal: 0.45 }),
      sc('b-mid', 2, { joy: 0.5 }),
      sc('a-far', 1, { sadness: 1.0, anger: 0.8 }),
    ];
    const sel = fillCharacter(pool, q, cfg());
    expect(contrastId(sel)).toBe('a-far'); // lowest score, farthest from the mean
  });

  it('skips an ineligible far candidate (forbidden pair with the selection) and takes the next', () => {
    const q = query({});
    const pool = [
      sc('p/banter', 5, { joy: 0.5 }, ['play', 'banter']),
      sc('far-crisis', 0.5, { sadness: 1.0 }, ['play', 'crisis']),
      sc('far-ok', 0.2, { sadness: 0.8 }),
    ];
    const sel = fillCharacter(pool, q, cfg({ quotas: { disposition: 0, pattern: 1, episodeMemoryMin: 0, episodeMemoryMax: 0, contrast: 1, proceduralMax: 0 } }));
    // far-crisis is more dissimilar, but crisis next to banter is a forbidden pair.
    expect(contrastId(sel)).toBe('far-ok');
  });

  it('breaks a dissimilarity tie by score, then id', () => {
    const q = query({});
    const noEm = cfg({ quotas: { disposition: 0, pattern: 1, episodeMemoryMin: 0, episodeMemoryMax: 0, contrast: 1, proceduralMax: 0 } });
    // mean over the selected pattern member is {joy: 0.5}; 't/lo' and 't/hi' are
    // equidistant (both 1.5), so the higher score wins.
    const pool = [
      sc('p/anchor', 5, { joy: 0.5 }),
      sc('t/lo', 0.4, { joy: -1.0 }),
      sc('t/hi', 0.9, { sadness: 1.0, valence: -1.0 }),
    ];
    expect(contrastId(fillCharacter(pool, q, noEm))).toBe('t/hi');

    // Full tie (same distance, same score): id ascending.
    const tied = [
      sc('p/anchor', 5, { joy: 0.5 }),
      sc('t/b', 0.5, { joy: -1.0 }),
      sc('t/a', 0.5, { sadness: 1.0, valence: -1.0 }),
    ];
    expect(contrastId(fillCharacter(tied, q, noEm))).toBe('t/a');
  });

  it('an empty leftover pool leaves the slot unfilled and marks scarcity', () => {
    const q = query({});
    const pool = [sc('p/only', 5, { joy: 0.5 })];
    const sel = fillCharacter(pool, q, cfg());
    expect(contrastId(sel)).toBeUndefined();
    expect(sel.scarcity).toBe(true);
  });
});

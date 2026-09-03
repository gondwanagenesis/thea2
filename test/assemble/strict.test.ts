// M11 — the register-strictness dial (Round 3 prep). mode_exclusive's rule
// itself lives in rules.ts (modeCompatible, not quota-owned); the dial and its
// consumption land in quota.ts's fill. Default stays EXCLUSION (the shipped
// mode-exclusivity law, pinned in quota.test.ts); strict:false demotes instead:
// out-of-register material is admitted behind every register-compatible
// candidate — the fill-time penalty, a total order, never a score rewrite.

import { describe, expect, it } from 'vitest';
import { fillCharacter, type Selection } from '../../src/assemble/quota.js';
import type { AssembleConfig } from '../../src/assemble/index.js';
import type { Scored } from '../../src/assemble/score.js';
import { cand, neutralCoherenceCfg, query } from './helpers.js';

const cfg: AssembleConfig = neutralCoherenceCfg({
  quotas: { disposition: 0, pattern: 2, episodeMemoryMin: 0, episodeMemoryMax: 2, contrast: 0, proceduralMax: 0 },
});

const sc = (id: string, score: number, tags: string[]): Scored => ({
  c: cand({ id, tier: 'pattern', baseScore: score, tags, render: () => `body ${id}` }),
  score,
  modulation: 0,
});

const groupOf = (sel: Selection, kind: string): Scored[] =>
  sel.groups.find((g) => g.kind === kind)?.members ?? [];

describe('register strictness (strict dial)', () => {
  it('strict false admits out-of-register scenes at a penalty', () => {
    const q = query({ register: 'play' });
    // The work scene outscores the play scene 3:1 — relevance cannot buy it past
    // the register law; the penalty is rank, not score.
    const pool = [sc('work/high', 3, ['work', 'precision']), sc('play-a', 1, ['play'])];

    const sel = fillCharacter(pool, q, cfg);
    expect(groupOf(sel, 'pattern').map((m) => m.c.id)).toEqual(['play-a']); // excluded, as always
    expect(sel.scarcity).toBe(true); // honestly short-handed, never padded with the work scene

    const lenient = fillCharacter(pool, q, { ...cfg, strict: false });
    const pattern = groupOf(lenient, 'pattern');
    expect(pattern.map((m) => m.c.id)).toEqual(['play-a', 'work/high']); // admitted, BEHIND the compatible one
    expect(lenient.scarcity).toBe(false);
    // The penalty never rewrites scores: baseScore stays the caller's credit-truth.
    expect(pattern[1]!.c.baseScore).toBe(3);
    expect(pattern[1]!.score).toBe(3);
  });

  it('register-compatible candidates always outrank penalized ones, then score desc, id asc', () => {
    const q = query({ register: 'work' });
    const pool = [
      sc('play/a', 5, ['play']),
      sc('work/a', 2, ['work']),
      sc('work/b', 1, ['work', 'precision']),
      sc('plain', 9, []), // no mode tag fits anywhere — never penalized
    ];
    const lenient = neutralCoherenceCfg({
      quotas: { disposition: 0, pattern: 3, episodeMemoryMin: 0, episodeMemoryMax: 0, contrast: 0, proceduralMax: 0 },
    });
    const sel = fillCharacter(pool, q, { ...lenient, strict: false });
    expect(groupOf(sel, 'pattern').map((m) => m.c.id)).toEqual(['plain', 'work/a', 'work/b']);
    expect(sel.scarcity).toBe(false);
  });
});

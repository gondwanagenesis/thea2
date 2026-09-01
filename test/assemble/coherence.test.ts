// M11 coherence tests — each layer's swap rule is pinned exactly: which slot is
// named the offender, where the replacement comes from, when the slot drops
// instead, and what three exhausted rounds produce.
//
// Members default to query-aligned vectors and a single 'play' tag so layers
// OTHER than the one under test have nothing to say; each test overrides only
// the fields its layer reads.

import { describe, expect, it } from 'vitest';
import { COHERENCE_LAYERS, runCoherence, type CoherenceCtx } from '../../src/assemble/coherence.js';
import { DEFAULT_ASSEMBLE_CONFIG, type AssembleConfig, type Candidate } from '../../src/assemble/index.js';
import type { Group, GroupKind, Selection } from '../../src/assemble/quota.js';
import type { Scored } from '../../src/assemble/score.js';
import { DIR_A, DIR_B, cand, vec3 } from './helpers.js';

const cfg: AssembleConfig = DEFAULT_ASSEMBLE_CONFIG;

const m = (id: string, score: number, over: Partial<Candidate> = {}): Scored => ({
  c: cand({ id, tier: 'pattern', baseScore: score, tags: ['play'], vec: vec3(DIR_A), ...over }),
  score,
  modulation: 0,
});

const grp = (kind: GroupKind, min: number, members: Scored[], runners: Scored[] = []): Group => ({
  kind,
  min,
  members,
  runners,
  out: [],
});

const selOf = (groups: Group[]): Selection => ({ groups, procedural: [], proceduralOut: [], scarcity: false });

const ctx = (over: Partial<CoherenceCtx> = {}): CoherenceCtx => ({
  queryVec: vec3(DIR_A),
  queryText: '',
  cfg,
  ...over,
});

const idsOf = (sel: Selection): string[] => sel.groups.flatMap((g) => g.members.map((x) => x.c.id));

describe('layer inventory', () => {
  it('evaluates in the pinned order', () => {
    expect([...COHERENCE_LAYERS]).toEqual([
      'forbidden-pairs',
      'dimension-caps',
      'register-tags',
      'signature-spread',
      'embedding-sanity',
    ]);
  });
});

describe('L1a — forbidden register pairs (contrast slot included)', () => {
  it('swaps the lower-scored member of an offending pair, from its own group', () => {
    const sel = selOf([
      grp('pattern', 2, [
        m('banter-high', 5, { tags: ['play', 'banter'] }),
        m('crisis-a', 1, { tags: ['play', 'crisis'] }),
      ], [m('runner-plain', 0.5)]),
    ]);
    const res = runCoherence(sel, ctx());
    expect(res).toEqual({ degraded: false, rounds: 1 });
    expect(idsOf(sel)).toEqual(['banter-high', 'runner-plain']);
    const g = sel.groups[0];
    expect(g?.out.map((x) => x.c.id)).toEqual(['crisis-a']);
  });

  it('names the offender by score, not by slot position', () => {
    const sel = selOf([
      grp('pattern', 2, [m('crisis-low', 0.2, { tags: ['play', 'crisis'] }), m('banter-high', 5, { tags: ['play', 'banter'] })], []),
    ]);
    runCoherence(sel, ctx());
    expect(sel.groups[0]?.out.map((x) => x.c.id)).toEqual(['crisis-low']);
  });

  it('a contrast-slot offender with no runner-up is dropped, not padded', () => {
    const sel = selOf([
      grp('pattern', 1, [m('banter-high', 5, { tags: ['play', 'banter'] })]),
      grp('contrast', 1, [m('crisis-contrast', 0.2, { tags: ['play', 'crisis'] })]),
    ]);
    const res = runCoherence(sel, ctx());
    expect(res).toEqual({ degraded: false, rounds: 1 });
    expect(sel.groups.find((g) => g.kind === 'contrast')?.members).toEqual([]);
  });
});

describe('L1b — dimension caps and the query-match lift', () => {
  it('caps a dimension and swaps the lowest-scored carrier', () => {
    const sel = selOf([
      grp('pattern', 2, [
        m('b-high', 3, { dimension: 'boundaries' }),
        m('b-low', 1, { dimension: 'boundaries' }),
      ], [m('b-runner', 0.5, { dimension: 'voice' })]),
    ]);
    const res = runCoherence(sel, ctx());
    expect(res).toEqual({ degraded: false, rounds: 1 });
    expect(idsOf(sel)).toEqual(['b-high', 'b-runner']);
    expect(sel.groups[0]?.out.map((x) => x.c.id)).toEqual(['b-low']);
  });

  it('lifts the cap when the query text matches the dimension', () => {
    const lifted: AssembleConfig = {
      ...cfg,
      dimensionMatchWords: { boundaries: ['boundaries'] },
    };
    const sel = selOf([
      grp('pattern', 2, [
        m('b-high', 3, { dimension: 'boundaries' }),
        m('b-low', 1, { dimension: 'boundaries' }),
      ], []),
    ]);
    const res = runCoherence(sel, ctx({ cfg: lifted, queryText: 'she asked about boundaries at work' }));
    expect(res).toEqual({ degraded: false, rounds: 0 });
    expect(idsOf(sel)).toEqual(['b-high', 'b-low']);
  });
});

describe('L1c — distinct register tags ≤ 2 (disposition and contrast exempt)', () => {
  it('swaps the lowest-scored carrier of a tag outside the allowed set', () => {
    const sel = selOf([
      grp('pattern', 2, [
        m('quiet-a', 3, { tags: ['play', 'quiet'] }),
        m('morning-b', 2, { tags: ['play', 'morning'] }),
        m('plain-c', 1),
      ], [m('runner-plain', 0.5)]),
    ]);
    const res = runCoherence(sel, ctx());
    // counts: play 3, quiet 1, morning 1 → allowed = {play, morning} (tie by tag asc)
    expect(res).toEqual({ degraded: false, rounds: 1 });
    expect(sel.groups[0]?.out.map((x) => x.c.id)).toEqual(['quiet-a']);
    expect(idsOf(sel)).toEqual(['morning-b', 'plain-c', 'runner-plain']);
  });

  it('the disposition slot is exempt — a third modifier on the keel never fires the layer', () => {
    const sel = selOf([
      grp('disposition', 1, [m('keel', 1, { tier: 'disposition', tags: ['play', 'quiet', 'late-night'] })]),
      grp('pattern', 2, [m('plain-a', 2), m('plain-b', 1)]),
    ]);
    const res = runCoherence(sel, ctx());
    expect(res).toEqual({ degraded: false, rounds: 0 });
  });

  it('the contrast slot is exempt', () => {
    const sel = selOf([
      grp('pattern', 2, [m('plain-a', 2), m('plain-b', 1)]),
      grp('contrast', 1, [m('odd-contrast', 0.5, { tags: ['play', 'reunion', 'morning'] })]),
    ]);
    const res = runCoherence(sel, ctx());
    expect(res).toEqual({ degraded: false, rounds: 0 });
  });
});

describe('L2 — per-dim signature spread ≤ 1.2 (contrast exempt)', () => {
  it('swaps the extreme offender on an over-wide dim (the first extreme in slot order on the midpoint tie)', () => {
    const sel = selOf([
      grp('pattern', 2, [
        m('sad-high', 3, { sig: { sadness: 0.9 } }),
        m('calm', 2, { sig: { joy: 0.2 } }),
      ]),
      grp('episodeMemory', 2, [m('sad-low', 1.5, { tier: 'episode', source: 'lived', sig: { sadness: -0.9 } })]),
    ]);
    const res = runCoherence(sel, ctx());
    // sadness range 1.8 > 1.2; both extremes are equidistant from the midpoint, so
    // the first extreme in slot order (pattern before episodeMemory) is named.
    expect(res).toEqual({ degraded: false, rounds: 1 });
    expect(sel.groups[0]?.out.map((x) => x.c.id)).toEqual(['sad-high']);
  });

  it('the contrast slot is exempt — a far signature is the point of that slot', () => {
    const sel = selOf([
      grp('pattern', 2, [m('calm-a', 2, { sig: { joy: 0.2 } }), m('calm-b', 1, { sig: { joy: 0.1 } })]),
      grp('contrast', 1, [m('far-contrast', 0.5, { sig: { sadness: -1.0, disgust: 0.9 } })]),
    ]);
    const res = runCoherence(sel, ctx());
    expect(res).toEqual({ degraded: false, rounds: 0 });
  });

  it('a spread within the threshold never fires', () => {
    const sel = selOf([
      grp('pattern', 2, [m('a', 2, { sig: { valence: 0.3 } }), m('b', 1, { sig: { valence: -0.6 } })]),
    ]);
    expect(runCoherence(sel, ctx())).toEqual({ degraded: false, rounds: 0 });
  });
});

describe('L3 — embedding sanity (pattern/episode tiers only)', () => {
  it('fails a pattern member anti-aligned with both the query and the packet centroid', () => {
    const anti = Float32Array.from([-1, 0, 0]);
    const sel = selOf([
      grp('pattern', 2, [
        m('aligned', 3),
        m('anti', 2, { vec: anti }),
        m('calm', 1, { vec: vec3(DIR_B) }),
      ], [m('runner', 0.5, { vec: vec3(DIR_B) })]),
    ]);
    const res = runCoherence(sel, ctx());
    // anti fails the query floor (cos −1) and the centroid floor (centroid ≈ +x).
    // The replacement from the runners faces the same way as the new centroid and passes.
    expect(res).toEqual({ degraded: false, rounds: 1 });
    expect(idsOf(sel)).toEqual(['aligned', 'calm', 'runner']);
  });

  it('fails a pattern member with no vector at all — unverifiable is not sane', () => {
    const sel = selOf([
      grp('pattern', 2, [m('with-vec', 3), m('no-vec', 2, { vec: undefined })], [m('runner', 1)]),
    ]);
    const res = runCoherence(sel, ctx());
    expect(res).toEqual({ degraded: false, rounds: 1 });
    expect(sel.groups[0]?.out.map((x) => x.c.id)).toEqual(['no-vec']);
  });

  it('memory-tier slots need no vector — the layer checks pattern/episode only', () => {
    const sel = selOf([
      grp('episodeMemory', 1, [m('mem', 2, { tier: 'memory', source: 'memory', vec: undefined })]),
    ]);
    expect(runCoherence(sel, ctx())).toEqual({ degraded: false, rounds: 0 });
  });

  it('rescues an off-query member through the packet centroid', () => {
    // Both members face DIR_B (orthogonal to the query) — but the packet centroid
    // faces DIR_B too, so cos(vec, centroid) = 1 ≥ 0.35.
    const sel = selOf([
      grp('pattern', 2, [m('b-one', 3, { vec: vec3(DIR_B) }), m('b-two', 2, { vec: vec3(DIR_B) })]),
    ]);
    expect(runCoherence(sel, ctx())).toEqual({ degraded: false, rounds: 0 });
  });
});

describe('the swap loop', () => {
  it('layer precedence: forbidden pairs are repaired before register tags', () => {
    const sel = selOf([
      grp('pattern', 3, [
        m('quiet-a', 3, { tags: ['play', 'quiet'] }),
        m('crisis-b', 2, { tags: ['play', 'crisis'] }),
        m('banter-c', 1, { tags: ['play', 'banter'] }),
      ]),
    ]);
    const res = runCoherence(sel, ctx());
    // Round 1 must be the crisis/banter pair (lower-scored banter-c dropped);
    // round 2 the quiet/crisis tag set resolves on quiet-a.
    expect(res).toEqual({ degraded: false, rounds: 2 });
    expect(sel.groups[0]?.out.map((x) => x.c.id)).toEqual(['banter-c', 'quiet-a']);
    expect(idsOf(sel)).toEqual(['crisis-b']);
  });

  it('three exhausted rounds with a violation still standing ⇒ degraded', () => {
    const sel = selOf([
      grp('pattern', 3, [
        m('banter-high', 5, { tags: ['play', 'banter'] }),
        m('crisis-m1', 1, { tags: ['play', 'crisis'] }),
        m('crisis-m2', 0.9, { tags: ['play', 'crisis'] }),
      ], [m('crisis-r1', 0.8, { tags: ['play', 'crisis'] }), m('crisis-r2', 0.7, { tags: ['play', 'crisis'] })]),
    ]);
    const res = runCoherence(sel, ctx());
    expect(res).toEqual({ degraded: true, rounds: 3 });
    // Every replacement re-offended (swapped-in members join the END of the slot
    // list, so the scan keeps finding a crisis/banter pair); the round-3 swap had
    // no runner left, so one offender remains standing.
    expect(idsOf(sel)).toEqual(['banter-high', 'crisis-r2']);
    expect(sel.groups[0]?.out.map((x) => x.c.id)).toEqual(['crisis-m1', 'crisis-m2', 'crisis-r1']);
  });

  it('a swapped-out candidate never returns within the same assembly', () => {
    const swapped = m('offender', 1, { tags: ['play', 'crisis'] });
    const sel = selOf([
      grp('pattern', 2, [
        m('banter-high', 5, { tags: ['play', 'banter'] }),
        swapped,
      ], [m('runner', 0.5)]),
    ]);
    runCoherence(sel, ctx());
    expect(sel.groups[0]?.out).toContain(swapped);
    expect(idsOf(sel)).not.toContain('offender');
  });

  it('a clean selection costs zero rounds', () => {
    const sel = selOf([
      grp('disposition', 1, [m('keel', 1, { tier: 'disposition' })]),
      grp('pattern', 2, [m('a', 2), m('b', 1)]),
    ]);
    expect(runCoherence(sel, ctx())).toEqual({ degraded: false, rounds: 0 });
  });
});

// M11 assemble — the three deterministic coherence layers and the swap loop.
//
// After quota fill, the selection is checked in a fixed layer order; the first
// violation found names an offender, which is replaced from its own group's
// ranked runner-up list (a pattern slot stays a pattern slot). At most
// `maxSwapRounds` swaps happen, then whatever still stands is accepted with
// coherence 'degraded' — never an exception, never a silent rewrite of the
// packet's character.
//
// Swap rules, pinned:
//   L1a forbidden pairs   offender = the lower-scored member of the offending pair
//   L1b dimension caps    offender = the lowest-scored carrier of the over-cap dimension
//   L1c register tags     counted over non-disposition, non-contrast slots; allowed set =
//                         the maxRegisterTags most common tags (count desc, tag asc);
//                         offender = the lowest-scored candidate carrying a tag outside it
//   L2 signature spread   per dim, max−min > spreadMax ⇒ offender = the candidate furthest
//                         from that dim's midpoint; the contrast slot is exempt
//   L3 embedding sanity   tier pattern/episode needs cos(vec, query) ≥ minQueryCos OR
//                         cos(vec, packet centroid) ≥ minCentroidCos; no vec fails —
//                         an unverifiable exemplar is not a sane one
//
// A swapped-out candidate never returns within the same assembly (that way lies
// oscillation), and a group with no runner-up left DROPS the offender: an
// unfilled slot is honest, a persistent offender is not.

import { AFFECT_DIMS, DIM_INDEX } from '../coupling/index.js';
import { cosineSimilarity } from '../embed/index.js';
import { compareStrings } from '../corpus/types.js';
import type { AssembleConfig } from './types.js';
import { denseOf, type Scored } from './score.js';
import { capLifted, registerTagsOf } from './rules.js';
import { characterMembers, isSelected, type Group, type Selection } from './quota.js';

export interface CoherenceCtx {
  queryVec: Float32Array;
  /** Lowercased query text + goal, for the dimension-cap lift. */
  queryText: string;
  cfg: AssembleConfig;
}

export interface CoherenceResult {
  degraded: boolean;
  rounds: number;
}

interface Offender {
  group: Group;
  slot: Scored;
}

/** Lowest-scored first — the tie-break makes "lower-scored" a total order. */
const lowestFirst = (x: Scored, y: Scored): number => x.score - y.score || compareStrings(x.c.id, y.c.id);

const groupOfScored = (sel: Selection, slot: Scored): Group => {
  const g = sel.groups.find((grp) => grp.members.includes(slot));
  if (g === undefined) throw new Error(`coherence: no group holds '${slot.c.id}'`);
  return g;
};

// --- L1a: forbidden register pairs (exclusions.yaml), contrast slot included ---

const scanForbiddenPairs = (sel: Selection, cfg: AssembleConfig): Offender | undefined => {
  const placed: Array<{ m: Scored; g: Group }> = [];
  for (const g of sel.groups) for (const m of g.members) placed.push({ m, g });
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const x = placed[i];
      const y = placed[j];
      if (x === undefined || y === undefined) continue;
      const xt = registerTagsOf(x.m.c, cfg);
      const yt = registerTagsOf(y.m.c, cfg);
      for (const [a, b] of cfg.forbiddenPairs) {
        if ((xt.includes(a) && yt.includes(b)) || (xt.includes(b) && yt.includes(a))) {
          const offender = lowestFirst(x.m, y.m) <= 0 ? x : y;
          return { group: offender.g, slot: offender.m };
        }
      }
    }
  }
  return undefined;
};

// --- L1b: dimension caps (exclusions.yaml dimension_caps) ---

const scanDimensionCaps = (sel: Selection, cfg: AssembleConfig, queryText: string): Offender | undefined => {
  for (const dim of Object.keys(cfg.dimensionCaps).sort(compareStrings)) {
    if (capLifted(dim, queryText, cfg)) continue;
    const cap = cfg.dimensionCaps[dim] ?? 0;
    const carriers: Array<{ m: Scored; g: Group }> = [];
    for (const g of sel.groups) {
      for (const m of g.members) {
        if (m.c.dimension === dim) carriers.push({ m, g });
      }
    }
    if (carriers.length > cap) {
      const offender = [...carriers].sort((a, b) => lowestFirst(a.m, b.m))[0];
      if (offender !== undefined) return { group: offender.g, slot: offender.m };
    }
  }
  return undefined;
};

// --- L1c: distinct register tags ≤ maxRegisterTags (disposition and contrast exempt) ---

const scanRegisterTags = (sel: Selection, cfg: AssembleConfig): Offender | undefined => {
  const counted = sel.groups
    .filter((g) => g.kind !== 'disposition' && g.kind !== 'contrast')
    .flatMap((g) => g.members);
  const counts = new Map<string, number>();
  for (const m of counted) {
    for (const t of registerTagsOf(m.c, cfg)) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  if (counts.size <= cfg.coherence.maxRegisterTags) return undefined;
  const allowed = new Set(
    [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || compareStrings(a[0], b[0]))
      .slice(0, cfg.coherence.maxRegisterTags)
      .map((e) => e[0]),
  );
  const offenders = counted.filter((m) => registerTagsOf(m.c, cfg).some((t) => !allowed.has(t)));
  const offender = [...offenders].sort(lowestFirst)[0];
  if (offender === undefined) return undefined;
  return { group: groupOfScored(sel, offender), slot: offender };
};

// --- L2: per-dim signature spread, contrast slot exempt ---

const scanSpread = (sel: Selection, cfg: AssembleConfig): Offender | undefined => {
  const counted = sel.groups.filter((g) => g.kind !== 'contrast').flatMap((g) => g.members);
  if (counted.length < 2) return undefined;
  const dense = counted.map((m) => denseOf(m.c.sig));
  for (const dim of AFFECT_DIMS) {
    const idx = DIM_INDEX[dim];
    let min = Infinity;
    let max = -Infinity;
    for (const d of dense) {
      const v = d[idx]!;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (max - min <= cfg.coherence.spreadMax) continue;
    const mid = (max + min) / 2;
    let worstIdx = 0;
    let worstDist = -1;
    for (let i = 0; i < counted.length; i++) {
      const dist = Math.abs(dense[i]![idx]! - mid);
      if (dist > worstDist) {
        worstDist = dist;
        worstIdx = i;
      }
    }
    const worst = counted[worstIdx];
    if (worst !== undefined) return { group: groupOfScored(sel, worst), slot: worst };
  }
  return undefined;
};

// --- L3: embedding sanity for pattern/episode tiers ---

const scanEmbeddingSanity = (sel: Selection, ctx: CoherenceCtx): Offender | undefined => {
  const members = characterMembers(sel);
  const withVec = members.filter((m) => m.c.vec !== undefined);
  const centroid = new Float32Array(withVec[0]?.c.vec?.length ?? 0);
  if (withVec.length > 0 && centroid.length > 0) {
    for (const m of withVec) {
      const v = m.c.vec;
      if (v === undefined) continue;
      for (let i = 0; i < centroid.length; i++) centroid[i] = centroid[i]! + v[i]!;
    }
    for (let i = 0; i < centroid.length; i++) centroid[i] = centroid[i]! / withVec.length;
  }
  const failing = members.filter((m) => {
    if (m.c.tier !== 'pattern' && m.c.tier !== 'episode') return false;
    const vec = m.c.vec;
    if (vec === undefined) return true; // unverifiable ⇒ not sane
    if (cosineSimilarity(vec, ctx.queryVec) >= ctx.cfg.coherence.minQueryCos) return false;
    const cc = centroid.length === vec.length ? cosineSimilarity(vec, centroid) : 0;
    return cc < ctx.cfg.coherence.minCentroidCos;
  });
  const offender = [...failing].sort(lowestFirst)[0];
  if (offender === undefined) return undefined;
  return { group: groupOfScored(sel, offender), slot: offender };
};

// --- the loop ---

const firstViolation = (sel: Selection, ctx: CoherenceCtx): Offender | undefined => {
  const { cfg, queryText } = ctx;
  return (
    scanForbiddenPairs(sel, cfg) ??
    scanDimensionCaps(sel, cfg, queryText) ??
    scanRegisterTags(sel, cfg) ??
    scanSpread(sel, cfg) ??
    scanEmbeddingSanity(sel, ctx)
  );
};

const swapOut = (sel: Selection, offender: Offender): void => {
  const g = offender.group;
  g.members = g.members.filter((m) => m !== offender.slot);
  g.out.push(offender.slot);
  const replacement = g.runners.find((r) => !g.out.includes(r) && !isSelected(sel, r.c.id));
  if (replacement !== undefined) g.members.push(replacement);
};

/**
 * Runs the layers to a verdict. Degraded means the swap budget ran out with a
 * violation still standing — the packet renders anyway, flagged, so the caller's
 * event record can correlate output quality with coherence pressure.
 */
export const runCoherence = (sel: Selection, ctx: CoherenceCtx): CoherenceResult => {
  let rounds = 0;
  while (rounds < ctx.cfg.coherence.maxSwapRounds) {
    const offender = firstViolation(sel, ctx);
    if (offender === undefined) return { degraded: false, rounds };
    swapOut(sel, offender);
    rounds += 1;
  }
  return { degraded: firstViolation(sel, ctx) !== undefined, rounds };
};

/** Layer names in evaluation order — exported so probes and reports can name what fired. */
export const COHERENCE_LAYERS = ['forbidden-pairs', 'dimension-caps', 'register-tags', 'signature-spread', 'embedding-sanity'] as const;

export type CoherenceLayer = (typeof COHERENCE_LAYERS)[number];

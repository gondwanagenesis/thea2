// v8 mind — EVOKE: the moment calls up memories by resemblance, tilted by mood.
//
// Law 1.3 (memory channel): her feeling acts on what comes to mind, never on
// the text of her prompt. The coupling matrix (coupling.yaml v2) adds mood-
// congruent pull plus the corrective off-diagonals (tension reaches for the
// times she steadied things). Options are chosen by MMR over HER REPLY vectors
// so they are different ways she has been, not three copies of one move (the
// v7 plain/flat/bright triplets). Selection is sampled, never argmax, so the
// same message does not pull the same memories twice.
//
// Pure given its inputs: store reads, an injected Rng, no clock, no I/O.

import { modulate, type CompiledCoupling, type Vec12 } from '../coupling/index.js';
import type { Rng } from '../kernel/index.js';
import { cosine } from './vectors.js';
import { momentIntensity, toSparse } from './vocab.js';
import { isPrecedent, type MindStore } from './store.js';
import { DREAM, dreamFade, isAversive } from './dream.js';
import type { Moment } from './types.js';

export interface EvokeConfig {
  /** How many options to show (3, or 4 when the moment is charged). */
  k: number;
  /** MMR relevance weight in [0,1]; lower = more diverse options. */
  mmrLambda: number;
  /** Softmax temperature for sampling among the top MMR candidates. */
  sampleTemp: number;
  /** Extra score for short precedents (low energy prefers short). */
  shortBias: number;
  /** Candidate pool size before MMR. */
  pool: number;
  /** How many turns a shown moment rests before it can be shown again. */
  showCooldownTurns: number;
  /** How long a followed moment rests (ms). */
  followCooldownMs: number;
  /** Moments this recent are already in her context window (ms). */
  recentWindowMs: number;
  /** Diary/thought memories to include beside the options, and their similarity floor. */
  memories: number;
  memoryFloor: number;
}

export const EVOKE_DEFAULTS: EvokeConfig = {
  k: 3,
  mmrLambda: 0.62,
  sampleTemp: 0.12,
  shortBias: 0,
  pool: 24,
  showCooldownTurns: 20,
  followCooldownMs: 7 * 24 * 3600_000,
  recentWindowMs: 24 * 3600_000,
  memories: 2,
  memoryFloor: 0.3,
};

/**
 * Score weights (plan §3.2). Starting values; the P2 offline test tunes them.
 * v12.1 intensity (Diego, 2026-09-27: "isn't that why we have emotions, to give memories
 * weights?"): what she felt strongly comes back more readily — emotional memories are stored
 * more firmly (McGaugh 2004). Capped at its weight; softened by how often it has come up.
 */
export const EVOKE_WEIGHTS = { sim: 0.45, move: 0.15, value: 0.15, mood: 0.15, gold: 0.1, intensity: 0.1 } as const;

/**
 * An estimated (inherited, from Thea1's texts) feeling counts this much of an exact one. It was
 * 0.5; v12.1 raises it — an estimate from her own words is evidence, not nothing.
 */
export const NONEXACT_FELT_WEIGHT = 0.75;

/** Recalls over which a memory's charge halves its pull (against rumination: the same hurt dominating). */
export const INTENSITY_SOFTEN_SHOWN = 10;

/** v12.1: the pull of how strongly she felt it — 0 for a blank memory, at most EVOKE_WEIGHTS.intensity. */
export const intensityTerm = (m: Moment): number => {
  const source = m.felt.source === 'exact' ? 1 : NONEXACT_FELT_WEIGHT;
  return (EVOKE_WEIGHTS.intensity * momentIntensity(m.felt) * source) / (1 + m.shown / INTENSITY_SOFTEN_SHOWN);
};

export interface EvokeInput {
  /** Situation vector (context + his words). */
  queryVec: Float32Array;
  /** His words alone. When present, similarity is 0.6·his + 0.4·situation. */
  hisQueryVec?: Float32Array | undefined;
  /** v14: moments that stay out of this turn (friend turns leave the workshop's moments out). */
  exclude?: ((m: Moment) => boolean) | undefined;
  move?: string | undefined;
  /** Her live state as a deviation vector. */
  a: Vec12;
  now: number;
  turn: number;
  rng: Rng;
  coupling: CompiledCoupling;
  cfg: EvokeConfig;
}

export interface Scored {
  m: Moment;
  score: number;
  sim: number;
  mood: number;
}

export interface Evoked {
  options: Scored[];
  memories: Scored[];
  /** Candidates considered (after exclusions) — for the trace. */
  considered: number;
}

const words = (m: Moment): number => m.hers.join(' ').split(/\s+/).filter((w) => w.length > 0).length;

/** The mood term: coupling's capped aᵀMe, rescaled into ±weight; inherited/estimated feelings count NONEXACT_FELT_WEIGHT. */
export const moodTerm = (a: Vec12, m: Moment, coupling: CompiledCoupling): number => {
  const lambda = coupling.cfg.lambda;
  if (lambda <= 0) return 0;
  const raw = modulate(a, toSparse(m.felt.sig), [], coupling);
  const scaled = (raw / lambda) * EVOKE_WEIGHTS.mood;
  return m.felt.source === 'exact' ? scaled : scaled * NONEXACT_FELT_WEIGHT;
};

export const scoreMoment = (m: Moment, sim: number, input: EvokeInput): Scored => {
  const mood = moodTerm(input.a, m, input.coupling);
  let score =
    EVOKE_WEIGHTS.sim * sim +
    (input.move !== undefined && m.move === input.move ? EVOKE_WEIGHTS.move : 0) +
    EVOKE_WEIGHTS.value * m.value +
    mood +
    intensityTerm(m) +
    (m.gold === true ? EVOKE_WEIGHTS.gold : 0);
  if (input.cfg.shortBias > 0) score += input.cfg.shortBias * (1 - Math.min(1, words(m) / 40));
  return { m, score, sim, mood };
};

const eligibleOption = (m: Moment, input: EvokeInput): boolean => {
  if (!isPrecedent(m)) return false;
  if (input.now - m.ts < input.cfg.recentWindowMs) return false;
  if (m.lastShownTurn !== undefined && input.turn - m.lastShownTurn < input.cfg.showCooldownTurns) return false;
  if (m.lastFollowedAt !== undefined && input.now - m.lastFollowedAt < input.cfg.followCooldownMs) return false;
  return true;
};

/** Softmax pick among `xs` by `key`, seeded. */
const softPick = <T>(xs: T[], key: (x: T) => number, temp: number, rng: Rng): T => {
  if (xs.length === 1 || temp <= 0) return xs[0]!;
  const top = Math.max(...xs.map(key));
  const ws = xs.map((x) => Math.exp((key(x) - top) / temp));
  const total = ws.reduce((s, w) => s + w, 0);
  let r = rng.float() * total;
  for (let i = 0; i < xs.length; i++) {
    r -= ws[i]!;
    if (r <= 0) return xs[i]!;
  }
  return xs[xs.length - 1]!;
};

const valenceSign = (m: Moment): number => Math.sign(m.felt.sig[0] ?? 0);

/** v13: a memory she dreamt comes back a little more easily for a couple of weeks. */
export const dreamtTerm = (m: Moment, now: number): number =>
  m.lastDreamtAt === undefined ? 0 : DREAM.dreamtBonus * Math.pow(0.5, Math.max(0, now - m.lastDreamtAt) / DREAM.linkFadeMs);

/**
 * v13 (NEXTUP): the memories a dream bound to the three this moment most resembles get a small pull —
 * a new retrieval path, one hop only, fading over two weeks, halved for an aversive link-mate
 * (the coupling law: feel it, never feed it).
 */
export const linkBonus = (store: MindStore, sims: ReadonlyArray<{ m: Moment; sim: number }>, now: number): Map<string, number> => {
  const out = new Map<string, number>();
  const top = [...sims].sort((a, b) => b.sim - a.sim).slice(0, 3);
  for (const t of top) {
    for (const a of t.m.assoc ?? []) {
      const mate = store.get(a.id);
      if (mate === undefined) continue;
      const b = DREAM.linkBonus * Math.pow(0.5, Math.max(0, now - a.at) / DREAM.linkFadeMs) * (isAversive(mate.felt.sig) ? 0.5 : 1);
      out.set(a.id, Math.max(out.get(a.id) ?? 0, b));
    }
  }
  return out;
};

export const evoke = (store: MindStore, input: EvokeInput): Evoked => {
  const { cfg } = input;
  const candidates: Scored[] = [];
  const memoryCands: Scored[] = [];
  const sims: Array<{ m: Moment; sim: number }> = [];
  for (const m of store.moments()) {
    const v = store.sitVec(m.id);
    if (v === undefined || input.exclude?.(m) === true) continue;
    // The 2026-09-25 live probe: a short message ("long day. i am wrecked")
    // was drowned by the previous conversation in the situation vector and
    // recalled tech threads. His words lead; context tilts.
    const hv = input.hisQueryVec !== undefined ? store.hisVec(m.id) : undefined;
    const sim = hv !== undefined && input.hisQueryVec !== undefined
      ? 0.6 * cosine(input.hisQueryVec, hv) + 0.4 * cosine(input.queryVec, v)
      : cosine(input.queryVec, v);
    sims.push({ m, sim });
  }
  // v13 dreams: what a dream bound to what this moment most resembles comes to mind too (one hop)
  const links = linkBonus(store, sims, input.now);
  for (const { m, sim } of sims) {
    const extra = (links.get(m.id) ?? 0) + dreamtTerm(m, input.now);
    if (eligibleOption(m, input)) {
      const s = scoreMoment(m, sim, input);
      candidates.push(extra > 0 ? { ...s, score: s.score + extra } : s);
    } else if (
      (m.kind === 'diary' || m.kind === 'thought' || m.kind === 'dream' || m.kind === 'practice') &&
      m.never !== true &&
      // a dream from this morning is not in her context window — it can come back the same day
      (m.kind === 'dream' || input.now - m.ts >= cfg.recentWindowMs)
    ) {
      // v12.1: among what resembles the moment, what she felt most comes first (relevance still gates it).
      // v13: a remembered dream pulls half as hard (a vivid nightmare can't dominate) and fades unless told.
      const pull = m.kind === 'dream' ? intensityTerm(m) / 2 : intensityTerm(m);
      memoryCands.push({ m, score: (sim + pull + extra) * dreamFade(m, input.now), sim, mood: 0 });
    }
  }
  candidates.sort((x, y) => y.score - x.score || (x.m.id < y.m.id ? -1 : 1));
  const pool = candidates.slice(0, cfg.pool);

  // MMR with sampling over reply vectors.
  const picked: Scored[] = [];
  const replyOf = (s: Scored): Float32Array | undefined => store.replyVec(s.m.id);
  const maxScore = pool[0]?.score ?? 0;
  const minScore = pool[pool.length - 1]?.score ?? 0;
  const span = Math.max(1e-6, maxScore - minScore);
  const remaining = [...pool];
  while (picked.length < cfg.k && remaining.length > 0) {
    const mmr = (s: Scored): number => {
      const rel = (s.score - minScore) / span;
      const r = replyOf(s);
      let red = 0;
      if (r !== undefined) {
        for (const p of picked) {
          const pr = replyOf(p);
          if (pr !== undefined) red = Math.max(red, cosine(r, pr));
        }
      }
      return cfg.mmrLambda * rel - (1 - cfg.mmrLambda) * red;
    };
    const ranked = [...remaining].sort((x, y) => mmr(y) - mmr(x) || (x.m.id < y.m.id ? -1 : 1));
    const choice = softPick(ranked.slice(0, 3), mmr, cfg.sampleTemp, input.rng);
    picked.push(choice);
    remaining.splice(remaining.indexOf(choice), 1);
  }

  // Guarantee a short option when a decent one exists (her shortest replies are her most human).
  if (picked.length > 0 && !picked.some((s) => words(s.m) <= 8)) {
    const short = remaining.find((s) => words(s.m) <= 8 && s.score >= 0.8 * maxScore);
    if (short !== undefined) picked[picked.length - 1] = short;
  }
  // Guarantee one contrast: a different emotional sign than the rest, when available.
  if (picked.length >= 2) {
    const signs = new Set(picked.map((s) => valenceSign(s.m)));
    if (signs.size === 1) {
      const s0 = [...signs][0]!;
      const contrast = remaining.find((s) => valenceSign(s.m) !== s0 && valenceSign(s.m) !== 0 && s.score >= 0.7 * maxScore && !picked.includes(s));
      if (contrast !== undefined) {
        // Never evict the guaranteed short option.
        const idx = picked.findIndex((s) => words(s.m) > 8);
        picked[idx >= 0 ? idx : picked.length - 1] = contrast;
      }
    }
  }

  memoryCands.sort((x, y) => y.score - x.score || (x.m.id < y.m.id ? -1 : 1));
  const memories = memoryCands.filter((s) => s.sim >= cfg.memoryFloor).slice(0, cfg.memories);
  return { options: picked, memories, considered: candidates.length };
};

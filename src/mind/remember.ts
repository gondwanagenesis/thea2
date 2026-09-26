// v8 mind — REMEMBER: experience changes her (law 1.5).
//
// Every reply she sends becomes a lived moment at once — her exact state at
// encoding, what she expected, the options she was shown. When his next
// message arrives, the slow appraisal grades how that reply landed and three
// things move, all bounded:
//   1. the moment's own outcome + value (reward-prediction error, α from surprise)
//   2. the option she followed (if any) gains or loses value — credit to the
//      precedent that shaped the reply (half weight)
//   3. reconsolidation: the followed memory's feeling drifts a little toward
//      how it went this time ("that joke used to hurt; now it's ours")

import { cosine } from './vectors.js';
import { nearestTag } from './vocab.js';
import type { MindStore } from './store.js';
import type { Act, Line, Moment, Outcome } from './types.js';

/** Cosine above which her reply counts as following a shown option (text-embedding-3-small; recalibrate from mind.remembered closestSim). */
export const FOLLOW_THRESHOLD = 0.65;
/** How far one recall can pull a memory's feeling toward the present (per event). */
export const RECONSOLIDATION_RHO = 0.1;

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

export interface EncodeInput {
  id: string;
  now: number;
  kind: 'reply' | 'text_first';
  before: Line[];
  his: string;
  hers: string[];
  /** Her state at encoding (coupling deviation vector). */
  sig: number[];
  move?: string | undefined;
  tone?: string | undefined;
  expect?: string | undefined;
  importance?: number | undefined;
  /** v9: the tools she used in this moment. */
  acts?: Act[] | undefined;
}

const ACT_FIELDS = ['scene', 'motion', 'prompt', 'query', 'words', 'about', 'brief', 'text', 'emoji', 'url', 'command', 'pattern', 'task', 'path', 'question', 'candy', 'room', 'action'] as const;

/** The acts of a turn, from the loop's tool trace (decide is not an act; denied calls did nothing). */
export const actsOf = (trace: ReadonlyArray<{ tool: string; args: unknown; result?: unknown; verdict?: { allow?: boolean } }>): Act[] =>
  trace
    .filter((t) => t.tool !== 'decide' && t.verdict?.allow !== false)
    .map((t) => {
      const a = (typeof t.args === 'object' && t.args !== null ? t.args : {}) as Record<string, unknown>;
      const key = ACT_FIELDS.find((k) => typeof a[k] === 'string' && (a[k] as string).trim() !== '');
      const what = key !== undefined ? String(a[key]).replace(/\s+/g, ' ').slice(0, 120) : '';
      const result = typeof t.result === 'string' ? t.result.replace(/\s+/g, ' ').slice(0, 120) : undefined;
      const job = typeof t.result === 'string' ? /\(([a-z]+(?:-[a-z]+)*-\d{10,}-\d+)\)/.exec(t.result)?.[1] : undefined;
      return { tool: t.tool, what, ...(result !== undefined ? { result } : {}), ...(job !== undefined ? { job } : {}) };
    });

export const encodeLived = (i: EncodeInput): Moment => ({
  id: i.id,
  ts: i.now,
  source: 'lived',
  kind: i.kind,
  before: i.before.slice(-3),
  his: i.his,
  hers: i.hers,
  ...(i.move !== undefined ? { move: i.move } : {}),
  ...(i.tone !== undefined ? { tone: i.tone } : {}),
  felt: { sig: i.sig, word: nearestTag(i.sig), source: 'exact' },
  ...(i.expect !== undefined ? { expect: i.expect } : {}),
  ...(i.importance !== undefined ? { importance: i.importance } : {}),
  value: 0,
  shown: 0,
  followed: 0,
  ...(i.acts !== undefined && i.acts.length > 0 ? { acts: i.acts } : {}),
});

/** The shown option closest to her reply (any similarity) — logged so the follow threshold can be calibrated live. */
export const bestOption = (
  replyVec: Float32Array,
  shownIds: readonly string[],
  store: MindStore,
): { id: string; sim: number } | null => {
  let best: { id: string; sim: number } | null = null;
  for (const id of shownIds) {
    const v = store.replyVec(id);
    if (v === undefined) continue;
    const s = cosine(replyVec, v);
    if (best === null || s > best.sim) best = { id, sim: s };
  }
  return best;
};

/** Which shown option (if any) her reply followed. */
export const inferFollowed = (
  replyVec: Float32Array,
  shownIds: readonly string[],
  store: MindStore,
): { id: string; sim: number } | null => {
  const best = bestOption(replyVec, shownIds, store);
  return best !== null && best.sim >= FOLLOW_THRESHOLD ? best : null;
};

export interface OutcomeUpdate {
  momentId: string;
  outcome: Outcome;
  /** Learning rate from her state (surprise raises it). */
  alpha: number;
  /** The option she followed on that turn, if any. */
  followedId?: string | null | undefined;
  now: number;
}

/** Apply how a reply landed: its own value, the followed option's value, and reconsolidation. */
export const applyOutcome = (store: MindStore, u: OutcomeUpdate): { rpe: number } | null => {
  const m = store.get(u.momentId);
  if (m === undefined) return null;
  const target = clamp(u.outcome.landed / 2, -1, 1);
  const rpe = target - m.value;
  store.update(m.id, { outcome: u.outcome, value: clamp(m.value + u.alpha * rpe, -1, 1) });
  if (u.followedId !== undefined && u.followedId !== null) {
    const f = store.get(u.followedId);
    if (f !== undefined) {
      const frpe = target - f.value;
      const sig = f.felt.sig.map((x, k) => clamp(x * (1 - RECONSOLIDATION_RHO) + (m.felt.sig[k] ?? 0) * RECONSOLIDATION_RHO, -1, 1));
      store.update(f.id, {
        value: clamp(f.value + 0.5 * u.alpha * frpe, -1, 1),
        felt: { ...f.felt, sig, word: nearestTag(sig) ?? f.felt.word },
        followed: f.followed + 1,
        lastFollowedAt: u.now,
      });
    }
  }
  return { rpe };
};

/** Record that options were shown this turn (cooldowns read these). */
export const markShown = (store: MindStore, ids: readonly string[], turn: number, now: number): void => {
  for (const id of ids) {
    const m = store.get(id);
    if (m === undefined) continue;
    store.update(id, { shown: m.shown + 1, lastShownTurn: turn, lastShownAt: now });
  }
};

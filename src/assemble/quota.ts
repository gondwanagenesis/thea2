// M11 assemble — the action-intent classifier behind the procedural quota, and
// the character-channel quota fill.
//
// The two channels never compete for slots (ADR-009): the character groups cut
// from the character pool, the procedural quota cuts from the procedural pool,
// and no code path below can move a candidate across. Track membership is
// decided by the NOMINATOR's channel, not the candidate's declared field — a
// misbehaving nominator cannot smuggle a procedure into [EXEMPLARS] by
// mislabeling it, which is the channel-bleed invariant tested adversarially.

import { compareStrings } from '../corpus/types.js';
import type { Candidate, Nominator, TurnQuery, AssembleConfig } from './types.js';
import { assertCandidateSane, byScoreThenId, dissimilarityOf, meanDenseOf, type Scored } from './score.js';
import { dimensionCapConflict, forbiddenPairConflict, modeCompatible } from './rules.js';

// ---------------------------------------------------------------------------
// proceduralQuota — pure action-intent classifier
// ---------------------------------------------------------------------------

/**
 * Tool-suggestive stems, word-boundary anchored. Deliberately conservative:
 * a false 1 costs one wasted nominator probe, while an over-eager battery
 * would pin [PROCEDURAL] onto ordinary chat. Pinned by the classifier test table.
 */
export const TOOL_SUGGESTIVE_STEMS: readonly string[] = [
  'run', 'deploy', 'commit', 'push', 'grep', 'build', 'script', 'command',
  'search', 'lookup', 'fetch', 'schedule', 'remind', 'api', 'tool', 'reboot',
  'restart', 'ssh', 'query', 'curl', 'endpoint', 'logs',
];

const TOOL_RE = new RegExp(`\\b(?:${TOOL_SUGGESTIVE_STEMS.join('|')})\\b`, 'i');

const hasGoal = (q: TurnQuery): boolean => q.goal !== undefined && q.goal.trim() !== '';

const toolSuggestive = (q: TurnQuery): boolean => {
  const text = [q.text ?? '', q.goal ?? ''].join(' ');
  return text !== '' && TOOL_RE.test(text);
};

/**
 * 0 — a plain social turn: no goal, no tool-suggestive signal.
 * 1 — one action-intent signal (goal, or ponder's committee/GROUND work, or tool-suggestive text).
 * 2 — two or more signals. Never more.
 */
export const proceduralQuota = (q: TurnQuery): 0 | 1 | 2 => {
  let signals = 0;
  if (hasGoal(q)) signals += 1;
  if (q.entry === 'ponder') signals += 1; // ponder is committee/GROUND work by construction
  if (toolSuggestive(q)) signals += 1;
  return signals === 0 ? 0 : signals === 1 ? 1 : 2;
};

// ---------------------------------------------------------------------------
// Selection state — the mutable structure coherence and budget operate on
// ---------------------------------------------------------------------------

export type GroupKind = 'disposition' | 'pattern' | 'episodeMemory' | 'contrast';

export interface Group {
  kind: GroupKind;
  /** Hard floor: below this the packet is scarce. */
  min: number;
  /** Filled slots, best first. */
  members: Scored[];
  /** Ranked runner-ups at fill time — the coherence swap source. Static after fill. */
  runners: Scored[];
  /** Swapped out or budget-dropped; never re-selected within this assembly. */
  out: Scored[];
}

export interface Selection {
  groups: Group[];
  procedural: Scored[];
  proceduralOut: Scored[];
  scarcity: boolean;
}

export const characterMembers = (sel: Selection): Scored[] => sel.groups.flatMap((g) => g.members);

export const isSelected = (sel: Selection, id: string): boolean =>
  characterMembers(sel).some((s) => s.c.id === id) || sel.procedural.some((s) => s.c.id === id);

// ---------------------------------------------------------------------------
// Character quota fill
// ---------------------------------------------------------------------------

/**
 * Register strictness (Round 3 prep). `mode_exclusive` itself lives in
 * rules.ts (`modeCompatible`) — not a quota-owned file — so the dial and its
 * consumption land here, at the fill. `strict !== false` (the default) keeps
 * the shipped law: mode-incompatible candidates are INELIGIBLE for every
 * non-disposition slot. `strict: false` demotes instead of excluding: the
 * penalty is a total order inside the group — every register-compatible
 * candidate outranks an incompatible one, then score desc, id asc — so
 * determinism is untouched and PacketRecord.baseScore stays the caller's
 * credit-truth (the penalty never rewrites a score). Round 3 decides whether
 * "prefer-not-exclude" becomes a graded score term; that edit belongs in
 * score.ts, and this comment marks the seam.
 */
export interface RegisterStrictness {
  strict?: boolean | undefined;
}
export type FillConfig = AssembleConfig & RegisterStrictness;

const takeSorted = (
  pool: ReadonlyArray<Scored>,
  n: number,
  cmp: (a: Scored, b: Scored) => number = byScoreThenId,
): { members: Scored[]; runners: Scored[] } => {
  const sorted = [...pool].sort(cmp);
  return { members: sorted.slice(0, n), runners: sorted.slice(n) };
};

const groupOf = (sel: Selection, kind: GroupKind): Group => {
  const g = sel.groups.find((x) => x.kind === kind);
  if (g === undefined) throw new Error(`selection has no '${kind}' group`);
  return g;
};

/**
 * Fill the four character groups in fixed order. Eligibility per group:
 *
 *   disposition    tier 'disposition' AND source 'canon' (ADR-006, no backfill ever);
 *                  exempt from the mode filter — the keel is present in every packet
 *   pattern        tier 'pattern', plus non-canon candidates mislabeled 'disposition'
 *                  (demoted rather than wasted — the canon-only law is about the slot,
 *                  not about the material)
 *   episode+memory tier 'episode' or 'memory' first, then seed backfill from the
 *                  ranked leftovers so an empty lived corpus still fills the quota
 *                  from canon/derived — the launch condition
 *   contrast       whatever is left that still passes register constraints, ranked by
 *                  max dissimilarity from the packet's mean signature
 *
 * An unmet floor sets `scarcity`; nothing is ever padded.
 */
export const fillCharacter = (pool: ReadonlyArray<Scored>, q: TurnQuery, cfg: FillConfig): Selection => {
  const { quotas } = cfg;
  const sel: Selection = {
    groups: [
      { kind: 'disposition', min: quotas.disposition, members: [], runners: [], out: [] },
      { kind: 'pattern', min: quotas.pattern, members: [], runners: [], out: [] },
      { kind: 'episodeMemory', min: quotas.episodeMemoryMin, members: [], runners: [], out: [] },
      { kind: 'contrast', min: quotas.contrast, members: [], runners: [], out: [] },
    ],
    procedural: [],
    proceduralOut: [],
    scarcity: false,
  };
  const queryText = `${q.text ?? ''} ${q.goal ?? ''}`.toLowerCase();
  const strict = cfg.strict !== false;
  const modeOk = (s: Scored): boolean => (strict ? modeCompatible(s.c, q.register, cfg) : true);
  // The strict:false penalty: out-of-register material sorts behind every
  // register-compatible candidate in its group (then score desc, id asc).
  const fillOrder = (x: Scored, y: Scored): number =>
    Number(modeCompatible(y.c, q.register, cfg)) - Number(modeCompatible(x.c, q.register, cfg)) || byScoreThenId(x, y);
  const order = strict ? byScoreThenId : fillOrder;
  const usedIds = (): Set<string> => new Set(characterMembers(sel).map((s) => s.c.id));

  // 1 — disposition: canon-only, permanently (ADR-006). Exempt from the mode
  // filter at any strictness — the keel is present in every packet.
  const disposition = groupOf(sel, 'disposition');
  const dispositionFill = takeSorted(
    pool.filter((s) => s.c.tier === 'disposition' && s.c.source === 'canon'),
    quotas.disposition,
  );
  disposition.members = dispositionFill.members;
  disposition.runners = dispositionFill.runners;

  // 2 — pattern. Non-canon 'disposition'-tier candidates are demoted here rather
  // than dropped: the canon-only law guards the slot, not the material.
  const patternEligible = (s: Scored): boolean =>
    s.c.tier === 'pattern' || (s.c.tier === 'disposition' && s.c.source !== 'canon');
  const pattern = groupOf(sel, 'pattern');
  const patternFill = takeSorted(
    pool.filter((s) => modeOk(s) && !usedIds().has(s.c.id) && patternEligible(s)),
    quotas.pattern,
    order,
  );
  pattern.members = patternFill.members;
  pattern.runners = patternFill.runners;

  // 3 — episode + memory: lived/memory material first, seed backfill second.
  const episodeMemory = groupOf(sel, 'episodeMemory');
  const liveMemory = pool
    .filter((s) => modeOk(s) && !usedIds().has(s.c.id) && (s.c.tier === 'episode' || s.c.tier === 'memory'))
    .sort(order);
  const backfill = pool
    .filter((s) => modeOk(s) && !usedIds().has(s.c.id) && patternEligible(s))
    .sort(order);
  const combined = [...liveMemory, ...backfill];
  episodeMemory.members = combined.slice(0, quotas.episodeMemoryMax);
  episodeMemory.runners = combined.slice(quotas.episodeMemoryMax);

  // 4 — contrast: the max-dissimilar candidate that still passes register
  // constraints. Its rank stays dissimilarity-first at any strictness (the slot
  // exists to pull against the packet, and coherence already exempts it) —
  // strict:false only widens the eligibility pool it draws from.
  const contrast = groupOf(sel, 'contrast');
  const selected = characterMembers(sel);
  const mean = meanDenseOf(selected.map((s) => s.c.sig));
  const contrastEligible = pool
    .filter(
      (s) =>
        !usedIds().has(s.c.id) &&
        modeOk(s) &&
        !forbiddenPairConflict(s.c, selected, cfg) &&
        !dimensionCapConflict(s.c, selected, cfg, queryText),
    )
    .sort(
      (x, y) =>
        dissimilarityOf(y.c.sig, mean) - dissimilarityOf(x.c.sig, mean) ||
        byScoreThenId(x, y),
    );
  contrast.members = contrastEligible.slice(0, quotas.contrast);
  contrast.runners = contrastEligible.slice(quotas.contrast);

  sel.scarcity = sel.groups.some((g) => g.members.length < g.min);
  return sel;
};

// ---------------------------------------------------------------------------
// Procedural quota fill
// ---------------------------------------------------------------------------

/** Top `quota` procedural candidates by score — no coherence applies to this channel. */
export const fillProcedural = (pool: ReadonlyArray<Scored>, quota: number): Selection => {
  const sorted = [...pool].sort(byScoreThenId);
  return {
    groups: [],
    procedural: sorted.slice(0, Math.max(0, quota)),
    proceduralOut: [],
    scarcity: false, // a cold procedural store is the normal early state, not scarcity
  };
};

// ---------------------------------------------------------------------------
// Intake — nominator → pool
// ---------------------------------------------------------------------------

/** How deep each nominator is asked: the character quota total, times the pool factor. */
export const characterAsk = (cfg: AssembleConfig): number => {
  const { quotas } = cfg;
  const total = quotas.disposition + quotas.pattern + quotas.episodeMemoryMax + quotas.contrast;
  return total * cfg.poolFactor;
};

/**
 * Consult every nominator of one channel and flatten. The nominator's channel
 * is authoritative for the track: the candidate's own `channel` field is
 * normalized to it, and tier-inconsistent candidates are dropped — a procedure
 * can only ever enter the packet through a procedural-channel nominator.
 * A rejecting nominator propagates: a silent half-packet looks like a working one.
 */
export const nominateChannel = async (
  nominators: ReadonlyArray<Nominator>,
  q: TurnQuery,
  k: number,
): Promise<{ character: Array<Candidate>; procedural: Array<Candidate> }> => {
  const pools = await Promise.all(nominators.map((n) => n.nominate(q, k)));
  const character: Array<Candidate> = [];
  const procedural: Array<Candidate> = [];
  nominators.forEach((n, i) => {
    const pool = pools[i];
    if (pool === undefined) return;
    for (const c of pool) {
      // Intake validation: a non-finite score would make every sort comparator
      // inconsistent (ordering by implementation detail = nondeterminism).
      assertCandidateSane(c, n.name);
      const normalized: Candidate = { ...c, channel: n.channel };
      if (n.channel === 'character' && normalized.tier !== 'procedure') character.push(normalized);
      else if (n.channel === 'procedural' && normalized.tier === 'procedure') procedural.push(normalized);
    }
  });
  return { character, procedural };
};

/** Same id nominated twice (two nominators, one event) keeps its best-scoring occurrence. */
export const dedupeById = (scoredPool: ReadonlyArray<Scored>): Array<Scored> => {
  const best = new Map<string, Scored>();
  for (const s of [...scoredPool].sort(byScoreThenId)) {
    if (!best.has(s.c.id)) best.set(s.c.id, s);
  }
  return [...best.values()].sort(byScoreThenId);
};

/** Deterministic string compare re-exported for the coherence layer's sorted key iteration. */
export const asc = compareStrings;

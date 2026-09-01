// M11 assemble — the token budget. The render IS the budget's unit of account:
// every measure below is taken on the same text the packet will ship, using
// M07's whitespace-split count (the unit every other corpus/packet budget in
// ARCHITECTURE.md assumes).
//
// Two regimes, in order:
//   per-section — [EXEMPLARS] ≤ 4000 and [MEMORY] ≤ 600, the two sections whose
//                 content the assembler owns; enforced by lowest-scored drops.
//   total       — packet ≤ 6000, enforced in the spec's overflow order: drop the
//                 lowest-scored procedural exemplar, then the lowest-scored
//                 character exemplar, then trim [MEMORY] items to 3 — repeated
//                 until the packet fits or nothing droppable remains.
//
// Caller-owned sections ([IDENTITY]/[GOAL]/[INTERLOCUTOR]/[AFFECT]/[REGISTER]/[INHIBITION])
// are passed through verbatim — the assembler never rewrites her identity or
// M12's rule text. If those alone exceed the packet budget, the drop order runs
// to exhaustion and the packet ships over budget: visible, deterministic, and
// the supplier's contract to fix.

import { countTokens } from '../corpus/body.js';
import { compareStrings } from '../corpus/types.js';
import type { AssembleConfig } from './types.js';
import type { Scored } from './score.js';
import type { Selection } from './quota.js';

/** §2.7: when the total is over budget, [MEMORY] is trimmed to this many items. */
export const MEMORY_TRIM_TARGET = 3;

export interface RenderedTexts {
  /** The 7-section system text. */
  system: string;
  /** The [PROCEDURAL] block, '' when absent. */
  procedural: string;
  /** The [INHIBITION] trailer. */
  trailer: string;
  /** Section bodies alone, for the per-section budgets. */
  memory: string;
  exemplars: string;
}

export const packetTokens = (t: RenderedTexts): number =>
  countTokens(t.system) + countTokens(t.procedural) + countTokens(t.trailer);

const memoryMembers = (sel: Selection): Scored[] =>
  sel.groups.filter((g) => g.kind === 'episodeMemory').flatMap((g) => g.members).filter((m) => m.c.tier === 'memory');

/** [EXEMPLARS] members: every character slot except the memory-tier ones (they render into [MEMORY]). */
const exemplarMembers = (sel: Selection): Scored[] =>
  sel.groups.flatMap((g) => g.members).filter((m) => m.c.tier !== 'memory');

const byLowestScore = (x: Scored, y: Scored): number => x.score - y.score || compareStrings(x.c.id, y.c.id);

const dropFromGroup = (members: Scored[], out: Scored[]): Scored | undefined => {
  const lowest = [...members].sort(byLowestScore)[0];
  if (lowest === undefined) return undefined;
  out.push(lowest);
  return lowest;
};

const dropLowestProcedural = (sel: Selection): boolean => {
  const dropped = dropFromGroup(sel.procedural, sel.proceduralOut);
  if (dropped === undefined) return false;
  sel.procedural = sel.procedural.filter((m) => m !== dropped);
  return true;
};

const dropLowestExemplar = (sel: Selection): boolean => {
  const victim = [...exemplarMembers(sel)].sort(byLowestScore)[0];
  if (victim === undefined) return false;
  const g = sel.groups.find((grp) => grp.members.includes(victim));
  if (g === undefined) return false;
  dropFromGroup([victim], g.out);
  g.members = g.members.filter((m) => m !== victim);
  return true;
};

const dropLowestMemory = (sel: Selection): boolean => {
  const victim = [...memoryMembers(sel)].sort(byLowestScore)[0];
  if (victim === undefined) return false;
  const g = sel.groups.find((grp) => grp.kind === 'episodeMemory');
  if (g === undefined) return false;
  dropFromGroup([victim], g.out);
  g.members = g.members.filter((m) => m !== victim);
  return true;
};

/**
 * Applies both budget regimes in place. Drops are permanent for this assembly
 * (victims join their group's `out`, so a coherence swap can never resurrect one).
 */
export const enforceBudgets = (sel: Selection, renderOf: () => RenderedTexts, cfg: AssembleConfig): void => {
  // Per-section budgets on assembler-owned content.
  while (countTokens(renderOf().exemplars) > cfg.budgets.exemplars) {
    if (!dropLowestExemplar(sel)) break;
  }
  while (countTokens(renderOf().memory) > cfg.budgets.memory) {
    if (!dropLowestMemory(sel)) break;
  }
  // Total, in the stated overflow order.
  for (;;) {
    if (packetTokens(renderOf()) <= cfg.budgets.total) return;
    if (sel.procedural.length > 0) {
      dropLowestProcedural(sel);
      continue;
    }
    if (exemplarMembers(sel).length > 0) {
      dropLowestExemplar(sel);
      continue;
    }
    if (memoryMembers(sel).length > MEMORY_TRIM_TARGET) {
      dropLowestMemory(sel);
      continue;
    }
    return; // nothing left the overflow order may drop — ship as-is
  }
};

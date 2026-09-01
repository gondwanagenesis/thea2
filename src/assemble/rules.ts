// M11 assemble — the tag rules coherence layer 1 and the contrast eligibility
// share. All of them read the config's copies of the canon controls (registers.yaml
// vocabulary, exclusions.yaml forbidden_pairs / dimension_caps): the assembler
// does no I/O, so the loaded controls arrive as data.

import type { Candidate } from './types.js';
import type { AssembleConfig } from './types.js';
import type { Scored } from './score.js';

/** A candidate's register tags — its tags that are in the controlled vocabulary. Memory candidates contribute none. */
export const registerTagsOf = (c: Candidate, cfg: AssembleConfig): string[] =>
  c.tags.filter((t) => cfg.registerVocab.includes(t));

/** A candidate's mode tags (play/work/friend) as opposed to its modifiers. */
export const modeTagsOf = (c: Candidate, cfg: AssembleConfig): string[] =>
  registerTagsOf(c, cfg).filter((t) => cfg.modes.includes(t));

/**
 * Mode exclusivity (exclusions.yaml): a packet serves exactly one mode. A
 * candidate with no mode tag fits any packet; one carrying modes may only
 * carry the query's. The disposition slot is exempt from this filter (ADR-006:
 * the keel is present in every packet), which is why it is not applied inside
 * here but by the caller.
 */
export const modeCompatible = (c: Candidate, register: 'work' | 'friend' | 'play', cfg: AssembleConfig): boolean => {
  const modes = modeTagsOf(c, cfg);
  return modes.length === 0 || (modes.length === 1 && modes[0] === register);
};

/** True when putting `c` next to `others` would create a forbidden register pair. */
export const forbiddenPairConflict = (c: Candidate, others: ReadonlyArray<Scored>, cfg: AssembleConfig): boolean => {
  const tags = registerTagsOf(c, cfg);
  if (tags.length === 0) return false;
  for (const other of others) {
    const otherTags = registerTagsOf(other.c, cfg);
    for (const [a, b] of cfg.forbiddenPairs) {
      if ((tags.includes(a) && otherTags.includes(b)) || (tags.includes(b) && otherTags.includes(a))) return true;
    }
  }
  return false;
};

/**
 * The dimension-cap lift: exclusions.yaml caps a dimension per packet "unless
 * the turn query itself matches the dimension's tags". Matching is a plain
 * substring hit of a configured trigger in the query's text/goal — deterministic
 * and cheap; the vocabulary arrives via config, empty by default (caps always
 * apply) so no behavior is invented here.
 */
export const capLifted = (dim: string, queryText: string, cfg: AssembleConfig): boolean => {
  const words = cfg.dimensionMatchWords[dim];
  if (words === undefined) return false;
  return words.some((w) => queryText.includes(w.toLowerCase()));
};

/** True when adding `c` to `others` would push any dimension cap (exclusions.yaml) over its limit. */
export const dimensionCapConflict = (c: Candidate, others: ReadonlyArray<Scored>, cfg: AssembleConfig, queryText: string): boolean => {
  const hypothetical: Array<Scored> = [...others, { c, score: 0, modulation: 0 }];
  for (const dim of Object.keys(cfg.dimensionCaps)) {
    if (capLifted(dim, queryText, cfg)) continue;
    const cap = cfg.dimensionCaps[dim] ?? 0;
    const count = hypothetical.filter((s) => s.c.dimension === dim).length;
    if (count > cap) return true;
  }
  return false;
};

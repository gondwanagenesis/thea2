// M12 inhibit — the [INHIBITION] packet block. One artifact: the text is
// PROJECTED from the same compiled rule objects the gate enforces, so the
// prompted rules and the enforced rules cannot drift apart (Thea1's orphan-tag
// lesson). A rule that is enforced and prompted here; a rule that is enforced
// but mechanical (normalize) is deliberately not prompted — a punctuation
// rewrite is fixed in code, not asked for in prose.
//
// The block names RULE IDS under one neutral header sentence, and nothing else:
// a rule's `why` is written to argue with a model that already planned to break
// it, and printing it here primes the exact constructions the rule bans (the
// gate, not the prompt, does the enforcing — a violation rejects the reply
// regardless of what the prompt said).

import { estimateTokens } from '../model/json.js';
import { InhibitError } from './errors.js';
import type { RuleInfo } from './types.js';

/** Packet budget for this block (§2.7: inhibition 300). Enforced at compile time. */
export const PROMPT_BUDGET_TOKENS = 300;

/** The one neutral header sentence — the block's whole prose allowance. */
export const PROMPT_HEADER = 'Active constraints — violating one rejects this reply and costs a re-entry.';

/** Renders the enforced deny rules: ids only, no why-text. Dormant allow_when exemptions are NOT rendered — the gate cannot honor them yet. */
export const renderPromptBlock = (rules: readonly RuleInfo[]): string =>
  [
    '[INHIBITION]',
    PROMPT_HEADER,
    ...rules.filter((r) => r.ruleClass !== 'normalize').map((r) => `- ${r.id}`),
  ].join('\n');

/** The block travels in the packet, so an over-budget rendering is a startup failure, not a silent trim. */
export const assertPromptBudget = (block: string): void => {
  const tokens = estimateTokens([block]);
  if (tokens > PROMPT_BUDGET_TOKENS) {
    throw new InhibitError(
      'inhibit/prompt-budget',
      `rendered [INHIBITION] block is ~${tokens} tokens — the packet budget is ${PROMPT_BUDGET_TOKENS} (§2.7). The block carries ids only, so this means the rule set itself is too large; trim the rules.`,
    );
  }
};

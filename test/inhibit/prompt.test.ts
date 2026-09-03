// M12 inhibit — the [INHIBITION] prompt block. The block projects the compiled
// rule IDS under one neutral header sentence and nothing else: the why-text of
// a ban is exactly the construction the ban exists to stop, and printing it
// would prime it into every generation. Enforcement is the gate's job.

import { describe, expect, it } from 'vitest';
import { PROMPT_BUDGET_TOKENS, PROMPT_HEADER, assertPromptBudget, renderPromptBlock } from '../../src/inhibit/prompt.js';
import { InhibitError } from '../../src/inhibit/errors.js';
import type { RuleInfo } from '../../src/inhibit/types.js';

const rule = (id: string, over: Partial<RuleInfo> = {}): RuleInfo => ({
  id,
  ruleClass: 'plan',
  severity: 'hard',
  why: `WHY-TEXT-FOR-${id}: never say the thing the rule bans, because the ban says so at length`,
  matcher: 'regex',
  ...over,
});

describe('renderPromptBlock — ids, not why-text', () => {
  it('inhibition block carries no why text', () => {
    const block = renderPromptBlock([
      rule('no-doom'),
      rule('no-em-dash', { ruleClass: 'normalize' }), // enforced, never prompted
      rule('no-ownership-claims', { severity: 'soft' }),
    ]);
    const lines = block.split('\n');
    expect(lines[0]).toBe('[INHIBITION]');
    expect(lines[1]).toBe(PROMPT_HEADER);
    // Every enforced rule id renders, one line each.
    expect(lines.slice(2)).toEqual(['- no-doom', '- no-ownership-claims']);
    // The banned constructions never ride along.
    expect(block).not.toContain('WHY-TEXT-FOR');
    expect(block).not.toContain('never say the thing');
    expect(block).not.toContain('no-em-dash');
    // One header sentence — neutral, no argument.
    expect(block.match(/constraints/g)).toHaveLength(1);
  });

  it('no rules renders the header alone — the block is honest about being empty', () => {
    expect(renderPromptBlock([])).toBe(`[INHIBITION]\n${PROMPT_HEADER}`);
  });
});

describe('assertPromptBudget — ids shrink the block, the rule count is what can blow it', () => {
  it('a normal rule set is far inside the packet budget', () => {
    const block = renderPromptBlock([rule('no-doom'), rule('no-ownership-claims')]);
    expect(block.length).toBeLessThan(PROMPT_BUDGET_TOKENS);
    expect(() => assertPromptBudget(block)).not.toThrow();
  });

  it('a rule set whose ids alone exceed 300 tokens refuses to compile', () => {
    const many = Array.from({ length: 60 }, (_, i) => rule(`rule-${String(i).padStart(3, '0')}-${'x'.repeat(32)}`));
    const block = renderPromptBlock(many);
    try {
      assertPromptBudget(block);
      expect.unreachable('budget must refuse');
    } catch (e) {
      expect(e).toBeInstanceOf(InhibitError);
      expect((e as InhibitError).code).toBe('inhibit/prompt-budget');
    }
  });
});

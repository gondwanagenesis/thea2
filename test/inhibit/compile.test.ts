// compileGate — the startup contract. An invalid rule is a startup failure that
// names the rule; no partially compiled gate ever exists (M12 spec, acceptance 1).
// The canon draft itself is compiled here so a canon edit that cannot compile
// fails CI the same day, not at boot on the VPS.

import { describe, expect, it } from 'vitest';
import { InhibitError, compileGate, type GateConfig, type Verdict } from '../../src/inhibit/index.js';
import { FIXTURE_YAML, canonGate, fixtureCfg, fixtureGate } from './helpers.js';

/** Verdicts are a union; tests read the code through this narrowing helper. */
const codeOf = (v: Verdict): string => (v.allow ? 'allow' : v.code);

const compileErrorOf = (yaml: string, cfg?: GateConfig): InhibitError => {
  try {
    compileGate(yaml, cfg);
  } catch (e) {
    if (e instanceof InhibitError) return e;
    throw new Error(`expected an InhibitError, got ${String(e)}`);
  }
  throw new Error('expected compileGate to reject this document');
};

describe('compileGate — malformed documents are startup failures', () => {
  it('text that is not YAML throws inhibit/yaml-parse', () => {
    const e = compileErrorOf('version: 1\nbad: [unclosed\n');
    expect(e.code).toBe('inhibit/yaml-parse');
  });

  it('a non-mapping root throws inhibit/schema', () => {
    const e = compileErrorOf('- just\n- a\n- list\n');
    expect(e.code).toBe('inhibit/schema');
  });

  it('an unknown top-level key is named, never ignored', () => {
    const e = compileErrorOf('version: 1\ninhibitns: []\n');
    expect(e.code).toBe('inhibit/unknown-field');
    expect(e.message).toContain('inhibitns');
  });

  it('an unknown field inside a rule names the rule', () => {
    const e = compileErrorOf(
      ['version: 1', 'tool:', '  - id: chat-lock', '    why: pinned', '    applies: [send_message]', '    cheak: chat_id', ''].join('\n'),
    );
    expect(e.code).toBe('inhibit/unknown-field');
    expect(e.message).toContain('chat-lock');
    expect(e.message).toContain('cheak');
  });

  it('a rule without an id is a schema error naming its slot', () => {
    const e = compileErrorOf(
      ['version: 1', 'tool:', '  - why: no id here', '    applies: [send_message]', '    owner_arg: chat_id', ''].join('\n'),
    );
    expect(e.code).toBe('inhibit/schema');
    expect(e.message).toContain('tool[0]');
  });

  it('duplicate rule ids collide across sections (ruleId must be unambiguous)', () => {
    const e = compileErrorOf(
      [
        'version: 1',
        'tool:',
        '  - id: dup',
        '    why: first',
        '    applies: [send_message]',
        '    owner_arg: chat_id',
        'plan:',
        '  - id: dup',
        '    severity: hard',
        '    why: second',
        '    reject_patterns: []',
        '',
      ].join('\n'),
    );
    expect(e.code).toBe('inhibit/duplicate-id');
    expect(e.message).toContain('dup');
  });

  it('an uncompilable reject pattern names the rule', () => {
    const e = compileErrorOf(
      ['version: 1', 'plan:', '  - id: broken', '    severity: hard', '    why: x', '    reject_patterns: ["("]', ''].join('\n'),
    );
    expect(e.code).toBe('inhibit/bad-regex');
    expect(e.message).toContain('broken');
  });

  it('a check text outside the registry names the rule and the accepted vocabulary', () => {
    const e = compileErrorOf(
      ['version: 1', 'tool:', '  - id: mystery', '    why: x', '    applies: [send_message]', '    check: be nice about it', ''].join('\n'),
    );
    expect(e.code).toBe('inhibit/unbound-rule');
    expect(e.message).toContain('mystery');
    expect(e.message).toContain('tool in registry');
  });

  it('a tool rule with neither machine fields nor a check cannot bind', () => {
    const e = compileErrorOf(
      ['version: 1', 'tool:', '  - id: empty', '    why: x', '    applies: [send_message]', ''].join('\n'),
    );
    expect(e.code).toBe('inhibit/unbound-rule');
    expect(e.message).toContain('empty');
  });

  it('a tool rule with predicates must name the tools it governs', () => {
    const e = compileErrorOf(['version: 1', 'tool:', '  - id: vague', '    why: x', '    owner_arg: chat_id', ''].join('\n'));
    expect(e.code).toBe('inhibit/schema');
    expect(e.message).toContain('vague');
  });

  it('version must be exactly 1', () => {
    const e = compileErrorOf('version: 2\n');
    expect(e.code).toBe('inhibit/schema');
  });

  it('a plan rule without a severity is rejected, not defaulted', () => {
    const e = compileErrorOf(['version: 1', 'plan:', '  - id: nosev', '    why: x', '    reject_patterns: ["x"]', ''].join('\n'));
    expect(e.code).toBe('inhibit/schema');
    expect(e.message).toContain('nosev');
  });

  it('the registry rule must apply to every tool', () => {
    const e = compileErrorOf(
      ['version: 1', 'tool:', '  - id: narrow-registry', '    why: x', '    applies: [send_message]', '    require_registry: true', ''].join('\n'),
    );
    expect(e.code).toBe('inhibit/schema');
    expect(e.message).toContain('narrow-registry');
  });

  it('an allow_when outside the recognized vocabulary is a startup failure', () => {
    const e = compileErrorOf(
      [
        'version: 1',
        'plan:',
        '  - id: moody',
        '    severity: soft',
        '    why: x',
        '    reject_patterns: ["x"]',
        '    allow_when: entry.mood == happy',
        '',
      ].join('\n'),
    );
    expect(e.code).toBe('inhibit/allow-when');
    expect(e.message).toContain('moody');
  });
});

describe('compileGate — compose-time config the yaml may not carry', () => {
  it('an owner-pinning rule without an injected ownerChatId refuses to compile', () => {
    const yaml = ['version: 1', 'tool:', '  - id: chat-lock', '    why: pinned', '    applies: [send_message]', '    owner_arg: chat_id', ''].join('\n');
    const e = compileErrorOf(yaml, {});
    expect(e.code).toBe('inhibit/config-required');
    expect(e.message).toContain('chat-lock');
  });

  it('a secret-scanning rule without injected secrets refuses to compile', () => {
    const yaml = ['version: 1', 'plan:', '  - id: no-secret-values', '    severity: hard', '    why: x', '    reject_patterns: []', ''].join('\n');
    const e = compileErrorOf(yaml, {});
    expect(e.code).toBe('inhibit/config-required');
    expect(e.message).toContain('no-secret-values');
  });

  it('an empty injected secret would match every argument and is rejected', () => {
    const e = compileErrorOf(FIXTURE_YAML, { ...fixtureCfg, secrets: [''] });
    expect(e.code).toBe('inhibit/config-invalid');
  });
});

describe('compileGate — the canon draft', () => {
  const gate = canonGate();

  it('compiles every rule in corpus/canon/inhibitions.yaml to a matcher', () => {
    const rules = gate.rules();
    expect(rules.map((r) => r.id)).toEqual([
      // tool rules, id order
      'chat-lock',
      'no-secret-args',
      'unknown-tool-deny',
      // plan rules, id order
      'banned-construction',
      'no-machinery-leak',
      'no-mind-reading',
      'no-secret-values',
      // normalize rules, document order (sequential rewrites)
      'em-dash',
      'smart-ellipsis',
    ]);
    for (const r of rules) {
      expect(r.why.length).toBeGreaterThan(0);
      expect(r.matcher.length).toBeGreaterThan(0);
    }
  });

  it('surfaces the crisis exemption as dormant — loudly, not silently dropped', () => {
    const dormant = gate.rules().filter((r) => r.dormantAllowWhen !== undefined);
    expect(dormant.map((r) => r.id)).toEqual(['no-mind-reading']);
    expect(dormant[0]?.dormantAllowWhen).toBe('entry.crisis == true');
    // Dormant means the rule is enforced unconditionally: the gate cannot see a
    // crisis flag through either call signature, so the exemption never fires.
    const why = dormant[0]?.why ?? '';
    expect(gate.checkPlan({ plan: 'reply', bubbles: ['you sound tired, rest'] })).toEqual({
      allow: false,
      code: 'forbidden-pattern',
      ruleId: 'no-mind-reading',
      hint: `[INHIBITION:no-mind-reading] ${why}`,
    });
  });

  it('compiles deterministically — two boots, one artifact', () => {
    const again = canonGate();
    expect(JSON.stringify(again.rules())).toBe(JSON.stringify(gate.rules()));
    expect(again.renderPromptBlock()).toBe(gate.renderPromptBlock());
    const call = { id: '1', name: 'send_message', args: { chat_id: 'chat-0' } as unknown };
    expect(again.checkTool(call, 'user-turn')).toEqual(gate.checkTool(call, 'user-turn'));
  });
});

describe('known tools — deny by default, and what makes a tool known', () => {
  it("the yaml's explicitly named tools are known (their own rules fire, not the default)", () => {
    const gate = fixtureGate();
    expect(codeOf(gate.checkTool({ id: '1', name: 'send_message', args: {} }, 'ponder'))).toBe('chat-lock');
    expect(codeOf(gate.checkTool({ id: '1', name: 'memory_search', args: {} }, 'ponder'))).toBe('path-fence');
    expect(codeOf(gate.checkTool({ id: '1', name: 'set_reminder', args: {} }, 'ponder'))).toBe('spend-cap');
  });

  it("a '*' rule grants knowledge of nothing (otherwise default-deny would be vacuous)", () => {
    const gate = compileGate(
      ['version: 1', 'tool:', '  - id: star', '    why: x', "    applies: '*'", '    allow_entry:', '      ponder: [web_fetch]', ''].join('\n'),
      { secrets: ['s'] },
    );
    expect(gate.checkTool({ id: '1', name: 'web_search', args: {} }, 'ponder')).toEqual({
      allow: false,
      code: 'unknown-tool',
      ruleId: 'unknown-tool-deny',
      hint: "[INHIBITION] tool 'web_search' is not in the registry — deny by default",
    });
  });

  it('cfg.knownTools extends the set at compose (M20 injects the M13 registry)', () => {
    const gate = compileGate(FIXTURE_YAML, { ...fixtureCfg, knownTools: ['fork'] });
    expect(gate.checkTool({ id: '1', name: 'fork', args: {} }, 'ponder').allow).toBe(true);
  });

  it('an undeclared tool is denied with the spec-pinned code even with no registry rule in the yaml', () => {
    const gate = compileGate('version: 1\n', { knownTools: ['web_search'] });
    expect(codeOf(gate.checkTool({ id: '1', name: 'web_search', args: {} }, 'ponder'))).toBe('allow');
    expect(codeOf(gate.checkTool({ id: '1', name: 'calc', args: {} }, 'ponder'))).toBe('unknown-tool');
  });
});

describe('renderPromptBlock — one artifact, one budget', () => {
  it('a block over the 300-token packet budget refuses to compile', () => {
    // The block renders rule IDS only (prompt.test.ts pins the no-why law), so
    // budget pressure now comes from the rule COUNT, not from why-text length:
    // 60 ids x ~43 chars ≈ 650 tokens, far past the 300-token packet budget.
    const yaml = [
      'version: 1',
      'plan:',
      ...Array.from({ length: 60 }, (_, i) => {
        const id = `rule-${String(i).padStart(3, '0')}-${'x'.repeat(32)}`;
        return `  - id: ${id}\n    severity: hard\n    why: short\n    reject_patterns: ["${i}"]`;
      }),
      '',
    ].join('\n');
    const e = compileErrorOf(yaml, {});
    expect(e.code).toBe('inhibit/prompt-budget');
  });
});

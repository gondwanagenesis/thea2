// The compiled gate — truth tables over (rule, tool call / plan, entry kind),
// the two-path parity matrix, the unknown-tool default, and the <1ms-class
// benchmark. Every row below is hand-derived from test/inhibit/fixtures/.

import { describe, expect, it } from 'vitest';
import {
  MAX_GATE_REENTRIES,
  VERDICT_CODES,
  compileGate,
  type EntryKind,
  type PlanView,
  type Verdict,
  type VerdictCode,
} from '../../src/inhibit/index.js';
import { fixtureGate, hintFor } from './helpers.js';
import { Verdict as VerdictSchema } from '../../schemas/decision.js';

const allow: Verdict = { allow: true };
const deny = (code: VerdictCode, ruleId: string, why: string): Verdict => ({
  allow: false,
  code,
  ruleId,
  hint: hintFor(ruleId, why),
});
const sameVerdict = (a: Verdict, b: Verdict): boolean => {
  if (a.allow !== b.allow) return false;
  if (!a.allow && !b.allow) return a.code === b.code && a.ruleId === b.ruleId && a.hint === b.hint;
  return true; // both allow
};

// -- fixture whys, kept next to the tables that assert on their hints ---------
const WHY = {
  'chat-lock': "outbound messages go to Diego's chat and nowhere else",
  'unknown-tool-deny': 'a tool not in the registry is a bug, not an improvisation',
  'no-secret-args': 'secret values must never ride tool arguments outward',
  'search-region-allow': 'the region pin is part of the tool contract',
  'ponder-spend-cap': 'a ponder reminder may not exceed its budget',
  'memory-path-fence': 'path access stays inside the memory and thread roots',
  'ponder-only-web': 'web reading is a ponder activity, not a heartbeat reflex',
  'no-machinery-leak': 'internal blocks and tool traffic must never reach the channel',
  'no-secret-values': 'known secret values never leave the process',
  'banned-construction': 'the "it\'s not X, it\'s Y" family is the #1 AI tell',
  'probe-only-leak': 'scanned on send_message args only on the tool path, on every bubble on the plan path',
} as const;

interface ToolRow {
  label: string;
  call: { id: string; name: string; args: unknown };
  entry: EntryKind;
  want: Verdict;
}

const toolRows: ToolRow[] = [
  // -- chat-id lock -------------------------------------------------------
  {
    label: 'send_message to the owner chat is allowed',
    call: { id: '1', name: 'send_message', args: { chat_id: 'chat-diego', body: 'hi' } },
    entry: 'user-turn',
    want: allow,
  },
  {
    label: 'send_message to another chat denies chat-lock',
    call: { id: '1', name: 'send_message', args: { chat_id: 'chat-999' } },
    entry: 'user-turn',
    want: deny('chat-lock', 'chat-lock', WHY['chat-lock']),
  },
  {
    label: 'send_message with no chat_id denies chat-lock (missing is not permission)',
    call: { id: '1', name: 'send_message', args: { body: 'hi' } },
    entry: 'heartbeat',
    want: deny('chat-lock', 'chat-lock', WHY['chat-lock']),
  },
  // -- secret args --------------------------------------------------------
  {
    label: 'a secret value inside a tool argument denies secret-leak',
    call: { id: '1', name: 'web_fetch', args: { url: 'https://x.test/?k=sk-fixture-0123456789' } },
    entry: 'ponder',
    want: deny('secret-leak', 'no-secret-args', WHY['no-secret-args']),
  },
  // -- arg allowlist ------------------------------------------------------
  {
    label: 'an allowed region passes the allowlist',
    call: { id: '1', name: 'web_search', args: { query: 'x', region: 'us' } },
    entry: 'ponder',
    want: allow,
  },
  {
    label: 'a region outside the allowlist denies arg-not-allowed',
    call: { id: '1', name: 'web_search', args: { query: 'x', region: 'mx' } },
    entry: 'ponder',
    want: deny('arg-not-allowed', 'search-region-allow', WHY['search-region-allow']),
  },
  {
    label: 'a missing allowlisted arg denies (fail closed)',
    call: { id: '1', name: 'web_search', args: { query: 'x' } },
    entry: 'ponder',
    want: deny('arg-not-allowed', 'search-region-allow', WHY['search-region-allow']),
  },
  // -- per-entry-context allowlist ---------------------------------------
  {
    label: 'web_fetch is legal under ponder',
    call: { id: '1', name: 'web_fetch', args: { url: 'https://ok.test' } },
    entry: 'ponder',
    want: allow,
  },
  {
    label: 'the same call is denied under heartbeat',
    call: { id: '1', name: 'web_fetch', args: { url: 'https://ok.test' } },
    entry: 'heartbeat',
    want: deny('entry-not-allowed', 'ponder-only-web', WHY['ponder-only-web']),
  },
  {
    label: 'user-turn lists web_search only, so web_fetch is denied there too',
    call: { id: '1', name: 'web_fetch', args: { url: 'https://ok.test' } },
    entry: 'user-turn',
    want: deny('entry-not-allowed', 'ponder-only-web', WHY['ponder-only-web']),
  },
  // -- spend cap ----------------------------------------------------------
  {
    label: 'a reminder at the cap passes',
    call: { id: '1', name: 'set_reminder', args: { minutes: 30 } },
    entry: 'ponder',
    want: allow,
  },
  {
    label: 'a reminder over the cap denies spend-cap',
    call: { id: '1', name: 'set_reminder', args: { minutes: 30.5 } },
    entry: 'ponder',
    want: deny('spend-cap', 'ponder-spend-cap', WHY['ponder-spend-cap']),
  },
  {
    label: 'a non-numeric spend arg denies (fail closed)',
    call: { id: '1', name: 'set_reminder', args: { minutes: '45' } },
    entry: 'ponder',
    want: deny('spend-cap', 'ponder-spend-cap', WHY['ponder-spend-cap']),
  },
  {
    label: 'a missing spend arg denies',
    call: { id: '1', name: 'set_reminder', args: {} },
    entry: 'ponder',
    want: deny('spend-cap', 'ponder-spend-cap', WHY['ponder-spend-cap']),
  },
  // -- path fence ---------------------------------------------------------
  {
    label: 'a path inside a fenced root passes',
    call: { id: '1', name: 'memory_search', args: { path: 'memory/notes/a.md' } },
    entry: 'user-turn',
    want: allow,
  },
  {
    label: 'the fence root itself passes',
    call: { id: '1', name: 'memory_search', args: { path: 'memory' } },
    entry: 'user-turn',
    want: allow,
  },
  {
    label: 'a second fenced root passes',
    call: { id: '1', name: 'memory_search', args: { path: 'threads/t1' } },
    entry: 'user-turn',
    want: allow,
  },
  {
    label: 'traversal out of the fence denies path-fence',
    call: { id: '1', name: 'memory_search', args: { path: 'memory/../secrets/x' } },
    entry: 'user-turn',
    want: deny('path-fence', 'memory-path-fence', WHY['memory-path-fence']),
  },
  {
    label: 'a path outside every fenced root denies',
    call: { id: '1', name: 'memory_search', args: { path: 'other/x' } },
    entry: 'user-turn',
    want: deny('path-fence', 'memory-path-fence', WHY['memory-path-fence']),
  },
  {
    label: 'an absolute path does not sneak past the fence',
    call: { id: '1', name: 'memory_search', args: { path: 'C:/memory/a' } },
    entry: 'user-turn',
    want: deny('path-fence', 'memory-path-fence', WHY['memory-path-fence']),
  },
  {
    label: 'a missing path denies',
    call: { id: '1', name: 'memory_search', args: {} },
    entry: 'user-turn',
    want: deny('path-fence', 'memory-path-fence', WHY['memory-path-fence']),
  },
  // -- regex over textual tool args --------------------------------------
  {
    label: 'machinery markup in an argument denies forbidden-pattern',
    call: { id: '1', name: 'send_message', args: { chat_id: 'chat-diego', body: 'a ⟦ work log' } },
    entry: 'user-turn',
    want: deny('forbidden-pattern', 'no-machinery-leak', WHY['no-machinery-leak']),
  },
  {
    label: 'a style rule fires on the tool path too (one rule set, two call sites)',
    call: { id: '1', name: 'send_message', args: { chat_id: 'chat-diego', body: 'not only fast, but right' } },
    entry: 'user-turn',
    want: deny('forbidden-pattern', 'banned-construction', WHY['banned-construction']),
  },
  {
    label: 'a declared applies narrows the tool-arg scan (web_search args are not scanned)',
    call: { id: '1', name: 'web_search', args: { query: 'INTERNAL_ONLY', region: 'us' } },
    entry: 'ponder',
    want: allow,
  },
  {
    label: 'the narrowed rule still fires on the tool it names',
    call: { id: '1', name: 'send_message', args: { chat_id: 'chat-diego', body: 'plain INTERNAL_ONLY text' } },
    entry: 'user-turn',
    want: deny('forbidden-pattern', 'probe-only-leak', WHY['probe-only-leak']),
  },
  // -- unknown tool -------------------------------------------------------
  {
    label: 'a tool no rule knows is denied by default, whatever the entry kind',
    call: { id: '1', name: 'fork', args: {} },
    entry: 'ponder',
    want: deny('unknown-tool', 'unknown-tool-deny', WHY['unknown-tool-deny']),
  },
  {
    label: 'the same unknown tool is denied under user-turn',
    call: { id: '1', name: 'fork', args: {} },
    entry: 'user-turn',
    want: deny('unknown-tool', 'unknown-tool-deny', WHY['unknown-tool-deny']),
  },
];

describe('checkTool — truth table over the compiled fixture gate', () => {
  const gate = fixtureGate();
  for (const row of toolRows) {
    it(`${row.call.name}/${row.entry}: ${row.label}`, () => {
      expect(gate.checkTool(row.call, row.entry)).toEqual(row.want);
    });
  }
});

interface PlanRow {
  label: string;
  d: { plan: 'reply' | 'silent' | 'defer'; bubbles: string[] };
  want: Verdict;
}

const planRows: PlanRow[] = [
  { label: 'clean bubbles pass', d: { plan: 'reply', bubbles: ['hello there'] }, want: allow },
  { label: 'a plan with no bubbles passes', d: { plan: 'silent', bubbles: [] }, want: allow },
  {
    label: 'machinery markup in one bubble denies',
    d: { plan: 'reply', bubbles: ['fine', '⟦ work log'] },
    want: deny('forbidden-pattern', 'no-machinery-leak', WHY['no-machinery-leak']),
  },
  {
    label: 'block-tag markup denies',
    d: { plan: 'reply', bubbles: ['[IDENTITY] I am'] },
    want: deny('forbidden-pattern', 'no-machinery-leak', WHY['no-machinery-leak']),
  },
  {
    label: 'an injected secret in a bubble denies secret-leak (compose slot)',
    d: { plan: 'reply', bubbles: ['the key is sk-fixture-0123456789 ok'] },
    want: deny('secret-leak', 'no-secret-values', WHY['no-secret-values']),
  },
  {
    label: 'a soft style rule denies the plan too — severity belongs to M13 re-entry, not to the gate',
    d: { plan: 'reply', bubbles: ['not only loud, but clear'] },
    want: deny('forbidden-pattern', 'banned-construction', WHY['banned-construction']),
  },
  {
    label: 'a declared applies does NOT narrow the plan path — every bubble is scanned',
    d: { plan: 'reply', bubbles: ['INTERNAL_ONLY marker'] },
    want: deny('forbidden-pattern', 'probe-only-leak', WHY['probe-only-leak']),
  },
  {
    label: 'em-dashes are normalized at realization, not gated',
    d: { plan: 'defer', bubbles: ['wait — ok'] },
    want: allow,
  },
];

describe('checkPlan — truth table over the compiled fixture gate', () => {
  const gate = fixtureGate();
  for (const row of planRows) {
    it(`${row.d.plan}: ${row.label}`, () => {
      expect(gate.checkPlan(row.d)).toEqual(row.want);
    });
  }
});

describe('path parity — one rule set, two call sites', () => {
  const gate = fixtureGate();

  it('every text rule yields the identical verdict for identical content on both paths', () => {
    const contents = ['a ⟦ leak', 'plain INTERNAL_ONLY text', 'not only rough, but clean'];
    for (const text of contents) {
      const viaPlan = gate.checkPlan({ plan: 'reply', bubbles: [text] });
      const viaTool = gate.checkTool(
        { id: '1', name: 'send_message', args: { chat_id: 'chat-diego', body: text } },
        'user-turn',
      );
      expect(viaTool).toEqual(viaPlan);
      expect(viaPlan.allow).toBe(false);
    }
  });

  it('the two secret rules share one code, each on its own path', () => {
    const secret = 'sk-fixture-0123456789';
    const viaPlan = gate.checkPlan({ plan: 'reply', bubbles: [secret] });
    const viaTool = gate.checkTool(
      { id: '1', name: 'send_message', args: { chat_id: 'chat-diego', body: secret } },
      'user-turn',
    );
    expect(viaPlan).toEqual({ allow: false, code: 'secret-leak', ruleId: 'no-secret-values', hint: hintFor('no-secret-values', WHY['no-secret-values']) });
    expect(viaTool).toEqual({ allow: false, code: 'secret-leak', ruleId: 'no-secret-args', hint: hintFor('no-secret-args', WHY['no-secret-args']) });
  });
});

describe('gate surface — what M13 and M20 consume', () => {
  it('MAX_GATE_REENTRIES is exported and equal to 2', () => {
    expect(MAX_GATE_REENTRIES).toBe(2);
  });

  it('the verdict codes are a closed, stable set with the spec-pinned unknown-tool', () => {
    expect(VERDICT_CODES).toEqual([
      'unknown-tool',
      'chat-lock',
      'secret-leak',
      'arg-not-allowed',
      'spend-cap',
      'path-fence',
      'entry-not-allowed',
      'forbidden-pattern',
    ]);
  });

  it('verdicts satisfy the reference DecisionObject Verdict schema M13 embeds', () => {
    const gate = fixtureGate();
    expect(VerdictSchema.safeParse(gate.checkTool({ id: '1', name: 'send_message', args: {} }, 'user-turn')).success).toBe(true);
    expect(VerdictSchema.safeParse(gate.checkPlan({ plan: 'reply', bubbles: ['⟦'] })).success).toBe(true);
  });

  it('severityOf answers the re-entry contract (hard forces silent, soft fails open — M13)', () => {
    const gate = fixtureGate();
    expect(gate.severityOf('no-machinery-leak')).toBe('hard');
    expect(gate.severityOf('banned-construction')).toBe('soft');
    expect(gate.severityOf('chat-lock')).toBe('hard');
    expect(gate.severityOf('em-dash')).toBe('hard');
    expect(gate.severityOf('no-such-rule')).toBeUndefined();
  });
});

describe('allow_when — bound where a call signature can see it, dormant where it cannot', () => {
  const yaml = [
    'version: 1',
    'tool:',
    '  - id: ponder-pinned-arg',
    '    why: the region pin applies except during ponder',
    '    applies: [web_search]',
    '    allow_args:',
    '      region: [us]',
    "    allow_when: entry.kind == 'ponder'",
    'plan:',
    '  - id: style-rule',
    '    severity: soft',
    '    why: style',
    '    reject_patterns: ["loud"]',
    "    allow_when: entry.kind == 'ponder'",
    '',
  ].join('\n');
  const gate = compileGate(yaml, { secrets: ['s'] });

  it('a tool rule skips while the bound condition holds', () => {
    expect(gate.checkTool({ id: '1', name: 'web_search', args: { region: 'eu' } }, 'ponder')).toEqual(allow);
  });

  it('the same rule enforces again outside the condition', () => {
    expect(gate.checkTool({ id: '1', name: 'web_search', args: { region: 'eu' } }, 'user-turn')).toEqual(
      deny('arg-not-allowed', 'ponder-pinned-arg', 'the region pin applies except during ponder'),
    );
  });

  it('a plan rule has no entry on its path, so the condition is surfaced as dormant and the rule stays enforced', () => {
    const info = gate.rules().find((r) => r.id === 'style-rule');
    expect(info?.dormantAllowWhen).toBe("entry.kind == 'ponder'");
    expect(gate.checkPlan({ plan: 'reply', bubbles: ['a loud thing'] }).allow).toBe(false);
  });
});

describe('normalizeText — the one mechanical rewrite class', () => {
  it('applies every normalizer, in document order, globally', () => {
    expect(fixtureGate().normalizeText('wait — really — ok… done')).toBe('wait. really. ok... done');
  });

  it('the replacement is literal — $ is never interpolation', () => {
    const gate = compileGate(
      ['version: 1', 'normalize:', "  - id: literal", '    replace: { from: x, to: "$&$1" }', ''].join('\n'),
      {},
    );
    expect(gate.normalizeText('axb')).toBe('a$&$1b');
  });
});

describe('purity — no mutation, no drift between repeats', () => {
  it('checkTool and checkPlan never mutate their inputs (frozen inputs cannot throw)', () => {
    const gate = fixtureGate();
    const call = Object.freeze({
      id: '1',
      name: 'send_message',
      args: Object.freeze({ chat_id: Object.freeze('chat-diego'), body: Object.freeze('⟦ frozen') }),
    });
    const plan: PlanView = Object.freeze({ plan: 'reply' as const, bubbles: Object.freeze(['⟦ frozen']) });
    expect(() => gate.checkTool(call, 'user-turn')).not.toThrow();
    expect(() => gate.checkPlan(plan)).not.toThrow();
    expect(gate.checkTool(call, 'user-turn')).toEqual(gate.checkTool(call, 'user-turn'));
  });

  it('two independently compiled gates agree on every verdict', () => {
    const a = fixtureGate();
    const b = fixtureGate();
    for (const row of toolRows) expect(b.checkTool(row.call, row.entry)).toEqual(a.checkTool(row.call, row.entry));
    for (const row of planRows) expect(b.checkPlan(row.d)).toEqual(a.checkPlan(row.d));
  });
});

describe('latency — the <1ms class, proven by loop size rather than a timer', () => {
  // No timing assertion: TESTING.md leaves wall-clock jitter to design margins.
  // The bound is structural — vitest fails this test at its 5 s timeout, so the
  // 50 000-check loop can only pass while a check costs ~two orders below 1 ms.
  // A per-check recompile or an I/O touch would blow straight through it. The
  // measured number is logged for the report, never asserted on.
  it('50 000 checks over the compiled fixture gate finish inside the harness budget with stable verdicts', () => {
    const gate = fixtureGate();
    const N = 50_000;

    // snapshot outside the timed region; the loop only counts agreement
    const toolSnapshot = toolRows.map((r) => ({ call: r.call, entry: r.entry, want: gate.checkTool(r.call, r.entry) }));
    const planSnapshot = planRows.map((r) => ({ d: r.d, want: gate.checkPlan(r.d) }));

    const started = process.hrtime.bigint();
    let stable = 0;
    for (let i = 0; i < N; i++) {
      const t = toolSnapshot[i % toolSnapshot.length];
      if (t !== undefined && sameVerdict(gate.checkTool(t.call, t.entry), t.want)) stable++;
      const p = planSnapshot[i % planSnapshot.length];
      if (p !== undefined && sameVerdict(gate.checkPlan(p.d), p.want)) stable++;
    }
    const perCheckUs = ((Number(process.hrtime.bigint() - started) / 1e6) / (N * 2)) * 1000;

    expect(stable).toBe(N * 2);
    console.info(`[inhibit] ${N * 2} checks over ${gate.rules().length} rules: ${perCheckUs.toFixed(3)} µs/check`);
  });
});

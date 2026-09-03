// M12 inhibit — compileGate: yaml text -> matchers -> InhibitionGate. Everything
// expensive happens here, once at boot: YAML parse, strict schema, regex
// compilation, known-tool set, prompt block. What the gate exposes afterwards is
// a pure function of (compiled rules, input) — <1 ms, zero I/O, zero model.

import { compareStrings } from '../corpus/types.js';
import type { ToolCall } from '../model/types.js';
import { InhibitError } from './errors.js';
import { assertPromptBudget, renderPromptBlock } from './prompt.js';
import { DOC_LABEL, parseInhibitionsDoc, type NormalizeRule, type PlanRule, type ToolRule } from './schema.js';
import { ENTRY_KINDS, type EntryKind, type GateConfig, type InhibitionGate, type PlanView, type RuleInfo, type Verdict, type VerdictCode } from './types.js';

const ALLOW: Verdict = { allow: true };

const hintFor = (ruleId: string, why: string): string => `[INHIBITION:${ruleId}] ${why}`;

const denyOf = (ruleId: string, why: string, code: VerdictCode): Verdict => ({
  allow: false,
  code,
  ruleId,
  hint: hintFor(ruleId, why),
});

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

// ---------------------------------------------------------------------------
// The check-text registry. The yaml's prose `check` lines are the human's
// documentation; the compiler recognizes exactly these and nothing else, so a
// rule can only bind to a predicate the code actually implements. New prose is
// therefore a code change — correct for rules that are hand-written and never
// generated. The machine fields in schema.ts let a new rule of a KNOWN class
// land without touching code.
// ---------------------------------------------------------------------------

const REGISTRY_CHECK = 'tool in registry';
const SECRET_CHECK = 'args match none of runtime secret values (injected at compose, never listed here)';
const OWNER_CHECK_RE = /^([\w.]+) == config\.owner_chat_id$/;

const normalizeCheckText = (text: string): string => text.trim().replace(/\s+/g, ' ');

// ---------------------------------------------------------------------------
// allow_when vocabulary. `entry.kind == '<kind>'` is live on the candidate path
// (checkTool receives the entry kind); checkPlan has no entry at all. Any other
// `entry.<field> == true|false` (the canon's `entry.crisis == true`) is
// RECOGNIZED but unbound — no caller can assert it through either signature — so
// it compiles as a dormant exemption, the rule stays enforced unconditionally,
// and rules() surfaces it. Anything else is a startup failure.
// ---------------------------------------------------------------------------

const ENTRY_KIND_ALLOW_RE = /^entry\.kind == '([a-z-]+)'$/;
const ENTRY_FIELD_ALLOW_RE = /^entry\.(\w+) == (true|false)$/;

interface AllowWhen {
  /** True when the rule must be skipped for this entry kind. */
  skips?: (entry: EntryKind) => boolean;
  /** The declared-but-unbindable condition, surfaced via rules(). */
  dormant?: string;
}

const compileAllowWhen = (expr: string, ruleId: string, entryVisible: boolean): AllowWhen => {
  if (expr === '') return {}; // no allow_when declared
  const kindMatch = ENTRY_KIND_ALLOW_RE.exec(expr);
  if (kindMatch !== null && kindMatch[1] !== undefined) {
    const kind = kindMatch[1];
    if ((ENTRY_KINDS as readonly string[]).includes(kind)) {
      if (!entryVisible) return { dormant: expr };
      return { skips: (entry) => entry === kind };
    }
  }
  if (ENTRY_FIELD_ALLOW_RE.test(expr)) return { dormant: expr };
  throw new InhibitError(
    'inhibit/allow-when',
    `${DOC_LABEL}: rule '${ruleId}' has allow_when '${expr}' — recognized forms are entry.kind == '<entry-kind>' and entry.<field> == true|false`,
    { ruleId },
  );
};

// ---------------------------------------------------------------------------
// Matcher building blocks (all pure; no fs, no clock).
// ---------------------------------------------------------------------------

/** Tool args are JSON-decoded (acyclic, depth-bounded by the model budget), so a plain walk is safe. */
const someArgText = (value: unknown, pred: (text: string) => boolean): boolean => {
  if (typeof value === 'string') return pred(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      if (someArgText(item, pred)) return true;
    }
    return false;
  }
  if (isPlainObject(value)) {
    for (const [key, v] of Object.entries(value)) {
      // Keys are model-authored too under native function calling — scan them.
      if (pred(key) || someArgText(v, pred)) return true;
    }
  }
  return false;
};

/** Lexical path containment: separators normalized, '.'/'..' resolved, no fs — identical on every OS. */
const splitPath = (p: string): string[] => {
  const out: string[] = [];
  for (const seg of p.replaceAll('\\', '/').split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      const last = out[out.length - 1];
      if (out.length > 0 && last !== '..') out.pop();
      else out.push('..');
    } else {
      out.push(seg);
    }
  }
  return out;
};

const pathUnderFence = (value: string, roots: readonly string[]): boolean => {
  const segs = splitPath(value);
  if (segs.length === 0 || segs[0] === '..') return false;
  for (const root of roots) {
    const fence = splitPath(root);
    if (fence.length === 0 || fence.length > segs.length) continue;
    let inside = true;
    for (let i = 0; i < fence.length; i++) {
      if (fence[i] !== segs[i]) {
        inside = false;
        break;
      }
    }
    if (inside) return true;
  }
  return false;
};

interface ToolCheck {
  code: VerdictCode;
  /** True = the rule is violated. */
  violates(args: unknown, entry: EntryKind, tool: string): boolean;
}

const ownerChatCheck = (arg: string, ownerChatId: string): ToolCheck => ({
  code: 'chat-lock',
  violates: (args) => !isPlainObject(args) || args[arg] !== ownerChatId,
});

const secretArgsCheck = (secrets: readonly string[]): ToolCheck => ({
  code: 'secret-leak',
  violates: (args) => secrets.some((s) => someArgText(args, (t) => t.includes(s))),
});

const allowArgsChecks = (map: Record<string, Array<string | number>>): ToolCheck[] =>
  Object.entries(map).map(([arg, values]) => ({
    code: 'arg-not-allowed' as const,
    violates: (args) => {
      if (!isPlainObject(args)) return true;
      const v = args[arg];
      return !(typeof v === 'string' || typeof v === 'number') || !values.includes(v);
    },
  }));

const spendCapCheck = (arg: string, max: number): ToolCheck => ({
  code: 'spend-cap',
  violates: (args) => {
    if (!isPlainObject(args)) return true;
    const v = args[arg];
    return typeof v !== 'number' || !Number.isFinite(v) || v > max;
  },
});

const pathFenceCheck = (arg: string, under: readonly string[]): ToolCheck => ({
  code: 'path-fence',
  violates: (args) => {
    if (!isPlainObject(args)) return true;
    const v = args[arg];
    return typeof v !== 'string' || !pathUnderFence(v, under);
  },
});

const entryAllowCheck = (map: Partial<Record<EntryKind, string[]>>): ToolCheck => ({
  code: 'entry-not-allowed',
  violates: (_args, entry, tool) => !(map[entry]?.includes(tool) ?? false),
});

// ---------------------------------------------------------------------------
// Compiled rule shapes.
// ---------------------------------------------------------------------------

interface CompiledToolRule {
  info: RuleInfo;
  isRegistry: boolean;
  /** undefined = '*' (every tool). */
  governed: ReadonlySet<string> | undefined;
  checks: ToolCheck[];
  allowWhen: AllowWhen;
}

interface CompiledTextRule {
  info: RuleInfo;
  patterns: RegExp[];
  /** The compose-slot secret scan — plan path only (the tool path has its own declared rule). */
  planSecrets: boolean;
  /** Candidate-path narrowing; undefined = scan every tool's args. */
  toolApplies: ReadonlySet<string> | undefined;
  patternDeny: Verdict;
  secretDeny: Verdict;
}

interface CompiledNormalize {
  info: RuleInfo;
  /** Global: a mechanical substitution replaces every occurrence. */
  regex: RegExp;
  to: string;
}

const needOwner = (ruleId: string, cfg: GateConfig): string => {
  if (cfg.ownerChatId === undefined) {
    throw new InhibitError(
      'inhibit/config-required',
      `${DOC_LABEL}: rule '${ruleId}' pins an argument to the owner chat id, but no ownerChatId was injected at compose`,
      { ruleId },
    );
  }
  return cfg.ownerChatId;
};

const needSecrets = (ruleId: string, secrets: readonly string[]): readonly string[] => {
  if (secrets.length === 0) {
    throw new InhibitError(
      'inhibit/config-required',
      `${DOC_LABEL}: rule '${ruleId}' scans the runtime secret values, but none were injected at compose (GateConfig.secrets)`,
      { ruleId },
    );
  }
  return secrets;
};

const compileToolRule = (rule: ToolRule, cfg: GateConfig, secrets: readonly string[]): CompiledToolRule => {
  let isRegistry = false;
  const matcherKinds: string[] = [];
  // Phase A — resolve WHICH predicates the rule carries, without touching config.
  // Structural validity is judged before any config value is demanded, so a rule
  // that cannot bind is reported as such even when a value is also missing.
  const pending: Array<(cfg: GateConfig, secrets: readonly string[]) => ToolCheck | ToolCheck[]> = [];

  if (rule.require_registry === true) {
    if (rule.applies !== undefined && rule.applies !== '*') {
      throw new InhibitError('inhibit/schema', `${DOC_LABEL}: rule '${rule.id}' is the registry rule and must apply to '*'`, { ruleId: rule.id });
    }
    isRegistry = true;
    matcherKinds.push('registry-default-deny');
  }

  if (rule.check !== undefined && !isRegistry) {
    const text = normalizeCheckText(rule.check);
    const ownerMatch = OWNER_CHECK_RE.exec(text);
    const ownerArg = ownerMatch !== null && ownerMatch[1] !== undefined ? ownerMatch[1] : undefined;
    if (ownerArg !== undefined) {
      pending.push((c) => ownerChatCheck(ownerArg, needOwner(rule.id, c)));
      matcherKinds.push('owner-chat');
    } else if (text === REGISTRY_CHECK) {
      isRegistry = true;
      matcherKinds.push('registry-default-deny');
    } else if (text === SECRET_CHECK) {
      pending.push((_c, s) => secretArgsCheck(needSecrets(rule.id, s)));
      matcherKinds.push('arg-secret-scan');
    } else {
      throw new InhibitError(
        'inhibit/unbound-rule',
        `${DOC_LABEL}: rule '${rule.id}' cannot be compiled — its check '${rule.check}' is not in the registry. ` +
          `Known checks: '${REGISTRY_CHECK}' / '${SECRET_CHECK}' / '<arg> == config.owner_chat_id', or use a machine field ` +
          `(owner_arg, allow_args, spend_cap, path_fence, allow_entry, no_secret_args)`,
        { ruleId: rule.id, field: 'check' },
      );
    }
  }

  // Machine predicates (they win over prose when both are present).
  if (rule.owner_arg !== undefined) {
    const arg = rule.owner_arg;
    pending.push((c) => ownerChatCheck(arg, needOwner(rule.id, c)));
    matcherKinds.push('owner-chat');
  }
  if (rule.no_secret_args === true || rule.secret_scan === true) {
    pending.push((_c, s) => secretArgsCheck(needSecrets(rule.id, s)));
    matcherKinds.push('arg-secret-scan');
  }
  if (rule.allow_args !== undefined) {
    const map = rule.allow_args;
    pending.push(() => [...allowArgsChecks(map)]);
    matcherKinds.push('arg-allowlist');
  }
  if (rule.spend_cap !== undefined) {
    const cap = rule.spend_cap;
    pending.push(() => spendCapCheck(cap.arg, cap.max));
    matcherKinds.push('spend-cap');
  }
  if (rule.path_fence !== undefined) {
    const fence = rule.path_fence;
    pending.push(() => pathFenceCheck(fence.arg, fence.under));
    matcherKinds.push('path-fence');
  }
  if (rule.allow_entry !== undefined) {
    const map = rule.allow_entry;
    pending.push(() => entryAllowCheck(map));
    matcherKinds.push('entry-allowlist');
  }

  // Phase B — structural checks, before any config value is demanded.
  if (isRegistry && pending.length > 0) {
    throw new InhibitError('inhibit/schema', `${DOC_LABEL}: rule '${rule.id}' is the registry rule and carries no other predicate`, { ruleId: rule.id });
  }
  if (pending.length === 0 && !isRegistry) {
    throw new InhibitError(
      'inhibit/unbound-rule',
      `${DOC_LABEL}: rule '${rule.id}' has neither a machine predicate nor a recognized check — a rule that cannot bind must not look loaded`,
      { ruleId: rule.id },
    );
  }

  // Governed tools: explicit naming only. '*' never makes a tool known, which is
  // exactly what keeps the file's own default-deny rule non-vacuous.
  let governed: ReadonlySet<string> | undefined;
  if (Array.isArray(rule.applies)) governed = new Set(rule.applies);
  if (rule.allow_entry !== undefined) {
    const named = new Set<string>();
    for (const kind of ENTRY_KINDS) {
      for (const tool of rule.allow_entry[kind] ?? []) named.add(tool);
    }
    governed = governed === undefined ? named : new Set([...governed].filter((t) => named.has(t)));
  }
  if (governed === undefined && !isRegistry) {
    throw new InhibitError(
      'inhibit/schema',
      `${DOC_LABEL}: rule '${rule.id}' has predicates but names no tools — declare applies or allow_entry (absence of a rule is not permission)`,
      { ruleId: rule.id },
    );
  }

  // Phase C — instantiate matchers, now demanding the config values they need.
  const checks = pending.map((make) => make(cfg, secrets)).flat();

  const allowWhen = compileAllowWhen(rule.allow_when ?? '', rule.id, true);
  return {
    info: {
      id: rule.id,
      ruleClass: 'tool',
      severity: 'hard',
      why: rule.why,
      matcher: matcherKinds.join('+'),
      ...(allowWhen.dormant !== undefined ? { dormantAllowWhen: allowWhen.dormant } : {}),
    },
    isRegistry,
    governed,
    checks,
    allowWhen,
  };
};

const compilePlanRule = (rule: PlanRule, secrets: readonly string[]): CompiledTextRule => {
  const patterns: RegExp[] = [];
  for (const p of rule.reject_patterns) {
    try {
      // Non-global and case-sensitive: compiled exactly as written, so `.test` is
      // stateless and the markup patterns cannot be widened into prose false
      // positives (a hard-rule false positive eats a real reply — the sentinel sin).
      patterns.push(new RegExp(p));
    } catch (e) {
      throw new InhibitError(
        'inhibit/bad-regex',
        `${DOC_LABEL}: rule '${rule.id}' pattern ${JSON.stringify(p)} does not compile: ${(e as Error).message}`,
        { ruleId: rule.id, cause: e },
      );
    }
  }

  // An empty reject_patterns list is the reserved compose slot ("populated at
  // compose time from env — never literal here"): it binds the injected secrets.
  const planSecrets = rule.reject_patterns.length === 0 || rule.secret_scan === true;
  if (planSecrets) needSecrets(rule.id, secrets);

  const matcherKinds = [patterns.length > 0 ? 'regex' : '', planSecrets ? 'compose-secrets' : ''].filter((s) => s !== '');
  const allowWhen = compileAllowWhen(rule.allow_when ?? '', rule.id, false);
  return {
    info: {
      id: rule.id,
      ruleClass: 'plan',
      severity: rule.severity,
      why: rule.why,
      matcher: matcherKinds.join('+'),
      ...(allowWhen.dormant !== undefined ? { dormantAllowWhen: allowWhen.dormant } : {}),
    },
    patterns,
    planSecrets,
    toolApplies: rule.applies === undefined ? undefined : new Set(rule.applies),
    patternDeny: denyOf(rule.id, rule.why, 'forbidden-pattern'),
    secretDeny: denyOf(rule.id, rule.why, 'secret-leak'),
  };
};

const compileNormalize = (rule: NormalizeRule): CompiledNormalize => {
  let regex: RegExp;
  try {
    regex = new RegExp(rule.replace.from, 'g');
  } catch (e) {
    throw new InhibitError(
      'inhibit/bad-regex',
      `${DOC_LABEL}: normalize rule '${rule.id}' pattern ${JSON.stringify(rule.replace.from)} does not compile: ${(e as Error).message}`,
      { ruleId: rule.id, cause: e },
    );
  }
  return {
    info: {
      id: rule.id,
      ruleClass: 'normalize',
      severity: 'hard',
      why: rule.why ?? 'mechanical rewrite (no why given)',
      matcher: 'regex-substitution',
    },
    regex,
    to: rule.replace.to,
  };
};

/**
 * Compiles the canon file into a gate. Throws on ANY invalid rule — no partially
 * compiled gate ever exists. `cfg` carries the compose-time values the yaml
 * deliberately never holds (owner chat id, secret values, registry names).
 */
export const compileGate = (yamlText: string, cfg: GateConfig = {}): InhibitionGate => {
  const doc = parseInhibitionsDoc(yamlText);

  // Ids share one namespace: verdicts name a rule, and M13 looks up its severity
  // by that name — an ambiguity here would be an ambiguity in enforcement.
  const declaredIn = new Map<string, string>();
  for (const section of ['tool', 'plan', 'normalize'] as const) {
    for (const rule of doc[section] ?? []) {
      const prev = declaredIn.get(rule.id);
      if (prev !== undefined) {
        throw new InhibitError(
          'inhibit/duplicate-id',
          `${DOC_LABEL}: rule id '${rule.id}' is declared twice ('${prev}' and '${section}') — verdicts must name one rule`,
          { ruleId: rule.id },
        );
      }
      declaredIn.set(rule.id, section);
    }
  }

  const secrets = cfg.secrets ?? [];
  for (const s of secrets) {
    if (s.length === 0) {
      throw new InhibitError('inhibit/config-invalid', `${DOC_LABEL}: an injected secret is the empty string — it would match every argument`);
    }
  }

  const toolRules = (doc.tool ?? []).map((r) => compileToolRule(r, cfg, secrets)).sort((a, b) => compareStrings(a.info.id, b.info.id));
  const textRules = (doc.plan ?? []).map((r) => compilePlanRule(r, secrets)).sort((a, b) => compareStrings(a.info.id, b.info.id));
  const normalizers = (doc.normalize ?? []).map(compileNormalize);

  const known = new Set<string>(cfg.knownTools ?? []);
  for (const rule of doc.tool ?? []) {
    if (Array.isArray(rule.applies)) {
      for (const name of rule.applies) known.add(name);
    }
    if (rule.allow_entry !== undefined) {
      for (const kind of ENTRY_KINDS) {
        for (const tool of rule.allow_entry[kind] ?? []) known.add(tool);
      }
    }
  }

  const infos: RuleInfo[] = [
    ...toolRules.map((r) => r.info),
    ...textRules.map((r) => r.info),
    ...normalizers.map((r) => r.info),
  ];
  const promptBlock = renderPromptBlock(infos);
  assertPromptBudget(promptBlock);

  const severityById = new Map(infos.map((i) => [i.id, i.severity]));
  const registryRule = toolRules.find((r) => r.isRegistry);

  const checkTool = (call: ToolCall, entry: EntryKind): Verdict => {
    if (!known.has(call.name)) {
      // Deny by default: a tool not in the registry is a bug, not an improvisation.
      return registryRule !== undefined
        ? denyOf(registryRule.info.id, registryRule.info.why, 'unknown-tool')
        : {
            allow: false,
            code: 'unknown-tool',
            ruleId: 'unknown-tool-deny',
            hint: `[INHIBITION] tool '${call.name}' is not in the registry — deny by default`,
          };
    }
    // Text prohibitions first, so a forbidden string is reported identically on
    // both paths (path parity) no matter which tool was carrying it.
    for (const rule of textRules) {
      if (rule.toolApplies !== undefined && !rule.toolApplies.has(call.name)) continue;
      for (const re of rule.patterns) {
        if (someArgText(call.args, (t) => re.test(t))) return rule.patternDeny;
      }
    }
    for (const rule of toolRules) {
      if (rule.isRegistry) continue;
      if (rule.governed !== undefined && !rule.governed.has(call.name)) continue;
      if (rule.allowWhen.skips?.(entry) === true) continue;
      for (const check of rule.checks) {
        if (check.violates(call.args, entry, call.name)) return denyOf(rule.info.id, rule.info.why, check.code);
      }
    }
    return ALLOW;
  };

  const checkPlan = (d: PlanView): Verdict => {
    for (const rule of textRules) {
      for (const re of rule.patterns) {
        if (d.bubbles.some((b) => re.test(b))) return rule.patternDeny;
      }
      if (rule.planSecrets) {
        for (const s of secrets) {
          if (d.bubbles.some((b) => b.includes(s))) return rule.secretDeny;
        }
      }
    }
    return ALLOW;
  };

  return {
    checkTool,
    checkPlan,
    renderPromptBlock: () => promptBlock,
    normalizeText: (text: string): string => {
      let out = text;
      for (const n of normalizers) out = out.replace(n.regex, () => n.to); // replacer fn: `to` is literal, never $-interpolation
      return out;
    },
    severityOf: (ruleId: string): 'hard' | 'soft' | undefined => severityById.get(ruleId),
    rules: () => infos,
  };
};

// ---------------------------------------------------------------------------
// P-CADENCE CA.4 — the bubble-shape gate rule (class 'shape', soft).
// Additive by design: this class does not ride the compiled doc sections yet
// (the yaml gains its section when the canon entry merges at landing — the
// draft lives in the P-CADENCE report), so it is a standalone pure check the
// loop composes beside `checkPlan`, with the same verdict shape and the same
// hint contract. Thresholds are the v6 spec constants (D.6-4), load-bearing.
// ---------------------------------------------------------------------------

export const SHAPE_RULE_ID = 'bubble-shape';
export const SHAPE_MAX_BUBBLE_CHARS = 220; // a bubble is one glance
export const SHAPE_MAX_BUBBLES = 5; // beyond this the reply is an essay
export const SHAPE_MIN_WEIGHT_FOR_MORE = 0.7; // ...unless the decision carries weight
export const SHAPE_MIN_SAME_EMOJI = 3; // three identical sign-offs is a kit
export const SHAPE_REJECTION_WHY = 'split shorter'; // the one neutral reason, never an argument

/** Compiled rule info for audits — the rule is soft: rephrase, fail open (M13's ladder owns the re-entry). */
export const SHAPE_RULE: RuleInfo = {
  id: SHAPE_RULE_ID,
  ruleClass: 'plan',
  severity: 'soft',
  why: SHAPE_REJECTION_WHY,
  matcher: 'bubble-shape',
};

/**
 * A bubble "ends with an emoji" when its tail is a run of Extended_Pictographic
 * code points (variation selector allowed). The ASCII keycap bases (#, *, 0-9)
 * are pictographic in Unicode's tables but are not sign-offs, so they are
 * excluded.
 */
const EMOJI_TAIL_RE = /(?:\p{Extended_Pictographic}\uFE0F?)+$/u;

const emojiTail = (text: string): string | undefined => {
  const m = EMOJI_TAIL_RE.exec(text);
  if (m === null || /^[\d#*]+$/.test(m[0]!)) return undefined;
  return m[0];
};

export interface ShapeView {
  bubbles: readonly string[];
  /** The decision's weight; absent counts as below the gate. */
  weight?: number | undefined;
}

/**
 * The bubble-shape verdict on a locked plan (checked beside `checkPlan`, before
 * realization). Rejects when any bubble is over 220 chars, when there are more
 * than 5 bubbles without weight ≥ 0.7, when a bubble contains a newline, or
 * when ≥ 3 bubbles all end with the same emoji. Every violation carries the
 * same neutral hint: the rephrase pass is told what to do, not which law it
 * broke.
 */
export const checkBubbleShape = (d: ShapeView): Verdict => {
  const deny: Verdict = {
    allow: false,
    code: 'forbidden-pattern',
    ruleId: SHAPE_RULE_ID,
    hint: hintFor(SHAPE_RULE_ID, SHAPE_REJECTION_WHY),
  };
  if (d.bubbles.some((b) => b.length > SHAPE_MAX_BUBBLE_CHARS)) return deny;
  if (d.bubbles.length > SHAPE_MAX_BUBBLES && !(d.weight !== undefined && d.weight >= SHAPE_MIN_WEIGHT_FOR_MORE)) return deny;
  if (d.bubbles.some((b) => b.includes('\n'))) return deny;
  const kits = new Map<string, number>();
  for (const b of d.bubbles) {
    const tail = emojiTail(b);
    if (tail !== undefined) kits.set(tail, (kits.get(tail) ?? 0) + 1);
  }
  for (const n of kits.values()) {
    if (n >= SHAPE_MIN_SAME_EMOJI) return deny;
  }
  return ALLOW;
};

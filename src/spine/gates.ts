// M21 spine — the gating wiring (S1.5). inhibitions.yaml compiles into:
//   (a) static deny rules as the spine agent/permission config JSON —
//       deny-by-default ('*': deny) plus explicit allows for every tool the
//       file itself acknowledges (the same `known` union compileGate builds);
//   (b) rules for the repo-tracked tool.execute.before plugin
//       (spine/plugin/gate-plugin.ts): the relational predicates the static
//       layer cannot express (owner_arg, secret-arg scans) plus the fail-open
//       registry of soft rules.
// Soft (fail-open) plan rules NEVER compile to a spine deny or a plugin veto —
// a style tic must never eat a real reply. Plan-class text rules stay
// loop-side: the spine's decide object is re-checked by the compiled gate on
// every locked decision, exactly as today.

import { parseInhibitionsDoc, InhibitError } from '../inhibit/index.js';
import type { ToolRule } from '../inhibit/schema.js';
import { canonicalJson } from '../kernel/index.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/** The spine permission config JSON shape (deny-by-default; last-match-wins). */
export interface SpinePermissionConfig {
  permission: Record<string, 'allow' | 'ask' | 'deny'>;
}

/** The relational rules the plugin evaluates (self-contained, no zod on the spine side). */
export type SpinePluginRule =
  | { kind: 'deny'; tool: string; ruleId: string }
  | { kind: 'owner-arg'; tool: string; ruleId: string; arg: string; ownerChatId: string }
  | { kind: 'secret-args'; tool: string; ruleId: string };

/** gate.rules.json — what the plugin loads from its own directory at boot. */
export interface SpineGateRules {
  version: 1;
  /** Tools the plugin may see at all; everything else vetoes as unknown-tool-deny. */
  allowTools: string[];
  rules: SpinePluginRule[];
  /** Soft rule ids: the plugin EMITS their gate events but never vetoes. */
  failOpenRuleIds: string[];
  /** Env names only — secret VALUES ride the spine child's env, never the repo (AGENTS rule 7). */
  secretsEnv: string;
  /** Env name holding the thead gate-event endpoint URL (path /spine/gate-events). */
  eventUrlEnv: string;
}

export interface SpineGateCompileOpts {
  knownTools?: readonly string[] | undefined;
  /** The only chat id outbound tools may target (chat-lock rules demand it). */
  ownerChatId?: string | undefined;
}

export interface CompiledSpineGate {
  permission: SpinePermissionConfig;
  rules: SpineGateRules;
  /** Tool rules the spine layer cannot express (allow_args/spend_cap/path_fence) — enforced loop-side only. */
  loopSideOnlyRuleIds: string[];
}

const REGISTRY_CHECK = 'tool in registry';
/** The prose owner-check, compiled identically to M12's OWNER_CHECK_RE. */
const OWNER_CHECK_RE = /^([\w.]+) == config\.owner_chat_id$/;

const normalizeCheck = (text: string): string => text.trim().replace(/\s+/g, ' ');

/** The tools a rule names (applies list + allow_entry names) — compileGate's `governed` union. */
const ruleTools = (rule: ToolRule): string[] => {
  const names = new Set<string>();
  if (Array.isArray(rule.applies)) for (const t of rule.applies) names.add(t);
  if (rule.applies === '*') names.add('*');
  if (rule.allow_entry !== undefined) {
    for (const tools of Object.values(rule.allow_entry)) {
      for (const t of tools ?? []) names.add(t);
    }
  }
  return [...names];
};

const LOOP_SIDE_ONLY_FIELDS = ['allow_args', 'spend_cap', 'path_fence', 'allow_entry'] as const;

const isLoopSideOnly = (rule: ToolRule): boolean =>
  LOOP_SIDE_ONLY_FIELDS.some((f) => rule[f] !== undefined);

/**
 * Compiles the SAME yaml text compileGate consumes into the spine's two gate
 * surfaces. Throws (startup failure) when a rule demands a value the spine
 * layer was not handed — a gate that cannot bind must not look loaded.
 */
export const compileSpineGate = (yamlText: string, opts: SpineGateCompileOpts = {}): CompiledSpineGate => {
  const doc = parseInhibitionsDoc(yamlText);

  const rules: SpinePluginRule[] = [];
  const loopSideOnlyRuleIds: string[] = [];

  for (const rule of doc.tool ?? []) {
    const isRegistry =
      rule.require_registry === true ||
      (rule.check !== undefined && normalizeCheck(rule.check) === REGISTRY_CHECK && rule.applies === '*');
    if (isRegistry) continue; // becomes the static '*' deny below
    const tools = ruleTools(rule);
    if (isLoopSideOnly(rule)) {
      // arg-allowlist / spend caps / path fences / entry allowlists bind to
      // loop-side context the plugin does not have — they stay M12's, loudly.
      loopSideOnlyRuleIds.push(rule.id);
      continue;
    }
    // The prose owner-check compiles to the SAME owner-arg rule its machine field does.
    const proseOwnerArg = rule.check !== undefined ? OWNER_CHECK_RE.exec(normalizeCheck(rule.check))?.[1] : undefined;
    let bound = false;
    for (const tool of tools) {
      const ownerArg = rule.owner_arg ?? proseOwnerArg;
      if (ownerArg !== undefined) {
        if (opts.ownerChatId === undefined) {
          throw new InhibitError(
            'spine/gate-config',
            `rule '${rule.id}' pins an argument to the owner chat id, but no ownerChatId was handed to the spine gate compile`,
            { ruleId: rule.id },
          );
        }
        rules.push({ kind: 'owner-arg', tool, ruleId: rule.id, arg: ownerArg, ownerChatId: opts.ownerChatId });
        bound = true;
      }
      if (rule.no_secret_args === true || rule.secret_scan === true) {
        rules.push({ kind: 'secret-args', tool, ruleId: rule.id });
        bound = true;
      }
    }
    if (!bound && tools.length > 0) {
      // a rule the spine layer cannot express is surfaced, never silently dropped:
      // it stays enforced by the compiled gate on the loop side only.
      loopSideOnlyRuleIds.push(rule.id);
    }
  }

  const known = new Set<string>(opts.knownTools ?? []);
  for (const rule of doc.tool ?? []) {
    for (const t of ruleTools(rule)) if (t !== '*') known.add(t);
  }
  const allowTools = [...known].sort();
  const failOpenRuleIds = (doc.plan ?? []).filter((r) => r.severity === 'soft').map((r) => r.id);

  // permission config: '*' deny first, then the explicit allows — last-match-wins
  const permission: Record<string, 'allow' | 'ask' | 'deny'> = { '*': 'deny' };
  for (const tool of allowTools) permission[tool] = 'allow';

  return {
    permission: { permission },
    rules: {
      version: 1,
      allowTools,
      rules,
      failOpenRuleIds,
      secretsEnv: 'THEA2_SPINE_SECRETS',
      eventUrlEnv: 'THEA2_SPINE_EVENT_URL',
    },
    loopSideOnlyRuleIds,
  };
};

/**
 * Writes gate.rules.json under `dir` (the plugin's own directory, repo-tracked
 * at spine/plugin/). The VALUES the plugin scans for (secret values, owner id)
 * resolve at boot from env/args — the file carries names and ids only.
 */
export const writeSpineGateFiles = async (
  dir: string,
  yamlText: string,
  opts: SpineGateCompileOpts = {},
): Promise<{ rulesPath: string; rules: SpineGateRules }> => {
  const compiled = compileSpineGate(yamlText, opts);
  mkdirSync(dir, { recursive: true });
  const rulesPath = join(dir, 'gate.rules.json');
  writeFileSync(rulesPath, `${canonicalJson(compiled.rules)}\n`, 'utf8');
  return { rulesPath, rules: compiled.rules };
};

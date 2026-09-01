// M12 inhibit — the inhibitions.yaml document schema, STRICT like the corpus
// controls loaders: an unknown key throws rather than being ignored, because a
// misspelled rule must never look like it loaded. The yaml's prose `check` lines
// stay documentation; what actually compiles is either a machine predicate field
// below or a check text the compiler's registry recognizes (see compile.ts).
//
// This is the owning schema (schemas/ has no inhibitions mirror yet; per
// schemas/README the source of truth lives in src/ from the owning stage on).

import { z } from 'zod';
import * as yaml from 'js-yaml';
import { InhibitError } from './errors.js';
import { ENTRY_KINDS } from './types.js';

const nonEmpty = z.string().min(1);

/**
 * One tool rule. `applies` names the tools it governs ('*' = every tool, which
 * by itself makes NO tool known — that is what keeps default-deny non-vacuous);
 * `check` is the human prose line; the remaining fields are the closed machine
 * vocabulary the compiler turns into matchers.
 */
export const ToolRuleSchema = z.strictObject({
  id: nonEmpty,
  why: nonEmpty,
  applies: z.union([z.literal('*'), z.array(nonEmpty).min(1)]).optional(),
  check: nonEmpty.optional(),
  /** `tool in registry` — the default-deny rule; must be `applies: '*'`. */
  require_registry: z.literal(true).optional(),
  /** args[<name>] must equal the injected owner chat id. */
  owner_arg: nonEmpty.optional(),
  /** No injected secret value may appear in any argument string. */
  no_secret_args: z.literal(true).optional(),
  /** args[<name>] must be one of the listed values; missing = denied (fail closed). */
  allow_args: z.record(nonEmpty, z.array(z.union([nonEmpty, z.number()])).min(1)).optional(),
  /** args[<arg>] must be a finite number <= max (same unit as the arg). */
  spend_cap: z.strictObject({ arg: nonEmpty, max: z.number() }).optional(),
  /** args[<arg>] must resolve lexically inside one of the fenced roots. Pure path math — no fs. */
  path_fence: z.strictObject({ arg: nonEmpty, under: z.array(nonEmpty).min(1) }).optional(),
  /** Per-entry-context allowlist: a tool listed under its entry kind passes, otherwise denied. */
  allow_entry: z.partialRecord(z.enum(ENTRY_KINDS), z.array(nonEmpty).min(1)).optional(),
  /**
   * Narrowed exemption, bound only in the recognized form `entry.kind == '<kind>'`
   * (checkTool receives the entry kind). Anything else compiles dormant — see compile.ts.
   */
  allow_when: nonEmpty.optional(),
  /** Explicit bind of the compose-time secret scan (the tool-path twin of the plan rule's empty slot). */
  secret_scan: z.literal(true).optional(),
});
export type ToolRule = z.infer<typeof ToolRuleSchema>;

/**
 * One plan rule: regexes rejected over plan text/bubbles, and over textual tool
 * args on the candidate path (narrowed by `applies` when declared). An EMPTY
 * reject_patterns list is the reserved compose slot: it binds the injected
 * secret values ("populated at compose time from env — never literal here").
 */
export const PlanRuleSchema = z.strictObject({
  id: nonEmpty,
  why: nonEmpty,
  severity: z.enum(['hard', 'soft']),
  reject_patterns: z.array(nonEmpty),
  allow_when: nonEmpty.optional(),
  /** Narrows which tools' args this rule scans on the candidate path; the plan path is always all bubbles. */
  applies: z.array(nonEmpty).min(1).optional(),
  secret_scan: z.literal(true).optional(),
});
export type PlanRule = z.infer<typeof PlanRuleSchema>;

/**
 * The one mechanical rewrite class: semantic-preserving character substitutions,
 * applied at realization (M14), never prompted — measured 0% prompt compliance
 * is exactly why the class exists.
 */
export const NormalizeRuleSchema = z.strictObject({
  id: nonEmpty,
  why: nonEmpty.optional(),
  replace: z.strictObject({ from: nonEmpty, to: z.string() }),
});
export type NormalizeRule = z.infer<typeof NormalizeRuleSchema>;

export const InhibitionsDocSchema = z.strictObject({
  version: z.literal(1),
  tool: z.array(ToolRuleSchema).optional(),
  plan: z.array(PlanRuleSchema).optional(),
  normalize: z.array(NormalizeRuleSchema).optional(),
});
export type InhibitionsDoc = z.infer<typeof InhibitionsDocSchema>;

/** Only file this compiler ever consumes; error messages point at the real canon location. */
export const DOC_LABEL = 'corpus/canon/inhibitions.yaml';

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

const firstLine = (message: string): string => message.split('\n')[0] ?? message;

/**
 * The rule id enclosing a failing zod path — so a rejection names the RULE, not
 * just an index. Walks the raw (pre-validation) document, stopping at the first
 * node that carries a string id.
 */
const ruleIdAt = (doc: Record<string, unknown>, path: readonly PropertyKey[]): string | undefined => {
  let cur: unknown = doc;
  for (const seg of path) {
    if (typeof seg === 'string' && isPlainObject(cur)) {
      cur = cur[seg];
    } else if (typeof seg === 'number' && Array.isArray(cur)) {
      cur = cur[seg];
    } else {
      break;
    }
    if (cur === undefined) break;
    if (isPlainObject(cur) && typeof cur['id'] === 'string') return cur['id'];
  }
  return undefined;
};

/** Renders a zod path the way humans read it: 'tool[0].check'. */
const formatPath = (path: readonly PropertyKey[]): string =>
  path
    .map((seg, i) => (typeof seg === 'number' ? `[${seg}]` : i === 0 ? String(seg) : `.${String(seg)}`))
    .join('');

/** Maps one zod v4 issue onto this module's error codes, naming the enclosing rule when there is one. */
const classifyIssue = (issue: { code: string; path: PropertyKey[]; message: string; keys?: unknown }, doc: Record<string, unknown>): InhibitError => {
  const field = formatPath(issue.path);
  const ruleId = ruleIdAt(doc, issue.path);
  const where = ruleId !== undefined ? `rule '${ruleId}' (${field})` : field || '(root)';
  const message = `${DOC_LABEL}: ${where} — ${firstLine(issue.message)}`;

  if (issue.code === 'unrecognized_keys') {
    const keys = Array.isArray(issue.keys) ? (issue.keys as unknown[]).map(String) : [];
    return new InhibitError('inhibit/unknown-field', `${message} [unknown field(s): ${keys.join(', ')}]`, {
      ruleId,
      field,
    });
  }
  return new InhibitError('inhibit/schema', message, { ruleId, field });
};

/**
 * Parses the yaml text into a validated document: YAML load, then strict zod.
 * Throws the first typed error — compileGate never returns a partial gate.
 */
export const parseInhibitionsDoc = (yamlText: string): InhibitionsDoc => {
  let doc: unknown;
  try {
    doc = yaml.load(yamlText);
  } catch (e) {
    throw new InhibitError('inhibit/yaml-parse', `${DOC_LABEL} is not valid YAML: ${firstLine((e as Error).message)}`, {
      cause: e,
    });
  }
  if (!isPlainObject(doc)) {
    throw new InhibitError('inhibit/schema', `${DOC_LABEL} must be a YAML mapping of {version, tool, plan, normalize}`, {
      field: '(root)',
    });
  }

  const result = InhibitionsDocSchema.safeParse(doc);
  if (result.success) return result.data;

  const issue = result.error.issues[0];
  if (issue) throw classifyIssue(issue, doc);
  throw new InhibitError('inhibit/schema', `${DOC_LABEL} rejected the document without a specific issue`, { field: '(root)' });
};

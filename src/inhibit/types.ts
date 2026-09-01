// M12 inhibit — public contract types (docs/modules/M12-inhibit.md §Interfaces).
// The gate is a compiled artifact: parse+compile happens once at boot, and every
// check afterwards is a synchronous pure function — no clock, no rng, no I/O,
// no model, and nothing learned from history.

import type { ToolCall } from '../model/types.js';

/** The three deliberation entry contexts (M13's LoopEntry.kind). */
export const ENTRY_KINDS = ['user-turn', 'heartbeat', 'ponder'] as const;
export type EntryKind = (typeof ENTRY_KINDS)[number];

/**
 * Machine-readable failure modes. Closed on purpose: M13's re-entry policy and
 * the Ledger's over-trigger reports switch on these, so a new code is a design
 * decision, not a string. The spec pins 'unknown-tool' verbatim.
 */
export const VERDICT_CODES = [
  'unknown-tool',
  'chat-lock',
  'secret-leak',
  'arg-not-allowed',
  'spend-cap',
  'path-fence',
  'entry-not-allowed',
  'forbidden-pattern',
] as const;
export type VerdictCode = (typeof VERDICT_CODES)[number];

/**
 * Binary plus a reason. On a deny, `ruleId` names the inhibitions.yaml entry that
 * fired and `hint` is the exact text M13 re-injects into context on re-entry.
 */
export type Verdict = { allow: true } | { allow: false; code: VerdictCode; ruleId: string; hint: string };

/**
 * Structural subset of M13's DecisionObject. M12 (S3) is built before M13 (S4);
 * TypeScript structural typing lets the full DecisionObject satisfy this without
 * an import — do not add fields here that DecisionObject lacks.
 */
export interface PlanView {
  plan: 'reply' | 'silent' | 'defer';
  bubbles: readonly string[];
}

export interface InhibitionGate {
  /** Candidate tool call during deliberation, before dispatch. */
  checkTool(call: ToolCall, entry: EntryKind): Verdict;
  /** The locked decision object, before realization. */
  checkPlan(d: PlanView): Verdict;
  /** The [INHIBITION] packet block (§2.7 budget) — projected from these same compiled rules. */
  renderPromptBlock(): string;
  /**
   * The `normalize` class applied to realized text (M14): semantic-preserving
   * character substitutions only. Mechanical, so it is enforced here rather than
   * prompted — a punctuation rewrite is not something the model has to learn.
   */
  normalizeText(text: string): string;
  /**
   * Severity behind a rule id: M13 fails OPEN after MAX_GATE_REENTRIES on 'soft'
   * and forces plan:'silent' + incident on 'hard'. Tool-class rules are hard by
   * definition (the yaml's tool section has no severity — it is binary).
   */
  severityOf(ruleId: string): 'hard' | 'soft' | undefined;
  /** Every compiled rule, for audits and for the "every rule compiled" proof. */
  rules(): readonly RuleInfo[];
}

/** Re-entry cap, owned here so gate and loop cannot disagree. Enforcement + incident emission live in M13. */
export const MAX_GATE_REENTRIES = 2;

/**
 * Values injected once at compose time (M20) that the yaml deliberately never
 * carries — secrets are env-shaped, the owner chat id is config, and the tool
 * registry belongs to M13. All optional: only rules that need a value demand it,
 * and a rule that cannot get its value is a startup failure, never a no-op.
 */
export interface GateConfig {
  /** The only chat id outbound tools may target (`owner_arg` / chat-lock rules). */
  ownerChatId?: string | undefined;
  /** Runtime secret VALUES no rule may let leave the process. Never logged, never listed in the yaml. */
  secrets?: readonly string[] | undefined;
  /** Tool names the M13 registry serves, unioned with the names the yaml itself declares. */
  knownTools?: readonly string[] | undefined;
}

/** One compiled rule as audits see it (also the projection the prompt block renders from). */
export interface RuleInfo {
  id: string;
  ruleClass: 'tool' | 'plan' | 'normalize';
  severity: 'hard' | 'soft';
  why: string;
  /** Compiled matcher kind, e.g. 'regex', 'owner-chat', 'compose-secrets', 'registry-default-deny'. */
  matcher: string;
  /**
   * Set when the rule declares an `allow_when` the current call signatures cannot
   * bind (no caller can assert `entry.crisis` yet): the exemption is NOT in force
   * and the rule is enforced unconditionally. Surfaced so that wiring the flag
   * later is a visible change, not a silent one.
   */
  dormantAllowWhen?: string | undefined;
}

---
module: M12
name: inhibit
syncedTo: v6-W1 (P-CADENCE CA.4 added the bubble-shape gate rule as an additive class 'shape' helper in compile.ts — see "As built (v6-W1)")
stage: S3
depends: [M01-kernel, M03-model, M07-corpus]
---
# M12 — inhibit

## Responsibility
Compile `corpus/canon/inhibitions.yaml` into deterministic matchers and expose a binary gate with reason codes at two call sites: every candidate tool call during deliberation, and the locked decision object before realization. The gate is <1 ms, zero LLM, never learned. The same compiled artifact also renders the human-readable [INHIBITION] prompt block, so the enforced rules and the prompted rules can never drift apart (the one-artifact lesson from Thea1's orphan-tag pathology).

## Interfaces (contract)
```ts
export type EntryKind = 'user-turn' | 'heartbeat' | 'ponder';
export type VerdictCode = 'unknown-tool' | 'chat-lock' | 'secret-leak' | 'arg-not-allowed'
  | 'spend-cap' | 'path-fence' | 'entry-not-allowed' | 'forbidden-pattern';   // closed union
export type Verdict = { allow: true } | { allow: false; code: VerdictCode; ruleId: string; hint: string };
// hint is always `[INHIBITION:<ruleId>] <why>` (the unknown-tool fallback: `[INHIBITION] tool '<name>' is not in the registry — deny by default`).

// Structural subset of M13's DecisionObject. M12 (S3) is built before M13 (S4);
// TypeScript structural typing lets the full DecisionObject satisfy this without an import.
export interface PlanView { plan: 'reply' | 'silent' | 'defer'; bubbles: readonly string[]; }

export interface InhibitionGate {
  checkTool(call: ToolCall, entry: EntryKind): Verdict;   // ToolCall type from M03-model
  checkPlan(d: PlanView): Verdict;
  renderPromptBlock(): string;                            // [INHIBITION] text, <= 300 tokens, fixed at compile
  normalizeText(text: string): string;                    // the `normalize` class, applied at realization (M14)
  severityOf(ruleId: string): 'hard' | 'soft' | undefined; // M13 re-entry policy looks severity up by verdict ruleId
  rules(): readonly RuleInfo[];                           // every compiled rule (audits, "every rule compiled" proof)
}

export const MAX_GATE_REENTRIES = 2;   // constant owned here; enforcement lives in M13's loop
export interface GateConfig {           // compose-time values the yaml deliberately never carries
  ownerChatId?: string | undefined;     // demanded by chat-lock/owner_arg rules
  secrets?: readonly string[] | undefined;  // runtime secret VALUES for the secret-scan rules
  knownTools?: readonly string[] | undefined; // M13's registry names, unioned with yaml-declared names
}
export const compileGate: (yamlText: string, cfg?: GateConfig) => InhibitionGate; // throws on any invalid rule at startup

export interface RuleInfo {              // one compiled rule, as audits and the prompt block see it
  id: string;
  ruleClass: 'tool' | 'plan' | 'normalize';
  severity: 'hard' | 'soft';
  why: string;
  matcher: string;                       // compiled kind: 'regex', 'owner-chat', 'compose-secrets', ...
  dormantAllowWhen?: string | undefined; // declared allow_when no caller can bind yet — NOT in force
}
```

## Behavior spec
- Source of truth: `corpus/canon/inhibitions.yaml`, compiled once at startup. An invalid rule is a startup failure, never a silently skipped rule. An edit to the file counts as a deploy (deploy marker change triggers Nightingale, M18).
- Three rule classes:
  - regex rules over plan text and bubbles (checkPlan path, and over textual tool args where declared);
  - a predicate registry over tool calls: argument allowlists, chat-id lock to Diego, spend caps, path fences;
  - per-entry-context tool allowlists (a tool legal under `ponder` may be denied under `heartbeat`).
- Two call sites, one rule set: a rule must produce the same verdict for equivalent content whether it arrives via `checkTool` (candidate tool call) or `checkPlan` (locked decision). No rule may exist on only one path.
- Unknown tool = deny by default (`code: 'unknown-tool'`). Absence of a rule is not permission for tools.
- Verdict is binary plus machine-readable reason: `{code, ruleId, hint}`. The `hint` is the text the loop re-injects into context on rejection.
- Performance and purity: <1 ms per check; zero model calls; no I/O after compile; rules are never learned, tuned, or auto-generated — the only writer is the human-edited yaml.
- Re-entry contract: a rejection re-enters the loop with the hint in context; after `MAX_GATE_REENTRIES = 2` re-entries the loop forces `plan:'silent'` plus an incident event (§5.10). The constant lives here so gate and loop cannot disagree; the enforcement and the incident emission live in M13.
- `renderPromptBlock()` projects the same compiled rules into the ≤300-token [INHIBITION] block (§2.7 budget). M11 receives this text and places it; M13 delivers it as the trailing system message.
- All verdicts produced during a turn (allow and deny) are attached by the loop to `DecisionObject.inhibitions` for audit; a chronically over-triggering rule therefore surfaces in the Ledger within a day, not a month.

### Decisions taken at build time (S3)
- **Check texts are a closed registry.** The yaml's prose `check:` line is the human's documentation; it compiles only if the compiler recognizes it verbatim (whitespace-normalized): `tool in registry`, `args match none of runtime secret values (injected at compose, never listed here)`, `<arg> == config.owner_chat_id`. Anything else is `inhibit/unbound-rule` at startup. A *new rule of a known class* needs no code (machine fields: `owner_arg`, `allow_args`, `spend_cap`, `path_fence`, `allow_entry`, `no_secret_args`/`secret_scan`); a *new class* is a code change — correct, since these rules are hand-written and never generated.
- **Known tools are explicit.** `checkTool` denies any tool outside `cfg.knownTools ∪ (tool names the yaml itself names)`. `applies: '*'` grants knowledge of nothing — that is what keeps the file's own default-deny rule non-vacuous.
- **Compose slot for secrets.** A plan rule with `reject_patterns: []` binds the injected `cfg.secrets` (the canon's `no-secret-values` says exactly this in its own comment). Empty list = never-empty enforcement. On the candidate path secrets ride tool args and are caught by the tool-class rule instead, so one leak is one verdict, not two.
- **Path parity is literal.** Plan rules scan bubbles on `checkPlan` and textual tool args on `checkTool` (`applies` narrows the tool path only). A content rule cannot be dodged by choosing the other exit.
- **`allow_when` binds only `entry.kind == '<kind>'`, on the tool path.** `checkPlan` has no entry, so a bounded condition there compiles DORMANT: surfaced via `RuleInfo.dormantAllowWhen`, rule still enforced unconditionally. Other `entry.<field> == true|false` forms (canon's `entry.crisis == true`) are recognized but unbindable today — same dormant-and-loud treatment, never silently dropped.
- **Reject regexes are case-sensitive and non-global**, compiled exactly as written. A hard-rule false positive eats a real reply (the sentinel sin), so widening stays a decision the yaml author makes deliberately, not a flag the compiler adds.
- **`normalize` rules are enforced, not prompted.** They are excluded from `renderPromptBlock` (measured 0% prompt compliance is why the class exists) and applied by M14 via `normalizeText`.
- **The prompt block names rule IDS under one neutral header sentence — no why-text (Package E, 2026-09-02).** A ban's `why` argues with a model that planned to break the rule, and printing it primes the exact construction the ban exists to stop; enforcement is the gate's job (`hint` still carries the full why for the loop's re-entry injection). Budget pressure now comes from rule COUNT, not why length: 60 ids ≈ 650 tokens refuses to compile, canon v1 renders far under the 300-token budget. Pinned in `test/inhibit/prompt.test.ts`.
- **The prompt budget is enforced at compile.** An over-budget block throws `inhibit/prompt-budget` at startup rather than trimming silently. Canon v1 renders at ~195 tokens by `estimateTokens` (779 chars).
- **Rule ids share one namespace** across `tool`/`plan`/`normalize` (a duplicate is `inhibit/duplicate-id`), because verdicts name a rule and `severityOf` resolves that name. Tool-class rules are `hard` by definition (binary section, no severity field); only plan rules may declare `soft`.

## Not this module's job
- Enforcing the re-entry cap, forcing `plan:'silent'`, emitting incident events — M13-loop.
- Placing the [INHIBITION] block in the packet/message array — M11-assemble (content slot) and M13-loop (trailing-system placement).
- Tool definitions and schemas — M13-loop registry; `ToolCall`/`ToolDef` types — M03-model.
- Deciding what the rules should say — human-authored canon; no module writes inhibitions.yaml.
- Nightingale's reaction to a rules change — M18-siblings.

## Acceptance criteria
- [x] `compileGate` rejects malformed yaml at startup with a precise error naming the rule; no partially compiled gate ever exists.
- [x] Unknown tool denied by default with `code:'unknown-tool'`.
- [x] Every rule fires identically through `checkTool` and `checkPlan` for equivalent content (path-parity fixture matrix).
- [x] All three rule classes implemented: regex over plan/bubbles, tool-arg predicates (allowlist, chat-id lock, spend cap, path fence), per-entry-context allowlists.
- [x] p99 check latency < 1 ms on the v1 rule set; module has zero imports from the model client runtime (depcruise-checkable — only M03 types).
- [x] `MAX_GATE_REENTRIES` exported and equal to 2.
- [x] `renderPromptBlock()` ≤ 300 tokens and derived from the same compiled rule objects (no second copy of the rule text).

## Canon v1 draft status (reported upstream, not fixed here)
The compiler consumes `corpus/canon/inhibitions.yaml` as-is; canon content is Diego-authored. One defect found and NOT corrected (agents never edit scene semantics):
- **`banned-construction.why` is truncated by YAML at line 47.** The line is unquoted and contains ` #1 AI tell …`, so everything from ` #` is a comment; the compiled why is `the "it's not X, it's Y" family is the`. Suggested fix when Diego edits canon: single-quote the value (`why: 'the "it''s not X, it''s Y" family is the #1 AI tell (owner''s law)…'`). Every other rule compiles clean; `entry.crisis == true` on `no-mind-reading` compiles dormant (see Decisions above) until a caller can assert the flag.

## As built (v6-W1) — the bubble-shape gate rule (class `shape`, soft; P-CADENCE CA.4)

Added additively at the end of `src/inhibit/compile.ts` — no existing export,
section, or compiled-gate behavior changed, so a later rule class can merge
beside it without conflict:

- `checkBubbleShape({ bubbles, weight? }) → Verdict` rejects (soft) when any
  bubble is over `SHAPE_MAX_BUBBLE_CHARS` 220 chars, when there are more than
  `SHAPE_MAX_BUBBLES` 5 bubbles unless `weight ≥ SHAPE_MIN_WEIGHT_FOR_MORE`
  0.7, when a bubble contains a newline, or when ≥ `SHAPE_MIN_SAME_EMOJI` 3
  bubbles all end with the same emoji. Every violation carries the one neutral
  reason `SHAPE_REJECTION_WHY` = "split shorter" (hint
  `[INHIBITION:bubble-shape] split shorter`) — the rephrase pass is told what
  to do, not which law it broke. `SHAPE_RULE` publishes the compiled
  `RuleInfo` (id `bubble-shape`, class `plan`, severity `soft`) for audits.
- Deliberately NOT wired through `compileGate`/`checkPlan` yet: the gate's doc
  schema (`src/inhibit/schema.ts`, not this package's file) has no section for
  the class until its canon entry merges, and `PlanView` carries no `weight`.
  The loop composes it beside `checkPlan` and reads softness via
  `SHAPE_RULE.severity` (or `severityOf` once the canon entry lands). The
  verdict code is the existing plan-path `'forbidden-pattern'` —
  `VERDICT_CODES` is a closed union owned in `src/inhibit/types.ts`, and a new
  code is a design decision there, not a local one.
- Emoji tails are matched with `\p{Extended_Pictographic}` (u-flag, variation
  selector allowed); the ASCII keycap bases (#, *, 0-9) are pictographic in
  Unicode's tables but excluded — they are not sign-offs.
- The canon entry for `corpus/canon/inhibitions.yaml` is drafted in the
  P-CADENCE package report and merges at landing (canon is Diego's); until
  then the rule is enforced by the loop's composition, not by the compiled
  canon gate, and `severityOf('bubble-shape')` resolves `undefined`.

## Test checklist
- unit: table-driven rule fixtures per class (regex hit/miss, arg allowlist, chat-id lock, spend cap, path fence, entry-context allowlist); unknown-tool default; malformed-yaml reject cases; reason-code stability.
- component: candidate-path vs plan-path verdict equivalence over a shared fixture matrix; prompt-block token cap; latency micro-benchmark on the compiled v1 rules.
- fixtures needed: a test inhibitions.yaml (valid set + malformed variants), ToolCall fixtures across all rule classes, PlanView fixtures with forbidden and clean bubble text.

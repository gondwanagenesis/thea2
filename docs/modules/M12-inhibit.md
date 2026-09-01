---
module: M12
name: inhibit
syncedTo: spec-v1 (no code yet)
stage: S3
depends: [M01-kernel, M03-model]
---
# M12 — inhibit

## Responsibility
Compile `corpus/canon/inhibitions.yaml` into deterministic matchers and expose a binary gate with reason codes at two call sites: every candidate tool call during deliberation, and the locked decision object before realization. The gate is <1 ms, zero LLM, never learned. The same compiled artifact also renders the human-readable [INHIBITION] prompt block, so the enforced rules and the prompted rules can never drift apart (the one-artifact lesson from Thea1's orphan-tag pathology).

## Interfaces (contract)
```ts
export type Verdict = { allow: true } | { allow: false; code: string; ruleId: string; hint: string };
export type EntryKind = 'user-turn' | 'heartbeat' | 'ponder';

// Structural subset of M13's DecisionObject. M12 (S3) is built before M13 (S4);
// TypeScript structural typing lets the full DecisionObject satisfy this without an import.
export interface PlanView {
  plan: 'reply' | 'silent' | 'defer';
  bubbles: string[];
}

export interface InhibitionGate {
  checkTool(call: ToolCall, entry: EntryKind): Verdict;   // ToolCall type from M03-model
  checkPlan(d: PlanView): Verdict;
  renderPromptBlock(): string;                            // [INHIBITION] text for the packet trailer, <= 300 tokens
}

export const MAX_GATE_REENTRIES = 2;   // constant owned here; enforcement lives in M13's loop
export const compileGate: (yamlText: string) => InhibitionGate;  // throws on any invalid rule at startup
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

## Not this module's job
- Enforcing the re-entry cap, forcing `plan:'silent'`, emitting incident events — M13-loop.
- Placing the [INHIBITION] block in the packet/message array — M11-assemble (content slot) and M13-loop (trailing-system placement).
- Tool definitions and schemas — M13-loop registry; `ToolCall`/`ToolDef` types — M03-model.
- Deciding what the rules should say — human-authored canon; no module writes inhibitions.yaml.
- Nightingale's reaction to a rules change — M18-siblings.

## Acceptance criteria
- [ ] `compileGate` rejects malformed yaml at startup with a precise error naming the rule; no partially compiled gate ever exists.
- [ ] Unknown tool denied by default with `code:'unknown-tool'`.
- [ ] Every rule fires identically through `checkTool` and `checkPlan` for equivalent content (path-parity fixture matrix).
- [ ] All three rule classes implemented: regex over plan/bubbles, tool-arg predicates (allowlist, chat-id lock, spend cap, path fence), per-entry-context allowlists.
- [ ] p99 check latency < 1 ms on the v1 rule set; module has zero imports from the model client runtime (depcruise-checkable — only M03 types).
- [ ] `MAX_GATE_REENTRIES` exported and equal to 2.
- [ ] `renderPromptBlock()` ≤ 300 tokens and derived from the same compiled rule objects (no second copy of the rule text).

## Test checklist
- unit: table-driven rule fixtures per class (regex hit/miss, arg allowlist, chat-id lock, spend cap, path fence, entry-context allowlist); unknown-tool default; malformed-yaml reject cases; reason-code stability.
- component: candidate-path vs plan-path verdict equivalence over a shared fixture matrix; prompt-block token cap; latency micro-benchmark on the compiled v1 rules.
- fixtures needed: a test inhibitions.yaml (valid set + malformed variants), ToolCall fixtures across all rule classes, PlanView fixtures with forbidden and clean bubble text.

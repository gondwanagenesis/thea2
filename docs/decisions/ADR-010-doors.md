---
adr: ADR-010
title: Doors with control — a named door registry carrying reasoning, forcing, and pricing per model endpoint
status: accepted
date: 2026-09-03
syncedTo: v6-W1
---

## Context

Through S8 the system had ONE wire (one endpoint + protocol) and a tier table naming model ids on it. That stopped being true the moment Diego's setup became multi-vendor: the Neuralwatt glm-5.3 door (D.6-1, the voice), z.ai's anthropic coding-plan door (the fallback), deepseek-v4-flash for mind work and kimi-k3 for judging (D.6-2) — different endpoints, different wire protocols, different env keys, and different tolerance for `reasoning_effort`/`thinking`/`tool_choice`. Meanwhile the reasoning control lived in the WRONG layer: the loop's `THINKING_DEFAULTS` table (anthropic `thinking` shapes only) meant a call's control depended on which module built the request, not on what the class needed, and the openai wire got nothing at all. Nothing logged which door served a call, what the control was, or what it cost.

## Decision

Doors become a config-level registry and the model layer's routing unit (ADR-010; implemented by P-DOOR in src/model + src/app/config.ts).

1. **Door schema (DR.1).** `models.doors.{voice, mind, judge, voiceFallback?}`, each `{endpoint, protocol:'anthropic'|'openai', keyEnv, model, effort?, thinkingBudget?, forcing:'tool_choice'|'none', temperature?, topP?, pricing?:{inputPerM, outputPerM}}`. `keyEnv` names an env variable — key values never enter the yaml (AGENTS rule 7). The legacy `models.endpoint/protocol/tiers` shape still loads and synthesizes the three tier doors (voice=main, mind=cheap, judge=reasoning, forcing `none`), so old configs boot unchanged. Shipped defaults: voice = Neuralwatt glm-5.3, effort low, forcing none, temperature 0.7, topP 0.95, `THEA2_NEURALWATT_KEY`; voiceFallback = z.ai anthropic glm-5.3-flash, thinkingBudget 512, forcing tool_choice, `THEA2_MODEL_API_KEY`; mind = Neuralwatt deepseek-v4-flash, effort none, forcing tool_choice; judge = Neuralwatt kimi-k3, effort none, forcing tool_choice (D.6-1/D.6-2; v5 D.10).
2. **Tier names stay; doors resolve.** Code tiers remain `main|cheap|reasoning`; `tierFor` maps main→voice, cheap→mind, reasoning→judge. Compose builds one transport per tier door; one `ModelClient` serves all of them (`chatCore` picks the runtime by routed tier). `voiceFallback` rides no tier — it is the swap-in when the Neuralwatt renewal fails (D.6-1's fallback clause) or the door is down.
3. **Reasoning control by task class, applied by the client (DR.2).** `REASONING_BY_CLASS` (src/model/tiers.ts) replaces the loop's `THINKING_DEFAULTS`:

   | taskClass | reasoning |
   |---|---|
   | turn, heartbeat-thought, summarize, ponder-seed, appraisal | low |
   | consolidate, derive, judge, probe-judge | high |

   `client.chat` applies the class default whenever the request carries no explicit `reasoning`; a caller override wins. Wire mapping: openai door → `reasoning_effort`, with `none`→`minimal` for glm-5.* models (others take `none` verbatim); anthropic door → `thinking:{type:'enabled', budget_tokens}` from the door's `thinkingBudget` or the effort table `{none:128, minimal:256, low:512, high:1024, max:2048}`. `type:'disabled'` is never emitted (W1.1 smoke: glm-5.3-flash 500s on it). Precedence: request override > class table > door `effort` (the door's effort is the terminal fallback for requests the class system does not cover — currently none, which makes the shipped mind/judge `effort: none` entries documentation-of-record for those doors' posture rather than a live override; revisit if a classless call path ever appears).
4. **Forcing is a door property (DR.3).** On a `forcing:'tool_choice'` door the client forces `decide` whenever `decide` is among the offered defs — not only when it is the sole def — and never overrides a caller's explicit `toolChoice`. A `forcing:'none'` door (the voice) never adds a force; its `tool_choice` default stands.
5. **Every call logs its door story (DR.4).** `model.call` gains `door, stopReason, maxTokens, reasoning, costUsd` (costUsd only for priced doors) and a failed call still credits the HTTP attempts it burned (the transport stamps them on the thrown `ModelError`).
6. **Truncation is failure (DR.5).** `model/truncated` fires on `stopReason === 'max_tokens'`, or output at the cap with no tool call, or a schema expected with empty content. A cut-off reply is never treated as a complete answer.
7. **Repair stays on tier (DR.6).** The one-shot repair keeps the requesting tier and doubles maxTokens.
8. **Tool-input validation rides the request (DR.7).** `ChatRequest.toolInput` carries per-tool zod validators; src/model never imports src/loop (the dependency DAG forbids it — model is below loop), so the loop's registry entries travel WITH the request instead. `decide.bubbles` is coerced (string → newline-split array) before validation.

## Consequences

- Swapping a door is a yaml edit plus an env var; swapping the VOICE door is a one-line change (D.6-1's unfunded fallback: set voice = voiceFallback's values). No code changes for any of it.
- The reasoning control is uniform: every task class carries one on both wires, tested per class, and `model.call` rows show what rode each call — P-FAST's budget math and P-WALLET's future allowances both read the same events.
- `costUsd` requires pricing in config; the shipped doors carry none until Diego pins numbers (constants are load-bearing; none were guessed).
- Behavior changes to note in review: (a) max_tokens stops with visible content or a completed tool call now FAIL the call (DR.5's literal disjunction — two pre-DR.5 behaviors inverted on purpose); (b) ponder-seed on the anthropic wire moves from enabled-1024 to low(512 by the effort table) — the ponder-starvation family must be re-watched after deploy; (c) the one-shot repair no longer rides the cheap tier, so `test/probes/judge.test.ts` (owned by the probes package) needs its repair-tier assertion updated from `cheap` to the requesting tier — filed as a cross-package handoff, not changed here.
- The loop's `LoopConfig.thinking` remains as a direct `thinking`-field escape hatch, default empty; per-class defaults now come from the model layer.

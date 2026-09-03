---
module: M03
name: model
syncedTo: v6-W1 as-built (2026-09-03 — P-DOOR: door registry with per-door reasoning control, forcing, pricing; model.call observability; truncation guard; repair on tier; request-carried tool-input validation)
stage: v6-W1
depends: [M01-kernel, M02-events]
---
# M03 — model

## Responsibility
Be the single door to LLMs: an OpenAI-compatible chat client for the Neuralwatt tiers, a tier registry with guardrailed per-call routing, retry/timeout handling, token accounting into L0, the structured-output ladder with one-shot repair, and the MockModel test double. Tool invocation is native OpenAI function calling passed through unchanged — no custom call syntax exists anywhere in Thea2; fork/task/committee arrive from the loop's registry as ordinary ToolDefs and M03 treats them like any other tool (ADR-001).

## Interfaces (contract)
```ts
export type Tier = 'main' | 'cheap' | 'reasoning';
export type TaskClass = 'turn' | 'appraisal' | 'heartbeat-thought' | 'ponder-seed'
  | 'consolidate' | 'derive' | 'judge' | 'probe-judge' | 'summarize';

export interface ChatMsg { role: 'system' | 'user' | 'assistant' | 'tool'; content: string;
  toolCallId?: string; toolCalls?: ToolCall[]; }
export interface ToolDef { name: string; description: string; parameters: unknown /* JSON Schema */; }
export interface ToolCall { id: string; name: string; args: unknown; }
export interface Usage { inputTokens: number; outputTokens: number; costUsd?: number; latencyMs: number; attempts: number; }

export interface ChatRequest {
  taskClass: TaskClass; tier: Tier; messages: ChatMsg[]; tools?: ToolDef[];
  schema?: z.ZodType; maxTokens: number; temperature: number; seedHint?: number;
}
export interface ModelClient {
  chat<T = string>(req: ChatRequest, ctx?: { turnId?: string; signal?: AbortSignal }):
    Promise<{ content: T; toolCalls?: ToolCall[]; usage: Usage; model: string }>;
}
export interface ModelRouter { resolve(taskClass: TaskClass, requested: Tier): { model: string; tier: Tier }; }

export class MockModel implements ModelClient {
  enqueue(r: ScriptedResponse): void;                       // FIFO
  onTask(match: TaskClass | RegExp, fn: Responder): void;   // rule-based
  readonly calls: ChatRequest[];                            // full log for assertions
}
```

## Behavior spec
- Tier registry from config: `{ main: 'glm-5.2', cheap: 'deepseek-v4-flash', reasoning: <config> }`. Endpoint base URL and key come from resolved config (M20); never read env directly here.
- Router reads `var/routing.json` (proposed by M18 Ledger). Guardrail: routing may only downgrade non-user-facing task classes; `turn` is pinned to main tier in code — an attempted downgrade is ignored and emits a `model.routing_ignored` warning event. Any applied routing change counts as a deploy (Nightingale trigger — M18's job).
- Every call emits `model.call` to L0: `{taskClass, tier, model, usage, outcome, turnId?}` — one event per logical chat with `attempts` inside usage.
- Transport: per-call timeout (config, default 60000 ms); 2 retries on transport errors and 5xx with jittered backoff drawn from an injected forked Rng; no retry on 4xx. Abort via `ctx.signal` cancels cleanly.
- Tools: ToolDefs serialize to OpenAI `tools: [{type:'function', function:{...}}]`; returned tool calls are parsed with args as JSON. Malformed tool-call args get ONE cheap-tier repair attempt; if still malformed, fail typed + `model.parse_failed` incident.
- Structured-output ladder (when `schema` is set): (a) native `response_format: json_schema` if the endpoint capability flag says supported; (b) tool-call-as-schema — synthesize a single `emit` function from the zod schema and force `tool_choice` — used only when (a) is unsupported AND `tools` is empty; (c) prompted JSON + zod parse. On zod parse failure at any rung: ONE repair call on cheap tier (malformed output + schema + error text); if repair fails, return typed error + emit `model.parse_failed` incident. Capability flags live in config per endpoint, verified once by the S5 live smoke, not per call.
- `schema` and `tools` may both be set (the loop's assess call): rung (b) is skipped; structure comes from (a) or (c).
- `seedHint` forwards as `seed` where supported; `temperature`/`maxTokens` forward verbatim.
- MockModel: FIFO scripted responses + rule responders matched on taskClass or message regex; can script toolCalls, malformed JSON, delays, and errors; records every request; strict mode throws on an unexpected call. The real adapter's parsing layer and MockModel pass one shared conformance suite over recorded wire fixtures.
- No streaming in v1: nothing consumes partials (bubbles are planned post-hoc by M14).

## As built (S8, 2026-09-02) — the z.ai anthropic door + streaming
Backend re-point per Diego's directive ("Z-AI GLM 5.3 flash, DO NOT USE NEURALWATT,
use the streaming output"): `models.protocol: 'openai' | 'anthropic'` in config picks
the wire. z.ai's OpenAI-compat door is pay-as-you-go (1113 "Insufficient balance" on
this account); the **Anthropic-compat door** (`https://api.z.ai/api/anthropic`,
`/v1/messages`, `x-api-key` + `anthropic-version: 2023-06-01`) is what his coding plan
covers. Everything above the wire is protocol-blind: `buildAnthropicBody` /
`parseAnthropicResponse` produce the same shapes the OpenAI path does.

Protocol mapping (src/model/anthropic.ts):
- `system` messages hoist to the top-level `system` string (joined `\n\n`).
- Consecutive `role:'tool'` rows group into ONE user message of `tool_result` blocks;
  assistant toolCalls become `tool_use` blocks.
- Rung (a) `json_schema` does not exist on this door; the ladder's capability flags
  keep it off, and the body builder defensively maps it to the forced-emit rung.
- `thinking` blocks are scaffolding — dropped, never content.
- Tool inputs arrive decoded; `malformedToolCalls` is always empty on this protocol.

Streaming: the anthropic transport always sends `stream: true` and folds the SSE event
stream (`parseAnthropicSSE`) into the same response body a non-streaming 200 gives, so
one parser serves both. The deadline is **per-chunk idle** (each chunk must arrive
within timeoutMs of the previous), not total — a thinking phase that keeps emitting
never trips it; torn lines / `ping` / `[DONE]` are noise. A **total cap**
(`streamTotalMs`, default max(timeoutMs×15, 15 min)) backs the idle deadline: a
wedged stream that keeps dribbling keepalive bytes resets the idle race forever
otherwise — hang live-proven (30+ min on one established socket), the cap fires
non-retryable. A tool_use whose `input_json_delta` never parses is dropped rather
than emitted with garbage args.
This is model-connection streaming only: Telegram still receives finished bubbles
(Bot API has no in-chat token streaming) — M14's typing indicator + bubble pacing
remains the UX law.

**The starvation family (live-proven, load-bearing):** GLM thinking models draw their
reasoning trace from the SAME `max_tokens` budget as visible content. A starved call
returns empty content / never fires the emit tool / repairs to "empty input". Every
budget below was raised after live failures; do not lower them without a live check:
`committeeMaxTokens` 500→2000, probe judge 512→4000, derive drafts 900→4000, derive
judge 400→2000, consolidate generate 900→4000 + judge 300→2000, appraisal 400→2000,
window summary 160→2000, heartbeat thought 800→2000, sibling voice passes 400→1200.

Accounting note: z.ai's SSE `message_start` does not carry `input_tokens` on this
plan, so streamed calls record `inputTokens: 0` in `model.call` usage — output
tokens and attempts are accurate; input accounting returns with the S9 api-embedder
work if the door starts sending it.

## Not this module's job
- Deciding when to call or which tools exist — M13-loop owns the registry and the hops.
- Prompt/packet content and section order — M11-assemble.
- Embeddings (even though the endpoint family matches) — M04-embed.
- Producing routing proposals — M18-siblings; applying config — M20-app.
- Interpreting DecisionObject/Appraisal semantics — M13/M09 own their schemas; M03 only enforces parse.

## Acceptance criteria
- [ ] Ladder fallthrough: scripted malformed JSON at rung (c) triggers exactly one cheap repair; a second failure returns a typed error and emits `model.parse_failed`.
- [ ] Every chat emits exactly one `model.call` event with usage populated; latency measured via the injected clock.
- [ ] Router: downgrade attempt on `turn` is ignored + `model.routing_ignored` emitted; downgrade on `summarize` is honored.
- [ ] ToolDef serialization matches the OpenAI wire shape byte-for-byte (golden); toolCalls round-trip with parsed args.
- [ ] Two 5xx responses then success yields one result with `usage.attempts = 3`; a 400 fails immediately with no retry.
- [ ] Rung (b) is never used when `tools` is non-empty (call-log assertion).
- [ ] MockModel and the real parsing layer pass the shared conformance suite over recorded fixtures.

## Test checklist
- unit: router guardrail table (all 9 task classes x 3 tiers); zod-to-JSON-schema goldens; repair-prompt construction; usage math; backoff jitter determinism per seed.
- component: ladder rung matrix against MockModel-scripted endpoints; retry/timeout/abort with TestClock; conformance suite over recorded Neuralwatt fixtures (plain chat, tool_calls, json_schema, malformed JSON, 5xx).
- fixtures needed: recorded wire responses for each conformance case; sample `var/routing.json` (legal + illegal downgrade); representative zod schemas (Appraisal shape, DecisionObject shape).

## As built (Phase 1)

`ChatRequest.toolChoice?: 'auto' | 'required' | {name: string}` (types.ts). Wire mappings: openai — `'auto'`/`'required'` pass through verbatim, `{name}` maps to `{type:'function',function:{name}}`, and an ABSENT field keeps the legacy bytes (tools on the request ⇒ `tool_choice:'auto'`; no tools ⇒ the field is omitted entirely). Anthropic — `'auto'` → `{type:'auto'}`, `'required'` → `{type:'any'}`, `{name}` → `{type:'tool',name}`, absent ⇒ the field is omitted from the body entirely. The structured ladder's forced-emit `tool_choice` still outranks a caller's value. Pinned in test/model/toolchoice.test.ts; the emit-tool goldens in wire.test.ts / anthropic.test.ts remain byte-identical when toolChoice is absent.

## As built (W1.1 door smoke, 2026-09-03)

Live smoke against the z.ai anthropic door (`scripts/thinking-smoke.ts`, both tier models × omitted / `disabled` / `enabled 1024` / `enabled 2048`):

- **`thinking:{type:'disabled'}` is REJECTED by `glm-5.3-flash`** — HTTP 500, `api_error` 1234, every time. `glm-5.3` accepts it. Asymmetry is the door's.
- Therefore `THINKING_DEFAULTS` **omits the field entirely** for `turn`, `heartbeat-thought`, `ponder-seed`, `summarize` (door default answered 200, end_turn, ~3.5 s on flash); `enabled 1024` verified working on BOTH models for the judge family.
- `enabled 2048` also accepted on both (no reason to raise the 1024 budget).
- Kill-switch `models.thinking: 'off'` remains the emergency lever (P-A.2).

## As built (v6-W1 P-DOOR, 2026-09-03) — doors with control

The door registry (ADR-010, D.6-1/D.6-2) lives in config (`models.doors.{voice,mind,judge,voiceFallback}` in `thea2.config.yaml`, schema in src/app/config.ts): each door `{endpoint, protocol:'anthropic'|'openai', keyEnv, model, effort?, thinkingBudget?, forcing:'tool_choice'|'none', temperature?, topP?, pricing?}` — `keyEnv` names an env variable, never a key value; `loadConfig` resolves every door's key from env (missing ⇒ `app/config-invalid` naming the door) and synthesizes the three tier doors from a legacy `models.endpoint/protocol/tiers` block (voice=main, mind=cheap, judge=reasoning, forcing 'none'). The shipped yaml carries the four D.6-1/D.6-2 doors. The flattened `models.{endpoint,apiKey,protocol,tiers}` view equals the voice door (the embedder and derive CLI ride it).

- **tier→door** (`src/model/tiers.ts`): `TIER_DOOR`/`tierFor` map main→voice, cheap→mind, reasoning→judge; tier names in code stay `main|cheap|reasoning`. `makeRouter` takes the door table and every `RoutedCall` names its door. Compose (src/app/compose.ts) builds ONE transport per tier door (`zaiTransport` with the door's endpoint/protocol/key, rng fork `door-<name>`); `chatCore` picks the runtime by routed tier, so a mixed openai+anthropic door set rides one `ModelClient`. `voiceFallback` ships in config for the D.6-1 swap; nothing routes to it yet.
- **Reasoning by class (DR.2)**: `REASONING_BY_CLASS` in tiers.ts — turn/heartbeat-thought/summarize/ponder-seed/appraisal → `low`; consolidate/derive/judge/probe-judge → `high`. `client.chat` applies it when `req.reasoning` is absent (caller override wins). Wire mapping: openai door → `reasoning_effort` (glm-5.* never see `none` — mapped to `minimal`; other models take it verbatim); anthropic door → `thinking:{type:'enabled', budget_tokens}` from the door's `thinkingBudget` or `{none:128, minimal:256, low:512, high:1024, max:2048}` — **`type:'disabled'` is never emitted** (a caller asking for it gets the field dropped). This replaces the loop's `THINKING_DEFAULTS` (P-FAST's `LoopConfig.thinking` stays as a direct-override escape hatch, default empty). NOTE: ponder-seed moves from enabled-1024 to low(512 on the effort table) on the anthropic wire — spec-mandated (DR.2); watch the ponder-starvation family after deploy.
- **Forcing per door (DR.3)**: on a `forcing:'tool_choice'` door the client forces `{name:'decide'}` whenever `decide` is among the offered defs and the caller set no toolChoice (not only as the sole def); `forcing:'none'` doors never add a force, and a caller's explicit toolChoice always outranks the door.
- **Observability (DR.4)**: `model.call` gains `door, stopReason, maxTokens, reasoning, costUsd` (costUsd only when the door has pricing: `in·inputPerM/1e6 + out·outputPerM/1e6`). A failed send's HTTP attempts are stamped onto the thrown `ModelError` by the transport and credited into `usage.attempts` (sum with completed generations).
- **Truncation guard (DR.5)**: `model/truncated` (non-retryable) fires when `stopReason === 'max_tokens'`, OR `outputTokens >= maxTokens` with no tool call, OR a schema was expected and content is empty — including cut-off replies WITH visible content and max_tokens stops that carried a tool call (two pre-DR.5 behaviors inverted deliberately; a cut-off answer is not her voice).
- **Repair on tier (DR.6)**: the one-shot structured/tool-arg repair keeps the REQUESTING tier (never downgrades to cheap) and doubles maxTokens.
- **Tool-input validation (DR.7)**: `ChatRequest.toolInput` carries per-tool zod validators on the REQUEST (the loop's registry entries — src/model never imports src/loop; the DAG forbids it). `decide.bubbles` is always coerced (bare string → newline-split string array, blanks dropped); validator failures join the one-shot repair rung and repaired args are revalidated. Wiring the loop side to pass `toolInput` lands with P-FAST/P-LOOP (their files).

---
module: M03
name: model
syncedTo: S1 (implemented — src/model, test/model; the structured ladder routes through the synthetic `emit` tool rung)
stage: S1
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

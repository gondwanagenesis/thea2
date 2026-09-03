// M03 model — public contract types (docs/modules/M03-model.md §Interfaces).
// M03 is the single door to LLMs: everything above this line talks to a
// ModelClient and never to HTTP, env, or a vendor SDK.

import type { ZodType } from 'zod';

export type Tier = 'main' | 'cheap' | 'reasoning';

/**
 * The reasoning-control vocabulary (P-DOOR DR.2). A request may carry one
 * explicitly (`ChatRequest.reasoning`); absent, the client applies the class
 * default from REASONING_BY_CLASS (tiers.ts) and the wire maps it per protocol.
 */
export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'high' | 'max';

/** The door registry names (P-DOOR DR.1). `voiceFallback` rides no tier: it is
 * the swap-in voice door (D.6-1) and later packages may route to it directly. */
export type DoorName = 'voice' | 'mind' | 'judge' | 'voiceFallback';

export interface DoorPricing {
  /** USD per 1M input tokens. */
  inputPerM: number;
  /** USD per 1M output tokens. */
  outputPerM: number;
}

/**
 * One door: an endpoint family + wire protocol + the controls it honors
 * (effort/thinking budget/forcing/sampling/pricing). No key material ever
 * lives here — keys ride the transport, resolved from `keyEnv` by M20 config.
 */
export interface Door {
  name: DoorName;
  protocol: 'openai' | 'anthropic';
  model: string;
  /** The door's own reasoning control — the fallback when no class default or caller override applies. */
  effort?: ReasoningEffort | undefined;
  /** Anthropic-door thinking budget; outranks the effort→budget table when set. */
  thinkingBudget?: number | undefined;
  /** 'tool_choice': the client forces `decide` whenever it is among the offered defs (DR.3). */
  forcing: 'tool_choice' | 'none';
  temperature?: number | undefined;
  topP?: number | undefined;
  pricing?: DoorPricing | undefined;
}

/** The decide tool's wire name (DR.3 forcing keys on it; the loop's DECIDE_TOOL_NAME matches). */
export const DECIDE_TOOL = 'decide';

export type TaskClass =
  | 'turn'
  | 'appraisal'
  | 'heartbeat-thought'
  | 'ponder-seed'
  | 'consolidate'
  | 'derive'
  | 'judge'
  | 'probe-judge'
  | 'summarize';

export const TASK_CLASSES: readonly TaskClass[] = [
  'turn',
  'appraisal',
  'heartbeat-thought',
  'ponder-seed',
  'consolidate',
  'derive',
  'judge',
  'probe-judge',
  'summarize',
];

/** One OpenAI function call, parsed off the wire (`args` is the decoded JSON value). */
export interface ToolCall {
  id: string;
  name: string;
  args: unknown;
}

export interface ChatMsg {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Set on role 'tool' messages: the ToolCall.id this message answers. */
  toolCallId?: string;
  /** Set on role 'assistant' messages that issued tool calls (loop replays them verbatim). */
  toolCalls?: ToolCall[];
}

/** Native OpenAI function calling, passed through unchanged (ADR-001). */
export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema for the arguments object. */
  parameters: unknown;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /** Only when the endpoint/config supplies pricing; the Ledger (M18) owns cost math. */
  costUsd?: number;
  latencyMs: number;
  /** HTTP attempts for this logical chat: retries + the one-shot repair all fold in here. */
  attempts: number;
}

/**
 * Anthropic-protocol extended-thinking control, passed through verbatim on the
 * anthropic door (z.ai's GLM thinking models draw the trace from the same
 * max_tokens budget — see M03 "starvation family"). Ignored on the openai wire.
 */
export type ThinkingControl = { type: 'enabled'; budget_tokens: number } | { type: 'disabled' };

/**
 * Why the model stopped, as the wire reported it. Anthropic vocabulary; the
 * openai wire maps finish_reason onto it (length → max_tokens, stop → end_turn,
 * tool_calls → tool_use). Unknown door-specific values pass through as strings.
 */
export type StopReason = 'end_turn' | 'max_tokens' | 'tool_use' | 'stop_sequence' | (string & {});

export interface ChatRequest<T = string> {
  taskClass: TaskClass;
  tier: Tier;
  messages: ChatMsg[];
  tools?: ToolDef[];
  /** When set, the structured-output ladder runs and `content` is the parsed value. */
  schema?: ZodType<T>;
  /** Name recorded in `model.parse_failed` payloads; falls back to the schema's `.description`. */
  schemaName?: string;
  maxTokens: number;
  temperature: number;
  /**
   * Native tool-choice control, mapped per protocol by the wire builders:
   * openai `'auto' | 'required' | {type:'function',function:{name}}`,
   * anthropic `{type:'auto'} | {type:'any'} | {type:'tool',name}`. Absent ⇒ the
   * field keeps each door's existing default (openai: 'auto' when tools ride
   * along; anthropic: omitted entirely). The loop's assess path sets
   * `{name:'decide'}` when `decide` is the ONLY tool offered — a decision is
   * mandatory, not a menu option.
   */
  toolChoice?: 'auto' | 'required' | { name: string };
  /** Forwarded as `seed` when the endpoint capability flag says it is supported. */
  seedHint?: number;
  /** Anthropic `thinking` parameter; sent only when set (anthropic protocol only). */
  thinking?: ThinkingControl;
  /**
   * Reasoning-control override (DR.2). Absent ⇒ the client applies the class
   * default (REASONING_BY_CLASS); the wire maps the effective value per door
   * protocol (openai: `reasoning_effort`, glm-5.* never sees 'none';
   * anthropic: `thinking {type:'enabled', budget_tokens}` — never 'disabled').
   */
  reasoning?: ReasoningEffort | undefined;
  /**
   * Per-tool zod validators (DR.7). The loop passes its registry entries HERE:
   * the model layer never imports loop (the DAG forbids it), so the validator
   * rides the request. Each tool call's args are zod-parsed against the
   * matching entry after coercion; failures join the one-shot repair rung.
   */
  toolInput?: Readonly<Record<string, ZodType>> | undefined;
}

export interface ChatContext {
  turnId?: string;
  signal?: AbortSignal;
}

export interface ChatResponse<T = string> {
  content: T;
  toolCalls?: ToolCall[];
  usage: Usage;
  model: string;
  /** Wire stop reason of the first (non-repair) generation, when the door reported one. */
  stopReason?: StopReason;
}

export interface ModelClient {
  chat<T = string>(req: ChatRequest<T>, ctx?: ChatContext): Promise<ChatResponse<T>>;
}

export interface RoutedCall {
  model: string;
  tier: Tier;
  /** The door serving this call, when the router was built with a door table. */
  door?: Door | undefined;
}

export interface ModelRouter {
  /** Applies var/routing.json under the ADR-008 guardrails; never throws for routing reasons. */
  resolve(taskClass: TaskClass, requested: Tier): RoutedCall;
}

// ---------------------------------------------------------------------------
// L0 payloads (mirrors schemas/events.ts — M03 owns these shapes)
// ---------------------------------------------------------------------------

export interface ModelCallEvent {
  taskClass: TaskClass;
  tier: Tier;
  model: string;
  usage: Usage;
  outcome: 'ok' | 'error' | 'timeout' | 'aborted';
  /** The door that served the call (door mode; absent on the legacy single-endpoint client). */
  door?: DoorName | undefined;
  /** The request's token cap (DR.4). */
  maxTokens?: number | undefined;
  /** The reasoning control that rode the call (DR.2/DR.4). */
  reasoning?: ReasoningEffort | undefined;
  /** Wire stop reason of the first (non-repair) generation, when the door reported one. */
  stopReason?: StopReason | undefined;
  /** Priced doors only: in·inputPerM/1e6 + out·outputPerM/1e6 over the call's total usage (DR.4). */
  costUsd?: number | undefined;
}

/** Structured-output rung vocabulary, as named in `model.parse_failed` payloads. */
export type ParseRung = 'json_schema' | 'tool_call' | 'prompted_json' | 'repair';

export interface ParseFailedEvent {
  schema: string;
  rung: ParseRung;
  error: string;
}

export interface RoutingIgnoredEvent {
  taskClass: string;
  attemptedTier: string;
  pinnedTier: string;
}

// ---------------------------------------------------------------------------
// Routing (var/routing.json — proposed by M18, loaded by M20, applied here)
// ---------------------------------------------------------------------------

export interface RoutingOverride {
  taskClass: TaskClass;
  tier: Tier;
  reason?: string;
}

export type RoutingTable = readonly RoutingOverride[];

// ---------------------------------------------------------------------------
// Endpoint capability flags (config per endpoint, verified once by the S5 live
// smoke — never probed per call).
// ---------------------------------------------------------------------------

export interface EndpointCapabilities {
  /** Native `response_format: json_schema` (ladder rung a). Default false → prompted JSON. */
  jsonSchema?: boolean;
  /** Endpoint accepts `seed`. Default false → `seedHint` is dropped. */
  seed?: boolean;
}

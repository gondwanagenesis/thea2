// M03 model — public contract types (docs/modules/M03-model.md §Interfaces).
// M03 is the single door to LLMs: everything above this line talks to a
// ModelClient and never to HTTP, env, or a vendor SDK.

import type { ZodType } from 'zod';

export type Tier = 'main' | 'cheap' | 'reasoning';

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

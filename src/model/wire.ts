// M03 model — the OpenAI wire boundary. Pure serialization/parsing only: no
// transport, no clock, no retries. The goldens in test/model pin these shapes
// byte-for-byte (acceptance criterion: ToolDef serialization matches the OpenAI
// wire shape).

import { z, type ZodType } from 'zod';
import { canonicalJson } from '../kernel/index.js';
import { modelError } from './errors.js';
import { EMIT_TOOL_NAME, looseJsonParse, promptedJsonInstruction } from './json.js';
import { ANTHROPIC_THINKING_BUDGETS } from './tiers.js';
import type { ChatMsg, ChatRequest, Door, ReasoningEffort, StopReason, ThinkingControl, ToolCall, ToolDef } from './types.js';

// ---------------------------------------------------------------------------
// Wire shapes (only the fields M03 sends or reads; unknown fields are ignored)
// ---------------------------------------------------------------------------

export interface WireToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string | null };
}

export interface WireMessage {
  role: string;
  content?: string | null;
  tool_call_id?: string;
  tool_calls?: WireToolCall[];
}

export interface WireBody {
  model: string;
  messages: WireMessage[];
  temperature: number;
  max_tokens: number;
  seed?: number;
  /** P-DOOR DR.2: the reasoning control, openai spelling. */
  reasoning_effort?: ReasoningEffort;
  /** Door topP (DR.1), openai spelling. */
  top_p?: number;
  tools?: Array<{ type: 'function'; function: { name: string; description: string; parameters: unknown } }>;
  tool_choice?: 'auto' | 'required' | { type: 'function'; function: { name: string } };
  response_format?: { type: 'json_schema'; json_schema: { name: string; strict: boolean; schema: unknown } };
}

export interface WireResponse {
  choices?: Array<{
    message?: { role?: string; content?: string | null; tool_calls?: WireToolCall[] };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

// ---------------------------------------------------------------------------
// Outbound serialization
// ---------------------------------------------------------------------------

export const toWireMessages = (msgs: readonly ChatMsg[]): WireMessage[] =>
  msgs.map((m) => ({
    role: m.role,
    content: m.content,
    ...(m.toolCallId !== undefined ? { tool_call_id: m.toolCallId } : {}),
    ...(m.toolCalls !== undefined
      ? {
          tool_calls: m.toolCalls.map((c) => ({
            id: c.id,
            type: 'function',
            function: { name: c.name, arguments: canonicalJson(c.args) },
          })),
        }
      : {}),
  }));

/** ToolDefs → OpenAI `tools` array. Golden-pinned; do not touch field names casually. */
export const toWireTools = (
  tools: readonly ToolDef[],
): Array<{ type: 'function'; function: { name: string; description: string; parameters: unknown } }> =>
  tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));

/**
 * zod → JSON Schema (draft 2020-12) for ladder rungs (a)/(b). The `$schema` key
 * is stripped: endpoints set the dialect themselves and a stable object keeps
 * goldens and request bytes stable. Unrepresentable schemas throw a typed error
 * — the ladder treats that as "rungs (a)/(b) unavailable" and falls through.
 */
export const schemaToJsonSchema = (schema: ZodType): Record<string, unknown> => {
  let converted: object;
  try {
    converted = z.toJSONSchema(schema) as object;
  } catch (e) {
    throw modelError('model/bad-json', `schema is not representable as JSON Schema: ${errMsg(e)}`, { cause: e });
  }
  const { $schema: _dialect, ...rest } = converted as Record<string, unknown>;
  void _dialect;
  return rest;
};

/** Compact, key-sorted JSON form of a schema — what goes into prompts. */
export const schemaJsonForPrompt = (schema: ZodType): string => canonicalJson(schemaToJsonSchema(schema));

// ---------------------------------------------------------------------------
// Inbound parsing
// ---------------------------------------------------------------------------

export interface MalformedToolCall {
  id: string;
  name: string;
  raw: string;
  error: string;
}

export interface ParsedResponse {
  content: string;
  toolCalls: ToolCall[];
  malformedToolCalls: MalformedToolCall[];
  inputTokens: number;
  outputTokens: number;
  /** Anthropic-vocabulary stop reason (openai finish_reason mapped); absent when the wire gave none. */
  stopReason?: StopReason;
}

/** OpenAI finish_reason → the Anthropic stop vocabulary the client reasons in. */
const FINISH_REASON_MAP: Record<string, StopReason> = {
  stop: 'end_turn',
  length: 'max_tokens',
  tool_calls: 'tool_use',
  function_call: 'tool_use',
};

/** Parses tool-call entries; throws only for unrepairable protocol violations (missing name). */
export const parseWireToolCalls = (
  list: readonly WireToolCall[],
): { calls: ToolCall[]; malformed: MalformedToolCall[] } => {
  const calls: ToolCall[] = [];
  const malformed: MalformedToolCall[] = [];
  list.forEach((tc, i) => {
    const name = tc.function?.name;
    if (typeof name !== 'string' || name === '') {
      throw modelError('model/bad-json', `tool call at index ${i} has no function name`);
    }
    const id = typeof tc.id === 'string' && tc.id !== '' ? tc.id : `call_${i}`;
    const rawArg = tc.function?.arguments;
    if (typeof rawArg === 'string') {
      const parsed = looseJsonParse(rawArg);
      if (parsed.ok) calls.push({ id, name, args: parsed.value });
      else malformed.push({ id, name, raw: rawArg, error: parsed.error });
      return;
    }
    if (rawArg === null || rawArg === undefined) {
      malformed.push({ id, name, raw: '', error: 'missing arguments string' });
      return;
    }
    // Some providers hand back an already-decoded object; accept it as-is.
    calls.push({ id, name, args: rawArg });
  });
  return { calls, malformed };
};

/** 200-body → domain result. Throws model/bad-json for protocol violations. */
export const parseWireResponse = (raw: unknown): ParsedResponse => {
  if (typeof raw !== 'object' || raw === null) {
    throw modelError('model/bad-json', 'response body is not a JSON object');
  }
  const body = raw as { choices?: unknown; usage?: unknown };
  if (!Array.isArray(body.choices) || body.choices.length === 0) {
    throw modelError('model/bad-json', 'response has no choices');
  }
  const first: unknown = body.choices[0];
  const message =
    typeof first === 'object' && first !== null ? ((first as { message?: unknown }).message ?? {}) : {};
  const m = message as { content?: unknown; tool_calls?: unknown };
  const content = typeof m.content === 'string' ? m.content : '';

  let toolCalls: ToolCall[] = [];
  let malformedToolCalls: MalformedToolCall[] = [];
  if (Array.isArray(m.tool_calls)) {
    const parsed = parseWireToolCalls(m.tool_calls as WireToolCall[]);
    toolCalls = parsed.calls;
    malformedToolCalls = parsed.malformed;
  }

  const usage = (typeof body.usage === 'object' && body.usage !== null ? body.usage : {}) as {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
  };
  const finish = (first as { finish_reason?: unknown }).finish_reason;
  const stopReason = typeof finish === 'string' ? (FINISH_REASON_MAP[finish] ?? finish) : undefined;
  return {
    content,
    toolCalls,
    malformedToolCalls,
    inputTokens: typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : 0,
    outputTokens: typeof usage.completion_tokens === 'number' ? usage.completion_tokens : 0,
    ...(stopReason !== undefined ? { stopReason } : {}),
  };
};

// ---------------------------------------------------------------------------
// Request assembly per ladder rung
// ---------------------------------------------------------------------------

export type RequestRung = 'json_schema' | 'tool_call' | 'prompted_json';

export interface BuildBodyInput {
  // `any` here is deliberate, mirroring CoreChat: the body builder only shapes
  // the request — it never touches the parsed `schema` output type.
  req: ChatRequest<any>;
  model: string;
  rung: RequestRung | 'auto';
  seedSupported: boolean;
  /** The serving door (DR.1): effort fallback, thinkingBudget, sampling defaults. Absent on the legacy single-door path — bytes stay legacy. */
  door?: Door | undefined;
}

/**
 * The effective reasoning control (DR.2): a caller/client override first, the
 * door's own effort second. Undefined ⇒ the field stays off the body (legacy
 * bytes). glm-5.* models never see 'none' — the openai wire maps it to
 * 'minimal' (the door's smallest honest effort); other models take 'none'
 * verbatim.
 */
export const reasoningEffortFor = (
  req: ChatRequest<any>,
  model: string,
  door?: Door | undefined,
): ReasoningEffort | undefined => {
  const effort = req.reasoning ?? door?.effort;
  if (effort === undefined) return undefined;
  if (effort === 'none' && GLM5_RE.test(model)) return 'minimal';
  return effort;
};

const GLM5_RE = /^glm-5\./;

/**
 * The effective reasoning control (DR.2), anthropic spelling: a caller's
 * `thinking` rides verbatim EXCEPT `type:'disabled'`, which is dropped — this
 * wire never emits disabled (glm-5.3-flash 500s on it; W1.1 door smoke).
 * Otherwise thinking derives from the effective effort as
 * `{type:'enabled', budget_tokens}` with the door's `thinkingBudget` outranking
 * the effort table. Undefined ⇒ the field stays off the body.
 */
export const anthropicThinkingFor = (
  req: ChatRequest<any>,
  door?: Door | undefined,
): ThinkingControl | undefined => {
  if (req.thinking !== undefined) {
    if (req.thinking.type === 'disabled') return undefined;
    return req.thinking;
  }
  const effort = req.reasoning ?? door?.effort;
  if (effort === undefined) return undefined;
  return { type: 'enabled', budget_tokens: door?.thinkingBudget ?? ANTHROPIC_THINKING_BUDGETS[effort] };
};

/**
 * Builds the wire body. Rung decisions are made upstream (the ladder); this only
 * shapes the request: (a) response_format json_schema, (b) a single forced `emit`
 * tool, (c) a trailing system message carrying the schema in prose.
 */
export const buildWireBody = (input: BuildBodyInput): WireBody => {
  const { req, model, rung, seedSupported, door } = input;
  const { schema } = req;
  const tools = req.tools !== undefined && req.tools.length > 0 ? toWireTools(req.tools) : undefined;
  const messages = [...toWireMessages(req.messages)];
  // Door sampling defaults (DR.1): a configured door temperature/topP outranks
  // the request default; top_p only ever rides from the door.
  const temperature = door?.temperature ?? req.temperature;
  const reasoningEffort = reasoningEffortFor(req, model, door);

  let responseFormat: WireBody['response_format'];
  // Legacy default stands when toolChoice is absent (goldens byte-identical):
  // tools on the wire ⇒ 'auto', no tools ⇒ the field is omitted entirely.
  let toolChoice: WireBody['tool_choice'] = tools !== undefined ? 'auto' : undefined;
  // The caller's explicit toolChoice (e.g. the loop's forced `decide`) rides
  // whenever tools do; a bare name maps to the openai forced-function shape.
  if (req.toolChoice !== undefined && tools !== undefined) {
    toolChoice =
      req.toolChoice === 'auto'
        ? 'auto'
        : req.toolChoice === 'required'
          ? 'required'
          : { type: 'function', function: { name: req.toolChoice.name } };
  }
  let wireTools = tools;

  if (rung === 'json_schema' && schema !== undefined) {
    responseFormat = {
      type: 'json_schema',
      json_schema: { name: schemaName(req), strict: true, schema: schemaToJsonSchema(schema) },
    };
  } else if (rung === 'tool_call' && schema !== undefined) {
    wireTools = [
      {
        type: 'function',
        function: {
          name: EMIT_TOOL_NAME,
          description: 'Emit the structured output. The arguments must conform exactly to the provided JSON schema.',
          parameters: schemaToJsonSchema(schema),
        },
      },
    ];
    toolChoice = { type: 'function', function: { name: EMIT_TOOL_NAME } };
  } else if (rung === 'prompted_json' && schema !== undefined) {
    messages.push({ role: 'system', content: promptedJsonInstruction(schemaJsonForPrompt(schema)) });
  }

  return {
    model,
    messages,
    temperature,
    max_tokens: req.maxTokens,
    ...(seedSupported && req.seedHint !== undefined ? { seed: req.seedHint } : {}),
    ...(reasoningEffort !== undefined ? { reasoning_effort: reasoningEffort } : {}),
    ...(door?.topP !== undefined ? { top_p: door.topP } : {}),
    ...(wireTools !== undefined ? { tools: wireTools } : {}),
    ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
    ...(responseFormat !== undefined ? { response_format: responseFormat } : {}),
  };
};

export const schemaName = (req: ChatRequest): string =>
  req.schemaName ??
  (typeof req.schema?.description === 'string' && req.schema.description !== '' ? req.schema.description : 'output');

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

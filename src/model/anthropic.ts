// M03 model — the Anthropic-protocol wire boundary (z.ai's /api/anthropic door,
// the one Diego's coding-plan key covers). Pure serialization/parsing only: no
// transport, no retries — same split as wire.ts, and the parser returns the SAME
// ParsedResponse the OpenAI path produces, so the ladder and token accounting
// above it never learn which protocol ran.
//
// Protocol notes that are load-bearing:
//  - `system` is a top-level string, not a message; hoisted + joined.
//  - Tool results travel as `tool_result` blocks inside the USER message that
//    follows the assistant's `tool_use` blocks — consecutive role:'tool' rows
//    are grouped into one such user message.
//  - Rung (a) (response_format json_schema) does not exist here; the ladder's
//    capability flags keep it off, and the builder defensively maps the rung to
//    the forced-emit tool anyway.
//  - Thinking models return `thinking` blocks before the answer; they are
//    scaffolding, not content, and are dropped — content is text blocks only.
//  - SSE (stream:true) is how the door keeps a thinking generation's connection
//    alive; parseAnthropicSSE folds the event stream into the same result.

import { modelError } from './errors.js';
import { EMIT_TOOL_NAME, promptedJsonInstruction } from './json.js';
import type { ChatMsg, StopReason, ThinkingControl, ToolCall } from './types.js';
import type { BuildBodyInput, ParsedResponse } from './wire.js';
import { anthropicThinkingFor, schemaJsonForPrompt, schemaToJsonSchema } from './wire.js';

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

export interface AnthropicToolDef {
  name: string;
  description?: string;
  input_schema: unknown;
}

export interface AnthropicContentBlock {
  type: 'text' | 'thinking' | 'tool_use' | 'tool_result' | string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string;
}

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

export interface AnthropicBody {
  model: string;
  max_tokens: number;
  temperature: number;
  system?: string;
  messages: AnthropicMessage[];
  tools?: AnthropicToolDef[];
  tool_choice?: { type: 'tool'; name: string } | { type: 'auto' } | { type: 'any' };
  /** Extended-thinking control, passed through verbatim (anthropic protocol only). */
  thinking?: ThinkingControl;
  /** Door topP (DR.1), anthropic spelling. */
  top_p?: number;
  stream?: boolean;
}

export interface AnthropicResponseBody {
  content?: AnthropicContentBlock[];
  usage?: { input_tokens?: number; output_tokens?: number };
  stop_reason?: string;
  /** A door-side `error` event folded out of an SSE stream (parseAnthropicSSE throws before this matters). */
  error?: { type?: string; message?: string };
}

// ---------------------------------------------------------------------------
// Outbound serialization
// ---------------------------------------------------------------------------

const assistantBlocks = (m: ChatMsg): AnthropicContentBlock[] => {
  const calls = m.toolCalls ?? [];
  return [
    ...(m.content !== '' ? [{ type: 'text' as const, text: m.content }] : []),
    ...calls.map((c) => ({ type: 'tool_use' as const, id: c.id, name: c.name, input: c.args })),
  ];
};

/**
 * ChatMsgs → Anthropic messages. `system` rows are hoisted out (returned via
 * the body builder); consecutive `tool` rows group into ONE user message of
 * `tool_result` blocks — the protocol's answer to the assistant turn.
 */
export const toAnthropicMessages = (msgs: readonly ChatMsg[]): AnthropicMessage[] => {
  const out: AnthropicMessage[] = [];
  for (const m of msgs) {
    if (m.role === 'system') continue; // hoisted by buildAnthropicBody
    if (m.role === 'tool') {
      const block: AnthropicContentBlock = { type: 'tool_result', tool_use_id: m.toolCallId ?? '', content: m.content };
      const last = out[out.length - 1];
      if (Array.isArray(last?.content) && last.content.every((b) => b.type === 'tool_result')) {
        last.content.push(block);
      } else {
        out.push({ role: 'user', content: [block] });
      }
      continue;
    }
    if (m.role === 'assistant' && m.toolCalls !== undefined && m.toolCalls.length > 0) {
      out.push({ role: 'assistant', content: assistantBlocks(m) });
      continue;
    }
    out.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content });
  }
  return out;
};

/**
 * Builds the Anthropic wire body. Rung decisions are made upstream (the
 * ladder); this only shapes the request: (b) a single forced `emit` tool with
 * the schema as input_schema, (c) the schema appended to `system` in prose.
 */
export const buildAnthropicBody = (input: BuildBodyInput): AnthropicBody => {
  const { req, model, rung, door } = input;
  const systemParts = req.messages.filter((m) => m.role === 'system').map((m) => m.content);
  const schema = req.schema;
  const wireTools: AnthropicToolDef[] | undefined =
    req.tools !== undefined && req.tools.length > 0
      ? req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }))
      : undefined;
  // DR.2: thinking derived from the effective reasoning control (caller
  // thinking rides verbatim; 'disabled' is never emitted). DR.1: door sampling
  // defaults outrank the request's, top_p only ever rides from the door.
  const thinking = anthropicThinkingFor(req, door);
  const temperature = door?.temperature ?? req.temperature;

  let tools = wireTools;
  let toolChoice: AnthropicBody['tool_choice'];
  if (schema !== undefined && (rung === 'tool_call' || rung === 'json_schema')) {
    // Rung (a) has no Anthropic equivalent; the forced-emit tool IS the rung here.
    tools = [
      {
        name: EMIT_TOOL_NAME,
        description: 'Emit the structured output. The arguments must conform exactly to the provided JSON schema.',
        input_schema: schemaToJsonSchema(schema),
      },
    ];
    toolChoice = { type: 'tool', name: EMIT_TOOL_NAME };
  } else if (schema !== undefined) {
    systemParts.push(promptedJsonInstruction(schemaJsonForPrompt(schema)));
  } else if (req.toolChoice !== undefined && wireTools !== undefined) {
    // The ladder did not claim tool_choice, so the caller's explicit control
    // rides (e.g. the loop's forced `decide`). openai 'required' ("some tool
    // must be called") is spelled 'any' on this protocol. Absent ⇒ the field
    // stays out of the body entirely — the pre-Phase-1 bytes, unchanged.
    toolChoice =
      req.toolChoice === 'auto'
        ? { type: 'auto' }
        : req.toolChoice === 'required'
          ? { type: 'any' }
          : { type: 'tool', name: req.toolChoice.name };
  }

  return {
    model,
    max_tokens: req.maxTokens,
    temperature,
    ...(systemParts.length > 0 ? { system: systemParts.join('\n\n') } : {}),
    messages: toAnthropicMessages(req.messages),
    ...(tools !== undefined ? { tools } : {}),
    ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
    ...(thinking !== undefined ? { thinking } : {}),
    ...(door?.topP !== undefined ? { top_p: door.topP } : {}),
  };
};

// ---------------------------------------------------------------------------
// Inbound parsing
// ---------------------------------------------------------------------------

/** Content blocks + usage (+ optional wire stop reason) → the same ParsedResponse the OpenAI path yields. */
export const parsedFromBlocks = (
  blocks: readonly AnthropicContentBlock[],
  usage: { input_tokens?: number; output_tokens?: number },
  stopReason?: StopReason,
): ParsedResponse => {
  let content = '';
  const toolCalls: ToolCall[] = [];
  for (const b of blocks) {
    if (b.type === 'text' && typeof b.text === 'string') content += b.text;
    else if (b.type === 'tool_use') {
      if (typeof b.name !== 'string' || b.name === '') {
        throw modelError('model/bad-json', 'tool_use block has no name');
      }
      toolCalls.push({
        id: typeof b.id === 'string' && b.id !== '' ? b.id : `call_${toolCalls.length}`,
        name: b.name,
        args: b.input,
      });
    }
    // `thinking` blocks are reasoning scaffolding — never content, never a tool.
  }
  return {
    content,
    toolCalls,
    malformedToolCalls: [], // args arrive decoded on this protocol — nothing to repair at the wire
    inputTokens: typeof usage.input_tokens === 'number' ? usage.input_tokens : 0,
    outputTokens: typeof usage.output_tokens === 'number' ? usage.output_tokens : 0,
    ...(stopReason !== undefined ? { stopReason } : {}),
  };
};

/** 200-body → domain result. Throws model/bad-json for protocol violations, model/http-error for a folded SSE `error` event. */
export const parseAnthropicResponse = (raw: unknown): ParsedResponse => {
  if (typeof raw !== 'object' || raw === null) {
    throw modelError('model/bad-json', 'response body is not a JSON object');
  }
  const body = raw as AnthropicResponseBody;
  if (!Array.isArray(body.content)) {
    throw modelError('model/bad-json', 'response has no content blocks');
  }
  return parsedFromBlocks(
    body.content,
    body.usage ?? {},
    typeof body.stop_reason === 'string' ? (body.stop_reason as StopReason) : undefined,
  );
};

// ---------------------------------------------------------------------------
// SSE parsing
// ---------------------------------------------------------------------------

interface StreamFold {
  blocks: AnthropicContentBlock[];
  inputTokens: number;
  outputTokens: number;
  /** The final stop_reason off message_delta's delta, once seen. */
  stopReason?: string;
  /** A door-side `error` event — recorded here, thrown by parseAnthropicSSE. */
  error?: { type: string; message: string };
}

/** Door error types worth another attempt; everything else fails fast. */
const RETRYABLE_SSE_ERRORS = new Set(['overloaded_error', 'rate_limit_error', 'api_error']);

/**
 * Folds one SSE `data:` payload into the accumulator. Events per the
 * Messages-Stream spec: message_start (input usage), content_block_start
 * (block typed), content_block_delta (text_delta / input_json_delta),
 * message_delta (output usage + stop_reason), message_stop — and `error`,
 * which is never noise: it is thrown to the transport's retry policy as a
 * typed model/http-error. Remaining unknown types are ignored so a door-side
 * `ping` or a future event kind degrades to noise, not a crash.
 */
const foldEvent = (acc: StreamFold, event: Record<string, unknown>): void => {
  const type = event['type'];
  if (type === 'message_start') {
    const msg = event['message'] as AnthropicResponseBody | undefined;
    acc.inputTokens = typeof msg?.usage?.input_tokens === 'number' ? msg.usage.input_tokens : acc.inputTokens;
  } else if (type === 'content_block_start') {
    const idx = typeof event['index'] === 'number' ? event['index'] : acc.blocks.length;
    const block = (event['content_block'] ?? {}) as AnthropicContentBlock;
    acc.blocks[idx] = { ...block };
  } else if (type === 'content_block_delta') {
    const idx = typeof event['index'] === 'number' ? event['index'] : acc.blocks.length - 1;
    const delta = (event['delta'] ?? {}) as { type?: string; text?: string; partial_json?: string };
    const block = acc.blocks[idx] ?? { type: 'text' };
    if (delta.type === 'text_delta' && typeof delta.text === 'string') {
      block.text = (block.text ?? '') + delta.text;
    } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
      block.input = `${typeof block.input === 'string' ? block.input : ''}${delta.partial_json}`;
    }
    acc.blocks[idx] = block;
  } else if (type === 'message_delta') {
    // z.ai carries BOTH counts here (message_start's usage is often empty on
    // this door) — dropping input_tokens logged every streamed call at 0.
    const usage = (event['usage'] ?? {}) as { input_tokens?: number; output_tokens?: number };
    if (typeof usage.input_tokens === 'number') acc.inputTokens = usage.input_tokens;
    if (typeof usage.output_tokens === 'number') acc.outputTokens = usage.output_tokens;
    const delta = (event['delta'] ?? {}) as { stop_reason?: unknown };
    if (typeof delta.stop_reason === 'string') acc.stopReason = delta.stop_reason;
  } else if (type === 'error') {
    // The door pushed an error event mid-stream and closed. Typed failure, not
    // empty content: the retry ladder above decides by the error type.
    const err = (event['error'] ?? {}) as { type?: unknown; message?: unknown };
    const errType = typeof err.type === 'string' ? err.type : 'unknown_error';
    const errMsg = typeof err.message === 'string' ? err.message : 'no message';
    acc.error = { type: errType, message: errMsg };
  }
};

/**
 * Raw SSE text → the same AnthropicResponseBody a non-streaming 200 gives, so
 * the transport can hand BOTH through one parser (parseAnthropicResponse).
 * `data:` lines carry JSON; the [DONE] sentinel and every non-JSON line are
 * ignored. Tool_use `input` arrives as an accumulated partial-JSON string and
 * is decoded here — a torn stream yields NO tool_use block rather than one
 * with garbage args (the ladder then reports the missing emit, honestly).
 */
export const parseAnthropicSSE = (sse: string): AnthropicResponseBody => {
  const acc: StreamFold = { blocks: [], inputTokens: 0, outputTokens: 0 };
  for (const line of sse.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice(5).trim();
    if (payload === '' || payload === '[DONE]') continue;
    let event: unknown;
    try {
      event = JSON.parse(payload);
    } catch {
      continue; // a torn or foreign line degrades to noise
    }
    if (typeof event === 'object' && event !== null) foldEvent(acc, event as Record<string, unknown>);
  }
  if (acc.error !== undefined) {
    // Thrown INSIDE sendOnce, so the transport's retry policy sees it: an
    // overloaded door is retried, the caller's own malformed request is not.
    throw modelError('model/http-error', `sse error event: ${acc.error.type}: ${acc.error.message}`, {
      cause: { sseError: { type: acc.error.type, message: acc.error.message } },
      retryable: RETRYABLE_SSE_ERRORS.has(acc.error.type),
    });
  }
  const blocks = acc.blocks.flatMap((b) => {
    if (b.type === 'tool_use' && typeof b.input === 'string') {
      try {
        return [{ ...b, input: JSON.parse(b.input) as unknown }];
      } catch {
        return [];
      }
    }
    return [b];
  });
  return {
    content: blocks,
    usage: { input_tokens: acc.inputTokens, output_tokens: acc.outputTokens },
    ...(acc.stopReason !== undefined ? { stop_reason: acc.stopReason } : {}),
  };
};

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
import type { ChatMsg, ToolCall } from './types.js';
import type { BuildBodyInput, ParsedResponse } from './wire.js';
import { schemaJsonForPrompt, schemaToJsonSchema } from './wire.js';

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
  tool_choice?: { type: 'tool'; name: string };
  stream?: boolean;
}

export interface AnthropicResponseBody {
  content?: AnthropicContentBlock[];
  usage?: { input_tokens?: number; output_tokens?: number };
  stop_reason?: string;
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
  const { req, model, rung } = input;
  const systemParts = req.messages.filter((m) => m.role === 'system').map((m) => m.content);
  const schema = req.schema;
  const wireTools: AnthropicToolDef[] | undefined =
    req.tools !== undefined && req.tools.length > 0
      ? req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }))
      : undefined;

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
  }

  return {
    model,
    max_tokens: req.maxTokens,
    temperature: req.temperature,
    ...(systemParts.length > 0 ? { system: systemParts.join('\n\n') } : {}),
    messages: toAnthropicMessages(req.messages),
    ...(tools !== undefined ? { tools } : {}),
    ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
  };
};

// ---------------------------------------------------------------------------
// Inbound parsing
// ---------------------------------------------------------------------------

/** Content blocks + usage → the same ParsedResponse the OpenAI path yields. */
export const parsedFromBlocks = (
  blocks: readonly AnthropicContentBlock[],
  usage: { input_tokens?: number; output_tokens?: number },
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
  };
};

/** 200-body → domain result. Throws model/bad-json for protocol violations. */
export const parseAnthropicResponse = (raw: unknown): ParsedResponse => {
  if (typeof raw !== 'object' || raw === null) {
    throw modelError('model/bad-json', 'response body is not a JSON object');
  }
  const body = raw as AnthropicResponseBody;
  if (!Array.isArray(body.content)) {
    throw modelError('model/bad-json', 'response has no content blocks');
  }
  return parsedFromBlocks(body.content, body.usage ?? {});
};

// ---------------------------------------------------------------------------
// SSE parsing
// ---------------------------------------------------------------------------

interface StreamFold {
  blocks: AnthropicContentBlock[];
  inputTokens: number;
  outputTokens: number;
}

/**
 * Folds one SSE `data:` payload into the accumulator. Events per the
 * Messages-Stream spec: message_start (input usage), content_block_start
 * (block typed), content_block_delta (text_delta / input_json_delta),
 * message_delta (output usage), message_stop. Unknown types are ignored so a
 * door-side `ping` or a future event kind degrades to noise, not a crash.
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
    const delta = (event['usage'] ?? {}) as { input_tokens?: number; output_tokens?: number };
    if (typeof delta.input_tokens === 'number') acc.inputTokens = delta.input_tokens;
    if (typeof delta.output_tokens === 'number') acc.outputTokens = delta.output_tokens;
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
  };
};

// M03 model — the shared client: per-call routing, the structured-output ladder
// with its one-shot repair, token accounting, and exactly one `model.call` event
// per logical chat (retries and the repair fold into usage.attempts).
//
// The layer is transport-agnostic on purpose: ZaiClient and MockModel are both
// just `createModelClient` over a different Transport, which is what lets the
// real parsing layer and the test double pass one conformance suite.

import type { ZodType } from 'zod';
import type { Clock } from '../kernel/index.js';
import type { EventLog } from '../events/index.js';
import { isModelError, modelError } from './errors.js';
import {
  EMIT_TOOL_NAME,
  looseJsonParse,
  structuredRepairMessages,
  toolArgsRepairMessages,
} from './json.js';
import type { Transport } from './transport.js';
import { TIER_TABLE } from './tiers.js';
import { buildAnthropicBody, parseAnthropicResponse } from './anthropic.js';
import {
  buildWireBody,
  parseWireResponse,
  schemaJsonForPrompt,
  schemaName,
  schemaToJsonSchema,
  type MalformedToolCall,
  type RequestRung,
  type WireBody,
} from './wire.js';
import type {
  ChatContext,
  ChatRequest,
  ChatResponse,
  EndpointCapabilities,
  ModelCallEvent,
  ModelClient,
  ModelRouter,
  ParseFailedEvent,
  ParseRung,
  StopReason,
  ToolCall,
  Tier,
  Usage,
} from './types.js';

// ---------------------------------------------------------------------------
// Core: one wire request = one routing decision = one parsed response
// ---------------------------------------------------------------------------

export interface CoreOutcome {
  content: string;
  toolCalls: ToolCall[];
  malformedToolCalls: MalformedToolCall[];
  inputTokens: number;
  outputTokens: number;
  attempts: number;
  model: string;
  tier: Tier;
  /** Wire stop reason, when the door reported one (Phase 1: truncation is loud). */
  stopReason?: StopReason;
}

// `any` here is deliberate: the core only shapes/forwards the request — it never
// touches the parsed `schema` output type, and a specific T above must flow through.
export type CoreChat = (
  req: ChatRequest<any>,
  ctx: ChatContext | undefined,
  rung: RequestRung | 'auto',
) => Promise<CoreOutcome>;

export interface CoreDeps {
  router: ModelRouter;
  send: Transport;
  capabilities?: EndpointCapabilities;
  /** Wire protocol; default openai. Anthropic swaps the body builder + parser. */
  protocol?: 'openai' | 'anthropic';
}

export const chatCore =
  (deps: CoreDeps): CoreChat =>
  async (req, ctx, rung) => {
    const routed = deps.router.resolve(req.taskClass, req.tier);
    if (deps.protocol === 'anthropic') {
      const body = buildAnthropicBody({ req, model: routed.model, rung, seedSupported: false });
      const sent = await deps.send({ body: body as unknown as WireBody, signal: ctx?.signal });
      const parsed = parseAnthropicResponse(sent.response as unknown);
      // The starvation family: thinking drew the whole budget and NOTHING
      // visible came back. That is never an empty decision — it is a typed,
      // non-retryable failure naming the budget (a max_tokens cut WITH content
      // or a tool call is just a cut-off reply and passes).
      if (parsed.stopReason === 'max_tokens' && parsed.content === '' && parsed.toolCalls.length === 0) {
        throw modelError(
          'model/truncated',
          `stop_reason max_tokens with no visible content — the ${req.maxTokens}-token budget was consumed by thinking or a torn stream; raise maxTokens`,
          { retryable: false },
        );
      }
      return {
        model: routed.model,
        tier: routed.tier,
        attempts: sent.attempts,
        ...parsed,
      };
    }
    const body = buildWireBody({ req, model: routed.model, rung, seedSupported: deps.capabilities?.seed === true });
    const sent = await deps.send({ body, signal: ctx?.signal });
    return { model: routed.model, tier: routed.tier, attempts: sent.attempts, ...parseWireResponse(sent.response) };
  };

// ---------------------------------------------------------------------------
// Ladder
// ---------------------------------------------------------------------------

export interface ModelClientDeps {
  /** The wire-level core (chatCore over a Transport, or a test double's core). */
  core: CoreChat;
  log: EventLog;
  clock: Clock;
  /** Endpoint capability flags for the ladder's rung selection (the core has its own copy for `seed`). */
  capabilities?: EndpointCapabilities;
}

export const createModelClient = (deps: ModelClientDeps): ModelClient => {
  const core = deps.core;
  const caps: EndpointCapabilities = deps.capabilities ?? {};

  const emitParseFailed = async (
    req: ChatRequest,
    ctx: ChatContext | undefined,
    rung: ParseRung,
    error: string,
  ): Promise<void> => {
    const payload: ParseFailedEvent = { schema: schemaName(req), rung, error };
    try {
      await deps.log.emit('model.parse_failed', payload, ctx?.turnId);
    } catch {
      // Same policy as model.call: a broken L0 is reported by M02, never fatal here.
    }
  };

  const chat = async <T>(req: ChatRequest<T>, ctx?: ChatContext): Promise<ChatResponse<T>> => {
    const startedAt = deps.clock.epochMs();
    const acc = { inputTokens: 0, outputTokens: 0, attempts: 0 };
    let model = TIER_TABLE[req.tier];
    let tier: Tier = req.tier;
    const note = (r: CoreOutcome): void => {
      acc.inputTokens += r.inputTokens;
      acc.outputTokens += r.outputTokens;
      acc.attempts += r.attempts;
      model = r.model;
      tier = r.tier;
    };
    const usage = (): Usage => ({
      inputTokens: acc.inputTokens,
      outputTokens: acc.outputTokens,
      latencyMs: deps.clock.epochMs() - startedAt,
      attempts: acc.attempts,
    });

    const emitCall = async (outcome: ModelCallEvent['outcome']): Promise<void> => {
      const payload: ModelCallEvent = { taskClass: req.taskClass, tier, model, usage: usage(), outcome };
      try {
        await deps.log.emit('model.call', payload, ctx?.turnId);
      } catch {
        // L0 unwritable ⇒ advisory (M20's policy): M02 retried once and reported to
        // stderr; a broken log must not destroy a completed model call.
      }
    };

    try {
      const result =
        req.schema === undefined
          ? await plain(req, ctx, core, note, emitParseFailed)
          : await structured<T>(req, req.schema, ctx, core, note, emitParseFailed, caps);
      await emitCall('ok');
      return {
        content: result.content,
        ...(result.toolCalls !== undefined ? { toolCalls: result.toolCalls } : {}),
        ...(result.stopReason !== undefined ? { stopReason: result.stopReason } : {}),
        usage: usage(),
        model,
      };
    } catch (e) {
      await emitCall(outcomeOf(e));
      throw e;
    }
  };

  return { chat };
};

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

type ChatResult<T> = { content: T; toolCalls?: ToolCall[]; stopReason?: StopReason };
type Note = (r: CoreOutcome) => void;
type EmitParseFailed = (
  req: ChatRequest<any>,
  ctx: ChatContext | undefined,
  rung: ParseRung,
  error: string,
) => Promise<void>;

const plain = async <T>(
  req: ChatRequest<T>,
  ctx: ChatContext | undefined,
  core: CoreChat,
  note: Note,
  emitParseFailed: EmitParseFailed,
): Promise<ChatResult<T>> => {
  const r = await core(req, ctx, 'auto');
  note(r);
  const toolCalls = await finishToolCalls(r.toolCalls, r, req, ctx, core, note, emitParseFailed);
  return {
    content: r.content as T,
    ...(r.stopReason !== undefined ? { stopReason: r.stopReason } : {}),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
  };
};

/**
 * Structured output. Rung selection per spec:
 *  (a) native response_format json_schema when the capability flag says supported;
 *  (b) a single forced `emit` tool — only when (a) is unsupported AND no tools are set;
 *  (c) prompted JSON + zod parse.
 * `schema` + `tools` together ⇒ (b) is skipped. Any parse failure gets exactly
 * one cheap-tier repair; a second failure is a typed error + model.parse_failed.
 */
const structured = async <T>(
  req: ChatRequest<T>,
  schema: ZodType<T>,
  ctx: ChatContext | undefined,
  core: CoreChat,
  note: Note,
  emitParseFailed: EmitParseFailed,
  caps: EndpointCapabilities,
): Promise<ChatResult<T>> => {
  const rung = pickRung(req, caps);
  const first = await core(req, ctx, rung);
  note(first);

  // Rung (b): the synthetic `emit` call is the channel for the payload, not a tool.
  const emitIndex = rung === 'tool_call' ? first.toolCalls.findIndex((c) => c.name === EMIT_TOOL_NAME) : -1;
  const visibleCalls = emitIndex >= 0 ? first.toolCalls.filter((_, i) => i !== emitIndex) : first.toolCalls;

  const parseFirst = (): { ok: true; value: T } | { ok: false; error: string } => {
    if (rung === 'tool_call') {
      if (emitIndex < 0) return { ok: false, error: 'model did not call the emit tool' };
      return runZod(schema, first.toolCalls[emitIndex]!.args);
    }
    const parsed = looseJsonParse(first.content);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    return runZod(schema, parsed.value);
  };
  const firstParsed = parseFirst();
  const content = firstParsed.ok
    ? firstParsed.value
    : await repairStructured<T>(req, schema, ctx, core, note, emitParseFailed, rung, first.content, firstParsed.error);

  // Malformed tool-call arguments: ONE cheap repair, independent of the content path.
  const toolCalls = await finishToolCalls(visibleCalls, first, req, ctx, core, note, emitParseFailed);

  return {
    content,
    ...(first.stopReason !== undefined ? { stopReason: first.stopReason } : {}),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
  };
};

/**
 * Malformed tool-call arguments get ONE cheap repair, keyed by call id, on every
 * content path — silently dropping a tool call the model asked for is not an
 * option downstream (M13 would act on nothing with no trace). `base` is the
 * visible call list (the synthetic emit already stripped out on rung (b)).
 */
const finishToolCalls = async (
  base: readonly ToolCall[],
  first: CoreOutcome,
  req: ChatRequest<any>,
  ctx: ChatContext | undefined,
  core: CoreChat,
  note: Note,
  emitParseFailed: EmitParseFailed,
): Promise<ToolCall[]> => {
  if (first.malformedToolCalls.length === 0) return [...base];
  const repaired = await repairToolArgs(req, ctx, core, note, emitParseFailed, first.malformedToolCalls);
  return mergeRepaired(base, repaired);
};

const repairStructured = async <T>(
  req: ChatRequest<T>,
  schema: ZodType<T>,
  ctx: ChatContext | undefined,
  core: CoreChat,
  note: Note,
  emitParseFailed: EmitParseFailed,
  rung: RequestRung,
  malformed: string,
  error: string,
): Promise<T> => {
  const repairReq: ChatRequest<T> = {
    taskClass: req.taskClass,
    tier: 'cheap',
    messages: structuredRepairMessages({
      original: req.messages,
      malformed,
      schemaJson: schemaJsonForPrompt(schema),
      error,
    }),
    maxTokens: req.maxTokens,
    temperature: req.temperature,
    schema,
    ...(req.schemaName !== undefined ? { schemaName: req.schemaName } : {}),
    // The repair re-ask is part of the SAME logical generation: reproducibility
    // (same store + seed ⇒ same bytes) requires the seed to ride along, or every
    // repaired draft would come from an unseeded call.
    ...(req.seedHint !== undefined ? { seedHint: req.seedHint } : {}),
  };
  const second = await core(repairReq, ctx, 'prompted_json');
  note(second);
  const retry = looseJsonParse(second.content);
  const zod = retry.ok ? runZod(schema, retry.value) : { ok: false as const, error: retry.error };
  if (zod.ok) return zod.value;
  const detail = `rung ${rung} output unparseable and the repair attempt failed too: ${zod.error}`;
  await emitParseFailed(req, ctx, 'repair', detail);
  throw modelError('model/parse-failed', detail);
};

const repairToolArgs = async (
  req: ChatRequest<any>,
  ctx: ChatContext | undefined,
  core: CoreChat,
  note: Note,
  emitParseFailed: EmitParseFailed,
  malformed: readonly MalformedToolCall[],
): Promise<ToolCall[]> => {
  const error = malformed.map((m) => `${m.id}: ${m.error}`).join('; ');
  const repairReq: ChatRequest = {
    taskClass: req.taskClass,
    tier: 'cheap',
    messages: toolArgsRepairMessages({
      original: req.messages,
      malformed: malformed.map((m) => ({ id: m.id, name: m.name, args: null })),
      rawArguments: new Map(malformed.map((m) => [m.id, m.raw])),
      error,
    }),
    maxTokens: req.maxTokens,
    temperature: req.temperature,
    // Same reproducibility rule as repairStructured: the re-ask belongs to the
    // same logical call, so the seed rides along.
    ...(req.seedHint !== undefined ? { seedHint: req.seedHint } : {}),
  };
  const second = await core(repairReq, ctx, 'prompted_json');
  note(second);
  const retry = looseJsonParse(second.content);
  if (retry.ok && typeof retry.value === 'object' && retry.value !== null && !Array.isArray(retry.value)) {
    const map = retry.value as Record<string, unknown>;
    const out: ToolCall[] = [];
    let complete = true;
    for (const m of malformed) {
      if (Object.prototype.hasOwnProperty.call(map, m.id)) out.push({ id: m.id, name: m.name, args: map[m.id] });
      else complete = false;
    }
    if (complete) return out;
  }
  const detail = retry.ok
    ? 'repair reply was not a JSON object keyed by tool-call id'
    : `repair reply unparseable: ${retry.error}`;
  const names = malformed.map((m) => m.name).join(',');
  const label = req.schema !== undefined ? schemaName(req) : `tool-args(${names})`;
  await emitParseFailed({ ...req, schemaName: req.schemaName ?? label }, ctx, 'repair', detail);
  throw modelError('model/tool-call-failed', `tool-call arguments unparseable after one repair: ${detail}`);
};

// ---------------------------------------------------------------------------
// Rung selection + small helpers
// ---------------------------------------------------------------------------

const pickRung = (req: ChatRequest<any>, caps: EndpointCapabilities): RequestRung => {
  const { schema } = req;
  if (schema === undefined) return 'prompted_json';
  const convertible = isSchemaConvertible(schema);
  if (caps.jsonSchema === true && convertible) return 'json_schema';
  if (convertible && (req.tools === undefined || req.tools.length === 0)) return 'tool_call';
  return 'prompted_json';
};

/** A schema that cannot become JSON Schema silently falls through to rung (c). */
const isSchemaConvertible = (schema: ZodType): boolean => {
  try {
    schemaToJsonSchema(schema);
    return true;
  } catch {
    return false; // unrepresentable schema ⇒ rung (c) only
  }
};

const runZod = <T>(schema: ZodType<T>, value: unknown): { ok: true; value: T } | { ok: false; error: string } => {
  const r = schema.safeParse(value);
  return r.success
    ? { ok: true, value: r.data }
    : { ok: false, error: r.error.issues.map((i) => `${i.path.map(String).join('.')}: ${i.message}`).join('; ') };
};

const mergeRepaired = (visible: readonly ToolCall[], repaired: readonly ToolCall[]): ToolCall[] => {
  const byId = new Map(repaired.map((c) => [c.id, c]));
  const merged = visible.map((c) => byId.get(c.id) ?? c);
  for (const c of repaired) if (!merged.some((m) => m.id === c.id)) merged.push(c);
  return merged;
};

const outcomeOf = (e: unknown): ModelCallEvent['outcome'] => {
  const code = isModelError(e) ? e.code : 'unknown';
  if (code === 'model/timeout') return 'timeout';
  if (code === 'model/aborted') return 'aborted';
  return 'error';
};

// M03 model — the shared client: per-call routing, the structured-output ladder
// with its one-shot repair, token accounting, and exactly one `model.call` event
// per logical chat (retries and the repair fold into usage.attempts).
//
// The layer is transport-agnostic on purpose: ZaiClient and MockModel are both
// just `createModelClient` over a different Transport, which is what lets the
// real parsing layer and the test double pass one conformance suite.

import type { ZodType } from 'zod';
import type { Clock } from '../kernel/index.js';
import { canonicalJson } from '../kernel/index.js';
import type { EventLog } from '../events/index.js';
import { isModelError, modelError } from './errors.js';
import {
  EMIT_TOOL_NAME,
  looseJsonParse,
  structuredRepairMessages,
  toolArgsRepairMessages,
} from './json.js';
import type { Transport } from './transport.js';
import { attemptsOf } from './transport.js';
import { REASONING_BY_CLASS, TIER_TABLE } from './tiers.js';
import { buildAnthropicBody, parseAnthropicResponse } from './anthropic.js';
import {
  buildWireBody,
  parseWireResponse,
  schemaJsonForPrompt,
  schemaName,
  schemaToJsonSchema,
  type MalformedToolCall,
  type ParsedResponse,
  type RequestRung,
  type WireBody,
} from './wire.js';
import type {
  ChatContext,
  ChatRequest,
  ChatResponse,
  Door,
  DoorName,
  DoorPricing,
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
import { DECIDE_TOOL } from './types.js';

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
  /** The door that served the call, when one did (DR.4's `model.call` payload). */
  door?: DoorName;
  /** The serving door's pricing, when it carries one (costUsd math at the client). */
  pricing?: DoorPricing;
  /** Wire stop reason, when the door reported one (truncation is loud, DR.5). */
  stopReason?: StopReason;
}

// `any` here is deliberate: the core only shapes/forwards the request — it never
// touches the parsed `schema` output type, and a specific T above must flow through.
export type CoreChat = (
  req: ChatRequest<any>,
  ctx: ChatContext | undefined,
  rung: RequestRung | 'auto',
) => Promise<CoreOutcome>;

/** One door's runtime: the resolved door config + the transport dialed for it. */
export interface DoorRuntime {
  door: Door;
  send: Transport;
  capabilities?: EndpointCapabilities;
}

export interface CoreDeps {
  router: ModelRouter;
  /** Legacy single-door transport (no doors configured). Ignored when the request's tier has a door runtime. */
  send?: Transport;
  /** Legacy wire protocol; default openai. Anthropic swaps the body builder + parser. */
  protocol?: 'openai' | 'anthropic';
  /** Door runtimes per tier (DR.1): main→voice, cheap→mind, reasoning→judge. */
  doors?: Partial<Record<Tier, DoorRuntime>> | undefined;
  capabilities?: EndpointCapabilities;
}

/**
 * DR.5 — the truncation guard. A generation that hit the cap is never an
 * answer: `model/truncated` (non-retryable) fires when the wire said
 * max_tokens, or the output burned the whole budget with no tool call, or a
 * schema was expected and nothing usable came back. Before this guard the
 * empty case died as model/parse-failed after a pointless repair.
 */
export const assertNotTruncated = (parsed: ParsedResponse, req: ChatRequest<any>): void => {
  const noToolCall = parsed.toolCalls.length === 0;
  const atCap =
    parsed.stopReason === 'max_tokens' || (parsed.outputTokens >= req.maxTokens && noToolCall);
  const starved = req.schema !== undefined && parsed.content === '' && noToolCall;
  if (atCap || starved) {
    throw modelError(
      'model/truncated',
      `stop_reason max_tokens or output at the ${req.maxTokens}-token cap with nothing usable — the budget was consumed by thinking or a cut-off stream; raise maxTokens`,
      { retryable: false },
    );
  }
};

/** DR.3 — a tool_choice-forcing door forces `decide` whenever it is among the offered defs (not only as the sole def). A caller's explicit toolChoice outranks the door. */
const applyDoorForcing = (req: ChatRequest<any>, door: Door | undefined): ChatRequest<any> => {
  if (door?.forcing !== 'tool_choice' || req.toolChoice !== undefined) return req;
  if (req.tools === undefined || !req.tools.some((t) => t.name === DECIDE_TOOL)) return req;
  return { ...req, toolChoice: { name: DECIDE_TOOL } };
};

export const chatCore =
  (deps: CoreDeps): CoreChat =>
  async (req, ctx, rung) => {
    const routed = deps.router.resolve(req.taskClass, req.tier);
    const runtime = deps.doors?.[routed.tier];
    const send = runtime?.send ?? deps.send;
    if (send === undefined) {
      throw modelError('model/transport', `no transport configured for tier '${routed.tier}'`);
    }
    const protocol = runtime?.door.protocol ?? deps.protocol ?? 'openai';
    const door = runtime?.door;
    // The door owns its model id on the wire; the router's table stays the legacy source.
    const model = door?.model ?? routed.model;
    const seedSupported = (runtime?.capabilities ?? deps.capabilities)?.seed === true;
    const effective = applyDoorForcing(req, door);

    if (protocol === 'anthropic') {
      const body = buildAnthropicBody({
        req: effective,
        model,
        rung,
        seedSupported: false,
        ...(door !== undefined ? { door } : {}),
      });
      const sent = await send({ body: body as unknown as WireBody, signal: ctx?.signal });
      const parsed = parseAnthropicResponse(sent.response as unknown);
      assertNotTruncated(parsed, effective);
      return {
        model,
        tier: routed.tier,
        attempts: sent.attempts,
        ...(door !== undefined ? { door: door.name, ...(door.pricing !== undefined ? { pricing: door.pricing } : {}) } : {}),
        ...parsed,
      };
    }
    const body = buildWireBody({ req: effective, model, rung, seedSupported, ...(door !== undefined ? { door } : {}) });
    const sent = await send({ body, signal: ctx?.signal });
    const parsed = parseWireResponse(sent.response);
    assertNotTruncated(parsed, effective);
    return {
      model,
      tier: routed.tier,
      attempts: sent.attempts,
      ...(door !== undefined ? { door: door.name, ...(door.pricing !== undefined ? { pricing: door.pricing } : {}) } : {}),
      ...parsed,
    };
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
    let door: DoorName | undefined;
    let pricing: DoorPricing | undefined;
    let stopReason: StopReason | undefined;
    const note = (r: CoreOutcome): void => {
      acc.inputTokens += r.inputTokens;
      acc.outputTokens += r.outputTokens;
      acc.attempts += r.attempts;
      model = r.model;
      tier = r.tier;
      if (r.door !== undefined) door = r.door;
      if (r.pricing !== undefined) pricing = r.pricing;
      // First (non-repair) generation wins — same rule ChatResponse.stopReason follows.
      if (r.stopReason !== undefined && stopReason === undefined) stopReason = r.stopReason;
    };
    // DR.2: the class default applies whenever the caller carried no override;
    // every task class has an entry, so the control always rides.
    const reasoning = req.reasoning ?? REASONING_BY_CLASS[req.taskClass];
    const effReq: ChatRequest<T> =
      req.reasoning === undefined ? { ...req, reasoning } : req;
    const usage = (failedAttempts = 0): Usage => ({
      inputTokens: acc.inputTokens,
      outputTokens: acc.outputTokens,
      latencyMs: deps.clock.epochMs() - startedAt,
      // DR.4: the attempts a FAILED send made are credited too (transport
      // attaches them to the thrown ModelError) — a failure never reads as free.
      attempts: acc.attempts + failedAttempts,
    });
    // DR.4: priced doors only — in·inputPerM/1e6 + out·outputPerM/1e6.
    const costUsd = (): number | undefined => {
      if (pricing === undefined) return undefined;
      return (acc.inputTokens * pricing.inputPerM + acc.outputTokens * pricing.outputPerM) / 1e6;
    };

    const emitCall = async (outcome: ModelCallEvent['outcome'], failedAttempts = 0): Promise<void> => {
      const cost = costUsd();
      const payload: ModelCallEvent = {
        taskClass: req.taskClass,
        tier,
        model,
        usage: usage(failedAttempts),
        outcome,
        maxTokens: req.maxTokens,
        ...(door !== undefined ? { door } : {}),
        ...(reasoning !== undefined ? { reasoning } : {}),
        ...(stopReason !== undefined ? { stopReason } : {}),
        ...(cost !== undefined ? { costUsd: cost } : {}),
      };
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
          ? await plain(effReq, ctx, core, note, emitParseFailed)
          : await structured<T>(effReq, req.schema, ctx, core, note, emitParseFailed, caps);
      await emitCall('ok');
      return {
        content: result.content,
        ...(result.toolCalls !== undefined ? { toolCalls: result.toolCalls } : {}),
        ...(result.stopReason !== undefined ? { stopReason: result.stopReason } : {}),
        usage: usage(),
        model,
      };
    } catch (e) {
      await emitCall(outcomeOf(e), attemptsOf(e) ?? 0);
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
 * DR.7 — per-call input contract: `decide.bubbles` is coerced (models emit it
 * as one string or newline-joined text; it must be a clean string array), and
 * when the request carries a zod validator for the tool, the args are
 * zod-parsed against it. Validation failures join the one-shot repair rung as
 * malformed calls — never silently dropped, never hand-parsed prose.
 */
export const prepareToolCall = (
  call: ToolCall,
  req: ChatRequest<any>,
): { ok: true; call: ToolCall } | { ok: false; bad: MalformedToolCall } => {
  const coerced = coerceDecideBubbles(call);
  const schema = req.toolInput?.[coerced.name];
  if (schema === undefined) return { ok: true, call: coerced };
  const r = runZod(schema, coerced.args);
  if (r.ok) return { ok: true, call: coerced };
  return { ok: false, bad: { id: coerced.id, name: coerced.name, raw: canonicalJson(coerced.args), error: r.error } };
};

/** `decide.bubbles`: a bare string becomes its (newline-split) bubble list; blank segments never survive. */
export const coerceDecideBubbles = (call: ToolCall): ToolCall => {
  if (call.name !== DECIDE_TOOL) return call;
  const args = call.args;
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return call;
  const bubbles = (args as { bubbles?: unknown }).bubbles;
  if (typeof bubbles !== 'string') return call;
  const split = bubbles
    .split('\n')
    .map((b) => b.trim())
    .filter((b) => b !== '');
  return { ...call, args: { ...(args as Record<string, unknown>), bubbles: split } };
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

  // Malformed tool-call arguments and validator-failing inputs: ONE cheap
  // repair, independent of the content path.
  const toolCalls = await finishToolCalls(visibleCalls, first, req, ctx, core, note, emitParseFailed);

  return {
    content,
    ...(first.stopReason !== undefined ? { stopReason: first.stopReason } : {}),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
  };
};

/**
 * Malformed tool-call arguments (wire-level JSON) and validator-failing inputs
 * (DR.7) get ONE cheap repair, keyed by call id, on every content path —
 * silently dropping a tool call the model asked for is not an option
 * downstream (M13 would act on nothing with no trace). `base` is the visible
 * call list (the synthetic emit already stripped out on rung (b)).
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
  const ok: ToolCall[] = [];
  const invalid: MalformedToolCall[] = [];
  for (const call of base) {
    const prepared = prepareToolCall(call, req);
    if (prepared.ok) ok.push(prepared.call);
    else invalid.push(prepared.bad);
  }
  const toRepair = [...first.malformedToolCalls, ...invalid];
  if (toRepair.length === 0) return ok;
  const repaired = await repairToolArgs(req, ctx, core, note, emitParseFailed, toRepair);
  return mergeRepaired(ok, repaired);
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
    // DR.6: the repair keeps the requesting tier — a structurally-failing
    // judge-family call never downgrades to a weaker door.
    tier: req.tier,
    messages: structuredRepairMessages({
      original: req.messages,
      malformed,
      schemaJson: schemaJsonForPrompt(schema),
      error,
    }),
    // DR.6: the repair budget is doubled — the re-ask quotes the schema and the
    // failed attempt, so it needs headroom over the original cap.
    maxTokens: req.maxTokens * 2,
    temperature: req.temperature,
    schema,
    ...(req.schemaName !== undefined ? { schemaName: req.schemaName } : {}),
    // The reasoning control rides (DR.2): the repair is the same logical call.
    ...(req.reasoning !== undefined ? { reasoning: req.reasoning } : {}),
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
    // DR.6: requesting tier + doubled budget, as repairStructured.
    tier: req.tier,
    messages: toolArgsRepairMessages({
      original: req.messages,
      malformed: malformed.map((m) => ({ id: m.id, name: m.name, args: null })),
      rawArguments: new Map(malformed.map((m) => [m.id, m.raw])),
      error,
    }),
    maxTokens: req.maxTokens * 2,
    temperature: req.temperature,
    // Repaired args are revalidated against the same request-carried validators.
    ...(req.toolInput !== undefined ? { toolInput: req.toolInput } : {}),
    ...(req.reasoning !== undefined ? { reasoning: req.reasoning } : {}),
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
      if (Object.prototype.hasOwnProperty.call(map, m.id)) {
        const prepared = prepareToolCall({ id: m.id, name: m.name, args: map[m.id] }, req);
        if (prepared.ok) out.push(prepared.call);
        else complete = false; // repaired args still fail the validator ⇒ unrepairable
      } else complete = false;
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

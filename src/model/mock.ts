// M03 model — MockModel, the hermetic ModelClient double. Same interface, same
// ladder, same parsing layer as the real client (that is the point: the
// conformance suite runs over both). FIFO scripts first, then rule responders,
// then (non-strict) an empty assistant turn — strict mode throws instead.

import { canonicalJson, type Clock, SystemClock } from '../kernel/index.js';
import type { EventEnvelope, EventLog } from '../events/index.js';
import { createModelClient, type CoreChat, type CoreOutcome } from './client.js';
import { modelError, type ModelErrorCode } from './errors.js';
import { estimateTokens } from './json.js';
import { makeRouter } from './router.js';
import {
  parseWireToolCalls,
  type WireToolCall,
} from './wire.js';
import type {
  ChatContext,
  ChatRequest,
  ChatResponse,
  EndpointCapabilities,
  ModelClient,
  ModelRouter,
  RoutingTable,
  TaskClass,
  Tier,
} from './types.js';

export interface ScriptedToolCall {
  id?: string;
  name: string;
  /** Already-decoded arguments (serialized with canonical JSON on the wire). */
  args?: unknown;
  /** Raw arguments string — script malformed JSON here to exercise the repair ladder. */
  argsJson?: string;
}

export interface ScriptedResponse {
  content?: string;
  toolCalls?: ScriptedToolCall[];
  inputTokens?: number;
  outputTokens?: number;
  /** Thrown instead of returned: script transport/model failures. */
  error?: { code: string; message: string };
  /** Resolves on the injected clock — hermetic under TestClock. */
  delayMs?: number;
}

export type Responder = (req: ChatRequest) => ScriptedResponse | Promise<ScriptedResponse>;

/** No-op log for when the mock runs without one: model.call/parse_failed emissions
 * are advisory (the client swallows L0 failures) and tests usually assert on
 * `calls`, not events. */
const silentLog: EventLog = {
  emit: async () => {},
  async *replay(): AsyncGenerator<EventEnvelope> {},
};

export interface MockModelDeps {
  clock?: Clock;
  log?: EventLog;
  routing?: RoutingTable;
  tiers?: Record<Tier, string>;
  capabilities?: EndpointCapabilities;
  /** Default false: unscripted calls return an empty assistant turn. */
  strict?: boolean;
}

export class MockModel implements ModelClient {
  /** Every request the model saw, verbatim — including ladder repair re-asks. */
  readonly calls: ChatRequest[] = [];

  private readonly queue: ScriptedResponse[] = [];
  private readonly rules: Array<{ match: TaskClass | RegExp; fn: Responder }> = [];
  private readonly clock: Clock;
  private readonly strict: boolean;
  private readonly router: ModelRouter;
  private readonly client: ModelClient;

  constructor(deps: MockModelDeps = {}) {
    this.clock = deps.clock ?? new SystemClock();
    this.strict = deps.strict ?? false;
    this.router = makeRouter({
      ...(deps.log !== undefined ? { log: deps.log } : {}),
      ...(deps.routing !== undefined ? { routing: deps.routing } : {}),
      ...(deps.tiers !== undefined ? { tiers: deps.tiers } : {}),
    });
    this.client = createModelClient({
      clock: this.clock,
      core: this.core(),
      log: deps.log ?? silentLog,
      ...(deps.capabilities !== undefined ? { capabilities: deps.capabilities } : {}),
    });
  }

  enqueue(r: ScriptedResponse): void {
    this.queue.push(r);
  }

  onTask(match: TaskClass | RegExp, fn: Responder): void {
    this.rules.push({ match, fn });
  }

  chat<T = string>(req: ChatRequest<T>, ctx?: ChatContext): Promise<ChatResponse<T>> {
    return this.client.chat<T>(req, ctx);
  }

  /** FIFO, then rule responders in registration order, then the strict-mode verdict. */
  private async nextScript(req: ChatRequest): Promise<ScriptedResponse> {
    const next = this.queue.shift();
    if (next !== undefined) return next;
    for (const rule of this.rules) {
      if (typeof rule.match === 'string') {
        if (rule.match === req.taskClass) return await rule.fn(req);
        continue;
      }
      const last = req.messages.at(-1);
      if (last !== undefined && rule.match.test(last.content)) return await rule.fn(req);
    }
    if (this.strict) {
      throw modelError(
        'model/mock-unexpected',
        `MockModel (strict): no script for taskClass '${req.taskClass}' with ${req.messages.length} message(s)`,
      );
    }
    return {};
  }

  private core(): CoreChat {
    return async (req, _ctx, _rung): Promise<CoreOutcome> => {
      this.calls.push(req);
      const routed = this.router.resolve(req.taskClass, req.tier);
      // FIFO scripts are known synchronously, so a scripted delayMs registers its
      // clock waiter BEFORE the first await — the natural test pattern
      // (`const p = m.chat(); await clock.advance(d)`) then works. Only the
      // async-responder path may register after a yield, which is fine: rule
      // scripts that use delayMs advance the clock from their own test pump.
      const script = this.queue.length > 0 ? this.queue.shift()! : await this.nextScript(req);
      if (script.delayMs !== undefined) await this.clock.waitUntil(this.clock.epochMs() + script.delayMs);
      if (script.error !== undefined) {
        // Deliberate cast: test scripts may name any code, including vendor shapes.
        throw modelError(script.error.code as ModelErrorCode, script.error.message);
      }
      const wireToolCalls: WireToolCall[] = (script.toolCalls ?? []).map((t, i) => ({
        id: t.id ?? `call_${i}`,
        type: 'function',
        function: {
          name: t.name,
          arguments: t.argsJson ?? (t.args !== undefined ? canonicalJson(t.args) : 'null'),
        },
      }));
      const parsed = parseWireToolCalls(wireToolCalls);
      const content = script.content ?? '';
      return {
        content,
        toolCalls: parsed.calls,
        malformedToolCalls: parsed.malformed,
        inputTokens: script.inputTokens ?? estimateTokens(req.messages.map((m) => `${m.role}\n${m.content}`)),
        outputTokens: script.outputTokens ?? estimateTokens([content]),
        attempts: 1,
        model: routed.model,
        tier: routed.tier,
      };
    };
  }
}

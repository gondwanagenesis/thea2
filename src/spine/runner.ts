// M21 spine — OpenCodeRunner (S1.2/S1.3/S1.4). Supervises the pinned
// `opencode serve` child on 127.0.0.1 (spawn -> health check -> restart with
// backoff -> abandon with incident.spine_failed on a wedge), owns the session
// lifecycle (our 4h break forks a fresh session), POSTs the per-turn message
// (agent 'thea', per-call door model, the assembled packet as system+parts, the
// decide contract as a json_schema format), consumes GET /event through the
// SSE bridge, and yields StreamEvents on the one SpineRunner seam.
//
// Turn-abort semantics mirror FA.1: a session.error or an idle timeout emits
// incident.spine_failed and ends the stream with stop-reason 'error' — the
// loop side locks its failure silence and the reply stays owed. The loop-side
// half of that contract lands with P-LOOP, not here.
//
// The spawn seam is injectable: tests drive a local node:http stub speaking
// the documented v1.18.x shape from recorded fixtures — never the real binary.

import { spawn as nodeSpawn } from 'node:child_process';
import type { ZodType } from 'zod';
import type { ToolCall, ToolDef } from '../model/index.js';
import { coerceDecideBubbles, looseJsonParse } from '../model/index.js';
import type { ModelCallEvent, TaskClass } from '../model/index.js';
import { DECISION_PARSE_INCIDENT, OUTPUT_CONTRACT, DECIDE_TOOL_NAME } from '../loop/index.js';
import { parseDecisionValue, type DecisionParse } from '../loop/loop.js';
import type { InhibitionPlacement, LoopEntry, LoopPacket } from '../loop/index.js';
import type { Clock } from '../kernel/index.js';
import type { EventLog } from '../events/index.js';
import { spineServeCommand, type ResolvedSpineConfig } from './config.js';
import { SseTurnBridge, parseSse, emitModelCall } from './events.js';
import { SpineSessions, conversationIdFor } from './session.js';
import { SpineError, type ModelRef, type SpawnFn, type SpinePart, type SpineRunOpts, type SpineTurnRequest, type SpineUsage, type StreamEvent } from './types.js';

/** The decide repair instruction — the loop's one-shot repair wording, adapted to one POST. */
const repairInstruction = (malformed: string, schemaJson: string, error: string): string =>
  'Your previous reply could not be parsed against the required schema.\n\n' +
  `Parse error:\n${error}\n\n` +
  `Required JSON Schema (draft 2020-12):\n${schemaJson}\n\n` +
  `Your previous reply was:\n${malformed}\n\n` +
  'Reply with ONLY the corrected JSON object. No prose, no markdown fences.';

export interface TurnRequestInput {
  entry: LoopEntry;
  packet: LoopPacket;
  tools: readonly ToolDef[];
  model: ModelRef;
  turnText: string;
  placement: InhibitionPlacement;
  decide?: { schema: unknown } | undefined;
}

/**
 * The packet injection path (S1.4). Byte-stable with the loop's message layout
 * (src/loop/messages.ts): head = packet.systemText() with [PROCEDURAL]
 * appended, the [OUTPUT] contract beside the decide tool; the [INHIBITION]
 * trailer is the LAST part (trailing placement — recency wins) or folded into
 * the head (merged fallback).
 */
export const buildTurnRequest = (i: TurnRequestInput): SpineTurnRequest => {
  const head = i.packet.systemText();
  const proc = i.packet.proceduralText();
  let system = proc === null || proc === '' ? head : `${head}\n\n${proc}`;
  if (i.decide !== undefined) system = `${system}\n\n${OUTPUT_CONTRACT}`;
  const trailer = i.packet.trailerText();
  const parts: SpinePart[] = [{ type: 'text', text: i.turnText, label: 'turn' }];
  if (i.placement === 'trailing' && trailer !== '') {
    parts.push({ type: 'text', text: trailer, label: 'inhibition' });
  } else if (i.placement === 'merged' && trailer !== '') {
    system = `${system}\n\n${trailer}`;
  }
  return {
    agent: 'thea',
    model: { providerID: i.model.providerID, modelID: i.model.modelID },
    system,
    parts,
    tools: Object.fromEntries(i.tools.map((t) => [t.name, true])),
    ...(i.decide !== undefined ? { format: { type: 'json_schema' as const, schema: i.decide.schema, retryCount: 1 } } : {}),
  };
};

/**
 * S1.3 — the decide object is zod-validated on OUR side through src/loop's own
 * decision parse, after the DR.7 coercion (`decide.bubbles` as a bare string
 * becomes its newline-split bubble list). One contract, two transports.
 */
export const validateDecideObject = (raw: unknown): DecisionParse => {
  const coerced = coerceDecideBubbles({ id: DECIDE_TOOL_NAME, name: DECIDE_TOOL_NAME, args: raw });
  return parseDecisionValue(coerced.args);
};

/** DR.7 parity for tool-call StreamEvents: coerce, then optional zod validation. */
export const prepareStreamToolCall = (
  call: ToolCall,
  validators?: Readonly<Record<string, ZodType>>,
): { ok: true; call: ToolCall } | { ok: false; error: string } => {
  const coerced = coerceDecideBubbles(call);
  const schema = validators?.[coerced.name];
  if (schema === undefined) return { ok: true, call: coerced };
  const r = schema.safeParse(coerced.args);
  if (r.success) return { ok: true, call: coerced };
  return { ok: false, error: r.error.issues.map((i) => `${i.path.map(String).join('.')}: ${i.message}`).join('; ') };
};

export interface OpenCodeRunnerDeps {
  clock: Clock;
  events: EventLog;
  /** Injectable spawn seam — tests pass fakes; prod spawns the pinned binary. */
  spawnProc?: SpawnFn | undefined;
  fetchImpl?: typeof fetch | undefined;
}

interface TurnCarry {
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
}

interface TurnState {
  attempts: number;
  repairsLeft: number;
  logicalStartMs: number;
  carried: TurnCarry;
  repair?: { malformed: string; error: string } | undefined;
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * The live runner. State machine: stopped -> booting -> ready -> (booting |
 * abandoned). A crash triggers spine.restart + a backoff respawn; exhausting
 * the boot attempts abandons the child with incident.spine_failed — the
 * process keeps running, every later turn refuses loudly (G3: no orphans, no
 * silent wedges).
 */
export class OpenCodeRunner {
  state: 'stopped' | 'booting' | 'ready' | 'abandoned' = 'stopped';

  private readonly cfg: ResolvedSpineConfig;
  private readonly deps: OpenCodeRunnerDeps;
  private readonly fetchImpl: typeof fetch;
  private readonly spawnProc: SpawnFn;
  private readonly sessions: SpineSessions;

  private child: ReturnType<SpawnFn> | undefined;
  private bootAttempt = 0;
  private boots = 0;
  private bootPromise: Promise<void> | undefined;

  constructor(cfg: ResolvedSpineConfig, deps: OpenCodeRunnerDeps) {
    this.cfg = cfg;
    this.deps = deps;
    this.fetchImpl = deps.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
    this.spawnProc =
      deps.spawnProc ??
      ((cmd, args, opts) => {
        const child = nodeSpawn(cmd, args, { env: { ...process.env, ...opts.env }, stdio: ['ignore', 'pipe', 'pipe'] });
        return {
          pid: child.pid,
          kill: (signal?: string) => child.kill(signal as NodeJS.Signals | undefined),
          onExit: (cb) =>
            child.once('exit', (code, signal) => {
              cb(code, signal);
            }),
        };
      });
    this.sessions = new SpineSessions(cfg.sessionBreakMs);
  }

  private get base(): string {
    return `http://${this.cfg.host}:${this.cfg.port}`;
  }

  /** Reads the supervisor phase un-narrowed: the exit handler and the turn
   * pump mutate it from other async flows, so control-flow narrowing lies. */
  private phase(): 'stopped' | 'booting' | 'ready' | 'abandoned' {
    return this.state;
  }

  private headers(): Record<string, string> {
    return { 'content-type': 'application/json', authorization: `Bearer ${this.cfg.authToken}` };
  }

  private emit(kind: string, payload: unknown, turnId?: string): Promise<void> {
    return this.deps.events.emit(kind, payload, turnId).catch(() => {
      // advisory — M02 has already retried once and reported to stderr
    });
  }

  private modelFor(taskClass: TaskClass | undefined): ModelRef {
    if (taskClass !== undefined) {
      const ref = this.cfg.byClass[taskClass];
      if (ref !== undefined) return ref;
    }
    return this.cfg.model;
  }

  /** Boot: spawn the pinned child and health-check it (GET /app). */
  async start(): Promise<void> {
    if (this.state === 'ready') return;
    if (this.bootPromise !== undefined) return this.bootPromise;
    this.bootPromise = this.supervise().finally(() => {
      this.bootPromise = undefined;
    });
    await this.bootPromise;
  }

  async stop(): Promise<void> {
    if (this.state === 'stopped') {
      this.cutChild();
      return;
    }
    this.state = 'stopped';
    this.cutChild();
  }

  private cutChild(): void {
    const child = this.child;
    this.child = undefined;
    if (child !== undefined) child.kill();
  }

  private spawnChild(): void {
    const { cmd, args, env } = spineServeCommand(this.cfg);
    const child = this.spawnProc(cmd, args, { env });
    this.child = child;
    child.onExit((code, signal) => {
      if (this.child !== child) return; // a stale or replaced child
      const current = this.phase();
      if (current !== 'ready' && current !== 'booting') return;
      // the seam is DOWN the moment the child dies — the next phase transition
      // (backoff -> spawn -> health) happens under 'booting', never silently ready.
      this.state = 'booting';
      this.child = undefined;
      this.bootAttempt += 1;
      if (this.bootAttempt >= this.cfg.maxBootAttempts) {
        void this.abandon('restart-cap');
        return;
      }
      void this.emit('spine.restart', { attempt: this.bootAttempt, exitCode: code, signal });
      void this.respawnAfterBackoff();
    });
  }

  private async supervise(): Promise<void> {
    this.state = 'booting';
    this.spawnChild();
    const healthy = await this.healthCheck();
    if (this.phase() === 'stopped' || this.phase() === 'abandoned') return;
    if (healthy) {
      this.bootAttempt = 0;
      this.state = 'ready';
      this.boots += 1;
      await this.emit('spine.boot', {
        version: this.cfg.version,
        port: this.cfg.port,
        pid: this.child?.pid,
        attempt: this.boots,
      });
      return;
    }
    // the wedge path: the child never became healthy — cut it and retry
    this.cutChild();
    this.bootAttempt += 1;
    if (this.bootAttempt >= this.cfg.maxBootAttempts) {
      await this.abandon('boot-timeout');
      return;
    }
    await this.backoffWait(this.bootAttempt);
    if (this.phase() === 'stopped' || this.phase() === 'abandoned') return;
    await this.supervise();
  }

  private async respawnAfterBackoff(): Promise<void> {
    await this.backoffWait(this.bootAttempt);
    if (this.phase() === 'stopped' || this.phase() === 'abandoned') return;
    await this.supervise();
  }

  private backoffMs(attempt: number): number {
    return Math.min(this.cfg.restartBackoffBaseMs * 2 ** Math.max(0, attempt - 1), this.cfg.restartBackoffMaxMs);
  }

  private backoffWait(attempt: number): Promise<void> {
    return this.deps.clock.waitUntil(this.deps.clock.epochMs() + this.backoffMs(attempt));
  }

  private async healthCheck(): Promise<boolean> {
    const deadline = this.deps.clock.epochMs() + this.cfg.bootTimeoutMs;
    for (;;) {
      try {
        const res = await this.fetchImpl(`${this.base}/app`, { headers: this.headers() });
        if (res.ok) return true;
      } catch {
        // not up yet — conn refused before the child binds its port
      }
      if (this.deps.clock.epochMs() + this.cfg.healthPollMs > deadline) return false;
      await this.deps.clock.waitUntil(this.deps.clock.epochMs() + this.cfg.healthPollMs);
      if (this.phase() === 'stopped' || this.phase() === 'abandoned') return false;
    }
  }

  private async abandon(reason: 'boot-timeout' | 'restart-cap'): Promise<void> {
    this.state = 'abandoned';
    this.cutChild();
    await this.emit('incident.spine_failed', { reason, attempts: this.bootAttempt, port: this.cfg.port, version: this.cfg.version });
  }

  private assertUsable(): void {
    if (this.state === 'abandoned') {
      throw new SpineError('spine/abandoned', 'the spine child was abandoned after repeated failures — incident.spine_failed has the details');
    }
  }

  private async createSession(): Promise<string> {
    const res = await this.fetchJson('POST', '/session', {});
    if (typeof res !== 'object' || res === null || typeof (res as Record<string, unknown>)['id'] !== 'string') {
      throw new SpineError('spine/request-failed', 'POST /session did not return an id');
    }
    return (res as { id: string }).id;
  }

  private async fetchJson(method: 'POST', path: string, body: unknown): Promise<unknown> {
    const res = await this.fetchImpl(`${this.base}${path}`, { method, headers: this.headers(), body: JSON.stringify(body) });
    if (!res.ok) throw new SpineError('spine/request-failed', `${method} ${path} -> ${res.status}`);
    try {
      return await res.json();
    } catch {
      return undefined;
    }
  }

  private modelCallPayload(
    opts: SpineRunOpts,
    model: ModelRef,
    usage: SpineUsage,
    stopReason: string,
    outcome: 'ok' | 'error',
  ): ModelCallEvent {
    return {
      taskClass: opts.taskClass ?? 'turn',
      tier: 'main',
      model: `${model.providerID}/${model.modelID}`,
      usage,
      outcome,
      ...(model.door !== undefined ? { door: model.door } : {}),
      stopReason,
    };
  }

  /** The ONE seam (S1.1). */
  async *run(entry: LoopEntry, packet: LoopPacket, tools: readonly ToolDef[], opts: SpineRunOpts): AsyncGenerator<StreamEvent> {
    this.assertUsable();
    if (this.state === 'booting' && this.bootPromise !== undefined) await this.bootPromise;
    if (this.state !== 'ready') await this.start();
    this.assertUsable();
    yield* this.runTurn(entry, packet, tools, opts, {
      attempts: 1,
      repairsLeft: opts.decide !== undefined ? this.cfg.decideRepairs : 0,
      logicalStartMs: this.deps.clock.epochMs(),
      carried: { inputTokens: 0, outputTokens: 0 },
    });
  }

  private async *runTurn(
    entry: LoopEntry,
    packet: LoopPacket,
    tools: readonly ToolDef[],
    opts: SpineRunOpts,
    state: TurnState,
  ): AsyncGenerator<StreamEvent> {
    const model = this.modelFor(opts.taskClass);
    const turnText = entry.inbound?.text ?? entry.goal ?? '';
    const ensured = await this.sessions.ensure(conversationIdFor(entry), this.deps.clock.epochMs(), () => this.createSession());
    const session = ensured.session;

    const request = buildTurnRequest({
      entry,
      packet,
      tools,
      model,
      turnText,
      placement: this.cfg.inhibitionPlacement,
      decide: opts.decide,
    });
    if (state.repair !== undefined && opts.decide !== undefined) {
      request.parts.push({
        type: 'text',
        text: repairInstruction(state.repair.malformed, JSON.stringify(opts.decide.schema), state.repair.error),
        label: 'repair',
      });
    }

    const bridge = new SseTurnBridge({
      decide: opts.decide !== undefined,
      turnStartMs: this.deps.clock.epochMs(),
      nowMs: () => this.deps.clock.epochMs(),
    });

    // the turn pump: one SSE connection per turn, opened BEFORE the POST so no
    // part is missed; events flow through a queue the generator drains, raced
    // against the idle watchdog (session.error / silence => FA.1 abort).
    const queue = new EventQueue<StreamEvent>();
    const turnAbort = new AbortController();
    const watchdog: Promise<'timeout' | 'aborted'> = this.deps.clock
      .waitUntil(this.deps.clock.epochMs() + this.cfg.turnIdleTimeoutMs, opts.signal)
      .then(
        () => 'timeout' as const,
        () => 'aborted' as const,
      );
    void watchdog.catch(() => {});

    void (async () => {
      try {
        const sseRes = await this.fetchImpl(`${this.base}/event`, { headers: this.headers(), signal: turnAbort.signal });
        if (!sseRes.ok || sseRes.body === null) {
          throw new SpineError('spine/request-failed', `GET /event -> ${sseRes.status}`);
        }
        const postPromise = this.fetchImpl(`${this.base}/session/${session.id}/message`, {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify(request),
          signal: turnAbort.signal,
        });
        let turnEnded = false;
        // fetch does NOT reject on HTTP errors — a non-2xx POST is a failed turn
        void postPromise.then(
          (res) => {
            if (!turnEnded && !res.ok) {
              queue.fail(new SpineError('spine/request-failed', `POST message -> ${res.status}`));
            }
          },
          (e: unknown) => {
            if (!turnEnded) queue.fail(e instanceof SpineError ? e : new SpineError('spine/request-failed', `POST message -> ${errText(e)}`));
          },
        );
        for await (const frame of parseSse(sseRes.body)) {
          const r = bridge.feed(frame);
          for (const ev of r.events) {
            if (ev.type === 'tool-call' && opts.toolInput !== undefined) {
              // DR.7 parity: coerce + validate before the loop ever sees the call
              const prepared = prepareStreamToolCall(ev.call, opts.toolInput);
              if (!prepared.ok) {
                void this.emit('model.parse_failed', { schema: 'tool-input', rung: 'tool_call', error: prepared.error }, opts.turnId);
                continue;
              }
              queue.push({ type: 'tool-call', call: prepared.call });
              continue;
            }
            queue.push(ev);
          }
          if (r.completed !== undefined) {
            void emitModelCall(
              this.deps.events,
              this.modelCallPayload(opts, model, r.completed.usage, r.completed.stopReason, 'ok'),
              opts.turnId,
            );
          }
          if (r.error !== undefined) throw new SpineError('spine/turn-failed', r.error);
          if (r.done) break;
        }
        turnEnded = true;
      } catch (e) {
        queue.fail(e);
      } finally {
        queue.end();
        turnAbort.abort();
      }
    })();

    let failure: unknown;
    try {
      for (;;) {
        const nextP = queue.next();
        nextP.catch(() => {}); // handled: the race may already have been won by the watchdog
        const raced = await Promise.race([nextP, watchdog]);
        if (raced === 'timeout') {
          failure = new SpineError('spine/idle-timeout', `no spine event for ${this.cfg.turnIdleTimeoutMs}ms — the turn was abandoned`);
          break;
        }
        if (raced === 'aborted') {
          yield { type: 'stop-reason', stopReason: 'aborted' };
          return;
        }
        if (raced.done) break;
        yield raced.value;
      }
    } catch (e) {
      failure = e;
    } finally {
      turnAbort.abort();
    }

    if (failure !== undefined) {
      // FA.1 mirror: loud incident, the turn ends, the reply stays owed.
      await this.emit(
        'incident.spine_failed',
        { turnId: opts.turnId, sessionId: session.id, reason: failure instanceof SpineError ? failure.code : 'turn-failed', error: errText(failure) },
        opts.turnId,
      );
      yield { type: 'stop-reason', stopReason: 'error' };
      return;
    }

    if (opts.decide === undefined) return;

    // -- S1.3: validate the structured output, ONE re-ask, then the ladder ends --
    const parsedJson = looseJsonParse(bridge.decideText);
    const parsed = parsedJson.ok ? validateDecideObject(parsedJson.value) : { ok: false as const, error: parsedJson.error };
    const total = this.totalUsage(state, bridge);
    if (parsed.ok) {
      const stopReason = bridge.lastStopReason ?? 'end_turn';
      yield { type: 'usage', usage: total };
      yield { type: 'stop-reason', stopReason };
      yield { type: 'decide-object', decision: parsed.value };
      void emitModelCall(this.deps.events, this.modelCallPayload(opts, model, total, stopReason, 'ok'), opts.turnId);
      return;
    }
    if (state.repairsLeft > 0) {
      yield* this.runTurn(entry, packet, tools, opts, {
        attempts: state.attempts + 1,
        repairsLeft: state.repairsLeft - 1,
        logicalStartMs: state.logicalStartMs,
        carried: {
          inputTokens: state.carried.inputTokens + bridge.summedUsage.inputTokens,
          outputTokens: state.carried.outputTokens + bridge.summedUsage.outputTokens,
          ...(state.carried.costUsd !== undefined || bridge.summedUsage.costUsd !== undefined
            ? { costUsd: (state.carried.costUsd ?? 0) + (bridge.summedUsage.costUsd ?? 0) }
            : {}),
        },
        repair: { malformed: bridge.decideText, error: parsed.error },
      });
      return;
    }
    await this.emit(DECISION_PARSE_INCIDENT, { turnId: opts.turnId, schema: 'DecisionObject', rung: 'json_schema', error: parsed.error }, opts.turnId);
    void emitModelCall(this.deps.events, this.modelCallPayload(opts, model, total, 'error', 'error'), opts.turnId);
    yield { type: 'usage', usage: total };
    yield { type: 'stop-reason', stopReason: 'error' };
  }

  private totalUsage(state: TurnState, bridge: SseTurnBridge): SpineUsage {
    const inputTokens = state.carried.inputTokens + bridge.summedUsage.inputTokens;
    const outputTokens = state.carried.outputTokens + bridge.summedUsage.outputTokens;
    const costUsd =
      state.carried.costUsd !== undefined || bridge.summedUsage.costUsd !== undefined
        ? (state.carried.costUsd ?? 0) + (bridge.summedUsage.costUsd ?? 0)
        : undefined;
    return {
      inputTokens,
      outputTokens,
      ...(costUsd !== undefined ? { costUsd } : {}),
      latencyMs: Math.max(0, this.deps.clock.epochMs() - state.logicalStartMs),
      attempts: state.attempts,
    };
  }
}

/** A minimal push queue bridging the pump task and the async generator. */
class EventQueue<T> {
  private buffer: T[] = [];
  private waiters: Array<{ resolve: (r: IteratorResult<T>) => void; reject: (e: unknown) => void }> = [];
  private ended = false;
  private error: { error: unknown } | undefined;

  push(value: T): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter !== undefined) waiter.resolve({ value, done: false });
    else this.buffer.push(value);
  }

  fail(error: unknown): void {
    if (this.ended) return;
    this.ended = true;
    this.error = { error };
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  end(): void {
    if (this.ended) {
      for (const waiter of this.waiters.splice(0)) waiter.resolve({ value: undefined as never, done: true });
      return;
    }
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter.resolve({ value: undefined as never, done: true });
  }

  next(): Promise<IteratorResult<T>> {
    const buffered = this.buffer.shift();
    if (buffered !== undefined) return Promise.resolve({ value: buffered, done: false });
    if (this.error !== undefined) return Promise.reject(this.error.error);
    if (this.ended) return Promise.resolve({ value: undefined as never, done: true });
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }
}

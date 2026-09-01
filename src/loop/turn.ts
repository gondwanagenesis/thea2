// M13 loop — the internal turn machinery shared by the main deliberation and
// every subprocess: one assess call shape, one tool-mediation path (gate ->
// execute -> observe), the spawn primitives as registry tools, and the caps.
// Kept apart from loop.ts so the public entry reads as the spec's sequence and
// this file reads as the machinery it runs on.
//
// The native function-calling invariant is structural here: tool calls are read
// ONLY from `response.toolCalls` (the wire field). Nothing in this module
// inspects prose for a call shape — tool-shaped JSON inside content is text.

import { z } from 'zod';
import { MAX_GATE_REENTRIES } from '../inhibit/index.js';
import { asError, canonicalJson, newId } from '../kernel/index.js';
import type { Clock, Rng } from '../kernel/index.js';
import type { EventLog } from '../events/index.js';
import type { SessionWindow } from '../memory/index.js';
import {
  estimateTokens,
  type ChatMsg,
  type ChatResponse,
  type ModelClient,
  type TaskClass,
  type Tier,
  type ToolCall,
  type ToolDef,
} from '../model/index.js';
import type { EntryKind, InhibitionGate, Verdict } from '../inhibit/index.js';
import type {
  LoopPacket,
  LoopQuery,
  SpawnRecord,
  SpawnSink,
  ToolRegistry,
  ToolRegistryEntry,
  ToolStep,
  Vec12,
} from './types.js';
import type { LoopConfig } from './config.js';
import { buildMessages, fitObservation } from './messages.js';
import { defOf } from './registry.js';
import { runCommittee } from './committee.js';
import {
  DELEGATION_KIND,
  DelegationPayloadSchema,
  SPAWN_REFUSED_INCIDENT,
  TOOL_TIMEOUT_INCIDENT,
} from './schema.js';

/** Advisory emission (M20's L0 policy): a broken log never kills a turn. */
export const emit = async (events: EventLog, kind: string, payload: unknown, turnId?: string): Promise<void> => {
  try {
    await events.emit(kind, payload, turnId);
  } catch {
    // advisory — M02 has already retried once and reported to stderr
  }
};

/** Everything one deliberation entry (main or spawned) carries while it runs. */
export interface TurnState {
  model: ModelClient;
  gate: InhibitionGate;
  events: EventLog;
  clock: Clock;
  rng: Rng;
  cfg: LoopConfig;
  kind: EntryKind;
  turnId: string;
  /** The current turn as one line — the situation delegation episodes carry. */
  situation: string;
  query: LoopQuery;
  affect: Vec12;
  /** The injected assembler with the affect argument bound. */
  assemble: (q: LoopQuery) => Promise<LoopPacket>;
  window: SessionWindow;
  /** The entry's own packet (subprocesses assemble their own). */
  packet: LoopPacket;
  /** Registry for THIS entry: the injected registry with the spawn primitives overlaid. */
  tools: ToolRegistry;
  defs: ToolDef[];
  deadline: number;
  /** Fires when the wall-clock budget is spent — every call this entry sees it. */
  signal: AbortSignal;
  /** Tool rounds, shared across the main deliberation and all subprocesses. */
  hops: number;
  /** Gate re-entries spent, shared the same way (MAX_GATE_REENTRIES bounds it). */
  reentries: number;
  usedObservationTokens: number;
  inhibitions: Verdict[];
  toolTrace: ToolStep[];
  spawns: SpawnRecord[];
  /** Set when a budget cut a hop, an observation, or a subprocess short. */
  truncated: boolean;
}

export const taskClassFor = (kind: EntryKind): TaskClass =>
  kind === 'user-turn' ? 'turn' : kind === 'heartbeat' ? 'heartbeat-thought' : 'ponder-seed';

/** One assess call: native tool defs attached, NO schema — a decision arrives as
 * the content; a tool round arrives as native tool_calls (schema + tools would
 * force M03's rung-(c) path and misparse every tool hop). */
export const assess = (
  state: TurnState,
  msgs: readonly ChatMsg[],
  opts: { tier: Tier; taskClass: TaskClass },
): Promise<ChatResponse> =>
  state.model.chat(
    {
      taskClass: opts.taskClass,
      tier: opts.tier,
      messages: [...msgs],
      tools: state.defs,
      maxTokens: state.cfg.assessMaxTokens,
      temperature: state.cfg.assessTemperature,
    },
    { turnId: state.turnId, signal: state.signal },
  );

// ---------------------------------------------------------------------------
// Tool mediation
// ---------------------------------------------------------------------------

const SPAWN_NAMES = new Set(['fork', 'task', 'committee']);
export const isSpawnName = (name: string): boolean => SPAWN_NAMES.has(name);

export interface Execution {
  call: ToolCall;
  /** The tool-role message this call is answered with — every tool_call gets one. */
  message: string;
  step: ToolStep;
}

const observe = (value: unknown): string => {
  if (typeof value === 'string') return value;
  try {
    return canonicalJson(value);
  } catch {
    return String(value);
  }
};

/**
 * Runs one allowed call: input-schema validation, then the handler under the
 * wedge cut. The timeout waiter is registered BEFORE the handler's first await
 * (the TestClock idiom), so `clock.advance()` resolves it even when the handler
 * never does. A wedged handler is abandoned (its settlement is mapped away and
 * never awaited again), the observation records the cut, the loop goes on.
 */
const executeCall = async (state: TurnState, call: ToolCall, depth: number, sink: SpawnSink): Promise<Execution> => {
  const started = state.clock.epochMs();
  const entry = state.tools.get(call.name);
  if (entry === undefined) {
    // Unreachable through mediation (the gate's registry default-deny fires
    // first); kept as the loud shape for a registry that lost a tool mid-turn.
    return {
      call,
      message: `[error] tool '${call.name}' is not registered`,
      step: { tool: call.name, args: call.args, verdict: { allow: true }, result: { error: 'unknown-tool' }, ms: 0 },
    };
  }

  const parsed = entry.input.safeParse(call.args);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.map(String).join('.')}: ${i.message}`).join('; ');
    return {
      call,
      message: `[rejected] arguments for '${call.name}' failed the tool's schema: ${detail}`,
      step: {
        tool: call.name,
        args: call.args,
        verdict: { allow: true },
        result: { error: 'args-schema', detail },
        ms: 0,
      },
    };
  }

  const cut = Math.min(started + state.cfg.toolTimeoutMs, state.deadline);
  // Registered synchronously, before the handler runs — TestClock ordering.
  const timer = state.clock.waitUntil(cut).then((): 'timeout' => 'timeout');
  const work = entry
    .handler(parsed.data, {
      entry: state.kind,
      turnId: state.turnId,
      depth,
      signal: state.signal,
      clock: state.clock,
      rng: state.rng,
      spawn: sink,
    })
    .then((value): { kind: 'done'; value: unknown } => ({ kind: 'done', value }))
    .catch((e: unknown): { kind: 'failed'; error: string } => ({ kind: 'failed', error: asError(e).message }));

  const raced = await Promise.race([work, timer]);
  const ms = state.clock.epochMs() - started;

  if (raced === 'timeout') {
    await emit(state.events, TOOL_TIMEOUT_INCIDENT, { turnId: state.turnId, tool: call.name, ms }, state.turnId);
    return {
      call,
      message: `[timeout] tool '${call.name}' did not resolve within ${ms}ms; the call was abandoned and deliberation continues`,
      step: { tool: call.name, args: call.args, verdict: { allow: true }, result: { error: 'timeout', ms }, ms },
    };
  }
  if (raced.kind === 'failed') {
    return {
      call,
      message: `[error] tool '${call.name}' failed: ${raced.error}`,
      step: { tool: call.name, args: call.args, verdict: { allow: true }, result: { error: raced.error }, ms },
    };
  }
  return {
    call,
    message: observe(raced.value),
    step: { tool: call.name, args: call.args, verdict: { allow: true }, result: raced.value, ms },
  };
};

export interface Mediation {
  /** At least one gate deny happened — the round consumes a gate re-entry. */
  denied: boolean;
  /** Rule ids that denied, in verdict order. */
  deniedRuleIds: string[];
}

/**
 * Mediates one round of native tool calls through the gate and the registry:
 * checkTool per candidate call, execute the allowed ones (spawn concurrency
 * capped), and answer EVERY call with a tool-role message — a denied call is
 * answered with its verdict's hint, which is exactly the re-injection path.
 * The assistant message that issued the calls precedes its answers, in the
 * original call order.
 */
export const mediate = async (
  state: TurnState,
  msgs: ChatMsg[],
  calls: readonly ToolCall[],
  depth: number,
): Promise<Mediation> => {
  const sink: SpawnSink = { situation: state.situation, record: (s) => state.spawns.push(s) };

  const judged = calls.map((call) => {
    const verdict = state.gate.checkTool(call, state.kind);
    state.inhibitions.push(verdict);
    return { call, verdict };
  });

  // Spawn concurrency cap: the tail of one round's spawn batch is refused.
  const spawnAllowed = judged.filter((j) => j.verdict.allow && isSpawnName(j.call.name));
  const capRefused = new Set(spawnAllowed.slice(state.cfg.maxSpawnConcurrency).map((j) => j.call.id));
  for (const j of spawnAllowed.slice(state.cfg.maxSpawnConcurrency)) {
    await recordRefusal(
      state,
      spawnKind(j.call.name),
      briefOf(j.call.args),
      `spawn concurrency cap (${state.cfg.maxSpawnConcurrency}) reached — run the rest in another round`,
    );
  }

  const runnable = judged.filter((j) => j.verdict.allow && !capRefused.has(j.call.id));
  const executed = await Promise.all(runnable.map((j) => executeCall(state, j.call, depth, sink)));
  const byId = new Map(executed.map((e) => [e.call.id, e]));

  const answers: ChatMsg[] = [];
  for (const j of judged) {
    const run = byId.get(j.call.id);
    const message =
      !j.verdict.allow
        ? j.verdict.hint
        : run !== undefined
          ? run.message
          : `[refused] spawn concurrency cap (${state.cfg.maxSpawnConcurrency}) reached — run the rest in another round`;
    const step: ToolStep =
      !j.verdict.allow
        ? { tool: j.call.name, args: j.call.args, verdict: j.verdict, ms: 0 }
        : run !== undefined
          ? run.step
          : { tool: j.call.name, args: j.call.args, verdict: { allow: true }, result: { error: 'spawn-cap' }, ms: 0 };
    const fitted = fitObservation(message, state.usedObservationTokens, state.cfg.turnTokenBudget);
    if (fitted !== message) state.truncated = true;
    state.usedObservationTokens += estimateTokens([fitted]);
    answers.push({ role: 'tool', content: fitted, toolCallId: j.call.id });
    state.toolTrace.push(step);
  }

  msgs.push({ role: 'assistant', content: '', toolCalls: [...calls] });
  msgs.push(...answers);

  return {
    denied: judged.some((j) => !j.verdict.allow),
    deniedRuleIds: judged.flatMap((j) => (j.verdict.allow ? [] : [j.verdict.ruleId])),
  };
};

// ---------------------------------------------------------------------------
// Spawn primitives (fork / task / committee) — ordinary registry tools
// ---------------------------------------------------------------------------

const spawnKind = (name: string): SpawnRecord['kind'] =>
  name === 'fork' ? 'fork' : name === 'task' ? 'task' : 'committee';

/** Subprocess channel composition (ADR-009): fork keeps both channels; a task worker never sees her voice. */
const spawnChannels = (name: string): { character: boolean; procedural: boolean } =>
  name === 'fork' ? { character: true, procedural: true } : { character: false, procedural: true };

const briefOf = (args: unknown): string => {
  const brief = z.object({ brief: z.string() }).safeParse(args);
  if (brief.success) return brief.data.brief;
  const spec = z.object({ spec: z.object({ name: z.string() }) }).safeParse(args);
  return spec.success ? spec.data.spec.name : '';
};

const summarize = (value: unknown): string => {
  const text = observe(value);
  return text.length > 240 ? `${text.slice(0, 240)}…` : text;
};

/** A refused spawn: recorded, incident, delegation episode with outcome 'bad'. */
const recordRefusal = async (
  state: TurnState,
  kind: SpawnRecord['kind'],
  brief: string,
  reason: string,
): Promise<void> => {
  const spawnId = newId(state.clock, state.rng);
  state.spawns.push({ kind, id: spawnId, brief, channels: spawnChannels(kind), outcome: `refused: ${reason}` });
  await emit(state.events, SPAWN_REFUSED_INCIDENT, { turnId: state.turnId, kind, reason }, state.turnId);
  await emitDelegation(state, {
    kind,
    spawnId,
    situation: state.situation,
    call: kind,
    argsSummary: summarize({ brief }),
    resultSummary: `refused: ${reason}`,
    outcome: 'bad',
  });
};

export const emitDelegation = async (state: TurnState, payload: unknown): Promise<void> => {
  const check = DelegationPayloadSchema.safeParse(payload);
  if (!check.success) return; // impossible by construction; a bad row must not poison the turn
  await emit(state.events, DELEGATION_KIND, check.data, state.turnId);
};

/**
 * The subprocess: assemble per the channel-composition rule, then deliberate on
 * its tier with the SAME machinery — native tool calls, the same gate, the same
 * shared hop/re-entry/deadline budgets, spawns one level deeper. Its answer is
 * the observation the parent's tool message carries.
 */
export const runSubprocess = async (
  state: TurnState,
  kind: 'fork' | 'task',
  brief: string,
  depth: number,
): Promise<{ text: string; outcome: 'good' | 'mixed' | 'bad' }> => {
  const query: LoopQuery = { ...state.query, text: brief, goal: brief, channels: spawnChannels(kind) };
  let packet: LoopPacket;
  try {
    packet = await state.assemble(query);
  } catch (e) {
    return { text: `[error] context assembly failed: ${asError(e).message}`, outcome: 'bad' };
  }
  const msgs = buildMessages({
    packet,
    window: state.window,
    turnText: brief,
    placement: state.cfg.inhibitionPlacement,
  });
  const taskClass = taskClassFor(state.kind);

  for (;;) {
    if (state.hops >= state.cfg.maxToolHops || state.clock.epochMs() >= state.deadline) {
      state.truncated = true;
      return {
        text: `[truncated] the '${kind}' subprocess ran out of its turn budget before answering`,
        outcome: 'mixed',
      };
    }
    const res = await assess(state, msgs, {
      tier: kind === 'fork' ? state.cfg.spawnTier.fork : state.cfg.spawnTier.task,
      taskClass,
    });
    if (res.toolCalls === undefined || res.toolCalls.length === 0) {
      return { text: res.content, outcome: res.content === '' ? 'mixed' : 'good' };
    }
    state.hops += 1;
    const med = await mediate(state, msgs, res.toolCalls, depth);
    if (med.denied) {
      state.reentries += 1;
      if (state.reentries > MAX_GATE_REENTRIES) {
        return {
          text: `[inhibited] the '${kind}' subprocess kept reaching for blocked tools (${med.deniedRuleIds.join(', ')}) and was stopped`,
          outcome: 'mixed',
        };
      }
    }
  }
};

// Tool-surface inputs. Deliberately flat and JSON-schema-friendly: a model is
// authoring these, and every nesting level is a malformation opportunity.
const briefInput = z.object({ brief: z.string().min(1) });
const committeeInput = z.object({
  spec: z.object({
    name: z.string().min(1),
    nodes: z.array(
      z.object({
        id: z.string().min(1),
        needs: z.array(z.string()),
        prompt: z.string().min(1),
        /** When true the node's system message carries the character channel. */
        character: z.boolean().optional(),
        requiresObservation: z.boolean().optional(),
      }),
    ),
  }),
});
type BriefArgs = { brief: string };
type CommitteeArgs = { spec: { name: string; nodes: Array<{ id: string; needs: string[]; prompt: string; character?: boolean | undefined; requiresObservation?: boolean | undefined }> } };

/**
 * The three spawn primitives as registry entries, bound to THIS turn's state.
 * A spawn beyond the depth cap is refused with an incident — recorded, never
 * executed; the parent keeps deliberating.
 */
export const spawnEntries = (state: TurnState): ToolRegistryEntry[] => {
  const runSpawn = async (kind: 'fork' | 'task', brief: string, depth: number, sink: SpawnSink): Promise<string> => {
    if (depth >= state.cfg.maxSpawnDepth) {
      const reason = `spawn depth cap (${state.cfg.maxSpawnDepth}) reached — no further delegation from inside a subprocess`;
      await recordRefusal(state, kind, brief, reason);
      return `[refused] ${reason}`;
    }
    const spawnId = newId(state.clock, state.rng);
    sink.record({ kind, id: spawnId, brief, channels: spawnChannels(kind) });
    const res = await runSubprocess(state, kind, brief, depth + 1);
    const outcomeText = res.text === '' ? '(no result)' : summarize(res.text);
    const record = state.spawns.find((s) => s.id === spawnId);
    if (record !== undefined) record.outcome = outcomeText;
    await emitDelegation(state, {
      kind,
      spawnId,
      situation: state.situation,
      call: kind,
      argsSummary: summarize({ brief }),
      resultSummary: outcomeText,
      outcome: res.outcome,
    });
    return res.text;
  };

  const briefDef = (name: 'fork' | 'task', description: string): ToolRegistryEntry<BriefArgs> => ({
    def: defOf(name, description, {
      type: 'object',
      properties: { brief: { type: 'string', description: 'the question or brief the subprocess answers' } },
      required: ['brief'],
    }),
    input: briefInput,
    inhibitionMeta: { class: 'spawn' },
    handler: (args, ctx) => runSpawn(name, args.brief, ctx.depth, ctx.spawn),
  });

  const committee: ToolRegistryEntry<CommitteeArgs> = {
    def: defOf(
      'committee',
      'Run a scripted committee DAG over the current question: nodes run in dependency order, the last node answers.',
      {
        type: 'object',
        properties: {
          spec: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'what this committee is deciding' },
              nodes: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    needs: { type: 'array', items: { type: 'string' }, description: 'ids of nodes whose output this node reads' },
                    prompt: { type: 'string' },
                    character: { type: 'boolean', description: 'true = the node sees the character channel' },
                    requiresObservation: { type: 'boolean' },
                  },
                  required: ['id', 'needs', 'prompt'],
                },
              },
            },
            required: ['name', 'nodes'],
          },
        },
        required: ['spec'],
      },
    ),
    input: committeeInput,
    inhibitionMeta: { class: 'spawn' },
    handler: async (args, ctx) => {
      if (ctx.depth >= state.cfg.maxSpawnDepth) {
        const reason = `spawn depth cap (${state.cfg.maxSpawnDepth}) reached — no committee from inside a subprocess`;
        await recordRefusal(state, 'committee', args.spec.name, reason);
        return `[refused] ${reason}`;
      }
      const spawnId = newId(state.clock, state.rng);
      ctx.spawn.record({
        kind: 'committee',
        id: spawnId,
        brief: args.spec.name,
        channels: { character: false, procedural: true },
      });
      const spec = {
        name: args.spec.name,
        nodes: args.spec.nodes.map(
          (n): {
            id: string;
            needs: string[];
            channels: { character: boolean; procedural: boolean };
            prompt: string;
          } => ({
            id: n.id,
            needs: [...n.needs],
            channels: { character: n.character === true, procedural: true },
            prompt: n.prompt,
          }),
        ),
        output: z.unknown(),
      };
      const res = await runCommittee(spec, {
        name: args.spec.name,
        model: state.model,
        packet: state.packet,
        query: state.query,
        affect: state.affect,
        turnId: state.turnId,
        signal: state.signal,
        maxTokens: state.cfg.assessMaxTokens,
        temperature: state.cfg.assessTemperature,
        tier: state.cfg.spawnTier.committee,
      });
      const record = state.spawns.find((s) => s.id === spawnId);
      if (record !== undefined) record.outcome = res.ok ? summarize(res.artifact) : `failed: ${res.error ?? 'unknown'}`;
      await emitDelegation(state, {
        kind: 'committee',
        spawnId,
        situation: state.situation,
        call: 'committee',
        argsSummary: summarize(args.spec),
        resultSummary: res.ok ? summarize(res.artifact) : `failed: ${res.error ?? 'unknown'}`,
        outcome: res.ok ? 'good' : 'bad',
      });
      return res.ok ? observe(res.artifact) : `[failed] ${res.error ?? 'the committee produced no artifact'}`;
    },
  };

  return [
    briefDef(
      'fork',
      'Clone of your current context on the cheap tier: it answers one question as you, with your voice and your reading of this conversation.',
    ),
    briefDef(
      'task',
      'A fresh-context worker: it sees only the procedural channel and your brief. Use for work that must not borrow your voice.',
    ),
    committee,
  ];
};

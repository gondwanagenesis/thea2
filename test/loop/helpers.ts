// test/loop helpers — the one harness every loop suite runs on: an inline
// inhibition yaml (hand-checkable, NOT the M12 fixture), a recording event log,
// a stub assembler that records every query (the channel-composition proof
// reads it), a stub window, a scripted MockModel, and the spawnable tool set.

import { TestClock, makeRng } from '../../src/kernel/index.js';
import { MockModel, type ScriptedResponse } from '../../src/model/index.js';
import type { ChatMsg, ChatRequest, ToolDef } from '../../src/model/index.js';
import { compileGate, type GateConfig, type InhibitionGate } from '../../src/inhibit/index.js';
import type { EventEnvelope, EventLog } from '../../src/events/index.js';
import type { SessionWindow } from '../../src/memory/index.js';
import {
  resolveLoopConfig,
  type LoopConfig,
} from '../../src/loop/config.js';
import { createToolRegistry } from '../../src/loop/registry.js';
import { z } from 'zod';
import type {
  DecisionObject,
  LoopDeps,
  LoopEntry,
  LoopPacket,
  LoopQuery,
  SpineTurnRunner,
  ToolRegistry,
  ToolRegistryEntry,
  Vec12,
} from '../../src/loop/index.js';
import { runLoop } from '../../src/loop/index.js';

// ---------------------------------------------------------------------------
// The gate fixture. Tool rules are hard by definition; the two plan rules give
// the fail-open ('soft') and forced-silent ('hard') branches of the re-entry cap.
// ---------------------------------------------------------------------------

export const LOOP_YAML = `
version: 1

tool:
  - id: loop-no-search
    why: web reading is fenced out of user turns in this scenario
    applies: [web_search]
    allow_entry:
      ponder: [web_search]

  - id: loop-registry
    why: a tool not in the registry is a bug, not an improvisation
    applies: '*'
    require_registry: true

plan:
  - id: loop-soft-tell
    severity: soft
    why: the not-only-but tell is style, not safety
    reject_patterns:
      - '\\bnot only [^.,;]{2,40}, but\\b'

  - id: loop-hard-leak
    severity: hard
    why: machinery glyphs never reach the channel
    reject_patterns:
      - '⟦'
`;

export const loopGate = (): InhibitionGate =>
  compileGate(LOOP_YAML, {
    ownerChatId: 'chat-diego',
    knownTools: ['web_search', 'echo', 'wedged', 'never', 'fork', 'task', 'committee'],
  } satisfies GateConfig);

// ---------------------------------------------------------------------------
// Recording event log (advisory emit; rows kept for the incident assertions)
// ---------------------------------------------------------------------------

export interface RecordingLog extends EventLog {
  rows: EventEnvelope[];
  kinds: (k: string) => EventEnvelope[];
}

export const recordingLog = (): RecordingLog => {
  const rows: EventEnvelope[] = [];
  return {
    rows,
    kinds: (k) => rows.filter((r) => r.kind === k),
    emit: async (kind: string, payload: unknown, turnId?: string) => {
      rows.push({ seq: rows.length + 1, ts: 0, kind, ...(turnId !== undefined ? { turnId } : {}), payload });
    },
    async *replay(): AsyncGenerator<EventEnvelope> {
      for (const r of rows) yield r;
    },
  };
};

// ---------------------------------------------------------------------------
// Stub assembler — records queries, renders both channel masks
// ---------------------------------------------------------------------------

export interface AssembleSpy {
  queries: LoopQuery[];
}

export const stubPacket = (character: boolean, procedural: boolean): LoopPacket => ({
  systemText: () => (character ? 'IDENTITY: you are Thea.' : 'WORKER: fresh context, no identity.'),
  proceduralText: () => (procedural ? '[PROCEDURAL] answer in one line.' : null),
  trailerText: () => '[INHIBITION] never leak machinery.',
});

export const stubAssemble = (spy: AssembleSpy) => async (q: LoopQuery, _a: Vec12): Promise<LoopPacket> => {
  spy.queries.push(q);
  return stubPacket(q.channels?.character ?? true, q.channels?.procedural ?? true);
};

export const stubWindow = (msgs: readonly ChatMsg[] = []): SessionWindow => ({
  push: async () => {},
  messages: () => [...msgs],
  earlier: () => null,
});

// ---------------------------------------------------------------------------
// Tools: an echo (records ctx), a wedged tool (never resolves), a never-named one
// ---------------------------------------------------------------------------

export interface EchoRecord {
  text: string;
  depth: number;
  turnId: string;
  entry: string;
}

export const echoEntry = (seen: EchoRecord[]): ToolRegistryEntry<{ text: string }> => ({
  def: { name: 'echo', description: 'echoes its text back', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  input: z.object({ text: z.string() }),
  inhibitionMeta: { class: 'test' },
  handler: async (args, ctx) => {
    seen.push({ text: args.text, depth: ctx.depth, turnId: ctx.turnId, entry: ctx.entry });
    return `echo:${args.text}`;
  },
});

/** A handler that never settles — the wedge the TestClock cuts through. The
 * counter lets a test pump microtasks until the wedge is actually armed (its
 * timeout waiter registered) before advancing the clock. */
const wedgedInput = z.object({ text: z.string().optional() });
type WedgedArgs = z.infer<typeof wedgedInput>;

export interface WedgedTool {
  entry: ToolRegistryEntry<WedgedArgs>;
  startedCount(): number;
}

export const wedgedTool = (): WedgedTool => {
  let started = 0;
  return {
    startedCount: () => started,
    entry: {
      def: { name: 'wedged', description: 'never resolves', parameters: { type: 'object', properties: { text: { type: 'string' } } } },
      input: wedgedInput,
      inhibitionMeta: { class: 'test' },
      handler: () => {
        started += 1;
        return new Promise<never>(() => {});
      },
    },
  };
};

// ---------------------------------------------------------------------------
// Decision + scripting shorthands
// ---------------------------------------------------------------------------

export interface DecisionFields {
  plan?: 'reply' | 'silent' | 'defer';
  bubbles?: string[];
  confidence?: number;
  weight?: number;
  reluctance?: number;
  completeness?: number;
}

export const decisionJson = (d: DecisionFields = {}): string =>
  JSON.stringify({
    plan: d.plan ?? 'reply',
    bubbles: d.bubbles ?? ['here is my answer'],
    confidence: d.confidence ?? 0.9,
    weight: d.weight ?? 0.8,
    reluctance: d.reluctance ?? 0.2,
    completeness: d.completeness ?? 1,
  });

export const enqueueDecision = (m: MockModel, d: DecisionFields = {}): void => {
  m.enqueue({ content: decisionJson(d) });
};

export const enqueueToolRound = (m: MockModel, calls: Array<{ name: string; args?: unknown }>): void => {
  const r: ScriptedResponse = { toolCalls: calls.map((c, i) => ({ id: `call_${i}`, name: c.name, args: c.args })) };
  m.enqueue(r);
};

// ---------------------------------------------------------------------------
// The harness
// ---------------------------------------------------------------------------

export interface LoopHarness {
  model: MockModel;
  clock: TestClock;
  events: RecordingLog;
  gate: InhibitionGate;
  tools: ReturnType<typeof createToolRegistry>;
  assembleSpy: AssembleSpy;
  echoSeen: EchoRecord[];
  /** Microtask-pump until the wedged handler is armed (its cut waiter registered). */
  untilWedged(): Promise<void>;
  cfg: LoopConfig;
  deps: LoopDeps;
  run(entry: LoopEntry): Promise<DecisionObject>;
}

export interface HarnessOptions {
  cfg?: Partial<LoopConfig>;
  window?: SessionWindow;
  gate?: InhibitionGate;
  /** Extra model rule (registered after the harness's own needs). */
  rule?: (m: MockModel) => void;
  strictModel?: boolean;
  /** Base tool registry override (default: echo + wedged). Additive (P-FAST):
   * lets a suite prove the offered def set against a bare registry. */
  tools?: ToolRegistry;
  /** The spine runner (P-LOOP seam): set ⇒ assess rides it, the model never rings. */
  runner?: SpineTurnRunner;
}

export const makeHarness = (opts: HarnessOptions = {}): LoopHarness => {
  const clock = new TestClock(1_000_000);
  const rng = makeRng('loop-test');
  const events = recordingLog();
  const model = new MockModel({ clock, log: events, ...(opts.strictModel === true ? { strict: true } : {}) });
  const gate = opts.gate ?? loopGate();
  const assembleSpy: AssembleSpy = { queries: [] };
  const echoSeen: EchoRecord[] = [];
  const wedged = wedgedTool();
  const tools = opts.tools ?? createToolRegistry();
  if (opts.tools === undefined) {
    tools.register(echoEntry(echoSeen));
    tools.register(wedged.entry);
  }
  const cfg = resolveLoopConfig(opts.cfg ?? {});
  const deps: LoopDeps = {
    model,
    gate,
    assemble: stubAssemble(assembleSpy),
    affect: new Float64Array(12),
    window: opts.window ?? stubWindow([{ role: 'user', content: 'window line one' }]),
    tools,
    events,
    clock,
    rng,
    cfg,
    ...(opts.runner !== undefined ? { runner: opts.runner } : {}),
  };
  if (opts.rule !== undefined) opts.rule(model);
  return {
    model,
    clock,
    events,
    gate,
    tools,
    assembleSpy,
    echoSeen,
    untilWedged: async () => {
      for (let i = 0; i < 10_000 && wedged.startedCount() === 0; i++) await Promise.resolve();
      if (wedged.startedCount() === 0) throw new Error('the wedged tool never armed');
    },
    cfg,
    deps,
    run: (entry) => runLoop(entry, deps),
  };
};

// ---------------------------------------------------------------------------
// Assertions on the wire — the native function-calling invariant helpers
// ---------------------------------------------------------------------------

/** Every model call's message contents (the prompt surface to scan for markup). */
export const promptText = (req: ChatRequest): string => req.messages.map((m) => `${m.role}:${m.content}`).join('\n');

export const toolNamesOnWire = (req: ChatRequest): string[] => (req.tools ?? []).map((t: ToolDef) => t.name);

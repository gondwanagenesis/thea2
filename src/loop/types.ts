// M13 loop — public contract types (docs/modules/M13-loop.md §Interfaces).
// The loop is the single deliberation path behind all three entry contexts; the
// DecisionObject it locks is the only thing downstream modules (realize, probes)
// ever see of a turn.
//
// Two types here are DELIBERATE structural mirrors of modules the S4 build runs
// parallel to: `LoopPacket` is the subset of M11-assemble's Packet the loop
// renders, and `LoopQuery` the loop-owned subset of M11's TurnQuery. Nothing in
// this module imports src/assemble — the assembler arrives injected, wired by
// M20, and TypeScript structural typing keeps the seam honest without a
// compile-time edge (dependency-cruiser forbids one).

import type { ZodType } from 'zod';
import type { Clock, Rng } from '../kernel/index.js';
import type { EntryKind, InhibitionGate, Verdict } from '../inhibit/index.js';
import type { ModelClient, ToolDef } from '../model/index.js';
import type { SessionWindow } from '../memory/index.js';
import type { EventLog } from '../events/index.js';
import type { LoopConfig } from './config.js';

/** 12-dim affect deviation vector (M06's Vec12, mirrored structurally). */
export type Vec12 = Float64Array;

/** M15-bridge's inbound message, mirrored structurally (src/bridge is upstream of the DAG). */
export interface InboundMsg {
  updateId: number;
  msgId: number;
  chatId: number;
  ts: number;
  text: string;
  speaker: { person: string; channel: string };
  reaction?: { emoji: string; toMsgId: number } | undefined;
}

/**
 * What the loop hands the injected assembler. Only the fields the loop itself
 * owns are required; M20's adapter merges the pipeline-owned ones (speaker,
 * register, queryVec, recentTurnIds) from its own turn context before the real
 * M11 `assemble` runs.
 */
export interface LoopQuery {
  entry?: EntryKind | undefined;
  text?: string | undefined;
  goal?: string | undefined;
  speaker?: unknown;
  register?: 'work' | 'friend' | 'play' | undefined;
  queryVec?: Float32Array | undefined;
  recentTurnIds?: string[] | undefined;
  channels?: { character: boolean; procedural: boolean } | undefined;
}

/** The packet surface the loop renders (M11's Packet is a strict superset). */
export interface LoopPacket {
  /** The 7 character sections in fixed order. */
  systemText(): string;
  /** The [PROCEDURAL] block, null when the quota resolved to 0. */
  proceduralText(): string | null;
  /** The [INHIBITION] block. */
  trailerText(): string;
}

/** One deliberation entry. Heartbeat/ponder policy lives in M17; the loop executes. */
export interface LoopEntry {
  kind: EntryKind;
  inbound?: InboundMsg | undefined;
  goal?: string | undefined;
  committee?: CommitteeSpec | undefined;
}

/** One tool call attempted inside the deliberation loop (schemas/decision.ts). */
export interface ToolStep {
  tool: string;
  /** Arguments as sent; validated against the tool's own zod input schema upstream. */
  args: unknown;
  /** Gate verdict for this call — checked before execution. */
  verdict: Verdict;
  /** Observation summarized back into the loop; absent when the call was denied. */
  result?: unknown;
  ms: number;
}

/** A spawned subprocess (schemas/decision.ts). fork/task/committee are registry tools. */
export interface SpawnRecord {
  kind: 'fork' | 'task' | 'committee';
  id: string;
  brief: string;
  /** Channel composition (ADR-009): fork = character + procedural; task/cast = procedural only. */
  channels: { character: boolean; procedural: boolean };
  /** Short result summary once the spawn resolves. */
  outcome?: string | undefined;
}

/** The loop's single output — the only shape that can reach the channel (M14 reads it). */
export interface DecisionObject {
  turnId: string;
  plan: 'reply' | 'silent' | 'defer';
  bubbles: string[];
  confidence: number;
  weight: number;
  reluctance: number;
  completeness: number;
  toolTrace: ToolStep[];
  spawns: SpawnRecord[];
  inhibitions: Verdict[];
}

/** What the model authors of a decision. The rest of the DecisionObject is loop-owned. */
export interface ModelDecision {
  plan: 'reply' | 'silent' | 'defer';
  bubbles: string[];
  confidence: number;
  weight: number;
  reluctance: number;
  completeness: number;
}

// ---------------------------------------------------------------------------
// Tool registry
// ---------------------------------------------------------------------------

/**
 * Per-tool inhibition/lineage metadata. The compiled gate enforces entry
 * allowlists from the yaml; this is the registry-side statement of the same
 * intent (which entries a tool may fire under) plus the classification M08's
 * procedural generator reads. `defs(entry)` filters on it.
 */
export interface InhibitionMeta {
  /** Entry kinds the tool may fire under; absent = every entry. */
  entries?: readonly EntryKind[] | undefined;
  /** Free-form class the procedural generator and audits group by ('web', 'memory', 'spawn', ...). */
  class?: string | undefined;
}

/** Per-call context handed to every tool handler. Hermetic by construction: clock and rng are injected. */
export interface ToolCtx {
  entry: EntryKind;
  turnId: string;
  /** Nesting level of spawns: the main deliberation is 0, a subprocess's own calls 1, ... */
  depth: number;
  signal: AbortSignal;
  clock: Clock;
  rng: Rng;
  /**
   * Spawn bookkeeping for this entry — fork/task/committee ARE registry tools,
   * so the delegation sink travels with the context. Other handlers ignore it.
   */
  spawn: SpawnSink;
}

export interface SpawnSink {
  /** The situation line delegation episodes carry: what she was in when she reached for this. */
  situation: string;
  /** Records a spawn into the DecisionObject being locked. */
  record(s: SpawnRecord): void;
}

export interface ToolRegistryEntry<T = unknown> {
  def: ToolDef;
  /**
   * Zod schema the registry validates the call's args against before the
   * handler runs. Stated structurally (zod's `safeParse` shape, not the
   * `ZodType` generic) so a concrete z.object is assignable without fighting
   * zod's Input/Output variance under exactOptionalPropertyTypes.
   */
  input: {
    safeParse(
      data: unknown,
    ):
      | { success: true; data: T; error?: never }
      | { success: false; data?: never; error: { issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }> } };
  };
  inhibitionMeta: InhibitionMeta;
  handler(args: T, ctx: ToolCtx): Promise<unknown>;
}

export interface ToolRegistry {
  register(e: ToolRegistryEntry): void;
  /** Tool defs for one entry context, in registration order — the request's `tools` array. */
  defs(entry: EntryKind): ToolDef[];
  get(name: string): ToolRegistryEntry | undefined;
  /** Every registered name — the compose-time `knownTools` the gate is compiled with. */
  names(): readonly string[];
}

// ---------------------------------------------------------------------------
// Spawns + committee
// ---------------------------------------------------------------------------

/** One node of a scripted committee DAG (ponder is one: SEED->GROUND->REVISE->ARTIFACT). */
export interface CommitteeNode {
  id: string;
  needs: string[];
  channels: { character: boolean; procedural: boolean };
  prompt: string;
  /** When set, the node's output must parse against it (one prompted-JSON read, no ladder). */
  schema?: ZodType | undefined;
  /**
   * Marks a node that consumes a grounding observation (ponder's REVISE). A node
   * carrying it must have at least one `needs` edge — structurally unreachable
   * without upstream input, enforced by DAG shape, never by prompt.
   */
  requiresObservation?: boolean | undefined;
}

export interface CommitteeSpec {
  name: string;
  nodes: CommitteeNode[];
  /** The terminal node's output must validate against this. */
  output: ZodType;
}

export interface CommitteeResult {
  ok: boolean;
  /** Node id -> rendered output, in execution order. */
  outputs: Array<{ id: string; output: string }>;
  /** The terminal node's output, validated against spec.output. */
  artifact: unknown;
  error?: string | undefined;
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

export interface LoopDeps {
  model: ModelClient;
  gate: InhibitionGate;
  /** Injected assembler — type-compatible with M11's `assemble`; M20 wires it. */
  assemble: (q: LoopQuery, a: Vec12) => Promise<LoopPacket>;
  /** The current affect signature the packet is selected against. */
  affect: Vec12;
  window: SessionWindow;
  tools: ToolRegistry;
  events: EventLog;
  clock: Clock;
  rng: Rng;
  cfg: LoopConfig;
}

/** The deliberation loop. Implemented in loop.js; declared here so the contract's
 * shape and the implementation cannot drift apart. */
export type RunLoop = (entry: LoopEntry, deps: LoopDeps) => Promise<DecisionObject>;

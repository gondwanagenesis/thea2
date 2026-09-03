// M21 spine — public contract types (docs/modules/M21-spine.md §Interfaces).
// The determinism seam (plan v7 PART 0.5): the loop drives the spine behind ONE
// interface — `run(entry, packet, tools, opts) -> AsyncIterable<StreamEvent>`.
// Live = OpenCodeRunner (a supervised `opencode serve` child); tests =
// FakeRunner replaying JSON fixtures. No test may require a live spine.
//
// src/loop + src/inhibit are imported READ-ONLY here: the decision contract and
// the inhibition vocabulary stay owned by their modules; the spine is their
// transport, never their redefinition.

import type { ZodType } from 'zod';
import type { DoorName, StopReason, TaskClass, ToolCall, ToolDef } from '../model/index.js';
import type { LoopEntry, LoopPacket, ModelDecision } from '../loop/index.js';

/**
 * One streamed spine event — the L0-facing vocabulary of a turn. A turn is a
 * sequence of these; a decide turn ends with exactly one `decide-object`
 * (already validated through src/loop's ModelDecisionSchema).
 */
export type StreamEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'tool-call'; call: ToolCall }
  | { type: 'decide-object'; decision: ModelDecision }
  | { type: 'usage'; usage: SpineUsage }
  | { type: 'stop-reason'; stopReason: StopReason };

/**
 * Usage with DR.4 semantics: tokens, priced cost when the door reported one,
 * latency, and attempts — retries + the one-shot decide repair fold into ONE
 * logical call, exactly as the native client's Usage.attempts does.
 */
export interface SpineUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
  latencyMs: number;
  attempts: number;
}

/** A model reference on the spine wire: the P-DOOR door a call rides. */
export interface ModelRef {
  providerID: string;
  modelID: string;
  door?: DoorName | undefined;
}

/** One text part of the turn message. `label` marks the load-bearing slots. */
export interface SpinePart {
  type: 'text';
  text: string;
  label?: 'turn' | 'inhibition' | 'repair' | undefined;
}

/**
 * The per-turn POST body (documented v1.18.x surface): agent, per-call model,
 * per-call system (the packet), context parts, tool on/off map, and the
 * structured-output format when the turn carries the decide contract.
 */
export interface SpineTurnRequest {
  agent: string;
  model: { providerID: string; modelID: string };
  system: string;
  parts: SpinePart[];
  tools: Record<string, boolean>;
  format?: { type: 'json_schema'; schema: unknown; retryCount: number } | undefined;
}

/** Options for one `run` — the loop's own handles ride alongside. */
export interface SpineRunOpts {
  /** The turn id minted by the pipeline — every L0 event carries it. */
  turnId: string;
  /** Task class selecting the per-call model (config `byClass`, else `model`). */
  taskClass?: TaskClass | undefined;
  /** The caller's cut: fired at the turn's wall-clock budget (FA.1 mirror). */
  signal?: AbortSignal | undefined;
  /**
   * The structured-output decide contract (S1.3). When set, the POST carries
   * `format: {type:'json_schema', schema, retryCount}` and the runner
   * zod-validates the object (one re-ask on failure) instead of streaming
   * text deltas.
   */
  decide?: { schema: unknown } | undefined;
  /**
   * Per-tool zod validators (DR.7 parity) checked on tool-call events before
   * they are yielded. Coercion (`decide.bubbles` string -> array) always runs.
   */
  toolInput?: Readonly<Record<string, ZodType>> | undefined;
}

/** The ONE spine seam. Implemented by OpenCodeRunner (live) and FakeRunner (tests). */
export interface SpineRunner {
  run(entry: LoopEntry, packet: LoopPacket, tools: readonly ToolDef[], opts: SpineRunOpts): AsyncIterable<StreamEvent>;
}

/** The supervised spine child, trimmed to what supervision needs. */
export interface SpineChild {
  pid?: number | undefined;
  kill(signal?: string): boolean;
  onExit(cb: (code: number | null, signal: string | null) => void): void;
}

export type SpawnFn = (cmd: string, args: readonly string[], opts: { env: Record<string, string> }) => SpineChild;

/** Typed spine failures — loud, never swallowed. */
export type SpineErrorCode =
  | 'spine/abandoned'
  | 'spine/boot-failed'
  | 'spine/request-failed'
  | 'spine/turn-failed'
  | 'spine/idle-timeout'
  | 'spine/config-invalid';

export class SpineError extends Error {
  constructor(
    readonly code: SpineErrorCode,
    message: string,
    readonly causeOpt?: { cause?: unknown },
  ) {
    super(message);
    this.name = 'SpineError';
  }
}

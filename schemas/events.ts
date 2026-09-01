// Reference schema — spec-v1. Source of truth migrates to src/events at stage S1; keep synced.
//
// The L0 event envelope (M02) plus a catalogue of the named event kinds used across
// the module specs. L0 is the append-only ground truth that credit assignment (M10),
// the Ledger sibling (M18), and crash recovery (M05, M10) replay from. It NEVER
// enters prompts (the M19 leakage evaluator checks the outbound side of this rule).
//
// Kinds are open strings with a dot-namespace (M02); the union below documents the
// kinds the specs actually name. Per-payload schemas are owned by the PRODUCING
// module (M02 stores envelopes opaquely) — the payload interfaces here are the
// documented shapes those producers have committed to, for cross-module reference.

import { z } from 'zod';

export const EventEnvelope = z.object({
  /** Monotonic across rotations and restarts; starts at 1. Never reused, even after a torn write. */
  seq: z.number().int().min(1),
  /** epochMs from the injected clock at emit. */
  ts: z.number().int().nonnegative(),
  /** Namespaced kind, e.g. 'model.call'. Dot rule enforced by M02. */
  kind: z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/),
  /** Present when the event belongs to a turn (model calls, packets, decisions, sends). */
  turnId: z.string().min(1).optional(),
  /** JSON-serializable, ≤ 32 KB serialized (default guard); producer owns the schema. */
  payload: z.unknown(),
});
export type EventEnvelope = z.infer<typeof EventEnvelope>;

// ---------------------------------------------------------------------------
// Named kinds (the specs' vocabulary). Reserved namespaces per M02:
//   model.* embed.* affect.* corpus.* derive.* memory.* consolidate.* credit.*
//   packet.* decision.* bridge.* sched.* life.* probe.* incident.* sibling.* app.*
// ---------------------------------------------------------------------------

/** M03 — one event per logical chat call, retries folded into usage.attempts. */
export interface ModelCallPayload {
  taskClass: 'turn' | 'appraisal' | 'heartbeat-thought' | 'ponder-seed' | 'consolidate'
    | 'derive' | 'judge' | 'probe-judge' | 'summarize';
  tier: 'main' | 'cheap' | 'reasoning';
  model: string;
  usage: { inputTokens: number; outputTokens: number; costUsd?: number; latencyMs: number; attempts: number };
  outcome: 'ok' | 'error' | 'timeout' | 'aborted';
}

/** M03/M09/M13 — structured output could not be parsed after the repair ladder. */
export interface ParseFailedPayload {
  schema: string;          // which shape failed ('DecisionObject', 'Appraisal', …)
  rung: 'json_schema' | 'tool_call' | 'prompted_json' | 'repair';
  error: string;           // final zod/parse error text
}

/** M03 — an illegal downgrade was attempted and ignored (the guardrail worked). */
export interface RoutingIgnoredPayload { taskClass: string; attemptedTier: string; pinnedTier: string }

/** M11 — every filled slot, for M10's nightly credit pass. */
export interface PacketRecordPayload {
  turnId: string;
  slots: Array<{ exemplarId: string; tier: 'disposition' | 'pattern' | 'episode' | 'memory' | 'procedure';
    channel: 'character' | 'procedural'; baseScore: number; modulation: number }>;
  affectSig: number[];     // Vec12 snapshot at assembly
  coherence: 'ok' | 'degraded';
  flags: { scarcity: boolean; staleDerived: boolean };
}

/** M13 — a spawned subprocess (procedural exemplar feedstock via M08). */
export interface DelegationPayload {
  kind: 'fork' | 'task' | 'committee';
  spawnId: string;
  situation: string;
  call: string;
  argsSummary: string;
  resultSummary: string;
  outcome: 'good' | 'mixed' | 'bad';
}

/** M09 — the verbatim factual evidence string for the previous packet's grade (audit trail). */
export interface OutcomePrevPayload { turnId: string; sign: -1 | 0 | 1; evidence: string }

/** M05 — full affect state snapshot (the 15-minute job); the corruption-recovery path. */
export interface AffectSnapshotPayload { state: unknown /* AffectState */ }

/** M05 — a tag outside EMOTION_TAGS hit the store boundary: rejected, state untouched. */
export interface UnknownTagPayload { tag: string; source: 'appraisal' | 'import' | 'other' }

/** M08 — an orphaned derived entry + its file were removed (git history is recovery). */
export interface OrphanGcPayload { id: string; deriveKey: string; generator: string }

/** M08 — weekly prod check found dirtiness; prod reports, never regenerates (ADR-007). */
export interface DeriveStalePayload { dirtyCount: number; orphanCount: number }

/** M15 — reconciliation found an inbound with neither outbound nor recorded silence. */
export interface LostReplyPayload { updateId: number; chatId: number; ageMs: number; turnId?: string }

/** M12/M13 — gate rejection loop exhausted: forced silent + incident. */
export interface GateLoopPayload { turnId: string; ruleIds: string[]; reentries: number }

/** M16 — a job failed 3 consecutive times (alarm) or wedged (singleton-locked). */
export interface SchedAlarmPayload { job: string; kind: 'failing' | 'wedged'; consecutiveFailures: number }

/** M10 — gravity metrics with the drift alarms evaluated. */
export interface GravityPayload {
  seedRatio: { pattern: number; episode: number };
  alarms: Array<'unmoored' | 'not-integrating' | 'tunnel-vision'>;
}

/** M18 — Nightingale verdict vs probes/baseline.json. */
export interface NightingalePayload {
  verdict: 'green' | 'yellow' | 'red';
  regressing: string[];    // probe ids
  markerDiff: string[];    // which deploy-marker inputs changed
}

/** M18 — a routing proposal was refused by the guardrail (turn is pinned). */
export interface RoutingRefusedPayload { taskClass: string; proposedTier: string; reason: string }

/** M20 — boot progress; a failed boot names its stage. */
export interface BootPayload { stage: string; ok: boolean; error?: string }

// Documentation note: the concrete zod schemas for these payloads live with their
// producing modules at migration time (the mirrors update in the same PR per
// schemas/README.md's sync rule). This file pins the ENVELOPE and the kind
// vocabulary — the two things every module shares.

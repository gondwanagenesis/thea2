// M14 realize — the public contract (docs/modules/M14-realize.md §Interfaces).
//
// `RealizableDecision` is a deliberate structural subset of M13's
// DecisionObject: S4 builds in parallel, so the realizer names only the fields
// cadence is caused by. The full DecisionObject satisfies it structurally — no
// import, no coupling (dependency-cruiser pins realize → kernel/coupling/bridge,
// and src/loop stays off the list on purpose).

import type { Clock, Rng } from '../kernel/index.js';
import type { Channel, ChannelLimits } from '../bridge/index.js';
import type { Vec12 } from '../coupling/index.js';

/** The slice of the decision object that cadence is caused by. */
export interface RealizableDecision {
  plan: 'reply' | 'silent' | 'defer';
  bubbles: string[];
  /** [0,1] — how little she wanted to send this. The sole driver of the pre-delay. */
  reluctance: number;
  weight: number;
  confidence: number;
}

/** One step of a delivery timeline. Sends are verbatim decision bubbles; pauses and typing carry the cadence. */
export type DeliveryStep =
  | { kind: 'pause'; ms: number }
  | { kind: 'typing'; ms: number }
  | { kind: 'send'; text: string };

export interface DeliveryPlan {
  steps: DeliveryStep[];
  /** Sum of the timed steps (pause + typing). Sends take no planned time. */
  totalMs: number;
}

/** What one plan execution actually did. */
export interface ExecResult {
  sent: Array<{ msgId: number; text: string }>;
  aborted: boolean;
  /** Unsent bubbles, in plan order — M20 feeds them into the next turn's context as "she was about to say". */
  undelivered: string[];
}

/** Pure: (decision, affect, limits, rng) → timeline. Jitter draws come from a fork of `rng`. */
export type PlanDelivery = (
  d: RealizableDecision,
  a: Vec12,
  limits: ChannelLimits,
  rng: Rng,
) => DeliveryPlan;

/**
 * Replays a plan against the Channel honoring channel physics, all waits through
 * the injected clock. `onSend`, when given, is awaited immediately after each
 * `ch.send` resolves and BEFORE the next step runs (v6 CA.2) — the pipeline
 * wires it to MessageLedger.recordOutbound so a ledger row lands per delivered
 * bubble, and an abort mid-plan leaves exactly the delivered bubbles recorded.
 * A throw from `onSend` propagates (loud, never swallowed).
 */
export type ExecutePlan = (
  plan: DeliveryPlan,
  chatId: number,
  ch: Channel,
  clock: Clock,
  signal: AbortSignal,
  onSend?: ((msgId: number, text: string) => Promise<void>) | undefined,
) => Promise<ExecResult>;

/** What a turn's delivery came to — the report M20 logs and reconciles against. */
export interface DeliveryReport {
  /** The plan as planned. When the send pacer had to stretch it (channel physics won), actuals run past `totalMs`. */
  plan: DeliveryPlan;
  sent: Array<{ msgId: number; text: string }>;
  aborted: boolean;
  undelivered: string[];
}

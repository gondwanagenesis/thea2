// M18 siblings — public contract (docs/modules/M18-siblings.md §Interfaces).
//
// The two surviving Thea1 siblings demoted to scheduler jobs: Ledger (cost /
// routing observability + guardrailed routing proposals) and Nightingale (the
// behavioral immune system that runs probes after any deploy-marker change).
// No bridges, no tokens, no inboxes — job bodies on M16's one scheduler with
// events to L0.

import type { Clock, Rng } from '../kernel/index.js';
import type { EventLog } from '../events/index.js';
import type { ModelClient, TaskClass, Tier } from '../model/index.js';
import type { ProbeRunner } from '../probes/index.js';

// ---------------------------------------------------------------------------
// Deps + run context
// ---------------------------------------------------------------------------

export interface SiblingDeps {
  model: ModelClient;
  events: EventLog;
  /** var/sched/state.json — the Ledger reports what actually ran. */
  sched: { statePath: string };
  /** M19's runner — Nightingale executes probes through this seam only. */
  probes: ProbeRunner;
  /** probes/baseline.json — read to gate, recommitted on green. */
  baselinePath: string;
  /** var/deploy-marker — the content hash Nightingale watches. */
  deployMarkerPath: string;
  /** var/routing.json — the Ledger may WRITE proposals here. */
  routingPath: string;
  /** var/reports/ */
  reportsDir: string;
  clock: Clock;
  rng: Rng;
  /**
   * Additive (not in the spec's field list): the deploy marker's remaining
   * inputs. Defaults are install-dir-relative, so M20 injects real paths.
   */
  marker?: SiblingMarkerPaths | undefined;
  /** Additive: persona seed dir override (defaults to the packaged personas/). */
  personaDir?: string | undefined;
}

/** The deploy marker's inputs beyond routing.json (see marker.ts). */
export interface SiblingMarkerPaths {
  /** Version string of the running code (git sha or package version). */
  codeVersion?: string | undefined;
  /** corpus/canon/inhibitions.yaml */
  inhibitionsPath?: string | undefined;
  /** coupling.yaml */
  couplingPath?: string | undefined;
  /** corpus/canon — the canon hash walks this dir. */
  corpusDir?: string | undefined;
}

/**
 * Per-run context. Job bodies receive M16's JobCtx (which satisfies this
 * structurally); the CLI verbs call the runners directly with the deps' own
 * clock/rng/events when no ctx is supplied.
 */
export interface SiblingRunCtx {
  clock: Clock;
  rng: Rng;
  events: EventLog;
  signal?: AbortSignal | undefined;
}

/** Falls back to the deps' own clock/rng/events — the spec'd standalone call shape. */
export const runCtx = (deps: SiblingDeps, ctx?: Partial<SiblingRunCtx> | undefined): SiblingRunCtx => ({
  clock: ctx?.clock ?? deps.clock,
  rng: ctx?.rng ?? deps.rng,
  events: ctx?.events ?? deps.events,
  ...(ctx?.signal !== undefined ? { signal: ctx.signal } : {}),
});

// ---------------------------------------------------------------------------
// Ledger aggregates + routing proposals (the spec'd pure surface)
// ---------------------------------------------------------------------------

export interface LedgerAggregate {
  taskClass: TaskClass;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyP50Ms: number;
  latencyP95Ms: number;
  parseFailures: number;
}

export interface RoutingProposal {
  taskClass: TaskClass;
  from: Tier;
  to: Tier;
  reason: string;
}

/** A guardrailed target the evidence rule reached but the pin refuses (turn). */
export interface RoutingRefusal {
  taskClass: TaskClass;
  proposedTier: Tier;
  reason: string;
}

/**
 * Wider than the spec's `=> RoutingProposal[]`: refusals must be LOGGED
 * (`sibling.routing_refused`), so the pure fn has to report them. Same
 * widening move M19 made on its suite result — recorded in Build deltas.
 */
export interface ProposalSet {
  proposals: RoutingProposal[];
  refused: RoutingRefusal[];
}

// ---------------------------------------------------------------------------
// Job naming / cadence constants (M16's job table v1, M18's two rows)
// ---------------------------------------------------------------------------

export const LEDGER_JOB_NAME = 'ledger-report';
export const NIGHTINGALE_JOB_NAME = 'probe-on-deploy';

/** M16's golden week pins ledger-report at 04:30 UTC — this default matches it. */
export const LEDGER_UTC_MINUTE = 270;
/** The Ledger reports the trailing UTC day. */
export const LEDGER_WINDOW_MS = 86_400_000;
export const LEDGER_TIMEOUT_MS = 5 * 60_000;

/** Deploy-marker watcher: 1 min, catchUp 'skip' (a change is checked once). */
export const WATCHER_PERIOD_MS = 60_000;
/** Live probes are k=3 real-model runs — the watcher needs room to breathe. */
export const NIGHTINGALE_TIMEOUT_MS = 15 * 60_000;

/** Spec: probes run k=3, median-aggregated. */
export const PROBE_K = 3;

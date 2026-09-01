// test/realize — shared builders. Hermetic by doctrine: TestClock only, seeded
// or scripted rngs, FakeChannel, and a tmpdir ledger. No wall clock, no network.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AFFECT_DIMS, DIM_INDEX, type AffectDim, type Vec12 } from '../../src/coupling/index.js';
import type { InboundMsg } from '../../src/bridge/index.js';
import type { DeliveryPlan, DeliveryStep, RealizableDecision } from '../../src/realize/index.js';
import type { Rng } from '../../src/kernel/index.js';
import type { TestClock } from '../../src/kernel/clock.js';

/** Fixture epoch: 2026-09-01T00:00:00Z. Never "now". */
export const T0 = Date.UTC(2026, 8, 1, 0, 0, 0);

export const DIEGO_TG_ID = 8123456;

/** A minimal inbound for the ledger halves of the tests. */
export const msg = (over: Partial<InboundMsg> = {}): InboundMsg => ({
  updateId: 1,
  msgId: 5000,
  chatId: DIEGO_TG_ID,
  ts: T0,
  text: 'estás ahí?',
  speaker: { person: 'diego', channel: 'telegram' },
  ...over,
});

export const decision = (over: Partial<RealizableDecision> = {}): RealizableDecision => ({
  plan: 'reply',
  bubbles: ['hola'],
  reluctance: 0,
  weight: 0.5,
  confidence: 0.8,
  ...over,
});

/** A dense deviation vector with everything at baseline (0) except the named dims. */
export const vec = (over: Partial<Record<AffectDim, number>> = {}): Vec12 => {
  const v = new Float64Array(AFFECT_DIMS.length);
  for (const [k, x] of Object.entries(over)) v[DIM_INDEX[k as AffectDim]] = x ?? 0;
  return v;
};

/**
 * A scripted rng: every draw is `value`. `fork` returns the same script so a
 * forked jitter stream reads the same sequence — with value 0.5 the gap jitter
 * is exactly 0, which is what makes the hand-computed timelines hand-computable.
 */
export const fixedRng = (value = 0.5): Rng => {
  const rng: Rng = {
    float: () => value,
    int: (lo, hi) => lo + Math.floor(value * (hi - lo + 1)),
    pick: (xs) => xs[Math.floor(value * xs.length)]!,
    shuffle: (xs) => [...xs],
    fork: () => rng,
  };
  return rng;
};

/**
 * Drains microtasks until the executor under test has parked on the clock.
 * Deterministic (fixed hop count, FIFO microtasks) — this is the "register the
 * waiter before the first advance" trap discharged, and the tests that use it
 * PROVE registration by asserting a captured typing before advancing.
 */
export const settle = async (hops = 50): Promise<void> => {
  for (let i = 0; i < hops; i++) await Promise.resolve();
};

/**
 * Advances the clock to `untilMs` (absolute epoch) in small slices, settling
 * between slices. TestClock.advance drains only two microtask hops per waiter
 * it fires, while the executor needs three or four to reach its NEXT
 * registration — so one big advance would leave later steps to run at the
 * overshoot time instead of their due instant. Slicing keeps every due instant
 * ahead of the clock until it is exactly due, which is what makes the timeline
 * assertions exact. `sliceMs` must stay below the smallest spacing between
 * consecutive due instants in the plan under test (50 covers all fixtures here).
 */
export const drive = async (clock: TestClock, untilMs: number, sliceMs = 1): Promise<void> => {
  while (clock.epochMs() < untilMs) {
    await clock.advance(Math.min(sliceMs, untilMs - clock.epochMs()));
    await settle(12);
  }
};

/** The verbatim invariant's only legal wiggle: whitespace runs collapse, nothing else changes. */
export const squash = (s: string): string => s.replace(/\s+/g, ' ').trim();

export const timedSteps = (p: DeliveryPlan): Array<Exclude<DeliveryStep, { kind: 'send' }>> =>
  p.steps.filter((s): s is Exclude<DeliveryStep, { kind: 'send' }> => s.kind !== 'send');

export const sendsOf = (p: DeliveryPlan): string[] =>
  p.steps.filter((s): s is Extract<DeliveryStep, { kind: 'send' }> => s.kind === 'send').map((s) => s.text);

/** Planned clock offset of the first send — "how late the delivery starts". */
export const firstSendOffset = (p: DeliveryPlan): number => {
  let at = 0;
  for (const s of p.steps) {
    if (s.kind === 'send') return at;
    at += s.ms;
  }
  return at;
};

/** Fresh tmpdir the caller must remove (tests use afterEach cleanup). */
export const freshDir = (prefix: string): string => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

// test/app helpers — the composition harness: hermetic boot over a tmp var/,
// shared TestClock, scripted MockModel, FakeChannel. The e2e proofs run the
// REAL corpus index (repo canon at cwd), so identity retrieval is exercised,
// not stubbed.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { makeRng, TestClock } from '../../src/kernel/index.js';
import { MockModel } from '../../src/model/index.js';
import { FakeChannel } from '../../src/bridge/index.js';
import { compose, loadConfig, type System } from '../../src/app/index.js';

export const T0 = 1_780_000_000_000; // a fixed 2026 morning
export const CHAT = 861800000;

export const HERMETIC_ENV: Record<string, string> = {
  THEA2_BOT_TOKEN: '123456789:AAEhf-abcDEF1234567890abcdefghijk',
  THEA2_MODEL_API_KEY: 'model-key-abc123',
};

const FIXTURE = resolve('test/fixtures/thea2.hermetic.yaml');

export type FakeChannelT = ReturnType<typeof FakeChannel>;

export interface AppHarness {
  sys: System;
  model: MockModel;
  channel: FakeChannelT;
  clock: TestClock;
  dir: string;
}

export type Inbound = Parameters<FakeChannelT['queueInbound']>[0];

export const bootApp = async (over: { model?: MockModel; channel?: FakeChannelT } = {}): Promise<AppHarness> => {
  const dir = mkdtempSync(join(tmpdir(), 'thea2-app-'));
  const clock = new TestClock(T0);
  const model = over.model ?? new MockModel({ clock });
  const channel = over.channel ?? FakeChannel({ clock, chatId: CHAT });
  const cfg = loadConfig(FIXTURE, HERMETIC_ENV);
  const sys = await compose(cfg, 'hermetic', { varDir: dir, clock, rng: makeRng('app-e2e'), model, channel });
  return { sys, model, channel, clock, dir };
};

/** Flush every pending microtask round + timers so the poll/ingest/pipeline
 * chain has run up to its first clock wait. Real setTimeout: TestClock gates
 * simulated time, never the test's own event loop. */
export const settle = (ms = 5): Promise<void> => new Promise((r) => setTimeout(r, ms));

export const inboundMsg = (over: Partial<Inbound> = {}): Inbound => ({
  updateId: 500,
  msgId: 900,
  chatId: CHAT,
  ts: T0,
  text: 'hey — is the box safe?',
  speaker: { person: 'diego', channel: 'telegram' },
  ...over,
});

/** DecisionObject JSON as the assess call returns it (mirrors test/loop's script shape). */
export const decisionJson = (d: { bubbles?: string[]; plan?: string } = {}): string =>
  JSON.stringify({
    plan: d.plan ?? 'reply',
    bubbles: d.bubbles ?? ['hi. the box is safe — I checked twice.'],
    confidence: 0.9,
    weight: 0.8,
    reluctance: 0.2,
    completeness: 1,
  });

/** The afterturn appraisal payload (taskClass 'appraisal'). The structured
 * ladder routes it through the synthetic `emit` tool — a plain content reply
 * never parses (this exact trap bit M17's thought schema too). */
export const appraisalPayload = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  importance: 4,
  emotions: [{ tag: 'fond', i: 5, cause: 'he asked about the box' }],
  diaryLine: 'he came back to the box question.',
  threads: [],
  outcomePrev: null,
  ...over,
});

export const enqueueAppraisal = (m: MockModel, over: Record<string, unknown> = {}): void => {
  m.enqueue({ toolCalls: [{ id: 'appr', name: 'emit', args: appraisalPayload(over) }] });
};

/** Drive the turn past its clock-parked spans (send gaps, typing) until the
 * pipeline quiesces. Advancing in small steps keeps waiter order honest. */
export const runToQuiescent = async (h: AppHarness, maxMs = 120_000): Promise<void> => {
  // Wait for the poll's real-fs ingest to actually enqueue the turn before
  // trusting isBusy() === false — under parallel load 5ms is not enough.
  // Bounded: a denied chat or reaction-only update legitimately never starts
  // a turn, so the wait gives up and the drain below is trivially done.
  for (let i = 0; i < 200; i++) {
    if (h.sys.pipeline.isBusy()) break;
    await settle(2);
  }
  let advanced = 0;
  while (h.sys.pipeline.isBusy() && advanced < maxMs) {
    await h.clock.advance(1_500);
    advanced += 1_500;
    await settle(1);
  }
  await h.sys.pipeline.drain();
};

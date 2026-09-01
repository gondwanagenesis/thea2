// M14 realize — the executor. It replays a DeliveryPlan against the Channel
// with the injected clock, so a plan's timeline is an exact schedule, not an
// aspiration. Channel physics are honored BY CONSTRUCTION here, not by the
// caller's luck: typing re-fires before the indicator expires, and a send
// never enters the channel inside the per-chat gap — FakeChannel throws on
// both, so a 429-shaped bug is red in CI instead of a prod incident.

import type { Channel } from '../bridge/index.js';
import type { Clock } from '../kernel/index.js';
import type { DeliveryPlan, ExecResult } from './types.js';

/** TestClock/SystemClock both reject aborted waits with `code: 'aborted'` — the one rejection this loop tolerates. */
const isAbort = (e: unknown): boolean =>
  typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 'aborted';

export const executePlan = async (
  plan: DeliveryPlan,
  chatId: number,
  ch: Channel,
  clock: Clock,
  signal: AbortSignal,
): Promise<ExecResult> => {
  const sent: Array<{ msgId: number; text: string }> = [];
  let lastSendAt: number | undefined;
  // `at` is the schedule's absolute position. The send pacer may push it later
  // than the plan said; later steps then chain from the pushed time, so the
  // clock never has to move backwards to satisfy a step.
  let at = clock.epochMs();
  let aborted = false;
  let stepIndex = 0;

  /** Waits through the clock; false means the signal aborted while parked. */
  const waitUntil = async (t: number): Promise<boolean> => {
    if (t <= clock.epochMs()) return true;
    try {
      await clock.waitUntil(t, signal);
      return true;
    } catch (e) {
      if (isAbort(e)) return false;
      throw e;
    }
  };

  const done = (): ExecResult => ({
    sent,
    aborted,
    // Undelivered is read off the remaining plan, so an abort mid-typing still
    // names the bubble she was typing as undelivered — that is exactly the
    // "she was about to say" text M20 carries into the next turn.
    undelivered: plan.steps
      .slice(stepIndex)
      .filter((s) => s.kind === 'send')
      .map((s) => s.text),
  });

  for (; stepIndex < plan.steps.length; stepIndex++) {
    const step = plan.steps[stepIndex];
    if (step === undefined) break;
    if (signal.aborted) {
      aborted = true;
      break;
    }

    if (step.kind === 'pause') {
      at += step.ms;
      if (!(await waitUntil(at))) {
        aborted = true;
        break;
      }
    } else if (step.kind === 'typing') {
      await ch.typing(chatId);
      // The indicator expires ~5s on Telegram; re-fire on every refresh tick
      // the channel publishes while typing continues, never after the span ends.
      let typed = 0;
      while (typed < step.ms) {
        const slice = Math.min(ch.limits.typingRefreshMs, step.ms - typed);
        typed += slice;
        at += slice;
        if (!(await waitUntil(at))) {
          aborted = true;
          break;
        }
        if (typed < step.ms) await ch.typing(chatId);
      }
      if (aborted) break;
    } else {
      // Send pacing: when the channel's per-chat gap has not elapsed since the
      // last send, hold the schedule until it has. The first send never waits.
      if (lastSendAt !== undefined) {
        const due = lastSendAt + ch.limits.minSendGapMs;
        if (clock.epochMs() < due && due > at) at = due;
        if (!(await waitUntil(at))) {
          aborted = true;
          break;
        }
      }
      // The gap reference is the moment the send hits the wire, not when its
      // promise resolves — a slow transport must not skew the next hold.
      const sendAt = clock.epochMs();
      const { msgId } = await ch.send(chatId, step.text);
      lastSendAt = sendAt;
      sent.push({ msgId, text: step.text });
    }
  }

  return done();
};

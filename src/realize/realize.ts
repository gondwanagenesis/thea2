// M14 realize — the composition entry M20 calls once per locked decision:
// decision in, Channel in, delivery report out. It adds nothing to the law —
// planDelivery times it, executePlan paces it — it only glues them to the
// channel's own limits and hands back what actually happened.
//
// The realizer never touches the MessageLedger itself (spec §Not this module's
// job): the pipeline owns that ordering. `recordSend` is handed straight down
// to `executePlan`, which awaits it immediately after each send resolves and
// before the next step (v6 CA.2) — so each ledger row lands per delivered
// bubble, and an abort mid-plan leaves exactly what was delivered recorded.
// Leaving it undefined is equally correct.

import type { Clock } from '../kernel/index.js';
import type { Channel } from '../bridge/index.js';
import type { Rng } from '../kernel/index.js';
import type { Vec12 } from '../coupling/index.js';
import { executePlan } from './execute.js';
import { planDelivery } from './plan.js';
import type { DeliveryPlan, DeliveryReport, RealizableDecision } from './types.js';

export interface RealizeDeps {
  chatId: number;
  channel: Channel;
  clock: Clock;
  /** M20 aborts this when a new inbound arrives mid-plan. */
  signal: AbortSignal;
  /** Awaited once per successful send, before the next step (v6 CA.2) — M20 wires it to MessageLedger.recordOutbound. A throw propagates (loud, never swallowed). */
  recordSend?: ((msgId: number, text: string) => Promise<void>) | undefined;
}

export const realize = async (
  d: RealizableDecision,
  affect: Vec12,
  rng: Rng,
  deps: RealizeDeps,
): Promise<DeliveryReport> => {
  const plan: DeliveryPlan = planDelivery(d, affect, deps.channel.limits, rng);
  const res = await executePlan(plan, deps.chatId, deps.channel, deps.clock, deps.signal, deps.recordSend);
  return { plan, sent: res.sent, aborted: res.aborted, undelivered: res.undelivered };
};

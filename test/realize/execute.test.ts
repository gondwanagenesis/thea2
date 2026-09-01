// executePlan + realize — the S4 realizer gate, execution half: the exact
// TestClock timeline (every pause/typing/send at its due instant), the typing
// re-fire cadence, the send pacer proven against FakeChannel's enforced limits,
// and the mid-plan interruption contract down to the ledger rows.

import * as fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { TestClock } from '../../src/kernel/clock.js';
import {
  DEFAULT_RECONCILE_WINDOW_MS,
  FAKE_FIRST_MSG_ID,
  FakeChannel,
  TELEGRAM_LIMITS,
  openMessageLedger,
  type LedgerRow,
  type MessageLedger,
} from '../../src/bridge/index.js';
import { executePlan, planDelivery, realize, type DeliveryPlan } from '../../src/realize/index.js';
import { DIEGO_TG_ID, T0, decision, drive, fixedRng, freshDir, msg, sendsOf, settle, vec } from './helpers.js';

const CHAT = DIEGO_TG_ID;

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  dirs = [];
});

/** The two-bubble plan every hand-computed timeline below is built from. */
const twoBubbles = (): DeliveryPlan =>
  planDelivery(
    decision({ bubbles: ['hola que tal', 'te lo cuento'] }), // 12 chars each → typing 1200 ms at cps 10
    vec(),
    TELEGRAM_LIMITS,
    fixedRng(0.5), // jitter draw 0.5 ⇒ gap exactly 750 ms
  );

const threeBubbles = (): DeliveryPlan =>
  planDelivery(
    decision({ bubbles: ['primera', 'segunda', 'tercera'] }), // 7 chars each → typing 700 ms at cps 10
    vec(),
    TELEGRAM_LIMITS,
    fixedRng(0.5),
  );

describe('executePlan — the exact timeline', () => {
  it('AC: every pause, typing and send lands at its exact due instant on the TestClock', async () => {
    const clock = new TestClock(T0);
    const ch = FakeChannel({ clock });
    const plan = twoBubbles();
    expect(plan.totalMs).toBe(3950); // 800 + 1200 + 750 + 1200 — the hand computation

    const run = executePlan(plan, CHAT, ch, clock, new AbortController().signal);
    await settle(); // the executor is now parked on the pre-delay waiter
    await drive(clock, T0 + 799);
    expect(ch.typings()).toEqual([]); // still inside the pre-delay, to the millisecond
    await clock.advance(1); // T0+800 exactly
    expect(ch.typings()).toEqual([{ chatId: CHAT, at: T0 + 800 }]);

    await drive(clock, T0 + plan.totalMs);
    const res = await run;

    expect(res).toEqual({
      sent: [
        { msgId: FAKE_FIRST_MSG_ID, text: 'hola que tal' },
        { msgId: FAKE_FIRST_MSG_ID + 1, text: 'te lo cuento' },
      ],
      aborted: false,
      undelivered: [],
    });
    expect(ch.typings()).toEqual([
      { chatId: CHAT, at: T0 + 800 }, // pre-delay over, typing for bubble 1
      { chatId: CHAT, at: T0 + 2750 }, // inter-bubble gap over, typing for bubble 2
    ]);
    expect(ch.outbound()).toEqual([
      { chatId: CHAT, text: 'hola que tal', msgId: FAKE_FIRST_MSG_ID, at: T0 + 2000 },
      { chatId: CHAT, text: 'te lo cuento', msgId: FAKE_FIRST_MSG_ID + 1, at: T0 + 3950 },
    ]);
    expect(clock.epochMs()).toBe(T0 + plan.totalMs); // the schedule, not a ms more
  });

  it('AC: the typing indicator re-fires every 4 s through a long span and never lapses', async () => {
    const clock = new TestClock(T0);
    const ch = FakeChannel({ clock });
    const plan: DeliveryPlan = {
      steps: [
        { kind: 'typing', ms: 30_000 }, // a 300-char bubble at cps 10
        { kind: 'send', text: 'x'.repeat(300) },
      ],
      totalMs: 30_000,
    };
    const run = executePlan(plan, CHAT, ch, clock, new AbortController().signal);
    await settle(); // typing is the first step: the first fire has already happened
    expect(ch.typings()).toEqual([{ chatId: CHAT, at: T0 }]);
    await drive(clock, T0 + plan.totalMs, 50); // refresh ticks are 4000 apart — slices of 50 stay exact
    await run;

    const fires = ch.typings().map((t) => t.at - T0);
    expect(fires).toEqual([0, 4000, 8000, 12000, 16000, 20000, 24000, 28000]); // refresh ticks + the tail slice
    for (let i = 1; i < fires.length; i++) {
      expect(fires[i]! - fires[i - 1]!).toBeLessThanOrEqual(TELEGRAM_LIMITS.typingRefreshMs); // ≤ 4 s: inside the ~5 s expiry
    }
    expect(ch.outbound()[0]?.at).toBe(T0 + 30_000);
  });

  it('the re-fire cadence is the channel’s own limit, not a hard-coded 4 s', async () => {
    const clock = new TestClock(T0);
    const ch = FakeChannel({ clock, limits: { typingRefreshMs: 1000 } }); // a chatty synthetic channel
    const plan: DeliveryPlan = {
      steps: [
        { kind: 'typing', ms: 4500 },
        { kind: 'send', text: 'hola' },
      ],
      totalMs: 4500,
    };
    const run = executePlan(plan, CHAT, ch, clock, new AbortController().signal);
    await settle();
    await drive(clock, T0 + plan.totalMs);
    await run;
    expect(ch.typings().map((t) => t.at - T0)).toEqual([0, 1000, 2000, 3000, 4000]);
  });

  it('AC: sends are paced ≥ minSendGapMs per chat — the pacer by construction, FakeChannel as the witness', async () => {
    const clock = new TestClock(T0);
    const ch = FakeChannel({ clock }); // real Telegram physics: 1100 ms per chat
    const plan = planDelivery(decision({ bubbles: ['a', 'b'] }), vec(), TELEGRAM_LIMITS, fixedRng(0.5));
    // Planned total is 1750 ms, which would put send #2 at 1750 — 850 ms after
    // send #1. The pacer must stretch the schedule; FakeChannel would throw
    // bridge/limit-send-gap otherwise, so this assertion cannot pass by luck.
    expect(plan.totalMs).toBe(1750);

    const run = executePlan(plan, CHAT, ch, clock, new AbortController().signal);
    await settle();
    await drive(clock, T0 + plan.totalMs + TELEGRAM_LIMITS.minSendGapMs);
    await run;

    expect(ch.outbound().map((s) => s.at - T0)).toEqual([900, 2000]); // send #2 held to send #1 + 1100
  });

  it('a tighter synthetic channel is honored the same way', async () => {
    const clock = new TestClock(T0);
    const ch = FakeChannel({ clock, limits: { minSendGapMs: 5000 } });
    const plan = planDelivery(decision({ bubbles: ['a', 'b', 'c'] }), vec(), ch.limits, fixedRng(0.5));

    const run = executePlan(plan, CHAT, ch, clock, new AbortController().signal);
    await settle();
    await drive(clock, T0 + 20_000);
    await run;

    expect(ch.outbound().map((s) => s.at - T0)).toEqual([900, 5900, 10_900]); // exactly minSendGapMs apart
  });
});

describe('executePlan — mid-plan interruption', () => {
  it('AC: an abort after step k delivers 0..k-1 exactly, never touches k+1.., and names the undelivered', async () => {
    const clock = new TestClock(T0);
    const ch = FakeChannel({ clock });
    const ac = new AbortController();

    const run = executePlan(threeBubbles(), CHAT, ch, clock, ac.signal);
    await settle();
    await drive(clock, T0 + 2000); // send #1 (at 1500) done; parked before bubble 2's typing (at 2250)
    expect(ch.outbound().map((s) => s.text)).toEqual(['primera']);

    ac.abort(); // a new inbound arrived — M20 fires the signal
    const res = await run;

    expect(res.aborted).toBe(true);
    expect(res.sent.map((s) => s.text)).toEqual(['primera']);
    expect(res.undelivered).toEqual(['segunda', 'tercera']);

    await clock.advance(60_000); // the executor is done: nothing is pending, so one big advance is exact
    expect(ch.outbound()).toHaveLength(1); // nothing further was ever sent
    expect(ch.typings()).toHaveLength(1); // and no stray typing fire after the abort
  });

  it('AC: an abort that lands mid-typing still names the bubble she was typing as undelivered', async () => {
    const clock = new TestClock(T0);
    const ch = FakeChannel({ clock });
    const ac = new AbortController();
    const run = executePlan(threeBubbles(), CHAT, ch, clock, ac.signal);
    await settle();
    await drive(clock, T0 + 1000); // inside the first typing span (800..1500)
    ac.abort();
    const res = await run;
    expect(res.sent).toEqual([]);
    expect(res.undelivered).toEqual(['primera', 'segunda', 'tercera']);
  });

  it('a signal already aborted at entry touches nothing', async () => {
    const clock = new TestClock(T0);
    const ch = FakeChannel({ clock });
    const ac = new AbortController();
    ac.abort();
    const res = await executePlan(threeBubbles(), CHAT, ch, clock, ac.signal);
    expect(res).toEqual({ sent: [], aborted: true, undelivered: ['primera', 'segunda', 'tercera'] });
    expect(ch.outbound()).toHaveLength(0);
    expect(ch.typings()).toHaveLength(0);
  });
});

describe('executePlan — degenerate plans still terminate', () => {
  it('an empty plan touches nothing and reports nothing', async () => {
    const clock = new TestClock(T0);
    const ch = FakeChannel({ clock });
    const res = await executePlan({ steps: [], totalMs: 0 }, CHAT, ch, clock, new AbortController().signal);
    expect(res).toEqual({ sent: [], aborted: false, undelivered: [] });
    expect(ch.outbound()).toHaveLength(0);
    expect(ch.typings()).toHaveLength(0);
    expect(clock.epochMs()).toBe(T0);
  });

  it('zero-length typing and pause steps fire the indicator once and do not hang', async () => {
    const clock = new TestClock(T0);
    const ch = FakeChannel({ clock });
    const res = await executePlan(
      {
        steps: [
          { kind: 'typing', ms: 0 },
          { kind: 'pause', ms: 0 },
          { kind: 'send', text: 'ya' },
        ],
        totalMs: 0,
      },
      CHAT,
      ch,
      clock,
      new AbortController().signal,
    );
    expect(res.sent.map((s) => s.text)).toEqual(['ya']);
    expect(ch.typings()).toEqual([{ chatId: CHAT, at: T0 }]);
    expect(clock.epochMs()).toBe(T0);
  });
});

// ---------------------------------------------------------------------------
// The ledger half — the realizer itself never writes rows; this is M20's
// protocol (record inbound → link → decision → execute → record per send), run
// end to end to prove reconcile stays clean when the pipeline follows it.
// ---------------------------------------------------------------------------

describe('realize → ledger — what was delivered is exactly what reconcile sees', () => {
  const openLedger = (clock: TestClock): MessageLedger => {
    const dir = freshDir('thea2-realize-ledger-');
    dirs.push(dir);
    return openMessageLedger(dir, { clock }); // the SAME clock the delivery runs on — timestamps must line up
  };

  const outboundTexts = async (l: MessageLedger): Promise<string[]> => {
    const rows: string[] = [];
    for await (const row of l.read()) if (row.kind === 'outbound') rows.push(row.text);
    return rows;
  };

  it('AC: a mid-plan interruption records exactly the delivered bubbles and reconciles clean', async () => {
    const clock = new TestClock(T0);
    const ledger = openLedger(clock);
    const ch = FakeChannel({ clock });
    const ac = new AbortController();
    await ledger.recordInbound(msg({ updateId: 7 }));
    await ledger.linkTurn(7, 'turn-1');
    await ledger.recordDecision('turn-1', { turnId: 'turn-1', plan: 'reply', at: clock.epochMs() });

    const run = realize(decision({ bubbles: ['primera', 'segunda', 'tercera'] }), vec(), fixedRng(0.5), {
      chatId: CHAT,
      channel: ch,
      clock,
      signal: ac.signal,
      recordSend: (msgId, text) => ledger.recordOutbound('turn-1', msgId, text),
    });
    await settle();
    await drive(clock, T0 + 2000); // 'primera' is out at T0+1500
    ac.abort();
    const report = await run;

    expect(report.aborted).toBe(true);
    expect(sendsOf(report.plan)).toEqual(['primera', 'segunda', 'tercera']);
    expect(await outboundTexts(ledger)).toEqual(['primera']); // the ledger holds EXACTLY what was delivered

    await clock.advance(DEFAULT_RECONCILE_WINDOW_MS + 1000);
    expect(await ledger.reconcile(clock.epochMs())).toEqual([]); // partial delivery is still a terminated turn
  });

  it('AC: a silent decision sends nothing, lands its ledger row, and reconciles clean', async () => {
    const clock = new TestClock(T0);
    const ledger = openLedger(clock);
    const ch = FakeChannel({ clock });
    await ledger.recordInbound(msg({ updateId: 8 }));
    await ledger.linkTurn(8, 'turn-2');
    await ledger.recordDecision('turn-2', { turnId: 'turn-2', plan: 'silent', at: clock.epochMs() });

    const report = await realize(decision({ plan: 'silent', bubbles: ['iba a decir algo'] }), vec(), fixedRng(0.5), {
      chatId: CHAT,
      channel: ch,
      clock,
      signal: new AbortController().signal,
    });

    expect(report).toEqual({ plan: { steps: [], totalMs: 0 }, sent: [], aborted: false, undelivered: [] });
    expect(ch.outbound()).toHaveLength(0);
    expect(ch.typings()).toHaveLength(0);
    expect(await outboundTexts(ledger)).toEqual([]);

    await clock.advance(DEFAULT_RECONCILE_WINDOW_MS + 1000);
    expect(await ledger.reconcile(clock.epochMs())).toEqual([]); // decided-silent is a typed, clean row
  });

  it('an abort that delivers nothing leaves the turn un-terminated — reconcile MUST say LOST_REPLY', async () => {
    // The handoff obligation this pins: undelivered bubbles go into the next
    // turn's context ("she was about to say"), and until something terminates
    // the turn the ledger is right to keep the alarm armed.
    const clock = new TestClock(T0);
    const ledger = openLedger(clock);
    const ch = FakeChannel({ clock });
    const ac = new AbortController();
    await ledger.recordInbound(msg({ updateId: 9 }));
    await ledger.linkTurn(9, 'turn-3');
    await ledger.recordDecision('turn-3', { turnId: 'turn-3', plan: 'reply', at: clock.epochMs() });

    const run = realize(decision({ bubbles: ['primera', 'segunda'] }), vec(), fixedRng(0.5), {
      chatId: CHAT,
      channel: ch,
      clock,
      signal: ac.signal,
    });
    await settle(); // parked on the pre-delay waiter, nothing said yet
    ac.abort(); // the inbound lands before she says anything at all
    const report = await run;
    expect(report.sent).toEqual([]);
    expect(report.undelivered).toEqual(['primera', 'segunda']);

    await clock.advance(DEFAULT_RECONCILE_WINDOW_MS + 1000);
    const found = await ledger.reconcile(clock.epochMs());
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ kind: 'LOST_REPLY', turnId: 'turn-3' });
  });

  it('rows land in delivery order, texts and msgIds matching the channel, ts non-decreasing', async () => {
    const clock = new TestClock(T0);
    const ledger = openLedger(clock);
    const ch = FakeChannel({ clock });
    const run = realize(decision({ bubbles: ['una', 'dos'] }), vec(), fixedRng(0.5), {
      chatId: CHAT,
      channel: ch,
      clock,
      signal: new AbortController().signal,
      recordSend: (msgId, text) => ledger.recordOutbound('turn-4', msgId, text),
    });
    await settle();
    await drive(clock, T0 + 3000); // the plan runs to completion (send #2 at T0+2150, pacer-pushed)
    const report = await run;
    const rows: LedgerRow[] = [];
    for await (const row of ledger.read()) rows.push(row);
    expect(rows.map((r) => r.kind)).toEqual(['outbound', 'outbound']);
    expect(rows.map((r) => (r.kind === 'outbound' ? r.text : ''))).toEqual(['una', 'dos']);
    expect(rows.map((r) => (r.kind === 'outbound' ? r.msgId : -1))).toEqual(report.sent.map((s) => s.msgId));
    // recordSend runs once the plan has executed, so a row's ts is when the
    // pipeline recorded it — the channel's own accept times live on the
    // CapturedSend/ExecResult side, linked by msgId.
    const ts = rows.map((r) => (r.kind === 'outbound' ? r.ts : -1));
    for (let i = 1; i < ts.length; i++) expect(ts[i]!).toBeGreaterThanOrEqual(ts[i - 1]!);
  });
});

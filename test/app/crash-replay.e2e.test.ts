// S5★ crown proof #2 — CRASH REPLAY. Kill the process at every interesting
// point between "the message is ledgered" and "the offset is committed", boot a
// FRESH composition over the SAME var/, let Telegram redeliver, and pin the
// law: no loss, no dupe, and a LOST_REPLY alarm exactly when a reply truly
// never happened — never silence.

import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeRng, TestClock } from '../../src/kernel/index.js';
import { MockModel } from '../../src/model/index.js';
import { FakeChannel } from '../../src/bridge/index.js';
import { compose, loadConfig, startThead } from '../../src/app/index.js';
import { CHAT, HERMETIC_ENV, T0, decisionJson, enqueueAppraisal, inboundMsg, runToQuiescent, settle } from './helpers.js';
import { resolve } from 'node:path';

const FIXTURE = resolve('test/fixtures/thea2.hermetic.yaml');

describe('crash replay', () => {
  it('crash AFTER a full reply: a re-delivered copy of the same update dedupes — no second reply', { timeout: 120_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'thea2-crash-'));
    const clock = new TestClock(T0);
    const boot = async (m: MockModel, ch: ReturnType<typeof FakeChannel>) =>
      compose(loadConfig(FIXTURE, HERMETIC_ENV), 'hermetic', { varDir: dir, clock, rng: makeRng('crash'), model: m, channel: ch });

    // --- life 1: a complete golden turn, then the process "dies" ---
    const m1 = new MockModel({ clock });
    const ch1 = FakeChannel({ clock, chatId: CHAT });
    m1.enqueue({ content: decisionJson({ bubbles: ['only once'] }) });
    enqueueAppraisal(m1);
    const s1 = await boot(m1, ch1);
    const h1handle = startThead(s1);
    ch1.queueInbound(inboundMsg({ updateId: 600, msgId: 950 }));
    await runToQuiescent({ sys: s1, model: m1, channel: ch1, clock, dir });
    expect(ch1.outbound()).toHaveLength(1);
    await h1handle.stop(); // the crash: state on disk, offset NOT advanced past the crash point in the wire's view

    // --- life 2: fresh composition over the same var/, Telegram redelivers ---
    const m2 = new MockModel({ clock });
    const ch2 = FakeChannel({ clock, chatId: CHAT });
    const s2 = await boot(m2, ch2);
    const handle2 = startThead(s2);
    ch2.queueInbound(inboundMsg({ updateId: 600, msgId: 950 })); // the SAME update
    await settle();
    await s2.pipeline.drain();

    // Dedupe at the ledger: no model call, no second bubble.
    expect(m2.calls).toHaveLength(0);
    expect(ch2.outbound()).toHaveLength(0);
    // The offset already sits past the update — the wire would not even have
    // redelivered it; a stray copy is still caught by the ledger's dedupe.
    expect((await s2.offsets.read()).committed).toBe(600);
    await handle2.stop();
  });

  it('crash AFTER ledger append but BEFORE the turn ran: the boot reconcile alarms the loss AND re-runs the young one', { timeout: 120_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'thea2-crash2-'));
    const clock = new TestClock(T0);
    const boot = async (m: MockModel, ch: ReturnType<typeof FakeChannel>) =>
      compose(loadConfig(FIXTURE, HERMETIC_ENV), 'hermetic', { varDir: dir, clock, rng: makeRng('crash2'), model: m, channel: ch });

    // --- life 1: the message is ledgered, the process dies before it runs ---
    const m1 = new MockModel({ clock });
    const ch1 = FakeChannel({ clock, chatId: CHAT });
    const s1 = await boot(m1, ch1);
    await s1.ledger.recordInbound(inboundMsg({ updateId: 610, msgId: 960 }));
    // no turn, no offset commit — the crash window

    // --- life 2: boot over the same var/; the raw reconcile alarms on L0 ---
    const m2 = new MockModel({ clock });
    const ch2 = FakeChannel({ clock, chatId: CHAT });
    const s2 = await boot(m2, ch2);
    await clock.advance(11 * 60_000); // past the lost-reply window, inside the re-run grace
    const bootAlarms = await s2.ledger.reconcile(clock.epochMs());
    expect(bootAlarms.filter((d) => d.kind === 'LOST_REPLY')).toHaveLength(1);

    // Recovery law (Phase 1): a loss younger than the grace is ANSWERED, not
    // just mourned — the boot reconcile re-runs it through the whole pipeline,
    // once, stamped `bridge.reply_rerun`.
    m2.enqueue({ content: decisionJson({ bubbles: ['still here — you were saying?'] }) });
    enqueueAppraisal(m2);
    const handle = startThead(s2);
    await runToQuiescent({ sys: s2, model: m2, channel: ch2, clock, dir });
    // the em-dash normalizer rewrites the bubble before the gate — the wire
    // contract, proven on the recovery path too
    expect(ch2.outbound().map((s) => s.text)).toEqual(['still here. you were saying?']);
    const kinds: string[] = [];
    for await (const e of s2.events.replay()) kinds.push(e.kind);
    expect(kinds).toContain('bridge.reply_rerun');
    // the ledger is clean again: the re-run linked the inbound to a delivered turn
    const afterRecovery = await s2.ledger.reconcile(clock.epochMs());
    expect(afterRecovery.filter((d) => d.kind === 'LOST_REPLY')).toEqual([]);

    // Telegram redelivers (offset never committed): deduped — the recovery
    // already owns this message, a second reply would be a lie.
    const turnCalls = (): number => m2.calls.filter((c) => c.taskClass === 'turn').length;
    const callsBeforeRedelivery = turnCalls();
    ch2.queueInbound(inboundMsg({ updateId: 610, msgId: 960 }));
    await settle();
    await s2.pipeline.drain();
    expect(turnCalls()).toBe(callsBeforeRedelivery);
    expect(ch2.outbound()).toHaveLength(1);

    // A NEW message after restart runs normally — the system is alive.
    m2.enqueue({ content: decisionJson({ bubbles: ['alive again'] }) });
    enqueueAppraisal(m2);
    ch2.queueInbound(inboundMsg({ updateId: 611, msgId: 961, text: 'you there?' }));
    await runToQuiescent({ sys: s2, model: m2, channel: ch2, clock, dir });
    expect(ch2.outbound().map((s) => s.text)).toEqual(['still here. you were saying?', 'alive again']);
    await handle.stop();
  });
});

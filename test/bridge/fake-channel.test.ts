// M15 bridge — FakeChannel as a test double with teeth. The S2 gate names it
// directly: a send inside the 1.1s gap or over the char cap throws HERE, red in
// CI, instead of surfacing as a 429 in prod. The producer side is a plain queue
// with waiters — no timers — so tests schedule inbound explicitly.

import { describe, expect, it } from 'vitest';
import { TestClock } from '../../src/kernel/clock.js';
import { FAKE_FIRST_MSG_ID, FakeChannel, TELEGRAM_LIMITS, type InboundMsg } from '../../src/bridge/index.js';
import { DIEGO_TG_ID, msg } from './helpers.js';

const T0 = 1_788_000_000_000;

describe('FakeChannel — send physics (the limits are load-bearing)', () => {
  it('AC: a send over maxMsgChars throws bridge/limit-max-chars; exactly at the cap passes', async () => {
    const ch = FakeChannel({ clock: new TestClock(T0) });
    const long = 'x'.repeat(TELEGRAM_LIMITS.maxMsgChars + 1);
    await expect(ch.send(8123456, long)).rejects.toMatchObject({ code: 'bridge/limit-max-chars' });
    expect(ch.outbound()).toHaveLength(0); // the rejected send left nothing behind
    await expect(ch.send(8123456, 'x'.repeat(TELEGRAM_LIMITS.maxMsgChars))).resolves.toEqual({
      msgId: FAKE_FIRST_MSG_ID,
    });
  });

  it('AC: a send inside minSendGapMs throws bridge/limit-send-gap; at exactly the gap it goes through', async () => {
    const clock = new TestClock(T0);
    const ch = FakeChannel({ clock });
    await ch.send(8123456, 'primero');
    await clock.advance(TELEGRAM_LIMITS.minSendGapMs - 1);
    await expect(ch.send(8123456, 'muy rápido')).rejects.toMatchObject({ code: 'bridge/limit-send-gap' });
    expect(ch.outbound()).toHaveLength(1);
    await clock.advance(1); // 1100ms since the first send — the boundary itself is allowed
    await expect(ch.send(8123456, 'ahora sí')).resolves.toEqual({ msgId: FAKE_FIRST_MSG_ID + 1 });
  });

  it('the gap is per chat — one conversation in flight never throttles another', async () => {
    const clock = new TestClock(T0);
    const ch = FakeChannel({ clock });
    await ch.send(111, 'a');
    await expect(ch.send(222, 'b')).resolves.toEqual({ msgId: FAKE_FIRST_MSG_ID + 1 });
    await expect(ch.send(111, 'c')).rejects.toMatchObject({ code: 'bridge/limit-send-gap' });
  });

  it('captures outbound in send order with deterministic msgIds and the injected clock time', async () => {
    const clock = new TestClock(T0);
    const ch = FakeChannel({ clock });
    await ch.send(1, 'uno');
    await clock.advance(2000);
    await ch.send(1, 'dos');
    expect(ch.outbound()).toEqual([
      { chatId: 1, text: 'uno', msgId: FAKE_FIRST_MSG_ID, at: T0 },
      { chatId: 1, text: 'dos', msgId: FAKE_FIRST_MSG_ID + 1, at: T0 + 2000 },
    ]);
  });
});

describe('FakeChannel — producer side (the queue is the schedule)', () => {
  it('yields queued inbounds FIFO, exactly as scripted', async () => {
    const ch = FakeChannel({ clock: new TestClock(T0) });
    const first = msg({ updateId: 1 });
    const second = msg({ updateId: 2 });
    ch.queueInbound(first);
    ch.queueInbound(second);
    expect(ch.pending()).toBe(2);

    const got: InboundMsg[] = [];
    const ac = new AbortController();
    for await (const m of ch.updates(ac.signal)) {
      got.push(m);
      if (got.length === 2) break;
    }
    expect(got).toEqual([first, second]);
    expect(ch.pending()).toBe(0);
  });

  it('a blocked iteration wakes on queueInbound — no timers, just the waiter', async () => {
    const ch = FakeChannel({ clock: new TestClock(T0) });
    const ac = new AbortController();
    const iter = ch.updates(ac.signal)[Symbol.asyncIterator]();
    const pulling = iter.next(); // nothing queued: parks on the waiter
    ch.queueInbound(msg({ updateId: 7, text: 'tardío' }));
    const res = await pulling;
    expect(res.done).toBe(false);
    expect(res.value).toEqual(msg({ updateId: 7, text: 'tardío' }));
  });

  it('aborting a blocked iteration ends the generator cleanly — done, not thrown', async () => {
    const ch = FakeChannel({ clock: new TestClock(T0) });
    const ac = new AbortController();
    const iter = ch.updates(ac.signal)[Symbol.asyncIterator]();
    const blocked = iter.next();
    ac.abort(); // shutdown mid-park: the process is going away, the loop must stop
    await expect(blocked).resolves.toMatchObject({ done: true });
  });
});

describe('FakeChannel — injectReaction', () => {
  it('synthesizes a reaction arrival: msgId = the message reacted to, ts from the clock, configured speaker', async () => {
    const clock = new TestClock(T0);
    const ch = FakeChannel({
      clock,
      chatId: DIEGO_TG_ID,
      reactionSpeaker: { person: 'diego', channel: 'telegram' },
    });
    ch.injectReaction({ emoji: '🔥', toMsgId: 5001 });
    ch.injectReaction({ emoji: '👀', toMsgId: 5002 });

    const ac = new AbortController();
    const got: InboundMsg[] = [];
    for await (const m of ch.updates(ac.signal)) {
      got.push(m);
      if (got.length === 2) break;
    }
    expect(got).toEqual([
      {
        updateId: 1,
        msgId: 5001,
        chatId: DIEGO_TG_ID,
        ts: T0,
        text: '',
        speaker: { person: 'diego', channel: 'telegram' },
        reaction: { emoji: '🔥', toMsgId: 5001 },
      },
      {
        updateId: 2,
        msgId: 5002,
        chatId: DIEGO_TG_ID,
        ts: T0,
        text: '',
        speaker: { person: 'diego', channel: 'telegram' },
        reaction: { emoji: '👀', toMsgId: 5002 },
      },
    ]);
  });
});

describe('FakeChannel — typing and limits', () => {
  it('typing actions are captured in order with the clock time', async () => {
    const clock = new TestClock(T0);
    const ch = FakeChannel({ clock });
    await ch.typing(555);
    await clock.advance(500);
    await ch.typing(555);
    expect(ch.typings()).toEqual([
      { chatId: 555, at: T0 },
      { chatId: 555, at: T0 + 500 },
    ]);
  });

  it('limits default to TELEGRAM_LIMITS verbatim; opts tighten on top, never loosen', () => {
    expect(FakeChannel().limits).toEqual(TELEGRAM_LIMITS);
    const tightened = FakeChannel({ limits: { maxMsgChars: 100 } });
    expect(tightened.limits).toEqual({ ...TELEGRAM_LIMITS, maxMsgChars: 100 });
    expect(tightened.limits.minSendGapMs).toBe(TELEGRAM_LIMITS.minSendGapMs);
  });
});

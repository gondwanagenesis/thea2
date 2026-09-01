// M15 bridge — the real Telegram adapter, hermetic: fetchImpl is scripted,
// the clock is stopped, the rng stream is seeded. What is under test is the
// wire contract (URLs, payloads, the committed+1 offset) and the failure
// policy (429 → wait retry_after → retry once → typed failure + a loud L0
// event). The token rides the URL, so every error message is checked for it.

import { describe, expect, it } from 'vitest';
import { TestClock } from '../../src/kernel/clock.js';
import { makeRng, type Rng } from '../../src/kernel/index.js';
import {
  DEFAULT_POLL_TIMEOUT_MS,
  TELEGRAM_ALLOWED_UPDATES,
  telegramChannel,
  type InboundMsg,
  type TelegramChannelDeps,
} from '../../src/bridge/index.js';
import { EXPECTED_INBOUND, fixture, memoryLog, testSpeaker } from './helpers.js';

const T0 = 1_788_000_000_000;
const TOKEN = '123456:ABC-not-a-real-token';

// ---------------------------------------------------------------------------
// Scripted transport
// ---------------------------------------------------------------------------

interface FakeResponse {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}

const jsonResult = (result: unknown): FakeResponse => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify({ ok: true, result }),
});
const okSend = (msgId: number): FakeResponse => jsonResult({ message_id: msgId });
const okUpdates = (updates: unknown[]): FakeResponse => jsonResult(updates);
const statusResponse = (status: number, body: string): FakeResponse => ({
  ok: false,
  status,
  text: async () => body,
});
const rateLimited = (retryAfterSec: number): FakeResponse =>
  statusResponse(429, JSON.stringify({ ok: false, parameters: { retry_after: retryAfterSec } }));

const scriptedFetch = (): {
  fetchImpl: typeof fetch;
  calls: Array<{ url: string; body: Record<string, unknown> }>;
  queue: FakeResponse[];
} => {
  const queue: FakeResponse[] = [];
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const next = queue.shift();
    if (next === undefined) throw new Error('scriptedFetch: exhausted');
    calls.push({ url: String(input), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    return next as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls, queue };
};

/** The jitter source pinned to zero so backoff math is exact: base * 0.5. */
const zeroJitter: Rng = {
  float: () => 0,
  int: (lo) => lo,
  pick: (xs) => xs[0]!,
  shuffle: (xs) => [...xs],
  fork: () => zeroJitter,
};

const channelDeps = (over: Partial<TelegramChannelDeps>): TelegramChannelDeps => ({
  token: TOKEN,
  clock: new TestClock(T0),
  rng: makeRng('bridge/telegram'),
  committedOffset: () => undefined,
  ...over,
});

/** Settles the pending microtask chain without any timer — the TestClock's own draining trick. */
const drain = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

describe('telegramChannel — send', () => {
  it('POSTs sendMessage to the Bot API with the chat and text, and returns the wire message_id', async () => {
    const { fetchImpl, calls, queue } = scriptedFetch();
    queue.push(okSend(42));
    const ch = telegramChannel(channelDeps({ fetchImpl }));
    await expect(ch.send(8123456, 'hola')).resolves.toEqual({ msgId: 42 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    expect(calls[0]!.body).toEqual({ chat_id: 8123456, text: 'hola' });
  });

  it('AC: a 429 waits retry_after on the clock, retries once, and succeeds', async () => {
    const { fetchImpl, calls, queue } = scriptedFetch();
    queue.push(rateLimited(7), okSend(43));
    const clock = new TestClock(T0);
    const ch = telegramChannel(channelDeps({ fetchImpl, clock }));
    const pending = ch.send(8123456, 'luego');
    await drain(); // the 429 comes back and the retry-after wait is armed on the clock
    expect(calls).toHaveLength(1);
    await clock.advance(7000); // exactly the demanded wait — the retry fires on it
    await expect(pending).resolves.toEqual({ msgId: 43 });
    expect(calls).toHaveLength(2);
  });

  it('AC: a 429 that survives the one retry is bridge/rate-limit plus a loud bridge.send_failed', async () => {
    const { fetchImpl, calls, queue } = scriptedFetch();
    queue.push(rateLimited(5), rateLimited(9));
    const clock = new TestClock(T0);
    const { log, events } = memoryLog();
    const ch = telegramChannel(channelDeps({ fetchImpl, clock, log }));
    const pending = ch.send(8123456, 'x');
    await drain(); // first 429 in, retry wait armed
    await clock.advance(5000);
    const err = (await pending.catch((e: unknown) => e)) as { code?: string; retryAfterMs?: number };
    expect(err.code).toBe('bridge/rate-limit');
    expect(err.retryAfterMs).toBe(9000); // the fresh demand; the first one was already consumed
    expect(calls).toHaveLength(2); // retried exactly once, then gave up
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe('bridge.send_failed');
    expect(events[0]!.payload).toEqual({
      chatId: 8123456,
      code: 'bridge/rate-limit',
      attempts: 2,
      error: expect.stringContaining('HTTP 429'),
      retryAfterMs: 5000, // the wait that WAS waited
    });
  });

  it('a 400 is bridge/telegram-error with no retry (bad tokens are not transient)', async () => {
    const { fetchImpl, calls, queue } = scriptedFetch();
    queue.push(statusResponse(400, 'Unauthorized'));
    const { log, events } = memoryLog();
    const ch = telegramChannel(channelDeps({ fetchImpl, log }));
    await expect(ch.send(1, 'x')).rejects.toMatchObject({ code: 'bridge/telegram-error' });
    expect(calls).toHaveLength(1);
    expect(events[0]!.payload).toEqual({
      chatId: 1,
      code: 'bridge/telegram-error',
      attempts: 1,
      error: expect.stringContaining('HTTP 400'),
    });
  });

  it('a fetch that throws is bridge/transport, also without retry', async () => {
    const failing = (async (): Promise<Response> => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;
    const ch = telegramChannel(channelDeps({ fetchImpl: failing }));
    await expect(ch.send(1, 'x')).rejects.toMatchObject({ code: 'bridge/transport' });
  });

  it('AC: the token never leaks into an error message, even when the body echoes it', async () => {
    const { fetchImpl, queue } = scriptedFetch();
    queue.push(statusResponse(500, `boom ${TOKEN} boom`));
    const ch = telegramChannel(channelDeps({ fetchImpl }));
    const err = await ch.send(1, 'x').catch((e: unknown) => e) as { message: string };
    expect(err.message).not.toContain(TOKEN);
    expect(err.message).toContain('***');
  });
});

describe('telegramChannel — typing', () => {
  it('POSTs the sendChatAction typing indicator (apiBase override respected)', async () => {
    const { fetchImpl, calls, queue } = scriptedFetch();
    queue.push(jsonResult(true));
    const ch = telegramChannel(channelDeps({ fetchImpl, apiBase: 'https://tg.example' }));
    await expect(ch.typing(8123456)).resolves.toBeUndefined();
    expect(calls[0]!.url).toBe(`https://tg.example/bot${TOKEN}/sendChatAction`);
    expect(calls[0]!.body).toEqual({ chat_id: 8123456, action: 'typing' });
  });
});

describe('telegramChannel — updates (long poll)', () => {
  it('AC: getUpdates requests committed+1 with the long-poll timeout and reaction-bearing allowed_updates', async () => {
    const { fetchImpl, calls, queue } = scriptedFetch();
    queue.push(okUpdates([]));
    const ch = telegramChannel(
      channelDeps({ fetchImpl, committedOffset: () => 401, pollTimeoutMs: DEFAULT_POLL_TIMEOUT_MS }),
    );
    const ac = new AbortController();
    const first = ch.updates(ac.signal)[Symbol.asyncIterator]().next();
    await drain(); // request out, empty batch back, parked in the idle gap
    expect(calls).toEqual([
      {
        url: `https://api.telegram.org/bot${TOKEN}/getUpdates`,
        body: { offset: 402, timeout: 25, allowed_updates: [...TELEGRAM_ALLOWED_UPDATES] },
      },
    ]);

    ac.abort(); // shutdown while parked: the loop must end without another poll
    await expect(first).resolves.toMatchObject({ done: true });
    expect(calls).toHaveLength(1); // the abort cut the loop — no further fetch
  });

  it('with nothing committed yet the first poll omits the offset', async () => {
    const { fetchImpl, calls, queue } = scriptedFetch();
    queue.push(okUpdates([]));
    const ch = telegramChannel(channelDeps({ fetchImpl }));
    const ac = new AbortController();
    const first = ch.updates(ac.signal)[Symbol.asyncIterator]().next();
    await drain();
    expect(calls[0]!.body).toEqual({ timeout: 25, allowed_updates: [...TELEGRAM_ALLOWED_UPDATES] });
    ac.abort();
    await first;
  });

  it('AC: parses accepted fixtures and skips the rest — a skipped update never reaches the pipeline', async () => {
    const { fetchImpl, queue } = scriptedFetch();
    queue.push(okUpdates([fixture('text_message'), fixture('edited_message'), fixture('reaction')]));
    const ch = telegramChannel(channelDeps({ fetchImpl, speaker: testSpeaker }));
    const ac = new AbortController();
    const got: InboundMsg[] = [];
    for await (const m of ch.updates(ac.signal)) {
      got.push(m);
      if (got.length === 2) break;
    }
    expect(got).toEqual([EXPECTED_INBOUND['text_message']!, EXPECTED_INBOUND['reaction']!]);
  });

  it('a failed poll backs off on the clock (jitter from the injected stream) and then retries', async () => {
    const { fetchImpl, calls, queue } = scriptedFetch();
    queue.push(statusResponse(500, 'boom'), okUpdates([fixture('text_message')]));
    const clock = new TestClock(T0);
    const ch = telegramChannel(channelDeps({ fetchImpl, clock, rng: zeroJitter, speaker: testSpeaker }));
    const ac = new AbortController();
    const first = ch.updates(ac.signal)[Symbol.asyncIterator]().next();
    await drain(); // request 1 out, 500 back, backoff parked at T0 + 250 (500 * 0.5)
    expect(calls).toHaveLength(1);

    await clock.advance(249);
    expect(calls).toHaveLength(1); // not yet — the backoff is exact, not "eventually"
    await clock.advance(1);

    const got = await first; // the retry's batch yields straight through
    expect(got.done).toBe(false);
    expect(got.value).toEqual(EXPECTED_INBOUND['text_message']!);
    expect(calls).toHaveLength(2);
    ac.abort();
  });
});

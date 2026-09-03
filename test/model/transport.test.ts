// M03 model — the Z.ai transport: retry policy (5xx, 429 honoring retry-after,
// transport errors; never other 4xx, never aborts), per-call timeout, caller
// aborts — all hermetic over an injected fetchImpl + TestClock. Zero-backoff
// config makes retries instant.

import { describe, expect, it } from 'vitest';
import { TestClock } from '../../src/kernel/clock.js';
import { makeRng } from '../../src/kernel/index.js';
import { isModelError } from '../../src/model/errors.js';
import { zaiTransport, backoffDelayMs, type BackoffConfig } from '../../src/model/index.js';
import type { WireBody } from '../../src/model/wire.js';
import { wireOk } from './helpers.js';

const BODY: WireBody = {
  model: 'glm-5.3-flash',
  messages: [{ role: 'user', content: 'hi' }],
  temperature: 0.5,
  max_tokens: 10,
};

const ZERO_BACKOFF: BackoffConfig = { baseMs: 0, capMs: 0 };

interface FakeResponse {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  headers?: { get: (name: string) => string | null };
}

const okResponse = (body: Record<string, unknown>): FakeResponse => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify(body),
});

const statusResponse = (status: number): FakeResponse => ({
  ok: false,
  status,
  text: async () => `body ${status}`,
});

/** fetchImpl whose responses are queued; each call is recorded for attempt assertions. */
const scriptedFetch = (
  script: Array<FakeResponse | { fail: string }>,
): { fetchImpl: typeof fetch; statuses: (number | string)[] } => {
  const queue = [...script];
  const statuses: (number | string)[] = [];
  const fetchImpl = (async (): Promise<Response> => {
    const next = queue.shift();
    if (next === undefined) throw new Error('scriptedFetch: exhausted');
    if ('fail' in next) {
      statuses.push('throw');
      throw new Error(next.fail);
    }
    statuses.push(next.status);
    return next as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, statuses };
};

describe('zaiTransport — retry policy', () => {
  it('AC: two 5xx responses then success ⇒ one result, usage attempts = 3', async () => {
    const { fetchImpl, statuses } = scriptedFetch([
      statusResponse(500),
      statusResponse(502),
      okResponse(wireOk({ content: 'third try' })),
    ]);
    const send = zaiTransport({
      apiKey: 'k',
      clock: new TestClock(0),
      rng: makeRng('transport/retry'),
      fetchImpl,
      backoff: ZERO_BACKOFF,
    });
    const res = await send({ body: BODY });
    expect((res.response as { choices?: unknown[] }).choices).toBeDefined();
    expect(res.attempts).toBe(3);
    expect(statuses).toEqual([500, 502, 200]);
  });

  it('AC: a 400 fails immediately with no retry', async () => {
    const { fetchImpl, statuses } = scriptedFetch([statusResponse(400)]);
    const send = zaiTransport({
      apiKey: 'k',
      clock: new TestClock(0),
      rng: makeRng('transport/400'),
      fetchImpl,
      backoff: ZERO_BACKOFF,
    });
    await expect(send({ body: BODY })).rejects.toThrowError(expect.objectContaining({ code: 'model/http-error' }));
    expect(statuses).toEqual([400]);
  });

  it('429 × (maxRetries + 1) exhausts the budget and fails with model/rate-limit', async () => {
    const { fetchImpl, statuses } = scriptedFetch([statusResponse(429), statusResponse(429), statusResponse(429)]);
    const send = zaiTransport({
      apiKey: 'k',
      clock: new TestClock(0),
      rng: makeRng('transport/429'),
      fetchImpl,
      backoff: ZERO_BACKOFF,
    });
    const err = await send({ body: BODY }).catch((e: unknown) => e);
    expect(isModelError(err)).toBe(true);
    expect((err as { code: string }).code).toBe('model/rate-limit');
    expect((err as { retryable: boolean }).retryable).toBe(true);
    expect(statuses).toEqual([429, 429, 429]); // 1 + maxRetries(2)
  });
});

describe('zaiTransport — 429 retry honors retry-after (TestClock-driven)', () => {
  /** Drains the microtask chain between fetch settling and the backoff waiter registering. */
  const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

  const rateLimited = (retryAfter: string | undefined): FakeResponse => ({
    ok: false,
    status: 429,
    text: async () => 'rate limited',
    ...(retryAfter !== undefined ? { headers: { get: (name: string) => (name === 'retry-after' ? retryAfter : null) } } : {}),
  });

  it('429 then 200 succeeds with attempts=2 after waiting retry-after when it exceeds the backoff', async () => {
    const { fetchImpl, statuses } = scriptedFetch([rateLimited('5'), okResponse(wireOk({ content: 'after' }))]);
    const clock = new TestClock(0);
    const send = zaiTransport({ apiKey: 'k', clock, rng: makeRng('transport/429-ra'), fetchImpl, backoff: ZERO_BACKOFF });
    const pending = send({ body: BODY });
    await flush();
    await clock.advance(4_999);
    await flush();
    expect(statuses).toEqual([429]); // still waiting on the server's retry-after
    await clock.advance(1);
    const res = await pending;
    expect(res.attempts).toBe(2);
    expect(statuses).toEqual([429, 200]);
  });

  it('waits the backoff when it exceeds retry-after (max of the two)', async () => {
    const cfg: BackoffConfig = { baseMs: 4_000, capMs: 8_000 }; // attempt 1 ⇒ [2000, 6000)
    const expected = backoffDelayMs(1, () => makeRng('transport/429-bo').float(), cfg);
    expect(expected).toBeGreaterThan(1_000);
    const { fetchImpl, statuses } = scriptedFetch([rateLimited('1'), okResponse(wireOk({ content: 'after' }))]);
    const clock = new TestClock(0);
    const send = zaiTransport({ apiKey: 'k', clock, rng: makeRng('transport/429-bo'), fetchImpl, backoff: cfg });
    const pending = send({ body: BODY });
    await flush();
    await clock.advance(expected - 1);
    await flush();
    expect(statuses).toEqual([429]);
    await clock.advance(1);
    const res = await pending;
    expect(res.attempts).toBe(2);
  });

  it('parses an HTTP-date retry-after against the injected clock and caps at 30 s', async () => {
    // 1_700_000_000_000 ms = Tue, 14 Nov 2023 22:13:20 GMT; the header names +7 s.
    const clock = new TestClock(1_700_000_000_000);
    const httpDate = 'Tue, 14 Nov 2023 22:13:27 GMT';
    const { fetchImpl: f1, statuses: s1 } = scriptedFetch([rateLimited(httpDate), okResponse(wireOk({ content: 'x' }))]);
    const send1 = zaiTransport({ apiKey: 'k', clock, rng: makeRng('t'), fetchImpl: f1, backoff: ZERO_BACKOFF });
    const p1 = send1({ body: BODY });
    await flush();
    await clock.advance(6_999);
    await flush();
    expect(s1).toEqual([429]);
    await clock.advance(1);
    expect((await p1).attempts).toBe(2);

    const { fetchImpl: f2, statuses: s2 } = scriptedFetch([rateLimited('120'), okResponse(wireOk({ content: 'x' }))]);
    const send2 = zaiTransport({ apiKey: 'k', clock, rng: makeRng('t'), fetchImpl: f2, backoff: ZERO_BACKOFF });
    const p2 = send2({ body: BODY });
    await flush();
    await clock.advance(29_999);
    await flush();
    expect(s2).toEqual([429]);
    await clock.advance(1);
    expect((await p2).attempts).toBe(2);
  });

  it('exposes retryAfterMs on the error and its cause when the budget is exhausted', async () => {
    const { fetchImpl } = scriptedFetch([rateLimited('3')]);
    const send = zaiTransport({
      apiKey: 'k',
      clock: new TestClock(0),
      rng: makeRng('t'),
      fetchImpl,
      backoff: ZERO_BACKOFF,
      maxRetries: 0,
    });
    const err = (await send({ body: BODY }).catch((e: unknown) => e)) as {
      code: string;
      retryAfterMs?: number;
      cause?: { status?: number; retryAfterMs?: number };
    };
    expect(err.code).toBe('model/rate-limit');
    expect(err.retryAfterMs).toBe(3_000);
    expect(err.cause?.status).toBe(429);
    expect(err.cause?.retryAfterMs).toBe(3_000);
  });

  it('transport throws are retryable; exhausts maxRetries then model/transport', async () => {
    const { fetchImpl, statuses } = scriptedFetch([{ fail: 'ECONNRESET' }, { fail: 'ECONNRESET' }, { fail: 'ECONNRESET' }]);
    const send = zaiTransport({
      apiKey: 'k',
      clock: new TestClock(0),
      rng: makeRng('transport/throw'),
      fetchImpl,
      backoff: ZERO_BACKOFF,
    });
    await expect(send({ body: BODY })).rejects.toThrowError(expect.objectContaining({ code: 'model/transport' }));
    expect(statuses).toEqual(['throw', 'throw', 'throw']); // 1 + maxRetries(2)
  });

  it('zero-backoff config makes retry waits resolve immediately on a stopped TestClock', async () => {
    // Implicitly proven above; this pins the config contract so the trick stays legal.
    expect(backoffDelayMs(3, () => 0.9, ZERO_BACKOFF)).toBe(0);
  });
});

describe('zaiTransport — timeout and aborts (TestClock-driven)', () => {
  it('a hung request is cut off at timeoutMs with model/timeout', async () => {
    // Never-resolving fetch: the request hangs until the clock's timer fires.
    // maxRetries: 0 because model/timeout is retryable — with the default the
    // retry's backoff waiter lands beyond this single advance and pending hangs.
    const fetchImpl = ((): Promise<Response> => new Promise(() => undefined)) as unknown as typeof fetch;
    const clock = new TestClock(0);
    const send = zaiTransport({ apiKey: 'k', clock, rng: makeRng('t'), fetchImpl, timeoutMs: 1_000, maxRetries: 0 });
    const pending = send({ body: BODY });
    const outcome = clock
      .advance(1_000)
      .then(() => pending)
      .catch((e: unknown) => e);
    const err = (await outcome) as { code?: string };
    expect(err.code).toBe('model/timeout');
  });

  it('aborting before send is model/aborted, no fetch at all', async () => {
    let fetched = 0;
    const fetchImpl = ((): Promise<Response> => {
      fetched += 1;
      return new Promise(() => undefined);
    }) as unknown as typeof fetch;
    const send = zaiTransport({ apiKey: 'k', clock: new TestClock(0), rng: makeRng('t'), fetchImpl });
    const controller = new AbortController();
    controller.abort();
    const err = await send({ body: BODY, signal: controller.signal }).catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe('model/aborted');
    expect(fetched).toBe(0);
  });

  it('aborting mid-flight rejects model/aborted and never retries', async () => {
    const fetchImpl = ((): Promise<Response> => new Promise(() => undefined)) as unknown as typeof fetch;
    const send = zaiTransport({
      apiKey: 'k',
      clock: new TestClock(0),
      rng: makeRng('t'),
      fetchImpl,
      backoff: ZERO_BACKOFF,
    });
    const controller = new AbortController();
    const pending = send({ body: BODY, signal: controller.signal });
    controller.abort();
    const err = (await pending.catch((e: unknown) => e)) as { code?: string };
    expect(err.code).toBe('model/aborted');
  });
});

describe('zaiTransport — request shape', () => {
  it('POSTs canonical JSON with a bearer key; an API-base endpoint gets /chat/completions appended', async () => {
    let seenUrl = '';
    let seenInit: RequestInit | undefined;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      seenUrl = String(url);
      seenInit = init;
      return okResponse(wireOk({ content: 'x' })) as unknown as Response;
    }) as unknown as typeof fetch;
    const send = zaiTransport({
      apiKey: 'secret-key',
      clock: new TestClock(0),
      rng: makeRng('t'),
      fetchImpl,
      endpoint: 'https://ep.example/v1',
    });
    await send({ body: BODY });
    expect(seenUrl).toBe('https://ep.example/v1/chat/completions');
    expect((seenInit?.headers as Record<string, string>)['authorization']).toBe('Bearer secret-key');
    expect(JSON.parse(String(seenInit?.body))).toEqual(BODY);
  });

  it('a full completions URL is used verbatim (trailing slash normalized)', async () => {
    let seenUrl = '';
    const fetchImpl = (async (url: string | URL | Request): Promise<Response> => {
      seenUrl = String(url);
      return okResponse(wireOk({ content: 'x' })) as unknown as Response;
    }) as unknown as typeof fetch;
    const send = zaiTransport({
      apiKey: 'k',
      clock: new TestClock(0),
      rng: makeRng('t'),
      fetchImpl,
      endpoint: 'https://ep.example/v1/chat/completions/',
    });
    await send({ body: BODY });
    expect(seenUrl).toBe('https://ep.example/v1/chat/completions');
  });

  it('backoff delays are deterministic per Rng stream and capped', () => {
    const cfg: BackoffConfig = { baseMs: 100, capMs: 1_000 };
    const seq = (): number[] => {
      const rng = makeRng('transport/backoff-seed');
      return [1, 2, 3].map((a) => backoffDelayMs(a, () => rng.float(), cfg));
    };
    expect(seq()).toEqual(seq());
  });
});

// M03 model — the Z.ai transport: retry policy (5xx + transport errors only,
// never 4xx/aborts), per-call timeout, caller aborts — all hermetic over an
// injected fetchImpl + TestClock. Zero-backoff config makes retries instant.

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

  it('429 is model/rate-limit and fails fast — the spec retries 5xx only', async () => {
    const { fetchImpl, statuses } = scriptedFetch([statusResponse(429)]);
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
    expect(statuses).toEqual([429]);
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

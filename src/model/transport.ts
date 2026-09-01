// M03 model — the Z.ai transport: one HTTP POST with per-call timeout, typed
// error mapping, and (spec) 2 retries on transport errors and 5xx only.
//
// Every impulse that could touch the outside world goes through an injected
// seam: fetchImpl (tests inject a fake), Clock (timeouts + backoff sleeps), and
// Rng (backoff jitter). The api key arrives as an injected string — M20 passes
// process.env.ZAI_API_KEY; this module never reads env itself.

import type { Clock, Rng } from '../kernel/index.js';
import { isModelError, isRetryable, modelError } from './errors.js';
import {
  DEFAULT_BACKOFF,
  DEFAULT_MAX_RETRIES,
  DEFAULT_TIMEOUT_MS,
  ZAI_ENDPOINT,
  backoffDelayMs,
  type BackoffConfig,
} from './tiers.js';
import type { WireBody, WireResponse } from './wire.js';

export interface TransportCall {
  body: WireBody;
  /** Explicitly passable as undefined: callers hold `ctx?.signal`. */
  signal?: AbortSignal | undefined;
}

export interface TransportResult {
  response: WireResponse;
  /** HTTP attempts this logical send consumed (retries included). */
  attempts: number;
}

export type Transport = (call: TransportCall) => Promise<TransportResult>;

export interface ZaiTransportDeps {
  apiKey: string;
  clock: Clock;
  /** Backoff jitter source; a forked stream per client keeps runs reproducible. */
  rng: Rng;
  fetchImpl?: typeof fetch;
  endpoint?: string;
  timeoutMs?: number;
  maxRetries?: number;
  backoff?: BackoffConfig;
}

export const zaiTransport = (deps: ZaiTransportDeps): Transport => {
  const endpoint = deps.endpoint ?? ZAI_ENDPOINT;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = deps.maxRetries ?? DEFAULT_MAX_RETRIES;
  const backoff = deps.backoff ?? DEFAULT_BACKOFF;
  const doFetch = deps.fetchImpl ?? globalThis.fetch.bind(globalThis);

  const sendOnce = async (body: WireBody, signal: AbortSignal | undefined): Promise<WireResponse> => {
    const wire = new AbortController();
    const onCallerAbort = (): void => {
      wire.abort();
    };
    if (signal !== undefined) {
      if (signal.aborted) throw modelError('model/aborted', 'chat aborted before the request was sent');
      signal.addEventListener('abort', onCallerAbort, { once: true });
    }

    // Per-call deadline on the injected clock. The timer promise never rejects:
    // once the request settles first we abort the gate and leave it pending (it
    // is dead weight the moment the race is over).
    const timerGate = new AbortController();
    const timer: Promise<'timeout'> = deps.clock
      .waitUntil(deps.clock.epochMs() + timeoutMs, timerGate.signal)
      .then(
        () => 'timeout' as const,
        () => new Promise<'timeout'>(() => undefined),
      );
    const callerAbort = new Promise<never>((_, reject) => {
      const fire = (): void => reject(modelError('model/aborted', 'chat aborted by caller signal'));
      if (signal?.aborted) fire();
      else signal?.addEventListener('abort', fire, { once: true });
    });

    try {
      const response = await Promise.race([
        doFetch(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
            authorization: `Bearer ${deps.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: wire.signal,
        }),
        timer,
        callerAbort,
      ]);

      if (response === 'timeout') {
        wire.abort();
        throw modelError('model/timeout', `no response within ${timeoutMs} ms`, { retryable: true });
      }

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        // Spec retry policy: 5xx only. 429 (rate-limit) fails fast with its own code.
        throw modelError(
          response.status === 429 ? 'model/rate-limit' : 'model/http-error',
          `HTTP ${response.status} from ${endpoint}: ${truncate(text)}`,
          { cause: { status: response.status, body: truncate(text) }, retryable: response.status >= 500 },
        );
      }

      const text = await response.text();
      try {
        return JSON.parse(text) as WireResponse;
      } catch (e) {
        throw modelError('model/bad-json', `response body is not JSON: ${truncate(text)}`, { cause: e });
      }
    } catch (e) {
      if (signal?.aborted) throw modelError('model/aborted', 'chat aborted by caller signal', { cause: e });
      if (isModelError(e)) throw e;
      throw modelError('model/transport', `fetch failed for ${endpoint}: ${errMsg(e)}`, { cause: e, retryable: true });
    } finally {
      timerGate.abort(); // release the clock waiter
      signal?.removeEventListener('abort', onCallerAbort);
    }
  };

  return async (call) => {
    let attempt = 0;
    for (;;) {
      attempt += 1;
      try {
        const response = await sendOnce(call.body, call.signal);
        return { response, attempts: attempt };
      } catch (e) {
        if (isModelError(e) && e.code === 'model/aborted') throw e;
        if (attempt > maxRetries || !isRetryable(e)) throw e;
        const delay = backoffDelayMs(attempt, () => deps.rng.float(), backoff);
        try {
          await deps.clock.waitUntil(deps.clock.epochMs() + delay, call.signal);
        } catch (waitError) {
          throw modelError('model/aborted', 'chat aborted while waiting to retry', { cause: waitError });
        }
      }
    }
  };
};

const truncate = (text: string): string => (text.length > 400 ? `${text.slice(0, 400)}…` : text);

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

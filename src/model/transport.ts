// M03 model — the wire transport: one HTTP POST with per-call timeout, typed
// error mapping, and (spec) 2 retries on transport errors and 5xx only.
//
// Two protocols share the send/retry machinery:
//  - openai    (default) — chat/completions, Bearer auth, JSON in/out.
//  - anthropic — /v1/messages (z.ai's coding-plan door), x-api-key + version
//    header, and STREAMING: the body is sent with stream:true and the reply is
//    consumed as SSE, because a thinking model can hold a silent non-streaming
//    connection past every gateway timeout on the route. The deadline is per
//    chunk (idle), not total — deltas keep it fed, a stalled stream dies.
//
// Every impulse that could touch the outside world goes through an injected
// seam: fetchImpl (tests inject a fake), Clock (timeouts + backoff sleeps), and
// Rng (backoff jitter). The api key arrives as an injected string — M20 passes
// process.env; this module never reads env itself.

import type { Clock, Rng } from '../kernel/index.js';
import { isModelError, isRetryable, modelError, retryAfterMsOf } from './errors.js';
import { parseAnthropicSSE } from './anthropic.js';
import {
  ANTHROPIC_ENDPOINT,
  DEFAULT_BACKOFF,
  DEFAULT_MAX_RETRIES,
  DEFAULT_TIMEOUT_MS,
  ZAI_ENDPOINT,
  backoffDelayMs,
  type BackoffConfig,
} from './tiers.js';
import type { WireBody, WireResponse } from './wire.js';

export type WireProtocol = 'openai' | 'anthropic';

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
  /** Total wall-clock cap on one streamed reply (the dribble guard). Default
   * max(timeoutMs*15, 15 min). */
  streamTotalMs?: number;
  maxRetries?: number;
  backoff?: BackoffConfig;
  protocol?: WireProtocol;
}

export const zaiTransport = (deps: ZaiTransportDeps): Transport => {
  const anthropic = deps.protocol === 'anthropic';
  // `endpoint` is the API BASE (M20's config shares it with the embedder); the
  // protocol's path is added here unless the caller already passed a full URL.
  const raw = (deps.endpoint ?? (anthropic ? ANTHROPIC_ENDPOINT : ZAI_ENDPOINT)).replace(/\/+$/, '');
  const endpoint = anthropic
    ? raw.endsWith('/messages')
      ? raw
      : `${raw.replace(/\/v\d+$/, '')}/v1/messages`
    : raw.endsWith('/chat/completions')
      ? raw
      : `${raw}/chat/completions`;
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

    const wireBody =
      anthropic
        ? { ...body, stream: true } // SSE all the way down on this protocol
        : body;

    try {
      const response = await Promise.race([
        doFetch(endpoint, {
          method: 'POST',
          headers: anthropic
            ? {
                'content-type': 'application/json',
                accept: 'text/event-stream',
                'x-api-key': deps.apiKey,
                'anthropic-version': '2023-06-01',
              }
            : {
                'content-type': 'application/json',
                accept: 'application/json',
                authorization: `Bearer ${deps.apiKey}`,
              },
          body: JSON.stringify(wireBody),
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
        if (response.status === 429) {
          // Rate-limit: retryable within the budget, waiting what the server
          // asked for before anything else (the wire rule the loop enforces).
          const retryAfterMs = retryAfterOf(response, deps.clock.epochMs());
          throw modelError('model/rate-limit', `HTTP 429 from ${endpoint}: ${truncate(text)}`, {
            cause: { status: 429, body: truncate(text), ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) },
            retryable: true,
            ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
          });
        }
        // Spec retry policy: 5xx only, never other 4xx.
        throw modelError('model/http-error', `HTTP ${response.status} from ${endpoint}: ${truncate(text)}`, {
          cause: { status: response.status, body: truncate(text) },
          retryable: response.status >= 500,
        });
      }

      if (!anthropic) {
        const text = await response.text();
        try {
          return JSON.parse(text) as WireResponse;
        } catch (e) {
          throw modelError('model/bad-json', `response body is not JSON: ${truncate(text)}`, { cause: e });
        }
      }
      return (await consumeSSE(response, timerGate, wire, callerAbort)) as unknown as WireResponse;
    } catch (e) {
      if (signal?.aborted) throw modelError('model/aborted', 'chat aborted by caller signal', { cause: e });
      if (isModelError(e)) throw e;
      throw modelError('model/transport', `fetch failed for ${endpoint}: ${errMsg(e)}`, { cause: e, retryable: true });
    } finally {
      timerGate.abort(); // release the clock waiter
      signal?.removeEventListener('abort', onCallerAbort);
    }
  };

  /**
   * Streams the SSE body under an IDLE deadline: every chunk must arrive within
   * timeoutMs of the last, but a long thinking phase that keeps emitting never
   * times out. A TOTAL cap backs the idle deadline: a wedged stream that still
   * dribbles keepalive bytes would otherwise reset the idle race forever (this
   * hang was live-proven — 30+ min on one established socket). Test fakes
   * without a stream body degrade to response.text().
   */
  const consumeSSE = async (
    response: Response,
    outerGate: AbortController,
    wire: AbortController,
    callerAbort: Promise<never>,
  ): Promise<unknown> => {
    const streamTotalMs = deps.streamTotalMs ?? Math.max(timeoutMs * 15, 900_000);
    // One outer-gate listener, many timers: each armed timer swaps itself into
    // `activeGates` so the outer abort kills whatever is pending — without
    // accumulating a listener per streamed chunk.
    const activeGates = new Set<AbortController>();
    const outerKill = (): void => {
      for (const g of activeGates) g.abort();
    };
    outerGate.signal.addEventListener('abort', outerKill, { once: true });
    const armTimer = (ms: number, label: 'timeout' | 'total'): Promise<'timeout' | 'total'> => {
      const gate = new AbortController();
      activeGates.add(gate);
      const t = deps.clock
        .waitUntil(deps.clock.epochMs() + ms, gate.signal)
        .then(
          () => label,
          () => new Promise<'timeout' | 'total'>(() => undefined),
        )
        .finally(() => {
          activeGates.delete(gate);
        });
      return t;
    };
    const idleRace = (): Promise<'timeout'> => armTimer(timeoutMs, 'timeout') as Promise<'timeout'>;
    const totalRace = armTimer(streamTotalMs, 'total');
    const body = response.body;
    if (body === null || typeof (body as { getReader?: unknown }).getReader !== 'function') {
      const text = await Promise.race([response.text(), idleRace(), callerAbort]);
      if (text === 'timeout') {
        wire.abort();
        throw modelError('model/timeout', `sse body stalled within ${timeoutMs} ms`, { retryable: true });
      }
      return parseAnthropicSSE(text as string);
    }
    const reader = (body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let sse = '';
    try {
      for (;;) {
        const next = await Promise.race([reader.read(), idleRace(), totalRace, callerAbort]);
        if (next === 'timeout') {
          wire.abort();
          throw modelError('model/timeout', `sse stream idle beyond ${timeoutMs} ms`, { retryable: true });
        }
        if (next === 'total') {
          wire.abort();
          // Not retryable: a 15-minute dead stream re-asked is 15 more minutes
          // of dead — surface it and let the caller decide.
          throw modelError('model/timeout', `sse stream exceeded the ${Math.round(streamTotalMs / 1000)}s total cap`, {
            retryable: false,
          });
        }
        if (next.done) break;
        sse += decoder.decode(next.value, { stream: true });
      }
      sse += decoder.decode();
    } finally {
      // A read() may still be outstanding — the race above can settle via the
      // idle/total timers while a chunk read is in flight — and releaseLock
      // throws while one is pending, replacing the typed timeout with a
      // retryable transport error. cancel() settles it (done) and stops the
      // download, which is what wire.abort() already meant.
      try {
        await reader.cancel();
      } catch {
        // already closed or errored — nothing to settle
      }
      try {
        reader.releaseLock();
      } catch {
        // the stream died with the reader lock held — the lock dies with it
      }
    }
    return parseAnthropicSSE(sse);
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
        // The server's retry-after outranks our backoff: the wait is the max of
        // the two (a named wait shorter than our jittered spacing stays polite;
        // a longer one is obeyed).
        const backoffMs = backoffDelayMs(attempt, () => deps.rng.float(), backoff);
        const serverMs = retryAfterMsOf(e) ?? 0;
        const delay = Math.max(backoffMs, serverMs);
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

/** A 429's wait never exceeds this, whatever the header says — a "try again in 2 h" is a refusal wearing a header. */
const RETRY_AFTER_CAP_MS = 30_000;

/**
 * Server-stated minimum wait before the next attempt: delta-seconds or an
 * HTTP-date measured against the INJECTED clock (never the host's). Absent or
 * unparseable ⇒ undefined, and the loop falls back to plain backoff.
 */
const retryAfterOf = (response: Response, clockMs: number): number | undefined => {
  const raw: string | null | undefined = response.headers?.get?.('retry-after');
  if (raw === undefined || raw === null || raw === '') return undefined;
  const seconds = Number(raw);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(raw) - clockMs;
  if (!Number.isFinite(ms)) return undefined;
  return Math.min(RETRY_AFTER_CAP_MS, Math.max(0, Math.round(ms)));
};

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

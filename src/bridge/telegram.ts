// M15 bridge — the real Channel: the only code in the repo that speaks Telegram
// wire format. Long poll for updates, sendMessage for text, sendChatAction for
// the typing indicator. Every impulse that could touch the outside world goes
// through an injected seam — fetchImpl (tests script it), Clock (long-poll
// waits, rate-limit waits, backoff), Rng (backoff jitter) — the M03 transport's
// discipline.
//
// Delivery correctness lives in the wire offset: getUpdates is called with
// `committed + 1`, and Telegram keeps holding an update until a request moves
// past it. The adapter never advances anything on its own — only the ingest's
// durable commit does, which is what makes at-least-once true end to end.

import type { Clock, Rng } from '../kernel/index.js';
import type { EventLog } from '../events/index.js';
import { BridgeError } from './errors.js';
import { parseUpdate, defaultSpeakerResolver, type SpeakerResolver } from './wire.js';
import {
  TELEGRAM_LIMITS,
  type Channel,
  type ChannelLimits,
  type InboundMsg,
  type PollFailedEvent,
  type SendFailedEvent,
} from './types.js';

export const TELEGRAM_API_BASE = 'https://api.telegram.org';

/** Telegram holds the long poll open for ~this long before returning an empty batch. */
export const DEFAULT_POLL_TIMEOUT_MS = 25_000;

/** Spec: allowed_updates must include message_reaction — reactions are M09's free outcome signals. */
export const TELEGRAM_ALLOWED_UPDATES: readonly string[] = ['message', 'edited_message', 'message_reaction'];

/** Re-poll gap after an instantly-empty batch: a proxy that kills long polls would otherwise spin. */
const IDLE_BATCH_GAP_MS = 1000;

const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 30_000;
/** Telegram always states retry_after; this only covers a body that omits it. */
const FALLBACK_RETRY_AFTER_MS = 1000;

/** P-CLOSE CL.4: this many consecutive poll failures mean the bridge is down — an incident, not a retry detail. */
export const POLL_DOWN_AFTER = 5;
export const POLL_FAILED_EVENT = 'bridge.poll_failed';
export const POLL_DOWN_INCIDENT = 'incident.poll_down';

interface TelegramBody {
  ok?: boolean;
  result?: unknown;
  parameters?: { retry_after?: unknown };
}

const truncate = (text: string): string => (text.length > 400 ? `${text.slice(0, 400)}…` : text);
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const retryAfterOf = (body: TelegramBody): number => {
  const seconds = body.parameters?.retry_after;
  return typeof seconds === 'number' && seconds > 0 ? seconds * 1000 : FALLBACK_RETRY_AFTER_MS;
};

/** Backstop for a wedged socket: far above the 25 s long-poll, it only fires when the connection is truly dead. */
const HTTP_TIMEOUT_MS = 60_000;

/**
 * One Bot API call: POST, status + bot-api `ok` mapping, typed errors. The token
 * rides the URL, so any body we did not build could echo it into an error
 * message — it is stripped before a message escapes this module.
 *
 * `signal` (P-CLOSE CL.4) is the caller's abort — the poll loop's stop signal —
 * combined with the 60 s host-network backstop, so a stop cuts an in-flight
 * request immediately instead of waiting out the socket.
 */
const httpCall = async (
  call: { doFetch: typeof fetch; base: string; token: string },
  method: string,
  payload: Record<string, unknown>,
  signal?: AbortSignal | undefined,
): Promise<TelegramBody> => {
  const redact = (text: string): string => (call.token === '' ? text : text.split(call.token).join('***'));
  let res: Response;
  try {
    res = await call.doFetch(`${call.base}/bot${call.token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      // Host-network backstop (real timers, deliberately not the injected
      // clock): a getUpdates socket that never answers would otherwise hang
      // the poll loop forever. 60 s sits far above the 25 s long-poll.
      signal: signal === undefined ? AbortSignal.timeout(HTTP_TIMEOUT_MS) : AbortSignal.any([AbortSignal.timeout(HTTP_TIMEOUT_MS), signal]),
    });
  } catch (e) {
    if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
      throw new BridgeError('bridge/timeout', `${method}: no response within ${HTTP_TIMEOUT_MS} ms`, { cause: e });
    }
    throw new BridgeError('bridge/transport', `${method}: ${errMsg(e)}`, { cause: e });
  }
  const text = await res.text().catch(() => '');
  let body: TelegramBody = {};
  if (text !== '') {
    try {
      body = JSON.parse(text) as TelegramBody;
    } catch {
      body = {}; // non-JSON body: the status code below carries the failure
    }
  }
  if (!res.ok) {
    const rateLimited = res.status === 429;
    throw new BridgeError(rateLimited ? 'bridge/rate-limit' : 'bridge/telegram-error', `${method}: HTTP ${res.status} ${redact(truncate(text))}`, {
      cause: { status: res.status },
      retryAfterMs: rateLimited ? retryAfterOf(body) : undefined,
    });
  }
  if (body.ok !== true) {
    throw new BridgeError('bridge/telegram-error', `${method}: bot-api refused: ${redact(truncate(text))}`);
  }
  return body;
};

export interface TelegramChannelDeps {
  token: string; // from env/keys.env via M20 — never read here, never logged
  clock: Clock;
  /** Backoff jitter source; fork a stream per channel so runs stay reproducible. */
  rng: Rng;
  /** Durable committed cursor (the ingest's OffsetStore). The wire offset is always committed + 1. */
  committedOffset: () => number | undefined | Promise<number | undefined>;
  apiBase?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
  log?: EventLog | undefined;
  limits?: Partial<ChannelLimits> | undefined;
  pollTimeoutMs?: number | undefined;
  speaker?: SpeakerResolver | undefined;
}

export const telegramChannel = (deps: TelegramChannelDeps): Channel => {
  const limits: ChannelLimits = { ...TELEGRAM_LIMITS, ...deps.limits };
  const call = {
    doFetch: deps.fetchImpl ?? globalThis.fetch.bind(globalThis),
    base: deps.apiBase ?? TELEGRAM_API_BASE,
    token: deps.token,
  };
  const speaker = deps.speaker ?? defaultSpeakerResolver;
  const pollTimeoutSec = Math.round((deps.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS) / 1000);

  const emitSendFailed = async (
    chatId: number,
    e: unknown,
    attempts: number,
    retryAfterMs: number | undefined,
  ): Promise<void> => {
    if (deps.log === undefined) return;
    const payload: SendFailedEvent = {
      chatId,
      code: e instanceof BridgeError ? e.code : 'unknown',
      attempts,
      error: errMsg(e),
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    };
    try {
      await deps.log.emit('bridge.send_failed', payload);
    } catch {
      // L0 unwritable ⇒ advisory (M20's policy, same as model.call). The typed
      // error still propagates to the realizer.
    }
  };

  return {
    limits,

    send: async (chatId, text) => {
      let attempts = 0;
      let lastWait: number | undefined;
      for (;;) {
        attempts += 1;
        try {
          const body = await httpCall(call, 'sendMessage', { chat_id: chatId, text });
          const result = body.result as { message_id?: unknown } | undefined;
          const msgId = result?.message_id;
          if (typeof msgId !== 'number') {
            throw new BridgeError('bridge/telegram-error', 'sendMessage: result carries no message_id');
          }
          return { msgId };
        } catch (e) {
          // Spec policy: 429 → wait retry_after on the clock → retry once →
          // typed failure + bridge.send_failed. The realizer's ≥1.1s pacing
          // makes this a should-never-fire path, not a strategy.
          const retryAfterMs = e instanceof BridgeError && e.code === 'bridge/rate-limit' ? e.retryAfterMs : undefined;
          if (retryAfterMs === undefined || attempts > 1) {
            await emitSendFailed(chatId, e, attempts, lastWait);
            throw e;
          }
          lastWait = retryAfterMs;
          await deps.clock.waitUntil(deps.clock.epochMs() + retryAfterMs);
        }
      }
    },

    typing: async (chatId) => {
      await httpCall(call, 'sendChatAction', { chat_id: chatId, action: 'typing' });
    },

    updates: (signal) => pollUpdates(deps, call, speaker, pollTimeoutSec, signal),
  };
};

const pollUpdates = async function* (
  deps: TelegramChannelDeps,
  call: { doFetch: typeof fetch; base: string; token: string },
  speaker: SpeakerResolver,
  pollTimeoutSec: number,
  signal: AbortSignal,
): AsyncGenerator<InboundMsg> {
  let failures = 0;
  while (!signal.aborted) {
    try {
      const committed = await deps.committedOffset();
      const body = await httpCall(
        call,
        'getUpdates',
        {
          ...(committed !== undefined ? { offset: committed + 1 } : {}),
          timeout: pollTimeoutSec,
          allowed_updates: TELEGRAM_ALLOWED_UPDATES,
        },
        signal,
      );
      failures = 0;
      const batch = Array.isArray(body.result) ? body.result : [];
      for (const raw of batch) {
        const parsed = parseUpdate(raw, speaker);
        // Every numbered update parses — a real inbound, or a skip-stamped
        // placeholder the ingest records so the offset commits past it (an
        // unrecorded skip would re-poll forever: the photo-wedge). Only an
        // update Telegram never numbered fails to parse, and there is nothing
        // to advance past — dropping it is all that can be done.
        if (parsed.ok) yield parsed.msg;
      }
      if (batch.length === 0) {
        await deps.clock.waitUntil(deps.clock.epochMs() + IDLE_BATCH_GAP_MS, signal).catch(() => undefined);
      }
    } catch (e) {
      if (signal.aborted) return; // abort while the request was in flight — clean end
      failures += 1;
      const retryAfterMs = e instanceof BridgeError ? e.retryAfterMs : undefined;
      // Telegram demands retry_after before anything else; otherwise jittered
      // exponential off the injected stream, capped.
      const uncapped = BACKOFF_BASE_MS * 2 ** Math.min(failures - 1, 6) * (0.5 + deps.rng.float());
      const jittered = Math.min(BACKOFF_CAP_MS, uncapped);
      const delay = Math.max(Math.round(jittered), retryAfterMs ?? 0);
      // P-CLOSE CL.4: poll failures are events, not just retry state — the
      // first failure, each pass where the exponential hits the backoff cap,
      // and an incident once the failures are clearly a pattern, not a blip.
      if (deps.log !== undefined) {
        if (failures === 1 || uncapped >= BACKOFF_CAP_MS) {
          const payload: PollFailedEvent = { failures, backoffMs: delay };
          await deps.log.emit(POLL_FAILED_EVENT, payload).catch(() => undefined);
        }
        if (failures === POLL_DOWN_AFTER) {
          await deps.log
            .emit(POLL_DOWN_INCIDENT, { failures, error: errMsg(e) })
            .catch(() => undefined);
        }
      }
      // An abort during the wait rejects into .catch; the loop condition ends it.
      await deps.clock.waitUntil(deps.clock.epochMs() + delay, signal).catch(() => undefined);
    }
  }
};

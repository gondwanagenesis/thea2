// M15 bridge — typed errors. Every failure mode of the channel door has one
// code, so the realizer (M14) and the app (M20) branch without string matching.

import { KernelErrorImpl } from '../kernel/index.js';

export type BridgeErrorCode =
  | 'bridge/limit-max-chars' // text exceeded ChannelLimits.maxMsgChars — FakeChannel throws this in tests
  | 'bridge/limit-send-gap' // send inside ChannelLimits.minSendGapMs — a 429-shaped bug caught in CI
  | 'bridge/rate-limit' // Telegram 429, retry_after already consumed: the one allowed retry did not clear it
  | 'bridge/telegram-error' // non-retryable Bot API refusal (bad token, 4xx, bot-api ok:false)
  | 'bridge/transport' // fetch itself threw (DNS, socket, reset)
  | 'bridge/offset-regress' // a caller tried to move the committed poll cursor backwards
  | 'bridge/decision-mismatch'; // recordDecision given a summary whose turnId disagrees with its key

export interface BridgeErrorOpts {
  cause?: unknown;
  /** Set on bridge/rate-limit: the wait Telegram demanded (ms), already consumed by the time this error surfaces. */
  retryAfterMs?: number | undefined;
}

export class BridgeError extends KernelErrorImpl {
  readonly retryAfterMs?: number;
  constructor(code: BridgeErrorCode | string, message: string, opts: BridgeErrorOpts = {}) {
    super(code, message, opts.cause);
    this.name = 'BridgeError';
    if (opts.retryAfterMs !== undefined) this.retryAfterMs = opts.retryAfterMs;
  }
}

export const bridgeError = (code: BridgeErrorCode, message: string, opts: BridgeErrorOpts = {}): BridgeError =>
  new BridgeError(code, message, opts);

export const isBridgeError = (e: unknown): e is BridgeError => e instanceof BridgeError;

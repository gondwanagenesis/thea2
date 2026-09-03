// M03 model — typed errors. Every failure mode of the model door has one code,
// so callers (loop, siblings, app) can branch without string matching.

import { KernelErrorImpl } from '../kernel/index.js';

export type ModelErrorCode =
  | 'model/transport' // fetch itself threw (DNS, socket, reset) — retryable
  | 'model/timeout' // per-call deadline elapsed — retryable (transport class)
  | 'model/aborted' // caller signal fired — never retried
  | 'model/http-error' // non-retryable 4xx and retryable 5xx alike carry this code; also an SSE `error` event
  | 'model/rate-limit' // HTTP 429 — retryable within maxRetries, honoring retry-after (Phase 1, 2026-09-02)
  | 'model/truncated' // stop_reason max_tokens with NOTHING visible (no text, no tool call) — never retried, never a decision
  | 'model/bad-json' // 200 with an unparseable/protocol-violating body — not retried
  | 'model/parse-failed' // structured output unparseable after the one-shot repair
  | 'model/tool-call-failed' // tool-call arguments unparseable after the one-shot repair
  | 'model/mock-exhausted' // MockModel: FIFO empty and no rule matched (non-strict)
  | 'model/mock-unexpected'; // MockModel in strict mode: call nobody scripted

export interface ModelErrorOpts {
  cause?: unknown;
  retryable?: boolean;
  /** Server-requested minimum wait before the next attempt (429 retry-after), ms. */
  retryAfterMs?: number | undefined;
}

export class ModelError extends KernelErrorImpl {
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  constructor(code: ModelErrorCode, message: string, opts: ModelErrorOpts = {}) {
    super(code, message, opts.cause);
    this.retryable = opts.retryable ?? false;
    if (opts.retryAfterMs !== undefined) this.retryAfterMs = opts.retryAfterMs;
    this.name = 'ModelError';
  }
}

export const modelError = (code: ModelErrorCode, message: string, opts: ModelErrorOpts = {}): ModelError =>
  new ModelError(code, message, opts);

export const isModelError = (e: unknown): e is ModelError => e instanceof ModelError;

/**
 * Retry policy: transport errors, idle timeouts, 5xx, 429 (bounded by
 * maxRetries, waiting max(retry-after, backoff)), and retryable SSE error
 * events. Never other 4xx, never aborts, never a truncation.
 */
export const isRetryable = (e: unknown): boolean => {
  if (e instanceof ModelError) return e.retryable;
  return false;
};

/** The wait a retryable error asks for, if the server named one. */
export const retryAfterMsOf = (e: unknown): number | undefined =>
  e instanceof ModelError ? e.retryAfterMs : undefined;

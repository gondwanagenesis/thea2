// M03 model — typed errors. Every failure mode of the model door has one code,
// so callers (loop, siblings, app) can branch without string matching.

import { KernelErrorImpl } from '../kernel/index.js';

export type ModelErrorCode =
  | 'model/transport' // fetch itself threw (DNS, socket, reset) — retryable
  | 'model/timeout' // per-call deadline elapsed — retryable (transport class)
  | 'model/aborted' // caller signal fired — never retried
  | 'model/http-error' // non-retryable 4xx and retryable 5xx alike carry this code
  | 'model/rate-limit' // HTTP 429 — the spec retries only 5xx, so this fails fast
  | 'model/bad-json' // 200 with an unparseable/protocol-violating body — not retried
  | 'model/parse-failed' // structured output unparseable after the one-shot repair
  | 'model/tool-call-failed' // tool-call arguments unparseable after the one-shot repair
  | 'model/mock-exhausted' // MockModel: FIFO empty and no rule matched (non-strict)
  | 'model/mock-unexpected'; // MockModel in strict mode: call nobody scripted

export interface ModelErrorOpts {
  cause?: unknown;
  retryable?: boolean;
}

export class ModelError extends KernelErrorImpl {
  readonly retryable: boolean;
  constructor(code: ModelErrorCode, message: string, opts: ModelErrorOpts = {}) {
    super(code, message, opts.cause);
    this.retryable = opts.retryable ?? false;
    this.name = 'ModelError';
  }
}

export const modelError = (code: ModelErrorCode, message: string, opts: ModelErrorOpts = {}): ModelError =>
  new ModelError(code, message, opts);

export const isModelError = (e: unknown): e is ModelError => e instanceof ModelError;

/** Retry policy per the spec: transport errors and 5xx only. Never 4xx, never aborts. */
export const isRetryable = (e: unknown): boolean => {
  if (e instanceof ModelError) return e.retryable;
  return false;
};

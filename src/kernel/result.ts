// M01 kernel — typed Result/error helpers. No domain knowledge.

export interface KernelError {
  code: string; // namespaced, e.g. 'canonical/circular', 'jsonl/corrupt'
  message: string;
  cause?: unknown;
}

export type Result<T, E = KernelError> = { ok: true; value: T } | { ok: false; error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });

export const err = (code: string, message: string, cause?: unknown): KernelError => ({
  code,
  message,
  ...(cause !== undefined ? { cause } : {}),
});

/** Throwing variant — most kernel callers prefer thrown KernelErrors. */
export class KernelErrorImpl extends Error {
  readonly code: string;
  constructor(code: string, message: string, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.code = code;
    this.name = 'KernelError';
  }
}

export const fail = (code: string, message: string, cause?: unknown): never => {
  throw new KernelErrorImpl(code, message, cause);
};

export const asError = (e: unknown): KernelError =>
  e instanceof KernelErrorImpl
    ? { code: e.code, message: e.message, cause: e.cause }
    : { code: 'unknown', message: e instanceof Error ? e.message : String(e), cause: e };

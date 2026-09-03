// M09 memory — typed errors. Every rejection names its store/shape so the
// pipeline (M20) can branch without string matching. Memory failures are loud
// but never conversation-fatal: the appraisal path degrades gracefully instead.

import { KernelErrorImpl } from '../kernel/index.js';

export type MemoryErrorCode =
  | 'memory/duplicate-id' // append of an id the store already holds
  | 'memory/bad-episode' // episode failed its store-boundary schema
  | 'memory/bad-procedure' // procedure record failed its store-boundary schema
  | 'memory/embed-empty' // the embedder returned no vector for a non-empty batch
  | 'memory/unknown-id' // vecsFor named an id the store does not hold
  | 'memory/affect-stamp' // affectAtEncoding is not a full Vec12
  | 'memory/index-orphan' // the vector index holds ids the row log does not
  | 'memory/window-role' // a non user/assistant message tried to enter the window
  | 'memory/window-corrupt' // persisted window state is unusable
  | 'memory/window-not-booted' // sync window read before the load landed
  | 'memory/threads-log'; // the durable thread log could not be appended

export class MemoryError extends KernelErrorImpl {
  constructor(code: MemoryErrorCode, message: string, cause?: unknown) {
    super(code, message, cause);
    this.name = 'MemoryError';
  }
}

export const memoryError = (code: MemoryErrorCode, message: string, cause?: unknown): MemoryError =>
  new MemoryError(code, message, cause);

/** Throwing variant for expression positions — `return failMemory(...)` is the
 * form that also narrows (a statement-position `fail(...)` does not). */
export const failMemory = (code: MemoryErrorCode, message: string, cause?: unknown): never => {
  throw new MemoryError(code, message, cause);
};

export const isMemoryError = (e: unknown): e is MemoryError => e instanceof MemoryError;

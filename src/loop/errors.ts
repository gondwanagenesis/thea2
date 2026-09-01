// M13 loop — typed errors. The loop's own failures are the structural kind: a
// registry that cannot hold the tools she is promised, or a committee spec whose
// DAG is not a DAG. Every runtime failure a turn can survive is a VALUE (a
// forced-silent decision + incident event), never an exception — the pipeline
// (M20) only sees exceptions it cannot recover from.

import { KernelErrorImpl } from '../kernel/index.js';

export type LoopErrorCode =
  | 'loop/duplicate-tool' // register() of a name the registry already holds
  | 'loop/bad-committee' // CommitteeSpec violates the DAG shape (ids, edges, observation reachability)
  | 'loop/not-booted' // a spawn tool ran without the loop context that owns it
  | 'loop/decision-invalid'; // the loop could not lock even the forced-silent stub against its schema

export class LoopError extends KernelErrorImpl {
  constructor(code: LoopErrorCode, message: string, cause?: unknown) {
    super(code, message, cause);
    this.name = 'LoopError';
  }
}

export const loopError = (code: LoopErrorCode, message: string, cause?: unknown): LoopError =>
  new LoopError(code, message, cause);

/** Throwing variant for expression positions — `return failLoop(...)` is the
 * form that also narrows (a statement-position `fail(...)` does not). */
export const failLoop = (code: LoopErrorCode, message: string, cause?: unknown): never => {
  throw new LoopError(code, message, cause);
};

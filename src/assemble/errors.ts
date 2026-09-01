// M11 assemble — typed errors. The assembler is a pure selector, so its failure
// modes are narrow: a config that cannot be honored, and a candidate that would
// poison deterministic ordering. Both are upstream bugs; neither is ever
// swallowed, because a silently mis-ranked packet looks exactly like a working one.

import { KernelErrorImpl } from '../kernel/index.js';

export type AssembleErrorCode = 'assemble/config' | 'assemble/bad-candidate';

export class AssembleError extends KernelErrorImpl {
  constructor(code: AssembleErrorCode, message: string) {
    super(code, message);
    this.name = 'AssembleError';
  }
}

export const isAssembleError = (e: unknown): e is AssembleError => e instanceof AssembleError;

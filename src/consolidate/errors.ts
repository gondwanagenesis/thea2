// M10 consolidate — typed errors. One namespaced code per failure mode; a
// consolidation error you cannot locate to a cluster key is a bug.

import { KernelErrorImpl } from '../kernel/index.js';

export type ConsolidateErrorCode =
  | 'consolidate/no-vector'
  | 'consolidate/draft-shape'
  | 'consolidate/state-schema'
  | 'consolidate/bad-config'
  | 'consolidate/episode-gap';

export class ConsolidateError extends KernelErrorImpl {
  constructor(code: ConsolidateErrorCode, message: string) {
    super(code, message);
    this.name = 'ConsolidateError';
  }
}

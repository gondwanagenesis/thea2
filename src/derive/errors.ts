// M08 derive — typed errors. One namespaced code per failure mode; a derive
// error you cannot locate to a generator or manifest entry is a bug.

import { KernelErrorImpl } from '../kernel/index.js';

export type DeriveErrorCode =
  | 'derive/manifest-schema'
  | 'derive/duplicate-generator'
  | 'derive/duplicate-derive-key'
  | 'derive/bad-derive-key'
  | 'derive/bad-gravity-cap'
  | 'derive/draft-shape'
  | 'derive/orphan-unlink';

export class DeriveError extends KernelErrorImpl {
  constructor(code: DeriveErrorCode | string, message: string) {
    super(code, message);
    this.name = 'DeriveError';
  }
}

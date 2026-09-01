// M06 coupling — typed errors. Every compile rejection names the offending
// entry (matrix index + from→to) so a bad `coupling.yaml` is locatable at
// startup without re-reading the file; Nightingale (M18) quotes the same
// message when a character drift traces back to a matrix change.

import { KernelErrorImpl } from '../kernel/index.js';

/** Error codes emitted by this module. 'coupling/schema' is the structural catch-all. */
export type CouplingErrorCode =
  | 'coupling/yaml-parse'
  | 'coupling/schema'
  | 'coupling/unknown-dim'
  | 'coupling/weight-range'
  | 'coupling/gain-range'
  | 'coupling/threshold-range'
  | 'coupling/duplicate-pair'
  | 'coupling/missing-why'
  | 'coupling/lambda-range'
  | 'coupling/version-shape'
  | 'coupling/baseline-range'
  | 'coupling/vec-length';

export interface CouplingErrorLoc {
  /** The coupling document's name, when the caller knows it (composition does). */
  file?: string | undefined;
  /** `matrix[3].w`-style path to the offending field. */
  field?: string | undefined;
  cause?: unknown;
}

/** Throwing variant used by compile/signature/modulate. Extends the kernel error so `asError` keeps the code. */
export class CouplingError extends KernelErrorImpl {
  readonly file?: string;
  readonly field?: string;

  constructor(code: CouplingErrorCode | string, message: string, loc?: CouplingErrorLoc) {
    super(code, message, loc?.cause);
    this.name = 'CouplingError';
    if (loc?.file !== undefined) this.file = loc.file;
    if (loc?.field !== undefined) this.field = loc.field;
  }
}

export const isCouplingError = (e: unknown): e is CouplingError => e instanceof CouplingError;

// M07 corpus — typed errors. Every rejection names its file and (when one
// exists) the field it is about; a corpus error you cannot locate is a bug.

import { KernelErrorImpl } from '../kernel/index.js';

/** Error codes emitted by this module. 'corpus/schema' is the zod catch-all for shape violations. */
export type CorpusErrorCode =
  | 'corpus/no-frontmatter'
  | 'corpus/yaml-parse'
  | 'corpus/schema'
  | 'corpus/unknown-field'
  | 'corpus/provenance-forbidden'
  | 'corpus/provenance-required'
  | 'corpus/lived-stamps-forbidden'
  | 'corpus/lived-stamps-required'
  | 'corpus/unknown-dimension'
  | 'corpus/unknown-kind'
  | 'corpus/unknown-outcome'
  | 'corpus/bad-affect-key'
  | 'corpus/affect-range'
  | 'corpus/id-mismatch'
  | 'corpus/canon-path-shape'
  | 'corpus/path-not-in-population'
  | 'corpus/primary-dim-mismatch'
  | 'corpus/unknown-register'
  | 'corpus/register-shape'
  | 'corpus/forbidden-register-pair'
  | 'corpus/dangling-counter'
  | 'corpus/duplicate-id'
  | 'corpus/body-grammar'
  | 'corpus/empty-turn'
  | 'corpus/scene-no-exchange'
  | 'corpus/procedure-incomplete'
  | 'corpus/body-too-long'
  | 'corpus/affect-too-dense'
  | 'corpus/controls-missing'
  | 'corpus/controls-unknown-key'
  | 'corpus/controls-unknown-register'
  | 'corpus/controls-unknown-dimension'
  | 'corpus/controls-schema'
  | 'corpus/missing-root'
  | 'corpus/dim-mismatch';

export interface CorpusErrorLocation {
  /** `| undefined` is deliberate: callers hold optionals and pass them straight through. */
  file?: string | undefined;
  field?: string | undefined;
  line?: number | undefined;
  cause?: unknown;
}

/** Throwing variant used by the parse path. Extends the kernel error so `asError` keeps the code. */
export class CorpusError extends KernelErrorImpl {
  readonly file?: string;
  readonly field?: string;
  readonly line?: number;

  constructor(code: CorpusErrorCode | string, message: string, loc?: CorpusErrorLocation) {
    super(code, message, loc?.cause);
    this.name = 'CorpusError';
    if (loc?.file !== undefined) this.file = loc.file;
    if (loc?.field !== undefined) this.field = loc.field;
    if (loc?.line !== undefined) this.line = loc.line;
  }
}

export const isCorpusError = (e: unknown): e is CorpusError => e instanceof CorpusError;

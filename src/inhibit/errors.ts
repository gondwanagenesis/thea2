// M12 inhibit — typed errors. inhibitions.yaml is a canon file: a rule that
// cannot compile is a startup failure naming the rule, never a silently skipped
// rule (the gate's whole authority rests on "compiled == enforced").

import { KernelErrorImpl } from '../kernel/index.js';

/** Error codes emitted by this module. One per failure mode. */
export type InhibitErrorCode =
  | 'inhibit/yaml-parse'
  | 'inhibit/schema'
  | 'inhibit/unknown-field'
  | 'inhibit/duplicate-id'
  | 'inhibit/bad-regex'
  | 'inhibit/unbound-rule'
  | 'inhibit/allow-when'
  | 'inhibit/config-required'
  | 'inhibit/config-invalid'
  | 'inhibit/prompt-budget';

export interface InhibitErrorLocation {
  /** The rule the failure is about, when one exists — a rejection you cannot locate is a bug. */
  ruleId?: string | undefined;
  /** Field path inside the document, e.g. 'tool[0].check'. */
  field?: string | undefined;
  cause?: unknown;
}

/** Throwing variant used by the compile path. Extends the kernel error so `asError` keeps the code. */
export class InhibitError extends KernelErrorImpl {
  readonly ruleId?: string;
  readonly field?: string;

  constructor(code: InhibitErrorCode | string, message: string, loc?: InhibitErrorLocation) {
    super(code, message, loc?.cause);
    this.name = 'InhibitError';
    if (loc?.ruleId !== undefined) this.ruleId = loc.ruleId;
    if (loc?.field !== undefined) this.field = loc.field;
  }
}

export const isInhibitError = (e: unknown): e is InhibitError => e instanceof InhibitError;

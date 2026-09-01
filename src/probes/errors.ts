// M19 probes — typed errors. Probe rot must be loud and locatable: every code
// names one failure mode and the message names the probe/file/id at fault.

import { KernelErrorImpl } from '../kernel/index.js';

/** Error codes emitted by this module. */
export type ProbeErrorCode =
  | 'probes/yaml' // the file is not valid YAML
  | 'probes/schema' // YAML parsed but the shape violates schemas/probe.ts
  | 'probes/duplicate-id' // two probe files claim the same id
  | 'probes/bad-regex' // a noForbiddenPattern pattern does not compile
  | 'probes/reference-unresolved' // a pinned exemplar id (references / centroidFrom) is not in the index
  | 'probes/anchor-unresolved' // the rubric anchor text cannot be read
  | 'probes/fixture-unresolved' // an episodeSet id has no fixture entry
  | 'probes/fixture-collision' // two fixture files claim the same episode id
  | 'probes/centroid-empty' // a drift dimension has no usable reference vectors
  | 'probes/no-judge-model' // a rubric is present but no ModelClient was injected
  | 'probes/no-transcript' // a dry run with no recorded transcript for the probe
  | 'probes/transcript-schema' // a recorded transcript fails validation
  | 'probes/baseline' // baseline.json fails the reference schema
  | 'probes/target-shape' // the injected ProbeTarget returned a malformed capture
  | 'probes/unknown-probe'; // runAll ids filter names a probe outside the suite

export interface ProbeErrorLocation {
  /** `| undefined` is deliberate: callers hold optionals and pass them straight through. */
  file?: string | undefined;
  field?: string | undefined;
  cause?: unknown;
}

/** Throwing variant used across the module. Extends the kernel error so `asError` keeps the code. */
export class ProbeError extends KernelErrorImpl {
  readonly file?: string;
  readonly field?: string;

  constructor(code: ProbeErrorCode | string, message: string, loc?: ProbeErrorLocation) {
    super(code, message, loc?.cause);
    this.name = 'ProbeError';
    if (loc?.file !== undefined) this.file = loc.file;
    if (loc?.field !== undefined) this.field = loc.field;
  }
}

export const isProbeError = (e: unknown): e is ProbeError => e instanceof ProbeError;

/** Flattens a zod error into one line per issue — the parse error text CI shows. */
export const zodIssuesText = (e: { issues: ReadonlyArray<{ path: PropertyKey[]; message: string }> }): string =>
  e.issues.map((i) => `${i.path.map(String).join('.') || '<root>'}: ${i.message}`).join('; ');

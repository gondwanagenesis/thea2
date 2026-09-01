// Ambient type shim for js-yaml 4.3.2 — the package ships no declarations and
// adding @types/js-yaml would be a new dependency (not allowed for M07). Only
// the surface src/corpus uses is declared. Delete this file if/when real types
// arrive via a dependency bump.
declare module 'js-yaml' {
  export interface LoadOptions {
    schema?: unknown;
    json?: boolean;
    filename?: string;
  }
  /** Parses `text` as a single YAML document. Throws YAMLException on bad input. */
  export function load(text: string, opts?: LoadOptions): unknown;
  export const DEFAULT_SCHEMA: unknown;
}

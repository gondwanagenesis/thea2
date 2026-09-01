// M07 corpus — shared shapes. No imports; everything else in this module may
// depend on this file.

/** The three corpus populations. Canon is human-edited; derived/lived are generated artifacts. */
export type SourceKind = 'canon' | 'derived' | 'lived';

/** Packet channels (ADR-009). M07's nominator serves the character channel only. */
export type PacketChannel = 'character' | 'procedural';

/** Tier assignment (spec §2.4): assigned at nomination/assembly time, never authored in frontmatter. */
export type CandidateTier = 'disposition' | 'pattern' | 'episode' | 'memory' | 'procedure';

/** A corpus file as handed to the parser/lint/index. `path` is identity (error messages + id derivation). */
export interface CorpusFile {
  /**
   * Repo-relative posix path, e.g. 'corpus/canon/voice/server-hum.md'. Canon ids derive
   * from it; derived/lived ids are the contentHash of `raw`.
   */
  path: string;
  /** Exact file text with line endings normalized to \n (so hashes are checkout-stable). */
  raw: string;
}

/** One lint finding. `severity: 'warning'` never blocks; errors are CI-fatal. */
export interface LintIssue {
  code: string; // namespaced, e.g. 'corpus/id-mismatch'
  severity: 'error' | 'warning';
  message: string;
  file: string;
  /** Frontmatter/body field the issue is about, when one exists (e.g. 'affect.sadness'). */
  field?: string;
  /** 1-based line in the body region, for body-grammar issues. */
  line?: number;
}

/** A file the loader saw but deliberately did not treat as an exemplar. */
export interface SkippedFile {
  path: string;
  reason: string;
}

/** Locale-independent string compare — the only ordering used anywhere in this module. */
export const compareStrings = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Total ordering for lint output: errors first, then file, code, field, line, message. */
export const compareIssues = (a: LintIssue, b: LintIssue): number =>
  compareStrings(a.severity === 'error' ? '0' : '1', b.severity === 'error' ? '0' : '1') ||
  compareStrings(a.file, b.file) ||
  compareStrings(a.code, b.code) ||
  compareStrings(a.field ?? '', b.field ?? '') ||
  (a.line ?? 0) - (b.line ?? 0) ||
  compareStrings(a.message, b.message);

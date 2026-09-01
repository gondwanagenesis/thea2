// M07 corpus — the parser proper: file -> Exemplar, with id derivation per
// population and every check that needs only ONE file (cross-file rules —
// duplicate ids, dangling counters, vocabularies — live in lint.ts).

import {
  contentHash,
} from '../kernel/index.js';
import {
  DIMENSIONS,
  type CanonFrontmatter,
  type DerivedFrontmatter,
  type Exemplar,
  type LivedFrontmatter,
} from '../../schemas/exemplar.js';
import { CorpusError } from './errors.js';
import { parseFrontmatterText, splitExemplarFile } from './frontmatter.js';
import { parseBody, validateBodyForKind } from './body.js';
import { compareStrings, type CorpusFile, type LintIssue, type SourceKind } from './types.js';

/** Population directory names; also the path segment that decides a file's source. */
export const SOURCE_SEGMENTS: readonly SourceKind[] = ['canon', 'derived', 'lived'];

/**
 * Reads a file's population from its path — the LAST matching segment wins, so
 * absolute Windows paths and repo-relative ones both work. Returns undefined
 * when no population segment is present.
 */
export const sourceForPath = (filePath: string): SourceKind | undefined => {
  const parts = filePath.replaceAll('\\', '/').split('/');
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i];
    if (part === 'canon' || part === 'derived' || part === 'lived') return part;
  }
  return undefined;
};

/**
 * Canon id = `canon/<dimension>/<slug>` derived from the path, per spec §File
 * format. Returns undefined when the path does not have the shape
 * .../canon/<dimension>/<slug>.md.
 */
export const canonIdFromPath = (filePath: string): string | undefined => {
  const parts = filePath.replaceAll('\\', '/').split('/');
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i] !== 'canon') continue;
    const dim = parts[i + 1];
    const slug = parts[i + 2]?.replace(/\.md$/, '');
    if (dim === undefined || slug === undefined || slug.length === 0) return undefined;
    return `canon/${dim}/${slug}`;
  }
  return undefined;
};

/**
 * Derived/lived ids are the contentHash of the (newline-normalized) file text.
 * M08/M10 write LF files, so this matches the bytes they wrote.
 */
export const contentIdFor = (raw: string): string => contentHash(raw.replace(/\r\n/g, '\n'));

/** The id a file SHOULD have, per its population. Undefined when the path is unusable for that population. */
export const expectedIdFor = (file: CorpusFile, source: SourceKind): string | undefined =>
  source === 'canon' ? canonIdFromPath(file.path) : contentIdFor(file.raw);

/** The dimension directory a canon file sits in (undefined when the path is not `.../canon/<dim>/<slug>.md`). */
export const dimensionDirFor = (filePath: string): string | undefined => {
  const parts = filePath.replaceAll('\\', '/').split('/');
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i] !== 'canon') continue;
    const dim = parts[i + 1];
    return dim;
  }
  return undefined;
};

export interface FileAnalysis {
  /** Present only when every parse-level ERROR passed (warnings do not block). */
  exemplar?: Exemplar;
  /** Parse-level issues only: frontmatter, body grammar, caps, id derivation, primary dimension. */
  issues: LintIssue[];
  id?: string;
  body?: string;
  frontmatterText?: string;
}

/**
 * Non-throwing single-file analysis. Never touches vocabularies or other files,
 * so it is the unit both lintCorpus and the index build consume.
 *
 * `pathIdentity` (default true) enables the location checks — canon id vs path,
 * primary dimension vs directory. Parse-only callers with no real path
 * (`parseExemplar(raw, source)`) turn them off; a pathless canon file has no
 * location to disagree with.
 */
export const analyzeFile = (
  file: CorpusFile,
  source: SourceKind,
  opts?: { pathIdentity?: boolean },
): FileAnalysis => {
  const pathIdentity = opts?.pathIdentity ?? true;
  const issues: LintIssue[] = [];
  let split: ReturnType<typeof splitExemplarFile>;
  try {
    split = splitExemplarFile(file.raw, file.path);
  } catch (e) {
    return { issues: [toIssue(e, file.path)] };
  }

  let frontmatter: CanonFrontmatter;
  try {
    frontmatter = parseFrontmatterText(split.frontmatterText, source, file.path);
  } catch (e) {
    return { issues: [toIssue(e, file.path)], body: split.body, frontmatterText: split.frontmatterText };
  }

  const parsedBody = parseBody(split.body, file.path);
  const validation = validateBodyForKind(frontmatter.kind, parsedBody, {
    file: file.path,
    affectKeyCount: Object.keys(frontmatter.affect).length,
  });
  issues.push(...validation.issues);

  // Id discipline: canon ids must match their location; derived/lived ids must
  // be the content hash of the file.
  let expectedId: string | undefined;
  if (pathIdentity) {
    expectedId = expectedIdFor(file, source);
    if (expectedId === undefined) {
      issues.push({
        code: 'corpus/canon-path-shape',
        severity: 'error',
        message: 'canon exemplars live at canon/<dimension>/<slug>.md — path does not have that shape',
        file: file.path,
        field: 'id',
      });
    } else if (frontmatter.id !== expectedId) {
      issues.push({
        code: 'corpus/id-mismatch',
        severity: 'error',
        message:
          source === 'canon'
            ? `id '${frontmatter.id}' does not match this file's location ('${expectedId}')`
            : `id '${frontmatter.id}' is not the contentHash of this file ('${expectedId}')`,
        file: file.path,
        field: 'id',
      });
    }
  }

  // The dimension directory is where the exemplar primarily demonstrates —
  // primary dimension must be that directory (same rule scripts/verify-schemas enforces).
  if (pathIdentity && source === 'canon') {
    const dimDir = dimensionDirFor(file.path);
    const primary = frontmatter.dimensions[0];
    if (dimDir !== undefined && primary !== undefined && primary !== dimDir) {
      const known = (DIMENSIONS as readonly string[]).includes(dimDir);
      issues.push({
        code: 'corpus/primary-dim-mismatch',
        severity: 'error',
        message: known
          ? `primary dimension '${primary}' does not match its directory '${dimDir}'`
          : `file sits in '${dimDir}', which is not one of the 8 dimension directories`,
        file: file.path,
        field: 'dimensions',
      });
    }
  }

  const hasErrors = issues.some((i) => i.severity === 'error');
  const analysis: FileAnalysis = {
    issues: issues.sort(compareIssuesSafe),
    body: split.body,
    frontmatterText: split.frontmatterText,
    ...(expectedId !== undefined ? { id: expectedId } : {}),
  };
  if (!hasErrors) {
    analysis.exemplar = toExemplar(frontmatter, source, split.body, parsedBody.tokens);
  }
  return analysis;
};

const compareIssuesSafe = (a: LintIssue, b: LintIssue): number =>
  (a.severity === 'error' ? 0 : 1) - (b.severity === 'error' ? 0 : 1) ||
  compareStrings(a.code, b.code) ||
  compareStrings(a.field ?? '', b.field ?? '') ||
  (a.line ?? 0) - (b.line ?? 0);

const toIssue = (e: unknown, file: string): LintIssue => {
  const err = e as CorpusError;
  return {
    code: err.code ?? 'corpus/schema',
    severity: 'error',
    message: err.message,
    file,
    ...(err.field !== undefined ? { field: err.field } : {}),
    ...(err.line !== undefined ? { line: err.line } : {}),
  };
};

/** Assembles the committed `Exemplar` value from a validated frontmatter + body. */
const toExemplar = (
  frontmatter: CanonFrontmatter,
  source: SourceKind,
  body: string,
  tokens: number,
): Exemplar => {
  const base: Exemplar = {
    ...frontmatter,
    source,
    body,
    tokens,
  };
  if (source === 'derived') {
    const provenance = (frontmatter as DerivedFrontmatter).provenance;
    return { ...base, provenance };
  }
  if (source === 'lived') {
    const lived = frontmatter as LivedFrontmatter;
    return {
      ...base,
      episodeIds: lived.episodeIds,
      encodedAffect: lived.encodedAffect,
      outcome: lived.outcome,
    };
  }
  return base;
};

/**
 * Spec contract: `parseExemplar(raw, expectedSource)` -> Exemplar. Throws the
 * first typed error, naming file + field. `file` is optional but pass it —
 * a rejection you cannot locate is a bug.
 */
export const parseExemplar = (raw: string, expectedSource: SourceKind, file?: string): Exemplar => {
  const analysis = analyzeFile({ path: file ?? '(anonymous)', raw }, expectedSource, {
    pathIdentity: file !== undefined,
  });
  const first = analysis.issues.find((i) => i.severity === 'error');
  if (first !== undefined) {
    throw new CorpusError(first.code, first.message, {
      file: first.file,
      ...(first.field !== undefined ? { field: first.field } : {}),
      ...(first.line !== undefined ? { line: first.line } : {}),
    });
  }
  if (analysis.exemplar === undefined) {
    throw new CorpusError('corpus/schema', 'file produced no exemplar but reported no error', { file });
  }
  return analysis.exemplar;
};

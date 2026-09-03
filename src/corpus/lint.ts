// M07 corpus — the lint. Corpus lint IS a CI test: every canon/derived/lived
// file in the repo must validate or the build is red (spec: "a validated
// artifact rather than a folder of prose").
//
// Per-file parse rules live in parse.ts/body.ts/frontmatter.ts. This file adds
// what needs a second file or a controls vocabulary: duplicate ids, dangling
// counters, register vocabulary and shape, forbidden pairs — and it owns the
// report shape every consumer (CI test, checkCorpus, the future CLI) reads.

import type { Exemplar } from '../../schemas/exemplar.js';
import { dimensionCapsUnknownKeys, registerShapeViolation, type CorpusControls } from './controls.js';
import { analyzeFile, sourceForPath } from './parse.js';
import { compareIssues, compareStrings, type CorpusFile, type LintIssue, type SkippedFile, type SourceKind } from './types.js';

export interface LintReport {
  /** Every issue, deterministically ordered: errors first, then file/code/field/line. */
  issues: LintIssue[];
  errors: LintIssue[];
  warnings: LintIssue[];
  /** Files present in the input that were deliberately not treated as exemplars. */
  skipped: SkippedFile[];
  /** Files actually linted (non-skipped). */
  files: number;
  /** Successfully parsed exemplars, sorted by id. */
  exemplars: Exemplar[];
  /** True when zero errors. Warnings do not block. */
  ok: boolean;
}

/**
 * Files that sit beside the exemplars and are not exemplars: the per-dimension
 * authoring templates and the identity anchor. Everything else ending in .md
 * inside a population directory IS an exemplar and must validate.
 */
export const NON_EXEMPLAR_NAMES: ReadonlySet<string> = new Set(['TEMPLATE.md', 'identity.md']);

export const isPopulationFile = (filePath: string): boolean => {
  const base = filePath.replaceAll('\\', '/').split('/').at(-1) ?? '';
  return base.endsWith('.md') && !base.startsWith('.') && !NON_EXEMPLAR_NAMES.has(base);
};

export const skipReason = (filePath: string): string | undefined => {
  const base = filePath.replaceAll('\\', '/').split('/').at(-1) ?? '';
  if (base === 'TEMPLATE.md') return 'authoring template, not an exemplar';
  if (base === 'identity.md') return 'identity anchor, not an exemplar (rendered as [IDENTITY])';
  if (base.startsWith('.')) return 'hidden file';
  if (!base.endsWith('.md')) return 'not markdown';
  return undefined;
};

export interface LintOptions {
  /**
   * Overrides path-derived source detection. Default: the LAST canon/derived/
   * lived segment in the path decides.
   */
  sourceFor?: (filePath: string) => SourceKind | undefined;
}

/** Lints a set of population files against the controlled vocabularies. Pure; no filesystem. */
export const lintCorpus = (files: CorpusFile[], controls?: CorpusControls, opts?: LintOptions): LintReport => {
  const issues: LintIssue[] = [];
  const skipped: SkippedFile[] = [];
  const loaded: Array<{ exemplar: Exemplar; file: string }> = [];

  // Controls self-check: a forbidden pair or a dimension cap naming a
  // vocabulary that does not exist would silently exempt itself from
  // enforcement, so it is an error here and now.
  if (controls !== undefined) {
    for (const [a, b] of controls.forbiddenPairs) {
      for (const tag of [a, b]) {
        if (!controls.registers.includes(tag)) {
          issues.push({
            code: 'corpus/controls-unknown-register',
            severity: 'error',
            message: `exclusions.yaml forbids '${tag}', which is not in registers.yaml vocabulary`,
            file: 'canon/exclusions.yaml',
            field: 'forbidden_pairs',
          });
        }
      }
    }
    for (const dim of dimensionCapsUnknownKeys(controls)) {
      issues.push({
        code: 'corpus/controls-unknown-dimension',
        severity: 'error',
        message: `dimension_caps names '${dim}', which is not one of the 8 dimensions`,
        file: 'canon/exclusions.yaml',
        field: 'dimension_caps',
      });
    }
  }

  for (const file of files) {
    const reason = skipReason(file.path);
    if (reason !== undefined) {
      skipped.push({ path: file.path, reason });
      continue;
    }

    const source = opts?.sourceFor?.(file.path) ?? sourceForPath(file.path);
    if (source === undefined) {
      issues.push({
        code: 'corpus/path-not-in-population',
        severity: 'error',
        message: 'path does not contain a canon/, derived/ or lived/ segment — cannot determine the population',
        file: file.path,
      });
      continue;
    }

    const analysis = analyzeFile(file, source);
    issues.push(...analysis.issues);

    const exemplar = analysis.exemplar;
    if (exemplar === undefined) continue;
    loaded.push({ exemplar, file: file.path });

    // Duplicate ids collapse to one exemplar in the index — that is silent
    // data loss, so the second claimant is an error.
    const earlier = loaded.find((x) => x.exemplar.id === exemplar.id);
    if (earlier !== undefined && earlier.file !== file.path) {
      issues.push({
        code: 'corpus/duplicate-id',
        severity: 'error',
        message: `id '${exemplar.id}' is also claimed by ${earlier.file}`,
        file: file.path,
        field: 'id',
      });
    }

    // Em/en-dashes are a machine tell: 0 occurrences in the measured human
    // corpus, banned by the voice law (corpus/README.md), and canon is what
    // the model imitates. Canon-only scope: derived is regenerated from canon
    // and judged separately (JU.1). A plain hyphen is the substitute.
    if (source === 'canon' && /[—–]/.test(file.raw)) {
      issues.push({
        code: 'corpus/em-dash',
        severity: 'error',
        message: 'em/en-dash in canon — use a plain hyphen (the human corpus has none)',
        file: file.path,
      });
    }

    if (controls !== undefined) {
      for (const tag of exemplar.register) {
        if (!controls.registers.includes(tag)) {
          issues.push({
            code: 'corpus/unknown-register',
            severity: 'error',
            message: `register tag '${tag}' is not in registers.yaml`,
            file: file.path,
            field: 'register',
          });
        }
      }
      const shape = registerShapeViolation(exemplar.register, controls);
      if (shape !== undefined) {
        issues.push({
          code: 'corpus/register-shape',
          severity: 'error',
          message: shape,
          file: file.path,
          field: 'register',
        });
      }
      // One exemplar carrying both halves of a forbidden pair is intrinsically
      // incoherent, whatever the packet does around it.
      for (const [a, b] of controls.forbiddenPairs) {
        if (exemplar.register.includes(a) && exemplar.register.includes(b)) {
          issues.push({
            code: 'corpus/forbidden-register-pair',
            severity: 'error',
            message: `register [${exemplar.register.join(', ')}] contains forbidden pair [${a}, ${b}]`,
            file: file.path,
            field: 'register',
          });
        }
      }
    }
  }

  // Cross-file: a counter must resolve to an exemplar present in this same
  // index load (spec: "dangling counter = lint error").
  const ids = new Set(loaded.map((x) => x.exemplar.id));
  for (const { exemplar, file } of loaded) {
    for (const counter of exemplar.counters ?? []) {
      if (!ids.has(counter)) {
        issues.push({
          code: 'corpus/dangling-counter',
          severity: 'error',
          message: `counter '${counter}' resolves to no exemplar in this corpus`,
          file,
          field: 'counters',
        });
      }
    }
  }

  const sorted = issues.sort(compareIssues);
  return {
    issues: sorted,
    errors: sorted.filter((i) => i.severity === 'error'),
    warnings: sorted.filter((i) => i.severity === 'warning'),
    skipped: skipped.sort((a, b) => compareStrings(a.path, b.path)),
    files: files.length - skipped.length,
    exemplars: loaded.map((x) => x.exemplar).sort((a, b) => compareStrings(a.id, b.id)),
    ok: sorted.every((i) => i.severity !== 'error'),
  };
};

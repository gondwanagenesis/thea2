// M08 derive — derived-file assembly.
//
// M08 owns exactly two frontmatter fields of a generated file: `id` (the
// content hash, unknowable until the text is final) and `provenance` (the
// judge attestation, unknowable until it has been judged). Generators own
// everything else. This file is the boundary between the two: it emits the
// frontmatter block, injects provenance, and masks the id line for hashing.
//
// The emitter is hand-rolled because the pipeline may only emit a fixed, closed
// shape and src/corpus's js-yaml shim deliberately declares `load` only. Plain
// scalars stay unquoted (diffs read like canon); everything else is JSON
// double-quoted, which is also valid YAML.

import {
  AFFECT_DIMS,
  DIMENSIONS,
  type DerivedProvenance,
  type ExemplarKind,
  type SparseAffect,
} from '../../schemas/exemplar.js';
import { BODY_TOKEN_HARD_CAP, countTokens } from '../corpus/body.js';
import { parseFrontmatterText, splitExemplarFile } from '../corpus/frontmatter.js';
import { DeriveError } from './errors.js';
import { DERIVED_ID_PLACEHOLDER } from './keys.js';

/**
 * Frontmatter of a draft, before M08 injects provenance. `affect` is sparse and
 * therefore ordered at emit time (AFFECT_DIMS order) so the bytes are stable.
 */
export interface DraftMeta {
  kind: ExemplarKind;
  dimensions: string[];
  register: string[];
  affect: SparseAffect;
  context: string;
  weight: number;
}

/**
 * True when the string can ride unquoted. Deliberately narrower than YAML's
 * plain-scalar rules: no colon at all (so ": " can never appear), no comment
 * or flow indicators, no leading/trailing space, and not a YAML/number
 * lookalike — a context emitted as `context: 1.5` would parse as a number and
 * fail the schema.
 */
const PLAIN_SAFE_RE = /^[A-Za-z0-9][A-Za-z0-9 ./_+-]*$/;
const LOOKALIKE_RE = /^(?:true|false|null|yes|no|on|off|~|[-+]?[0-9][0-9_.]*)$/i;
const plainSafe = (s: string): boolean =>
  s.length > 0 && PLAIN_SAFE_RE.test(s) && !s.endsWith(' ') && !LOOKALIKE_RE.test(s);

/** JSON's double-quoted escaping is valid YAML flow-scalar escaping for ASCII and \uXXXX. */
const scalar = (s: string): string => (plainSafe(s) ? s : JSON.stringify(s));

const flowList = (xs: readonly string[]): string => `[${xs.map(scalar).join(', ')}]`;

const affectKeys = (affect: SparseAffect): string[] =>
  Object.keys(affect)
    .filter((k) => (AFFECT_DIMS as readonly string[]).includes(k))
    .sort();

const affectLine = (affect: SparseAffect): string => {
  const keys = affectKeys(affect);
  if (keys.length === 0) return 'affect: {}';
  const pairs = keys.map((k) => {
    const v = affect[k as keyof SparseAffect];
    return `${k}: ${typeof v === 'number' && Number.isFinite(v) ? v : 0}`;
  });
  return `affect: {${pairs.join(', ')}}`;
};

/**
 * Renders a draft exemplar file: frontmatter with the id left at the pending
 * placeholder and no provenance block, then the body. Throws when a dimension
 * is outside the 8-dim vocabulary — M07 would reject the file anyway, and a
 * bad generator should be loud at the emitting site.
 */
export const renderDraft = (meta: DraftMeta, body: string): string => {
  for (const d of meta.dimensions) {
    if (!(DIMENSIONS as readonly string[]).includes(d)) {
      throw new DeriveError('derive/draft-shape', `'${d}' is not one of the 8 behavioral dimensions`);
    }
  }
  const lines = [
    `id: ${DERIVED_ID_PLACEHOLDER}`,
    `kind: ${meta.kind}`,
    `dimensions: ${flowList(meta.dimensions)}`,
    `register: ${flowList(meta.register)}`,
    affectLine(meta.affect),
    `context: ${scalar(meta.context)}`,
    `weight: ${meta.weight}`,
  ];
  return `---\n${lines.join('\n')}\n---\n${body}`;
};

/**
 * Injects the provenance block before the closing fence. Re-splitting (rather
 * than string surgery on the whole text) keeps the body byte-identical — the
 * body is the part a reviewer actually diffs.
 */
export const withProvenance = (draft: string, provenance: DerivedProvenance): string => {
  const { frontmatterText, body } = splitExemplarFile(draft);
  const block = [
    'provenance:',
    `  generator: ${scalar(provenance.generator)}`,
    `  generatorVersion: ${scalar(provenance.generatorVersion)}`,
    `  canonIds: ${flowList(provenance.canonIds)}`,
    `  sourceHashes: ${flowList(provenance.sourceHashes)}`,
    `  model: ${scalar(provenance.model)}`,
    `  judge: {version: ${scalar(provenance.judge.version)}, score: ${provenance.judge.score}, pass: ${provenance.judge.pass}}`,
  ].join('\n');
  return `---\n${frontmatterText}\n${block}\n---\n${body}`;
};

/**
 * Sets the real content id once the draft's hash is known (see keys.ts). A
 * draft may have arrived with a placeholder or a stale id; both are replaced.
 */
export const withId = (draft: string, id: string): string => {
  const { frontmatterText, body } = splitExemplarFile(draft);
  return `---\n${frontmatterText.replace(/^id:[^\n]*$/m, `id: ${id}`)}\n---\n${body}`;
};

/**
 * Models like to wrap verbatim output in a code fence. The body grammar has no
 * prose lines, so a fence would fail the parse; stripping one is the same
 * documented tolerance the M03 ladder applies to JSON, not a silent acceptance
 * of malformed exemplars (everything else still has to parse).
 */
export const stripOuterFence = (text: string): string => {
  const m = /^```[a-z]*\n([\s\S]*?)\n?```$/.exec(text.trim());
  const inner = (m?.[1] ?? text).replace(/\r\n/g, '\n').trim();
  return inner.length === 0 ? '' : `${inner}\n`;
};

/** The kind a draft declares, with M07's own strict frontmatter schema. */
export const draftKind = (draft: string): ExemplarKind =>
  parseFrontmatterText(splitExemplarFile(draft).frontmatterText, 'derived').kind;

/** Rewrites everything below the closing fence. Used by the statement shim in run.ts. */
export const withBody = (draft: string, body: string): string => {
  const { frontmatterText } = splitExemplarFile(draft);
  return `---\n${frontmatterText}\n---\n${body}`;
};

const GRAMMAR_LINE_RE =
  /^(?:Setup:|D:(?:$|[ :])|T:(?:$|[ :])|\[tool\]|\[outcome\]|→)/;

/**
 * M07's body validator currently rejects prose lines for EVERY kind — including
 * `kind: statement`, whose own documented rule (and committed canon, e.g.
 * corpus/canon/taste/seaglass-jar.md) is that prose IS the body. Until that
 * lands upstream, statements are validated here: plain prose lines only, under
 * the same hard token cap. See docs/modules/M08-derive.md §Deviations.
 */
export const assertStatementProse = (body: string): void => {
  const lines = body.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length === 0) {
    throw new DeriveError('derive/draft-shape', 'statement draft has an empty body');
  }
  const first = lines.findIndex((l) => GRAMMAR_LINE_RE.test(l));
  if (first >= 0) {
    throw new DeriveError(
      'derive/draft-shape',
      `statement draft line ${first + 1} is a dialogue/trace line ('${lines[first]}') — statements are prose`,
    );
  }
  const tokens = countTokens(body);
  if (tokens > BODY_TOKEN_HARD_CAP) {
    throw new DeriveError('derive/draft-shape', `statement draft is ${tokens} tokens — hard cap is ${BODY_TOKEN_HARD_CAP}`);
  }
};

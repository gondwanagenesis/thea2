// M07 corpus — frontmatter splitting and schema validation.
//
// The exemplar schema itself is NOT redefined here: schemas/exemplar.ts is the
// reference (spec: "until S2 migration ... mirror-synced, never forked"). This
// file derives *strict* variants of those schemas — same shapes, same
// vocabularies, same defaults — because z.object strips unknown keys and the
// corpus lint must reject them (a typo'd `registrar:` must not silently vanish).

import { z } from 'zod';
import * as yaml from 'js-yaml';
import {
  AFFECT_DIMS,
  CanonFrontmatter,
  DerivedFrontmatter,
  Dimension,
  LivedFrontmatter,
  SparseAffect,
  type CanonFrontmatter as CanonFrontmatterT,
} from '../../schemas/exemplar.js';
import { CorpusError } from './errors.js';
import type { SourceKind } from './types.js';

/** Frontmatter fields that mark a file as belonging to a different population. */
const PROVENANCE_KEYS: readonly string[] = ['provenance'];
const LIVED_STAMP_KEYS: readonly string[] = ['episodeIds', 'encodedAffect', 'outcome'];

// Strict variants — identical shapes, unknown keys rejected. Built from the
// reference schemas' `.shape`, so a field added there is picked up here.
const CanonStrict = z.strictObject(CanonFrontmatter.shape);
const DerivedStrict = z.strictObject(DerivedFrontmatter.shape);
const LivedStrict = z.strictObject(LivedFrontmatter.shape);

/**
 * Sparse affect with unknown-key rejection. `SparseAffect` (z.partialRecord)
 * already rejects unknown keys; this restates the same constraint explicitly so
 * the affect block stays strict even if the reference ever loosens. Vocabulary
 * (AFFECT_DIMS) and value range [-1, 1] come from the reference constants.
 */
const SparseAffectStrict = z.strictObject(
  Object.fromEntries(AFFECT_DIMS.map((d) => [d, z.number().min(-1).max(1).optional()])),
);

export interface SplitExemplarFile {
  /** YAML text between the `---` fences, normalized to \n. */
  frontmatterText: string;
  /** Everything after the closing fence (body region; may be empty). */
  body: string;
}

/**
 * Splits `---\n...\n---` frontmatter off the body. Line endings are normalized
 * first so ids and hashes are identical on Windows and Linux checkouts.
 * Throws 'corpus/no-frontmatter' when the fences are absent or malformed.
 */
export const splitExemplarFile = (raw: string, file?: string): SplitExemplarFile => {
  const text = raw.replace(/\r\n/g, '\n');
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(text);
  if (!match) {
    throw new CorpusError('corpus/no-frontmatter', 'no `---`-fenced YAML frontmatter block', { file });
  }
  return { frontmatterText: match[1] ?? '', body: text.slice(match[0].length) };
};

/**
 * Body-only view of a canon file that is NOT an exemplar but carries exemplar
 * furniture — today that is exactly one file: corpus/canon/identity.md, whose
 * `---`-fenced frontmatter (id/role/note) is repo metadata, never prompt text.
 * Strips a leading frontmatter block and returns what follows (leading blank
 * lines trimmed so the [IDENTITY] section starts on content); text without
 * fences is returned as-is. Never throws — a fenceless identity is all body.
 */
export const identityBody = (raw: string): string => {
  const text = raw.replace(/\r\n/g, '\n');
  const match = /^---\n[\s\S]*?\n---(?:\n|$)/.exec(text);
  return (match === null ? text : text.slice(match[0].length)).replace(/^\n+/, '');
};

export interface CanonParse {
  frontmatter: CanonFrontmatterT;
  body: string;
  frontmatterText: string;
}

/**
 * Parses a canon exemplar file: frontmatter split + strict zod, nothing more.
 * Body-grammar, id derivation and vocabulary checks live in parse.ts / lint.ts.
 * Throws typed errors naming `file` and `field`.
 */
export const parseCanon = (raw: string, opts?: { file?: string }): CanonParse => {
  const { frontmatterText, body } = splitExemplarFile(raw, opts?.file);
  return {
    frontmatter: parseFrontmatterText(frontmatterText, 'canon', opts?.file),
    body,
    frontmatterText,
  };
};

/**
 * Strict zod parse of one population's frontmatter. Returns the fully
 * defaulted output (affect {}, weight 1.0 when absent) as CanonFrontmatter.
 */
export const parseFrontmatterText = (
  frontmatterText: string,
  source: SourceKind,
  file?: string,
): CanonFrontmatterT => {
  let doc: unknown;
  try {
    doc = yaml.load(frontmatterText);
  } catch (e) {
    throw new CorpusError('corpus/yaml-parse', `frontmatter is not valid YAML: ${firstLine((e as Error).message)}`, {
      file,
      cause: e,
    });
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new CorpusError('corpus/schema', 'frontmatter must be a YAML mapping, not a scalar or list', {
      file,
      field: '(root)',
    });
  }

  const schema = source === 'canon' ? CanonStrict : source === 'derived' ? DerivedStrict : LivedStrict;
  const result = schema.safeParse(doc);
  if (result.success) return result.data as CanonFrontmatterT;

  const issue = result.error.issues[0];
  if (!issue) throw new CorpusError('corpus/schema', 'frontmatter rejected', { file });
  const loc = classifyIssue(issue, source);
  throw new CorpusError(loc.code, `${loc.message} [zod: ${issue.message}]`, { file, field: loc.field });
};

/** The slice of a zod v4 issue this module classifies on — structural, so zod internals stay out of types. */
interface ZodIssueLike {
  code: string;
  path: PropertyKey[];
  message: string;
  keys?: unknown;
  expected?: unknown;
}

interface Classified {
  code: string;
  /** Explicitly undefined-able: the classifiers hold `path.join('.')` results that may be undefined. */
  field?: string | undefined;
  message: string;
}

/**
 * Maps a zod issue onto a corpus error code. Zod v4 codes used here:
 * unrecognized_keys (unknown field), invalid_value (enum), invalid_type
 * (missing/shape), too_big / too_small (range).
 */
const classifyIssue = (rawIssue: ZodIssueLike, source: SourceKind): Classified => {
  const issue: ZodIssueLike = rawIssue;
  const path = issue.path.map(String);
  const head = path[0];
  const field = path.length > 0 ? path.join('.') : undefined;
  const keys = Array.isArray(issue.keys) ? (issue.keys as unknown[]).map(String) : [];

  if (issue.code === 'unrecognized_keys') {
    if (head === undefined) {
      const provenance = keys.find((k) => PROVENANCE_KEYS.includes(k));
      if (provenance !== undefined) {
        return {
          code: 'corpus/provenance-forbidden',
          field: provenance,
          message: `${source} frontmatter must not carry a provenance block — that is derived-only`,
        };
      }
      const stamp = keys.find((k) => LIVED_STAMP_KEYS.includes(k));
      if (stamp !== undefined) {
        return {
          code: 'corpus/lived-stamps-forbidden',
          field: stamp,
          message: `${source} frontmatter must not carry lived stamps — those are lived-only`,
        };
      }
      return { code: 'corpus/unknown-field', field: keys[0], message: `unknown frontmatter field(s): ${keys.join(', ')}` };
    }
    if (head === 'affect') {
      return {
        code: 'corpus/bad-affect-key',
        field: keys[0] !== undefined ? `affect.${keys[0]}` : 'affect',
        message: `unknown affect dimension(s): ${keys.join(', ')} — keys must be in AFFECT_DIMS`,
      };
    }
    return { code: 'corpus/unknown-field', field, message: `unknown field(s) in '${head}': ${keys.join(', ')}` };
  }

  if (issue.code === 'invalid_value') {
    if (head === 'dimensions') {
      return {
        code: 'corpus/unknown-dimension',
        field,
        message: `'${String(path.at(-1))}' is not one of the 8 behavioral dimensions`,
      };
    }
    if (head === 'kind') return { code: 'corpus/unknown-kind', field, message: 'kind must be scene|statement|procedure' };
    if (head === 'outcome') return { code: 'corpus/unknown-outcome', field, message: 'outcome must be good|mixed|bad' };
    return { code: 'corpus/schema', field, message: 'invalid value' };
  }

  if (issue.code === 'invalid_type') {
    if (head === 'provenance') {
      return {
        code: 'corpus/provenance-required',
        field: 'provenance',
        message: 'derived frontmatter requires a provenance block (generator, canonIds, sourceHashes, model, judge)',
      };
    }
    if (head !== undefined && LIVED_STAMP_KEYS.includes(head)) {
      return {
        code: 'corpus/lived-stamps-required',
        field: head,
        message: `lived frontmatter requires '${head}' (episodeIds, encodedAffect and outcome are all mandatory)`,
      };
    }
    return { code: 'corpus/schema', field, message: `expected ${String(issue.expected ?? 'different type')}` };
  }

  if (issue.code === 'too_big' || issue.code === 'too_small') {
    if (head === 'affect') {
      return {
        code: 'corpus/affect-range',
        field: path[1] !== undefined ? `affect.${path[1]}` : 'affect',
        message: 'affect values must lie in [-1, 1]',
      };
    }
    return { code: 'corpus/schema', field, message: issue.message };
  }

  return { code: 'corpus/schema', field, message: issue.message };
};

const firstLine = (message: string): string => message.split('\n')[0] ?? message;

/** Sorted affect keys (defensive helper for callers holding already-parsed data). */
export const affectKeys = (affect: SparseAffect): string[] => Object.keys(affect).sort();

/** True when every key of `affect` is in AFFECT_DIMS (zod already guarantees this post-parse). */
export const affectKeysValid = (affect: SparseAffect): boolean =>
  affectKeys(affect).every((k) => (AFFECT_DIMS as readonly string[]).includes(k));

/** Vocabulary check against the 8 behavioral dimensions. */
export const isDimension = (value: string): boolean => Dimension.safeParse(value).success;

export { SparseAffectStrict };

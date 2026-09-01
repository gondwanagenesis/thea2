// M07 corpus — content identity for the derived/lived populations.
//
// A generated file's id is the contentHash of its own text — but the text
// contains the id line, which would be a self-reference paradox (the id can
// never equal the hash of a string containing that id). The convention: the
// id line is masked to a fixed placeholder before hashing. Any other byte,
// frontmatter or body, is covered — a hand edit to a derived file breaks its
// hash, and lint/corpus:check report the mismatch instead of absorbing it.
//
// Writers (M08 derive, M10 consolidate) consume these helpers through their
// module's re-export; this file is the single source of the convention.

import { contentHash } from '../kernel/index.js';
import { splitExemplarFile } from './frontmatter.js';

/**
 * The placeholder a generator writes into `id:` before the real id exists.
 * Writers stamp the real id afterwards; the result's masked hash is that id.
 */
export const DERIVED_ID_PLACEHOLDER = 'sha256:pending';

const ID_LINE_RE = /^id:[^\n]*$/m;

/**
 * The file text as it is hashed: newline-normalized (M07's read convention —
 * CorpusFile.raw is already normalized; this also makes direct-from-disk
 * callers checkout-stable) with the id line masked. Throws corpus/no-frontmatter
 * when the text is not an exemplar file at all — callers treat that as a
 * failed generation.
 */
export const hashableText = (raw: string): string => {
  const { frontmatterText, body } = splitExemplarFile(raw.replaceAll('\r\n', '\n'));
  return `---\n${frontmatterText.replace(ID_LINE_RE, `id: ${DERIVED_ID_PLACEHOLDER}`)}\n---\n${body}`;
};

/** The content id of a derived/lived file (the manifest entry id and the file stem). */
export const derivedFileId = (raw: string): string => contentHash(hashableText(raw));

/**
 * Rewrites the id line in place. Used once per accepted generation, after the
 * hash is known; the result's masked hash is exactly `id`.
 */
export const withFileId = (raw: string, id: string): string => {
  const { frontmatterText, body } = splitExemplarFile(raw.replaceAll('\r\n', '\n'));
  return `---\n${frontmatterText.replace(ID_LINE_RE, `id: ${id}`)}\n---\n${body}`;
};

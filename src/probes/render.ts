// M19 probes — prompt rendering shared by the judge. Pure text shaping only;
// the corpus index and the injected canon reader are the only sources, and a
// miss throws (rendering a grading prompt with a hole in it would forge a score).

import type { CorpusIndex } from '../corpus/corpus-index.js';
import { ProbeError } from './errors.js';

/** The rubric anchor text: an exemplar id resolves through the index; any other
 * canon path goes through the injected reader (identity.md is deliberately not
 * an exemplar). */
export const anchorTextFor = (
  anchor: string,
  corpus: CorpusIndex,
  readCanonFile?: (corpusPath: string) => string | undefined,
): string => {
  const exemplar = corpus.byId(anchor);
  if (exemplar !== undefined) return exemplar.body;
  const text = readCanonFile?.(anchor);
  if (text === undefined) {
    throw new ProbeError(
      'probes/anchor-unresolved',
      `judge anchor '${anchor}' is neither an exemplar id nor readable via the injected canon reader`,
      { field: 'expect.judgeRubric.anchor' },
    );
  }
  return text;
};

export const renderExemplar = (context: string, body: string): string => `context: ${context}\n---\n${body}\n---`;

export const renderTranscript = (inbound: readonly string[], outbound: readonly string[]): string => {
  const lines: string[] = [];
  let outIdx = 0;
  for (const text of inbound) lines.push(`Diego: ${text}`);
  for (; outIdx < outbound.length; outIdx++) lines.push(`Thea: ${outbound[outIdx] ?? ''}`);
  if (outbound.length === 0) lines.push('(Thea did not reply)');
  return lines.join('\n');
};

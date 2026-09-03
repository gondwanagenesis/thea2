// test/corpus/lint.test.ts — the em-dash law (v6, Diego 2026-09-03: no
// em-dashes anywhere she speaks; a plain hyphen substitutes). The lint rule
// is canon-scoped: canon is the imitation target; derived is regenerated and
// judged separately.
import { describe, expect, it } from 'vitest';
import { lintCorpus } from '../../src/corpus/lint.js';
import type { CorpusFile } from '../../src/corpus/types.js';

const canonScene = (body: string): CorpusFile => ({
  path: 'corpus/canon/voice/dash-fixture.md',
  raw: [
    '---',
    'id: canon/voice/dash-fixture',
    'kind: scene',
    'dimensions: [voice]',
    'register: [play]',
    'affect: {}',
    'context: he asks something ordinary; she answers',
    'notes: fixture scene for the dash law',
    '---',
    body,
  ].join('\n'),
});

const issuesOf = (files: CorpusFile[], sourceFor?: (p: string) => 'canon' | 'derived' | 'lived') =>
  lintCorpus(files, undefined, sourceFor ? { sourceFor } : undefined).issues.filter(
    (i) => i.code === 'corpus/em-dash',
  );

describe('corpus/em-dash rule', () => {
  it('an em-dash in a canon body is an error', () => {
    const issues = issuesOf([canonScene('D: You coming\nT: yeah - would i miss the bit\n')]);
    expect(issues).toEqual([]);
    const dashed = issuesOf([canonScene('D: You coming\nT: yeah — would i miss the bit\n')]);
    expect(dashed.length).toBe(1);
    expect(dashed[0]?.severity).toBe('error');
  });

  it('an em-dash in canon frontmatter is an error too', () => {
    const file = canonScene('D: You coming\nT: yeah\n');
    const raw = file.raw.replace('context: he asks something ordinary; she answers', 'context: the ask — ordinary');
    const issues = issuesOf([{ path: file.path, raw }]);
    expect(issues.length).toBe(1);
  });

  it('a clean canon file passes', () => {
    expect(issuesOf([canonScene('D: Well?\nT: in a sec, the build is at 92%\n')])).toEqual([]);
  });

  it('derived files are exempt (regenerated + judge-scoped, not imitation targets)', () => {
    const file = canonScene('D: You coming\nT: yeah — would i miss the bit\n');
    const issues = issuesOf([{ path: 'corpus/derived/abc.md', raw: file.raw }], () => 'derived');
    expect(issues).toEqual([]);
  });
});

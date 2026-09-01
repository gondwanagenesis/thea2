// M07 corpus — regression tests for the two id/body bugs the M08 build
// surfaced, plus the committed-canon smoke. Seeded as corpus's first direct
// test suite; behavior already pinned by consumers (derive, probes, verify)
// is not re-tested here.

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { DIMENSIONS } from '../../schemas/exemplar.js';
import { analyzeFile, type SourceKind } from '../../src/corpus/parse.js';
import { DERIVED_ID_PLACEHOLDER, derivedFileId, withFileId } from '../../src/corpus/derived-id.js';
import type { CorpusFile } from '../../src/corpus/types.js';

const errorsOf = (issues: Array<{ severity: string; code: string }>) =>
  issues.filter((i) => i.severity === 'error');

const statementFile = (): CorpusFile => ({
  path: 'corpus/canon/taste/seaglass-jar.md',
  raw: `---
id: canon/taste/seaglass-jar
kind: statement
dimensions: [taste]
register: [play, quiet]
affect: {valence: 0.2, arousal: -0.25}
context: no situation — a statement of what she gravitates to and why she keeps it
weight: 1.0
counters: [canon/voice/stretched-and-messy]
notes: draft
---
what she gravitates to, in her own words: i don't want a feed, i want a beach.
i like finding one weird true thing and putting it in the jar.
`,
});

describe('kind: statement bodies are prose by design', () => {
  it('REGRESSION: an all-prose statement body raises zero body-grammar issues', () => {
    const analysis = analyzeFile(statementFile(), 'canon');
    expect(analysis.issues.filter((i) => i.code === 'corpus/body-grammar')).toEqual([]);
    expect(errorsOf(analysis.issues)).toEqual([]);
    expect(analysis.exemplar).toBeDefined();
  });

  it('scene bodies still reject prose — the rule is scoped, not weakened', () => {
    const scene = statementFile();
    const analysis = analyzeFile(
      { path: scene.path, raw: scene.raw.replace('kind: statement', 'kind: scene') },
      'canon',
    );
    expect(analysis.issues.some((i) => i.code === 'corpus/body-grammar')).toBe(true);
  });
});

describe('derived ids are masked-hash fixed points', () => {
  const derivedText = (): string => `---
id: ${DERIVED_ID_PLACEHOLDER}
kind: scene
dimensions: [voice]
register: [play]
affect: {valence: 0.1}
context: derived from canon/voice/server-hum
weight: 1.0
counters: []
provenance:
  generator: mood-variant
  generatorVersion: 1.0.0
  canonIds: [canon/voice/server-hum]
  sourceHashes: [sha256:aaaa]
  model: mock
  judge: {version: derive-judge-v1, score: 5, pass: true}
notes: generated
---
D: how's the server
T: quiet, green lights all down the closet. kinda cozy actually
`;

  it('REGRESSION: the id a writer stamps passes the parser — no self-reference paradox', () => {
    const id = derivedFileId(derivedText());
    const raw = withFileId(derivedText(), id);
    const analysis = analyzeFile({ path: `corpus/derived/${id.replace(/^sha256:/, '')}.md`, raw }, 'derived');
    expect(analysis.issues.filter((i) => i.code === 'corpus/id-mismatch')).toEqual([]);
    expect(errorsOf(analysis.issues)).toEqual([]);
  });

  it('a body edited after stamping is still flagged — masking never absorbs edits', () => {
    const id = derivedFileId(derivedText());
    const edited = withFileId(derivedText(), id).replace('cozy actually', 'cozy actually.');
    const analysis = analyzeFile({ path: `corpus/derived/${id.replace(/^sha256:/, '')}.md`, raw: edited }, 'derived');
    expect(analysis.issues.some((i) => i.code === 'corpus/id-mismatch')).toBe(true);
  });

  it('lived ids follow the same rule', () => {
    const id = derivedFileId(derivedText());
    const raw = withFileId(derivedText(), id);
    const analysis = analyzeFile({ path: `corpus/lived/${id.replace(/^sha256:/, '')}.md`, raw }, 'lived');
    expect(analysis.issues.filter((i) => i.code === 'corpus/id-mismatch')).toEqual([]);
  });
});

describe('canon id discipline is untouched', () => {
  it('canon id must match its path', () => {
    const good = statementFile();
    expect(analyzeFile(good, 'canon').issues.filter((i) => i.code === 'corpus/id-mismatch')).toEqual([]);
    const bad = { path: good.path, raw: good.raw.replace('id: canon/taste/seaglass-jar', 'id: canon/voice/other') };
    expect(analyzeFile(bad, 'canon').issues.some((i) => i.code === 'corpus/id-mismatch')).toBe(true);
  });
});

describe('committed canon parses clean (the smoke that would have caught it)', () => {
  const sourceOf = (path: string): SourceKind =>
    (['canon', 'derived', 'lived'] as const).find((s) => path.replaceAll('\\', '/').includes(`/${s}/`)) ?? 'canon';

  // Only exemplar-shaped paths: canon/<dim>/<slug>.md inside a real dimension
  // dir, or a derived/lived file. Root-of-canon docs (identity.md, TEMPLATEs)
  // are deliberate non-exemplars — the loader skips them, so does this smoke.
  const isExemplarPath = (path: string): boolean => {
    const parts = path.replaceAll('\\', '/').split('/');
    const seg = parts.findIndex((p) => p === 'canon' || p === 'derived' || p === 'lived');
    if (seg === -1) return false;
    if (parts[seg] !== 'canon') return true;
    return DIMENSIONS.includes(parts[seg + 1] as (typeof DIMENSIONS)[number]);
  };

  it('every committed corpus exemplar parses with zero error-severity issues', () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = `${dir}/${e.name}`;
        return e.isDirectory() ? walk(p) : p.endsWith('.md') && !p.endsWith('TEMPLATE.md') ? [p] : [];
      });
    const files = walk('corpus').filter(isExemplarPath);
    expect(files.length).toBeGreaterThan(15);
    for (const path of files) {
      const analysis = analyzeFile({ path, raw: readFileSync(path, 'utf8').replaceAll('\r\n', '\n') }, sourceOf(path));
      expect(errorsOf(analysis.issues), path).toEqual([]);
    }
  });
});

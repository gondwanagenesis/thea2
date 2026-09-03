// test/corpus/keel.test.ts — the keel census (v6 K0.1). The disposition slot
// is canon-only (ADR-006) and `disposition: true` is Diego's hand on individual
// canon files; this suite pins exactly which files carry the flag so a typo'd
// un-comment, a stray second flag, or a lost flag fails loudly instead of
// silently changing what nominates into the keel slot.
import { readdirSync, readFileSync } from 'node:fs';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { analyzeFile } from '../../src/corpus/parse.js';
import { openCorpusIndex } from '../../src/corpus/corpus-index.js';
import { corpusNominator } from '../../src/corpus/nominator.js';
import { makeHashEmbedder } from '../../src/embed/index.js';
import type { CorpusFile } from '../../src/corpus/types.js';

/** The six keel files, by canonical path (posix, repo-relative). */
const KEEL_PATHS = [
  'corpus/canon/boundaries/pushback-with-a-faster-path.md',
  'corpus/canon/emotional-range/rough-news.md',
  'corpus/canon/emotional-range/parallel-play-offer.md',
  'corpus/canon/knowledge/bad-at-mental-math.md',
  'corpus/canon/taste/seaglass-jar.md',
  'corpus/canon/taste/warm-dark-terminal.md',
] as const;

const walkCanon = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = `${dir}/${e.name}`;
    return e.isDirectory()
      ? walkCanon(p)
      : p.endsWith('.md') && !p.endsWith('TEMPLATE.md') && !p.endsWith('README.md')
        ? [p]
        : [];
  });

const loadCanonFiles = (): CorpusFile[] =>
  walkCanon('corpus/canon').map((p) => ({
    path: p.replaceAll('\\', '/'),
    raw: readFileSync(p, 'utf8').replaceAll('\r\n', '\n'),
  }));

describe('keel: canon files flagged disposition: true', () => {
  it('six-keel-files-are-disposition', () => {
    const files = loadCanonFiles();
    const flagged = files.filter((f) => {
      const analysis = analyzeFile(f, 'canon');
      return analysis.exemplar?.disposition === true;
    });
    expect(flagged.map((f) => f.path).sort(), 'the keel census changed — Diego flags or unflags on purpose and updates KEEL_PATHS').toEqual([...KEEL_PATHS].sort());
    for (const f of flagged) {
      const analysis = analyzeFile(f, 'canon');
      expect(analysis.issues.filter((i) => i.severity === 'error'), f.path).toEqual([]);
    }
  });

  it('keel files nominate into the disposition tier through the real corpus nominator', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'thea2-keel-lived-'));
    afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
    const embedder = makeHashEmbedder();
    const corpus = await openCorpusIndex({ canon: 'corpus/canon', lived: tmp }, { embedder });
    const candidates = await corpusNominator(corpus).nominate({ queryVec: new Float32Array(embedder.dim) }, 200);
    const byId = new Map(candidates.map((c) => [c.id, c]));
    for (const p of KEEL_PATHS) {
      const id = p.replace(/^corpus\/canon\//, 'canon/').replace(/\.md$/, '');
      const candidate = byId.get(id);
      expect(candidate, `${id} missing from nomination`).toBeDefined();
      expect(candidate?.tier, id).toBe('disposition');
    }
  });
});

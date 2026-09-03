// test/corpus — the filesystem-backed index: open/reload over real dirs (round
// 2's reload seam). The consolidator writes lived scenes into var/lived at
// runtime; the index must pick them up through reload() — no restart — and the
// corpus nominator must then be able to SELECT them. This file pins the reload
// path only; parsing/lint/identity live in their own suites.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeHashEmbedder } from '../../src/embed/index.js';
import { openCorpusIndex } from '../../src/corpus/corpus-index.js';
import { corpusNominator } from '../../src/corpus/nominator.js';
import { fileBaseName, renderLivedDraft } from '../../src/consolidate/index.js';
import { derivedFileId, withFileId } from '../../src/corpus/derived-id.js';
import { AFFECT_DIMS, type AffectDim } from '../../schemas/exemplar.js';

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

const freshRoots = (): { canon: string; lived: string } => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'thea2-corpus-index-'));
  roots.push(root);
  const canon = path.join(root, 'corpus', 'canon');
  const lived = path.join(root, 'var', 'lived');
  fs.mkdirSync(canon, { recursive: true });
  fs.mkdirSync(lived, { recursive: true });
  return { canon, lived };
};

/** A lived exemplar exactly as M10's consolidator writes it: rendered with the
 * placeholder id, then stamped with the content hash. */
const livedFile = (): { name: string; id: string; text: string } => {
  const zeroAffect = Object.fromEntries(AFFECT_DIMS.map((d) => [d, 0])) as Record<AffectDim, number>;
  const draft = renderLivedDraft(
    {
      dimensions: ['voice'],
      register: ['play'],
      affect: {},
      context: 'late night, one lamp, the fans humming',
      weight: 1,
      episodeIds: ['e1', 'e2', 'e3'],
      encodedAffect: zeroAffect,
      outcome: 'good',
      notes: 'fixture lived scene',
    },
    'Setup: a quiet terminal\nD: you there?\nT: always. say it and I keep it\n',
  );
  const id = derivedFileId(draft);
  return { name: `${fileBaseName(id)}.md`, id, text: withFileId(draft, id) };
};

describe('openCorpusIndex — the reload path (round 2)', () => {
  it('lived file is selectable after reload without restart', async () => {
    const { canon, lived } = freshRoots();
    const embedder = makeHashEmbedder();
    const corpus = await openCorpusIndex({ canon, lived }, { embedder });

    // Launch state: the consolidator has not run yet, the index holds nothing.
    expect(corpus.size()).toBe(0);
    const before = await corpusNominator(corpus).nominate({ queryVec: new Float32Array(embedder.dim) }, 5);
    expect(before).toEqual([]);

    // A nightly run lands a lived scene under var/lived ...
    const file = livedFile();
    fs.writeFileSync(path.join(lived, file.name), file.text, 'utf8');

    // ... and the index sees it through reload() — the exact call the
    // consolidator's onConsolidated hook will be wired to (round 3, compose).
    const report = await corpus.reload();
    expect(report.added).toEqual([file.id]);
    expect(report.removed).toEqual([]);
    expect(corpus.size()).toBe(1);
    expect(corpus.byId(file.id)).toMatchObject({ source: 'lived', kind: 'scene' });
    expect(corpus.quarantined()).toEqual([]);

    // The point of the whole seam: the corpus nominator can now SELECT it —
    // tier 'episode', source 'lived' — without any restart.
    const [query = new Float32Array(embedder.dim)] = await embedder.embed(['you there? say it and I keep it']);
    const candidates = await corpusNominator(corpus).nominate({ queryVec: query }, 5);
    const hit = candidates.find((c) => c.id === file.id);
    expect(hit).toBeDefined();
    expect(hit).toMatchObject({ tier: 'episode', source: 'lived', channel: 'character' });
    expect(hit?.render()).toContain('you there?');
  });

  it('reload is incremental: unchanged files are not re-embedded', async () => {
    const { canon, lived } = freshRoots();
    const embedder = makeHashEmbedder();
    const corpus = await openCorpusIndex({ canon, lived }, { embedder });

    const file = livedFile();
    fs.writeFileSync(path.join(lived, file.name), file.text, 'utf8');
    await corpus.reload();

    // A second reload with nothing dirty: everything served from the hash comparison.
    const stable = await corpus.reload();
    expect(stable.embedded).toBe(0);
    expect(stable.added).toEqual([]);
    expect(stable.removed).toEqual([]);

    // A removal is seen too — the fold stays the truth.
    fs.rmSync(path.join(lived, file.name));
    const afterRemove = await corpus.reload();
    expect(afterRemove.removed).toEqual([file.id]);
    expect(corpus.byId(file.id)).toBeUndefined();
    expect(corpus.size()).toBe(0);
  });
});

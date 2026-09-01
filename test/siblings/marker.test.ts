// M18 gate — the deploy marker. var/deploy-marker is a content hash over
// {code version, var/routing.json, inhibitions.yaml, coupling.yaml, corpus hash}:
// ANY of those changing is a deploy, because each one can silently alter
// behavior. A persona seed edit is deliberately NOT an input (voice for reports,
// not behavior), and that omission is pinned too. The stored file keeps the
// per-input hashes so a red report can name WHAT changed.

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { canonicalJson, contentHash } from '../../src/kernel/index.js';
import {
  DEFAULT_CODE_VERSION,
  MARKER_INPUT_LABELS,
  computeMarkerInputs,
  corpusHash,
  diffMarker,
  markerHash,
  readMarker,
  writeMarker,
} from '../../src/siblings/marker.js';
import { rmDir, tmpDir, writeText } from './helpers.js';

/** A real input tree: every marker input present on disk, plus a persona dir
 * that is deliberately outside the hash. */
const inputTree = (label: string): string => {
  const root = tmpDir(label);
  writeText(path.join(root, 'var', 'routing.json'), canonicalJson([]));
  writeText(path.join(root, 'corpus', 'canon', 'inhibitions.yaml'), 'rules: []\n');
  writeText(path.join(root, 'coupling.yaml'), 'matrix: {}\n');
  writeText(path.join(root, 'corpus', 'canon', 'voice', 'late-server.md'), 'D: you there?\nT: always.\n');
  writeText(path.join(root, 'personas', 'ledger.md'), 'seed v1\n');
  return root;
};

const inputsFor = async (root: string) =>
  computeMarkerInputs({
    codeVersion: 'test-1',
    routingPath: path.join(root, 'var', 'routing.json'),
    inhibitionsPath: path.join(root, 'corpus', 'canon', 'inhibitions.yaml'),
    couplingPath: path.join(root, 'coupling.yaml'),
    corpusDir: path.join(root, 'corpus', 'canon'),
  });

describe('the marker inputs', () => {
  it('a not-yet-existing config is a state ("absent"), not an error', async () => {
    const dir = tmpDir('marker-absent');
    try {
      // Explicit missing paths for every input: the defaults are install-relative,
      // and the repo checkout has real files there.
      const inputs = await computeMarkerInputs({
        routingPath: path.join(dir, 'var', 'routing.json'),
        inhibitionsPath: path.join(dir, 'no', 'inhibitions.yaml'),
        couplingPath: path.join(dir, 'no', 'coupling.yaml'),
        corpusDir: path.join(dir, 'no', 'canon'),
      });
      expect(inputs).toEqual({
        codeVersion: DEFAULT_CODE_VERSION,
        routing: 'absent',
        inhibitions: 'absent',
        coupling: 'absent',
        corpus: 'absent',
      });
      // An all-absent install still hashes to a stable value.
      expect(markerHash(inputs)).toBe(contentHash(canonicalJson(inputs)));
    } finally {
      rmDir(dir);
    }
  });

  it('the code version defaults to the module constant when M20 injects nothing', async () => {
    const dir = tmpDir('marker-codeversion');
    try {
      const inputs = await computeMarkerInputs({ routingPath: path.join(dir, 'nothing.json') });
      expect(inputs.codeVersion).toBe(DEFAULT_CODE_VERSION);
      expect(DEFAULT_CODE_VERSION).toBe('0.1.0');
    } finally {
      rmDir(dir);
    }
  });

  it('hashes the BYTES: every one of the five inputs moving is a different marker', async () => {
    const root = inputTree('marker-sensitive');
    const base = await inputsFor(root);

    // An inhibitions edit is deliberately TWO inputs at once: the yaml is its own
    // input AND it lives inside corpus/canon, so the corpus hash moves with it.
    writeText(path.join(root, 'corpus', 'canon', 'inhibitions.yaml'), 'rules: [x]\n');
    const afterInhibitions = await inputsFor(root);
    expect(diffMarker(base, afterInhibitions)).toEqual([
      MARKER_INPUT_LABELS.inhibitions,
      MARKER_INPUT_LABELS.corpus,
    ]);
    expect(markerHash(afterInhibitions)).not.toBe(markerHash(base));

    const touch = async (file: string, text: string): Promise<void> => {
      const before = await inputsFor(root);
      writeText(file, text);
      const after = await inputsFor(root);
      expect(markerHash(after)).not.toBe(markerHash(before));
      // Every other touch moves exactly one named input.
      expect(diffMarker(before, after)).toHaveLength(1);
    };

    await touch(path.join(root, 'coupling.yaml'), 'matrix: {a: 1}\n');
    await touch(path.join(root, 'var', 'routing.json'), canonicalJson([{ taskClass: 'summarize', tier: 'cheap' }]));
    await touch(path.join(root, 'corpus', 'canon', 'voice', 'late-server.md'), 'D: you there?\nT: sure.\n');
    // A NEW canon file is a corpus change too, and so is a nested one.
    writeText(path.join(root, 'corpus', 'canon', 'emotional-range', 'missing-you.md'), 'D: hey\nT: yeah\n');
    const grown = await inputsFor(root);
    expect(grown.corpus).not.toBe(base.corpus);
    expect(markerHash(grown)).not.toBe(markerHash(base));
  });

  it('the code version is an input: a new deploy is a new marker even with identical configs', async () => {
    const root = inputTree('marker-deploy');
    const a = await inputsFor(root);
    const b = await computeMarkerInputs({
      codeVersion: 'test-2',
      routingPath: path.join(root, 'var', 'routing.json'),
      inhibitionsPath: path.join(root, 'corpus', 'canon', 'inhibitions.yaml'),
      couplingPath: path.join(root, 'coupling.yaml'),
      corpusDir: path.join(root, 'corpus', 'canon'),
    });
    expect(b.codeVersion).toBe('test-2');
    expect(markerHash(b)).not.toBe(markerHash(a));
  });

  it('a persona seed edit is NOT a marker input — Nightingale sleeps for voice-only changes', async () => {
    const root = inputTree('marker-persona');
    const before = await inputsFor(root);
    writeText(path.join(root, 'personas', 'ledger.md'), 'seed v2 — a whole new voice\n');
    writeText(path.join(root, 'personas', 'nightingale.md'), 'seed v2\n');
    expect(await inputsFor(root)).toEqual(before);
  });

  it('markerHash is order-independent by construction (canonicalJson sorts the keys)', async () => {
    const a = { codeVersion: 'v', routing: 'r', inhibitions: 'i', coupling: 'c', corpus: 'k' };
    const b = { corpus: 'k', coupling: 'c', inhibitions: 'i', routing: 'r', codeVersion: 'v' };
    expect(markerHash(b)).toBe(markerHash(a));
  });
});

describe('corpusHash — the canon walk', () => {
  it('an absent directory hashes as "absent"; an empty one is the hash of an empty pair list', async () => {
    const dir = tmpDir('corpus-hash');
    try {
      expect(await corpusHash(path.join(dir, 'nope'))).toBe('absent');
      const empty = path.join(dir, 'empty');
      fs.mkdirSync(empty, { recursive: true });
      expect(await corpusHash(empty)).toBe(contentHash(canonicalJson([])));
    } finally {
      rmDir(dir);
    }
  });

  it('walks nested directories, and the PATH is part of the hash', async () => {
    const dir = tmpDir('corpus-hash-tree');
    try {
      writeText(path.join(dir, 'a', 'voice', 'one.md'), 'one\n');
      writeText(path.join(dir, 'a', 'voice', 'deep', 'two.md'), 'two\n');
      const withDeep = await corpusHash(path.join(dir, 'a'));

      fs.rmSync(path.join(dir, 'a', 'voice', 'deep'), { recursive: true });
      const withoutDeep = await corpusHash(path.join(dir, 'a'));
      expect(withDeep).not.toBe(withoutDeep);

      // Same bytes under a different name hash differently: the pair list is
      // [relative path, content hash], not just the content.
      writeText(path.join(dir, 'b', 'voice', 'renamed.md'), 'one\n');
      expect(await corpusHash(path.join(dir, 'b'))).not.toBe(withoutDeep);
    } finally {
      rmDir(dir);
    }
  });

  it('hashes the sorted [relative path, content hash] pair list — no dirent order can leak in', async () => {
    const dir = tmpDir('corpus-hash-golden');
    try {
      writeText(path.join(dir, 'voice', 'zeta.md'), 'zeta\n');
      writeText(path.join(dir, 'voice', 'alpha.md'), 'alpha\n');
      writeText(path.join(dir, 'taste', 'one.md'), 'one\n');
      // The golden form: forward-slash relative paths, path-sorted, then combined.
      expect(await corpusHash(dir)).toBe(
        contentHash(
          canonicalJson([
            ['taste/one.md', contentHash(Buffer.from('one\n', 'utf8'))],
            ['voice/alpha.md', contentHash(Buffer.from('alpha\n', 'utf8'))],
            ['voice/zeta.md', contentHash(Buffer.from('zeta\n', 'utf8'))],
          ]),
        ),
      );
    } finally {
      rmDir(dir);
    }
  });
});

describe('diffMarker — what changed, by human name', () => {
  it('names only the inputs that moved, using the report labels', () => {
    const before = { codeVersion: 'v1', routing: 'r1', inhibitions: 'i1', coupling: 'c1', corpus: 'k1' };
    expect(diffMarker(before, { ...before })).toEqual([]);
    expect(diffMarker(before, { ...before, routing: 'r2' })).toEqual([MARKER_INPUT_LABELS.routing]);
    expect(diffMarker(before, { ...before, corpus: 'k2', codeVersion: 'v2' })).toEqual([
      MARKER_INPUT_LABELS.codeVersion,
      MARKER_INPUT_LABELS.corpus,
    ]);
    expect(MARKER_INPUT_LABELS.routing).toBe('var/routing.json');
    expect(MARKER_INPUT_LABELS.codeVersion).toBe('code version');
    expect(MARKER_INPUT_LABELS.corpus).toBe('corpus hash');
  });
});

describe('the marker file', () => {
  it('round-trips: writeMarker stores version 1, the combined hash, and the per-input hashes', async () => {
    const dir = tmpDir('marker-file');
    try {
      const file = path.join(dir, 'var', 'deploy-marker');
      const inputs = { codeVersion: 'v1', routing: 'r', inhibitions: 'i', coupling: 'c', corpus: 'k' };
      const written = await writeMarker(file, inputs);
      expect(written).toEqual({ version: 1, hash: markerHash(inputs), inputs });
      expect(await readMarker(file)).toEqual(written);
    } finally {
      rmDir(dir);
    }
  });

  it('a missing OR malformed marker reads as null — the safe side is probes running, never silence', async () => {
    const dir = tmpDir('marker-read');
    try {
      const file = path.join(dir, 'var', 'deploy-marker');
      expect(await readMarker(file)).toBeNull(); // absent: first observation

      writeText(file, '{ not json');
      expect(await readMarker(file)).toBeNull();

      writeText(file, canonicalJson({ version: 2, hash: 'x', inputs: {} }));
      expect(await readMarker(file)).toBeNull(); // wrong version

      writeText(file, canonicalJson({ version: 1, hash: 'x' }));
      expect(await readMarker(file)).toBeNull(); // missing inputs
    } finally {
      rmDir(dir);
    }
  });
});

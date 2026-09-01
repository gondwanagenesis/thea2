// M08 — manifest loader strictness. A manifest that does not match the schema
// is not a manifest; quietly accepting one would make dirty/orphan lie.

import { describe, expect, it } from 'vitest';
import {
  DeriveError,
  emptyManifest,
  loadManifest,
  serializeManifest,
  sortEntries,
  V1_GENERATORS,
  type ManifestEntry,
} from '../../src/derive/index.js';
import { contentHash } from '../../src/kernel/index.js';
import { baseInputs, errorCodeOf, makeArtifact, pristineTree, sceneA } from './helpers.js';

const sha = (s: string): string => contentHash(s);

const validEntry = (over: Partial<ManifestEntry> = {}): ManifestEntry => ({
  id: sha('a'),
  deriveKey: sha('b'),
  generator: 'mood-variant',
  generatorVersion: '1',
  inputs: { canonIds: [{ id: 'canon/voice/late-server', sha256: sha('c') }] },
  model: 'test-gen',
  createdAt: 0,
  judge: { version: 'derive-judge-v1', score: 5, pass: true },
  ...over,
});

describe('loadManifest', () => {
  it('round-trips through serializeManifest (canonical bytes in, same object out)', () => {
    const { manifest } = pristineTree(baseInputs(), V1_GENERATORS, 3);
    expect(loadManifest(serializeManifest(manifest))).toEqual(manifest);
  });

  it('rejects invalid JSON with derive/manifest-schema', () => {
    expect(() => loadManifest('{not json')).toThrowError(DeriveError);
    expect(errorCodeOf(() => loadManifest('{not json'))).toBe('derive/manifest-schema');
  });

  it('rejects unknown keys (strict), wrong version, and an empty embedder', () => {
    const doc = (over: object): string =>
      JSON.stringify({ version: 1, embedderId: 'e', entries: [], ...over });
    expect(errorCodeOf(() => loadManifest(doc({ extra: 1 })))).toBe('derive/manifest-schema');
    expect(errorCodeOf(() => loadManifest(doc({ version: 2 })))).toBe('derive/manifest-schema');
    expect(errorCodeOf(() => loadManifest(doc({ embedderId: '' })))).toBe('derive/manifest-schema');
    expect(errorCodeOf(() =>
      loadManifest(JSON.stringify({ version: 1, embedderId: 'e', entries: [validEntry()], oops: true })),
    )).toBe('derive/manifest-schema');
  });

  it('rejects entries with malformed hashes, a partial judge, or an empty inputs list', () => {
    const entry = (over: object): string =>
      JSON.stringify({ version: 1, embedderId: 'e', entries: [{ ...validEntry(), ...over }] });
    expect(errorCodeOf(() => loadManifest(entry({ id: 'not-a-hash' })))).toBe('derive/manifest-schema');
    expect(errorCodeOf(() => loadManifest(entry({ deriveKey: 'sha256:xyz' })))).toBe('derive/manifest-schema');
    expect(errorCodeOf(() => loadManifest(entry({ judge: { version: 'v', score: 5 } })))).toBe(
      'derive/manifest-schema',
    );
    expect(errorCodeOf(() => loadManifest(entry({ inputs: { canonIds: [] } })))).toBe('derive/manifest-schema');
    expect(errorCodeOf(() =>
      loadManifest(entry({ inputs: { canonIds: validEntry().inputs.canonIds, surprise: 1 } })),
    )).toBe('derive/manifest-schema');
    expect(errorCodeOf(() => loadManifest(entry({ createdAt: 1.5 })))).toBe('derive/manifest-schema');
  });

  it('the error names the offending path', () => {
    let message = '';
    try {
      loadManifest(JSON.stringify({ version: 1, embedderId: 'e', entries: [validEntry({ createdAt: -1 })] }));
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('entries.0.createdAt');
  });
});

describe('sortEntries + emptyManifest', () => {
  it('orders by deriveKey then id, without mutating the input array', () => {
    const low = 'sha256:' + 'a'.repeat(64);
    const high = 'sha256:' + 'b'.repeat(64);
    const mid = 'sha256:' + 'a'.repeat(63) + 'c'; // between low and high by one hex digit
    const c = validEntry({ deriveKey: high, id: sha('1') });
    const a = validEntry({ deriveKey: low, id: sha('2') });
    const b = validEntry({ deriveKey: mid, id: sha('3') });
    expect(sortEntries([c, a, b]).map((e) => e.deriveKey)).toEqual([low, mid, high]);
    expect(sortEntries([validEntry({ deriveKey: low, id: high }), validEntry({ deriveKey: low, id: low })]).map((e) => e.id)).toEqual([
      low,
      high,
    ]);
    // input untouched
    expect([c, a, b].map((e) => e.deriveKey)).toEqual([high, low, mid]);
  });

  it('emptyManifest has no entries and the current schema version', () => {
    expect(emptyManifest('emb')).toEqual({ version: 1, embedderId: 'emb', entries: [] });
  });
});

describe('fixture sanity', () => {
  it('artifacts hash to their own ids and sceneA is a usable canon source', () => {
    const inputs = baseInputs();
    const generator = V1_GENERATORS[0]!;
    const target = generator.targets(inputs)[0]!;
    const artifact = makeArtifact({ generator, target, n: 1, kind: 'scene' });
    expect(artifact.entry.id).toBe(artifact.id);
    expect(sceneA().source).toBe('canon');
  });
});

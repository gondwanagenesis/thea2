// M08 gate — identity goldens. deriveKey is what decides dirty; the file id is
// what decides tamper. Both are pinned here so a hash change can never land as
// a silent behavior change.

import { describe, expect, it } from 'vitest';
import type { Exemplar } from '../../schemas/exemplar.js';
import {
  DERIVED_ID_PLACEHOLDER,
  canonSourceHash,
  derivedFileId,
  deriveKeyOf,
  fileBaseName,
  hashableText,
  sortedInputHashes,
  targetDeriveKey,
  templateHashOf,
  toolDefHash,
  withFileId,
} from '../../src/derive/index.js';
import { canonicalJson, contentHash } from '../../src/kernel/index.js';
import { compareStrings } from '../../src/corpus/types.js';
import { renderDraft, withProvenance } from '../../src/derive/index.js';
import { sceneA, TOOL_DEFS } from './helpers.js';

const sha = (s: string): string => contentHash(s);

describe('deriveKey', () => {
  it('is deterministic and changes when any part changes', () => {
    const key = deriveKeyOf('mood-variant', '1', [sha('x'), sha('y')], sha('t'));
    expect(key).toBe(deriveKeyOf('mood-variant', '1', [sha('x'), sha('y')], sha('t')));
    expect(key).not.toBe(deriveKeyOf('mood-variant', '2', [sha('x'), sha('y')], sha('t')));
    expect(key).not.toBe(deriveKeyOf('procedural', '1', [sha('x'), sha('y')], sha('t')));
    expect(key).not.toBe(deriveKeyOf('mood-variant', '1', [sha('x')], sha('t')));
    expect(key).not.toBe(deriveKeyOf('mood-variant', '1', [sha('x'), sha('y')], sha('other')));
  });

  it('is independent of input-hash ORDER (sortedInputHashes is the spec pin)', () => {
    const [h1, h2, h3] = [sha('1'), sha('2'), sha('3')];
    expect(deriveKeyOf('g', '1', [h1, h2, h3], 't')).toBe(deriveKeyOf('g', '1', [h3, h1, h2], 't'));
    // the tool hash rides in the same sorted set as the canon hashes
    expect(sortedInputHashes({ canonIds: [{ sha256: h3 }, { sha256: h1 }], toolDefsHash: h2 })).toEqual(
      [h1, h2, h3].sort(compareStrings),
    );
    expect(sortedInputHashes({ canonIds: [{ sha256: h1 }] })).toEqual([h1]);
  });

  it('concatenates parts unambiguously (canonical JSON, not string +)', () => {
    // 'a'+'b|c' would collide with 'a|b'+'c' under naive concatenation.
    expect(deriveKeyOf('a', 'b|c', [], 't')).not.toBe(deriveKeyOf('a|b', 'c', [], 't'));
  });

  it('targetDeriveKey rebuilds the key a generator computed (makeTarget agreement)', () => {
    const template = 'TEMPLATE v1';
    const target = {
      templateHash: templateHashOf(template),
      inputs: { canonIds: [{ id: 's', sha256: sha('s') }], toolDefsHash: sha('t') },
    };
    expect(targetDeriveKey({ name: 'g', version: '1' }, target)).toBe(
      deriveKeyOf('g', '1', sortedInputHashes(target.inputs), target.templateHash),
    );
    expect(templateHashOf(template)).toBe(contentHash(template));
  });
});

describe('source hashes', () => {
  it('canonSourceHash: meaning edits change it, key order does not', () => {
    const a = sceneA();
    expect(canonSourceHash(a)).toBe(contentHash(canonicalJson(a)));
    // reverse insertion order — canonicalJson must sort keys for this to hold
    const reordered: Exemplar = {
      notes: a.notes,
      body: a.body,
      tokens: a.tokens,
      source: a.source,
      weight: a.weight,
      context: a.context,
      affect: a.affect,
      register: a.register,
      dimensions: a.dimensions,
      kind: a.kind,
      id: a.id,
    };
    expect(canonSourceHash(reordered)).toBe(canonSourceHash(a));
    const edited = sceneA();
    edited.body = `${a.body}T: one more bubble\n`;
    expect(canonSourceHash(edited)).not.toBe(canonSourceHash(a));
    const noted = sceneA();
    noted.notes = 'different judge contract';
    expect(canonSourceHash(noted)).not.toBe(canonSourceHash(a));
  });

  it('toolDefHash changes when a def changes', () => {
    const first = TOOL_DEFS[0]!;
    expect(toolDefHash(first)).toBe(contentHash(canonicalJson(first)));
    expect(toolDefHash({ ...first, description: 'changed' })).not.toBe(toolDefHash(first));
  });
});

describe('output hashes (content addressing)', () => {
  const meta = {
    kind: 'scene' as const,
    dimensions: ['voice'],
    register: ['play'],
    affect: { valence: 0.2 },
    context: 'fixture',
    weight: 1,
  };
  const draft = renderDraft(meta, 'D: one\nT: two\n');
  const attested = withProvenance(draft, {
    generator: 'g',
    generatorVersion: '1',
    canonIds: ['canon/voice/late-server'],
    sourceHashes: [sha('s')],
    model: 'test-gen',
    judge: { version: 'derive-judge-v1', score: 5, pass: true },
  });

  it('the id line is masked before hashing: withFileId round-trips to its own id', () => {
    expect(attested).toContain(`id: ${DERIVED_ID_PLACEHOLDER}`);
    const id = derivedFileId(attested);
    expect(id).toMatch(/^sha256:[0-9a-f]{64}$/);
    const final = withFileId(attested, id);
    expect(derivedFileId(final)).toBe(id); // masking makes the id a fixed point
    expect(final).toContain(`id: ${id}`);
  });

  it('every other byte is covered: body OR provenance edits change the id', () => {
    const id = derivedFileId(attested);
    const bodyEdit = withFileId(attested.replace('T: two', 'T: two.'), id);
    expect(derivedFileId(bodyEdit)).not.toBe(id);
    const provEdit = withProvenance(draft, {
      generator: 'g',
      generatorVersion: '2',
      canonIds: ['canon/voice/late-server'],
      sourceHashes: [sha('s')],
      model: 'test-gen',
      judge: { version: 'derive-judge-v1', score: 5, pass: true },
    });
    expect(derivedFileId(provEdit)).not.toBe(id);
  });

  it('hashableText normalizes CRLF so a Windows checkout hashes identically', () => {
    const crlf = attested.replace(/\n/g, '\r\n');
    expect(derivedFileId(crlf)).toBe(derivedFileId(attested));
    expect(hashableText(crlf)).toBe(hashableText(attested));
  });

  it('fileBaseName strips the sha256: prefix (NTFS treats : as a data stream)', () => {
    expect(fileBaseName('sha256:abcdef')).toBe('abcdef');
    expect(fileBaseName('abcdef')).toBe('abcdef');
  });
});

// M08 gate — `corpus:check` truth table over constructed trees. This is what CI
// runs: hermetic, no model, no network, and every failure names exactly one
// thing that is wrong.

import { describe, expect, it } from 'vitest';
import {
  corpusCheck,
  emptyManifest,
  renderCheckReport,
  V1_GENERATORS,
  type CheckReport,
  type Manifest,
} from '../../src/derive/index.js';
import { contentHash } from '../../src/kernel/index.js';
import { baseInputs, pristineTree, sceneA, sceneB } from './helpers.js';
import type { DeriveInputs } from '../../src/derive/index.js';

const check = (inputs: DeriveInputs, manifest: Manifest, files: Map<string, string>): CheckReport =>
  corpusCheck({ inputs, manifest, generators: V1_GENERATORS, files });

/** An 8-target pristine tree: 4 mood variants (2 scenes × bright/low), 2 procedural, 1 deliberation, 1 weave. */
const smallTree = (): { inputs: DeriveInputs; manifest: Manifest; files: Map<string, string> } => {
  const inputs = baseInputs({ moodBuckets: ['bright', 'low'] });
  const { manifest, files } = pristineTree(inputs, V1_GENERATORS, 8);
  return { inputs, manifest, files };
};

describe('pristine corpus', () => {
  it('passes with zero dirty, zero orphans, zero violations, caps satisfied', () => {
    const { inputs, manifest, files } = smallTree();
    const report = check(inputs, manifest, files);
    expect(report.ok).toBe(true);
    expect(report.dirty).toEqual([]);
    expect(report.orphans).toEqual([]);
    expect(report.violations).toEqual([]);
    expect(report.caps.ok).toBe(true);
    expect(report.caps.canonCount).toBe(3);
    expect(report.caps.derivedCount).toBe(8);
    expect(report.caps.maxDerived).toBe(24);
  });

  it('the ok report renders the corpus:check ok line', () => {
    const { inputs, manifest, files } = smallTree();
    const lines = renderCheckReport(check(inputs, manifest, files)).split('\n');
    expect(lines.at(-1)).toBe('corpus:check ok — 8 derived, 0 dirty, 0 orphans');
  });
});

describe('violations', () => {
  it('a hand-edited derived file is a hash-mismatch NAMING the file, not absorbed', () => {
    const { inputs, manifest, files } = smallTree();
    const victim = manifest.entries[0]!;
    const tampered = files.get(victim.id)!.replace('weight: 1', 'weight: 1.5');
    const files2 = new Map(files);
    files2.set(victim.id, tampered);
    const report = check(inputs, manifest, files2);
    expect(report.ok).toBe(false);
    const mismatch = report.violations.find((v) => v.kind === 'hash-mismatch');
    expect(mismatch).toBeDefined();
    expect(mismatch && mismatch.kind === 'hash-mismatch' ? mismatch.id : '').toBe(victim.id);
    expect(mismatch && mismatch.kind === 'hash-mismatch' ? mismatch.fileHash : '').toBe(
      contentHash(tampered.replace(/^id:[^\n]*$/m, 'id: sha256:pending')),
    );
    expect(mismatch && mismatch.kind === 'hash-mismatch' ? mismatch.message : '').toContain('hand-edited');
    expect(renderCheckReport(report)).toContain(`VIOLATION hash-mismatch`);
  });

  it('a missing file is named', () => {
    const { inputs, manifest, files } = smallTree();
    const victim = manifest.entries[0]!;
    const files2 = new Map(files);
    files2.delete(victim.id);
    const report = check(inputs, manifest, files2);
    expect(report.violations.some((v) => v.kind === 'missing-file' && v.id === victim.id)).toBe(true);
    expect(report.ok).toBe(false);
  });

  it('a pass:false entry fails even though its bytes are intact', () => {
    const { inputs, manifest, files } = smallTree();
    const forged: Manifest = {
      ...manifest,
      entries: manifest.entries.map((e, i) =>
        i === 0 ? { ...e, judge: { ...e.judge, score: 2, pass: false } } : e,
      ),
    };
    const report = check(inputs, forged, files);
    const failed = report.violations.find((v) => v.kind === 'judge-failed');
    expect(failed).toBeDefined();
    expect(failed && failed.kind === 'judge-failed' ? failed.judge.pass : true).toBe(false);
    expect(report.ok).toBe(false);
  });

  it('a file no entry claims is reported, not ignored', () => {
    const { inputs, manifest, files } = smallTree();
    const files2 = new Map(files);
    files2.set('sha256:' + 'e'.repeat(64), 'not even an exemplar');
    const report = check(inputs, manifest, files2);
    const unclaimed = report.violations.find((v) => v.kind === 'unclaimed-file');
    expect(unclaimed && unclaimed.kind === 'unclaimed-file' ? unclaimed.id : '').toBe('sha256:' + 'e'.repeat(64));
    expect(report.ok).toBe(false);
  });
});

describe('dirty and orphans in check', () => {
  it('a missing manifest entry is a dirty failure (and its file reads as unclaimed)', () => {
    const { inputs, manifest, files } = smallTree();
    const dropped = manifest.entries[0]!;
    const forged: Manifest = { ...manifest, entries: manifest.entries.slice(1) };
    const report = check(inputs, forged, files);
    expect(report.dirty.map((t) => t.deriveKey)).toContain(dropped.deriveKey);
    expect(report.violations.some((v) => v.kind === 'unclaimed-file' && v.id === dropped.id)).toBe(true);
    expect(report.ok).toBe(false);
    expect(renderCheckReport(report)).toContain('DIRTY ');
  });

  it('an entry whose deriveKey left the expected set is GC-listed', () => {
    const { manifest, files } = smallTree();
    const shrunk = baseInputs({ moodBuckets: ['bright'] }); // 'low' variants lose their expected keys
    const report = check(shrunk, manifest, files);
    // enumeration order is scene×bucket, so entries 1 and 3 are the two 'low' variants
    const lowIds = [manifest.entries[1]!.id, manifest.entries[3]!.id];
    expect(report.orphans.map((o) => o.id).sort()).toEqual([...lowIds].sort());
    expect(report.ok).toBe(false);
    expect(renderCheckReport(report)).toContain('ORPHAN ');
  });
});

describe('caps in check', () => {
  it('a shrunken gravityCap still counts live output as live (caps never un-live entries)', () => {
    const { manifest, files } = smallTree();
    const report = check(baseInputs({ moodBuckets: ['bright', 'low'], gravityCap: 0.5 }), manifest, files);
    expect(report.caps.derivedCount).toBe(8); // nothing was un-livened by the smaller budget
    expect(report.caps.maxDerived).toBe(1);
  });
});

describe('empty corpus', () => {
  it('no canon, no entries, no files: trivially ok', () => {
    const report = check(baseInputs({ canon: [] }), emptyManifest('e'), new Map());
    expect(report.ok).toBe(true);
    expect(report.caps.canonCount).toBe(0);
  });
});

describe('sceneA / sceneB fixture self-check', () => {
  it('fixtures are distinct scenes so the tree builder spans pairs', () => {
    expect(sceneA().id).not.toBe(sceneB().id);
  });
});

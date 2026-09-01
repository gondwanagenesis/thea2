// M08 derive — `thea2 corpus:check`.
//
// HERMETIC: no model, no network, no clock, no filesystem. CI hands it the
// committed manifest and the committed file bytes and gets back a report whose
// rows name exactly what is wrong. A red check means the corpus on main is not
// what the manifest attests — judge-approved, byte for byte (ADR-007).

import { contentHash } from '../kernel/index.js';
import { compareStrings } from '../corpus/types.js';
import { dirtySet, gravityLimit, orphanSet } from './enumerate.js';
import { hashableText } from './keys.js';
import { MAX_VARIANTS_PER_SCENE } from './types.js';
import type {
  CapsReport,
  CheckReport,
  CheckViolation,
  DeriveInputs,
  Generator,
  Manifest,
  ManifestEntry,
} from './types.js';

export interface CorpusCheckOptions {
  inputs: DeriveInputs;
  manifest: Manifest;
  /**
   * The generator set the corpus was generated with. The expected-target set is
   * a function of canon × generator code (versions + templates), so no
   * dirty/orphan computation can run without it.
   */
  generators: readonly Generator[];
  /** Derived files keyed by the id they are committed under, value = exact bytes. */
  files: Map<string, string>;
}

/**
 * The CI truth table: pristine ⇒ pass; a hand-edited file ⇒ hash-mismatch naming
 * it; a missing entry ⇒ dirty; a `pass:false` entry ⇒ violation; an orphan ⇒
 * GC-listed; caps must hold.
 */
export const corpusCheck = (opts: CorpusCheckOptions): CheckReport => {
  const { inputs, manifest, generators, files } = opts;

  // Orphan-hood is decided against the uncapped expected set: a shrunken cap
  // must never turn live output into deletable garbage.
  const orphans = orphanSet(inputs, manifest, generators);
  const dirty = dirtySet(inputs, manifest, generators);
  const orphanIds = new Set(orphans.map((o) => o.id));
  const live = manifest.entries.filter((e) => !orphanIds.has(e.id));

  const violations: CheckViolation[] = [...hashViolations(live, files), ...unclaimedFiles(live, files)];
  const caps = capReport(inputs, live);

  return {
    // Unreachable through the pure functions (live entries carry expected keys,
    // and expected keys never exceed a cap), but a hand-authored manifest can
    // breach one — so the caps report folds into the verdict, not just the lines.
    ok: dirty.length === 0 && orphans.length === 0 && violations.length === 0 && caps.ok,
    dirty: [...dirty].sort((a, b) => compareStrings(a.deriveKey, b.deriveKey)),
    orphans: [...orphans].sort((a, b) => compareStrings(a.deriveKey, b.deriveKey)),
    violations,
    caps,
  };
};

/** Content addressing: a file's bytes (id line masked) must hash to its entry id. */
const hashViolations = (live: ManifestEntry[], files: Map<string, string>): CheckViolation[] => {
  const out: CheckViolation[] = [];
  for (const entry of live) {
    const raw = files.get(entry.id);
    if (raw === undefined) {
      out.push({
        kind: 'missing-file',
        id: entry.id,
        message: `manifest entry ${entry.id} (${entry.generator}@${entry.generatorVersion}) has no committed file`,
      });
      continue;
    }
    const actual = contentHash(hashableText(raw));
    if (actual !== entry.id) {
      out.push({
        kind: 'hash-mismatch',
        id: entry.id,
        fileHash: actual,
        message:
          `derived file '${entry.id}' no longer hashes to its id (found ${actual}) — ` +
          'hand-edited derived output is not a workflow; regenerate or revert',
      });
    }
    if (!entry.judge.pass) {
      out.push({
        kind: 'judge-failed',
        id: entry.id,
        judge: entry.judge,
        message: `manifest entry ${entry.id} carries judge.pass=false (score ${entry.judge.score}, rubric ${entry.judge.version})`,
      });
    }
  }
  return out;
};

/** A file on disk no entry claims — dropped in by hand, or left behind by a lost manifest. */
const unclaimedFiles = (live: ManifestEntry[], files: Map<string, string>): CheckViolation[] => {
  const claimed = new Set(live.map((e) => e.id));
  const out: CheckViolation[] = [];
  for (const id of [...files.keys()].sort(compareStrings)) {
    if (claimed.has(id)) continue;
    out.push({
      kind: 'unclaimed-file',
      id,
      message: `derived file '${id}' is claimed by no manifest entry — remove it or regenerate the manifest`,
    });
  }
  return out;
};

/** Caps over what will still exist after a GC: orphans count against nothing. */
const capReport = (inputs: DeriveInputs, live: ManifestEntry[]): CapsReport => {
  const { maxDerived, canonCount } = gravityLimit(inputs);

  const perScene = new Map<string, number>();
  for (const entry of live) {
    if (entry.generator !== 'mood-variant') continue;
    const scene = entry.inputs.canonIds[0]?.id;
    if (scene === undefined) continue;
    perScene.set(scene, (perScene.get(scene) ?? 0) + 1);
  }
  const scenesOver = [...perScene.entries()]
    .filter(([, n]) => n > MAX_VARIANTS_PER_SCENE)
    .map(([canonId, variants]) => ({ canonId, variants }))
    .sort((a, b) => compareStrings(a.canonId, b.canonId));

  return {
    ok: live.length <= maxDerived && scenesOver.length === 0,
    canonCount,
    derivedCount: live.length,
    maxDerived,
    gravityCap: maxDerived === 0 && canonCount === 0 ? 0 : maxDerived / Math.max(1, canonCount),
    scenesOver,
  };
};

/**
 * The canonical rendering M20's CLI prints before exiting nonzero. Every line
 * names one thing that is wrong, in a stable order.
 */
export const renderCheckReport = (report: CheckReport): string => {
  const lines: string[] = [];
  for (const v of report.violations) lines.push(`VIOLATION ${v.kind}: ${v.message}`);
  for (const o of report.orphans) lines.push(`ORPHAN ${o.id} (${o.generator}@${o.generatorVersion}) — GC owed`);
  for (const d of report.dirty) lines.push(`DIRTY ${d.deriveKey} — no manifest entry, regenerate`);
  if (report.caps.scenesOver.length > 0) {
    for (const s of report.caps.scenesOver) {
      lines.push(`CAP ${s.canonId}: ${s.variants} mood variants > ${MAX_VARIANTS_PER_SCENE}`);
    }
  }
  if (report.caps.derivedCount > report.caps.maxDerived) {
    lines.push(
      `CAP derived:canon ${report.caps.derivedCount}:${report.caps.canonCount} > ${report.caps.maxDerived} allowed`,
    );
  }
  lines.push(
    report.ok
      ? `corpus:check ok — ${report.caps.derivedCount} derived, 0 dirty, 0 orphans`
      : `corpus:check FAILED — ${report.violations.length} violation(s), ${report.orphans.length} orphan(s), ${report.dirty.length} dirty`,
  );
  return lines.join('\n');
};

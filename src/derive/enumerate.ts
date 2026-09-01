// M08 derive — target enumeration and the two pure set functions.
//
// Enumeration is the module's only place where caps are applied, and it is
// where every fan-out rule lives: a generator that would overflow the 8:1
// budget simply stops proposing. Nothing here deletes, so a shrunken cap can
// never orphan live output — post-hoc deletion is the failure mode ADR-007
// exists to prevent.

import { DeriveError } from './errors.js';
import { targetDeriveKey } from './keys.js';
import type { DerivedTarget, DeriveInputs, Generator, Manifest, ManifestEntry } from './types.js';

/** A proposal paired with the generator that owns it — the run needs both. */
export interface ExpectedTarget {
  generator: Generator;
  target: DerivedTarget;
}

export interface Enumeration {
  /** The expected target set after the global cap: live entries' keys plus the dirty proposals kept. */
  targets: ExpectedTarget[];
  /** Proposals the budget refused. Reported, never deleted. */
  droppedByCap: number;
  /** The budget the proposals were truncated against. */
  maxDerived: number;
  canonCount: number;
}

export const gravityLimit = (inputs: DeriveInputs): { maxDerived: number; canonCount: number } => {
  if (!Number.isFinite(inputs.gravityCap) || inputs.gravityCap < 0) {
    throw new DeriveError('derive/bad-gravity-cap', `gravityCap must be a finite number ≥ 0, got ${inputs.gravityCap}`);
  }
  const canonCount = inputs.canon.length;
  // Floor keeps the ratio ≤ cap exactly when the product is not integral.
  return { maxDerived: Math.floor(inputs.gravityCap * canonCount), canonCount };
};

/**
 * Enumerates every generator's proposals in registration order (registration
 * order is priority order under the global cap), validates each target's
 * deriveKey against its declared parts — a generator that computes keys
 * inconsistently would corrupt dirty detection for its whole family — and
 * truncates to the budget. Pure: no clock, no rng, no filesystem, no mutation.
 */
export const enumerateTargets = (
  inputs: DeriveInputs,
  generators: readonly Generator[],
  manifest: Manifest,
): Enumeration => {
  const names = new Set<string>();
  for (const g of generators) {
    if (names.has(g.name)) {
      throw new DeriveError('derive/duplicate-generator', `two generators are named '${g.name}'`);
    }
    names.add(g.name);
  }

  const { maxDerived, canonCount } = gravityLimit(inputs);

  const all: ExpectedTarget[] = [];
  const keys = new Set<string>();
  for (const generator of generators) {
    for (const target of generator.targets(inputs)) {
      const expected = targetDeriveKey(generator, target);
      if (target.deriveKey !== expected) {
        throw new DeriveError(
          'derive/bad-derive-key',
          `generator '${generator.name}' proposed a target whose deriveKey does not match ` +
            `${generator.name}@${generator.version} + its inputs + templateHash`,
        );
      }
      if (keys.has(target.deriveKey)) {
        throw new DeriveError(
          'derive/duplicate-derive-key',
          `generator '${generator.name}' proposed a target whose deriveKey is already proposed: ${target.deriveKey}`,
        );
      }
      keys.add(target.deriveKey);
      all.push({ generator, target });
    }
  }

  // Manifest keys are live, not re-proposed: they survive unchanged whether or
  // not the budget has room for anything new. Orphan-hood is decided against
  // the UNCAPPED key set, so a shrunken cap cannot delete anything.
  const manifestKeys = new Set(manifest.entries.map((e) => e.deriveKey));
  const proposals = all.filter((t) => !manifestKeys.has(t.target.deriveKey));
  const budget = Math.max(0, maxDerived - liveCount(manifest, keys));
  const kept = proposals.slice(0, budget);

  return {
    targets: [
      ...all.filter((t) => manifestKeys.has(t.target.deriveKey)),
      ...kept,
    ],
    droppedByCap: proposals.length - kept.length,
    maxDerived,
    canonCount,
  };
};

/** Manifest entries whose deriveKey is among the currently proposed keys. */
const liveCount = (manifest: Manifest, keys: ReadonlySet<string>): number =>
  manifest.entries.filter((e) => keys.has(e.deriveKey)).length;

/**
 * Expected targets with no manifest entry carrying their deriveKey. Pure — the
 * unit-test core of this module: canon edits, generator-version bumps and
 * template edits must each dirty exactly the targets they touch.
 */
export const dirtySet = (
  inputs: DeriveInputs,
  manifest: Manifest,
  generators: readonly Generator[],
): DerivedTarget[] => {
  const enumerated = enumerateTargets(inputs, generators, manifest);
  const have = new Set(manifest.entries.map((e) => e.deriveKey));
  return enumerated.targets.filter((t) => !have.has(t.target.deriveKey)).map((t) => t.target);
};

/**
 * Manifest entries whose deriveKey left the expected set. These are the GC
 * candidates: `thea2 derive` deletes their files and entries; the weekly
 * derive-check job only reports them.
 */
export const orphanSet = (
  inputs: DeriveInputs,
  manifest: Manifest,
  generators: readonly Generator[],
): ManifestEntry[] => {
  const keys = new Set<string>();
  for (const generator of generators) {
    for (const target of generator.targets(inputs)) keys.add(targetDeriveKey(generator, target));
  }
  return manifest.entries.filter((e) => !keys.has(e.deriveKey));
};

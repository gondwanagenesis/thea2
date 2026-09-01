// test/derive — shared fixtures. Everything here is deterministic data or the
// same assembly steps run.ts performs (renderDraft → withProvenance → withFileId),
// so check/run tests exercise real bytes, never hand-waved hashes.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Exemplar } from '../../schemas/exemplar.js';
import type { ToolDef } from '../../src/model/index.js';
import {
  MOOD_BUCKETS,
  type DerivedTarget,
  type DeriveInputs,
  type Generator,
  type Manifest,
  type ManifestEntry,
} from '../../src/derive/index.js';
import { renderDraft, withProvenance, type DraftMeta } from '../../src/derive/index.js';
import { derivedFileId, fileBaseName, withFileId } from '../../src/derive/index.js';

// ---------------------------------------------------------------------------
// Canon fixtures. Ids look like canon paths; bodies are minimal grammar-legal.
// ---------------------------------------------------------------------------

export const sceneA = (): Exemplar =>
  scene('canon/voice/late-server', {
    dimensions: ['voice'],
    notes: 'the rambling long turn and the named detail he never asked about must survive',
  });

export const sceneB = (): Exemplar =>
  scene('canon/tooluse/status-check', {
    dimensions: ['tool-use'],
    body: 'Setup: mid-conversation\nD: is the box ok\nT: hold on — their status page says green, we are fine\n',
    notes: 'reflex, not announcement: she never says she is checking a tool',
  });

/** A statement-shaped canon source for deliberation-shape's 1:1 fan-out. */
export const reasoningC = (): Exemplar =>
  scene('canon/reasoning/triage-order', {
    kind: 'statement',
    dimensions: ['reasoning'],
    body: 'what she weighs first, in her own words: the thing that can burn\n',
    notes: 'the order she triages in must survive',
  });

export const scene = (id: string, over: Partial<Exemplar> = {}): Exemplar => ({
  id,
  kind: 'scene',
  dimensions: ['voice'],
  register: ['play'],
  affect: { valence: 0.3, arousal: -0.3 },
  context: `context of ${id}`,
  weight: 1,
  source: 'canon',
  body: `D: hey, ${id}\nT: quiet one. kinda cozy\n`,
  tokens: 12,
  ...over,
});

export const TOOL_DEFS: ToolDef[] = [
  {
    name: 'splyce_status',
    description: 'read the electroporator build status page',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'ledger_sum',
    description: 'sum one month of ledger entries',
    parameters: { type: 'object', properties: { month: { type: 'string' } }, required: ['month'] },
  },
];

/** Three canon sources hitting all four generators; gravityCap 8 leaves room for all 16 targets. */
export const baseInputs = (over: Partial<DeriveInputs> = {}): DeriveInputs => ({
  canon: [sceneA(), sceneB(), reasoningC()],
  toolDefs: TOOL_DEFS,
  gravityCap: 8,
  moodBuckets: MOOD_BUCKETS,
  ...over,
});

// ---------------------------------------------------------------------------
// Derived artifacts, assembled exactly the way run.ts assembles them.
// ---------------------------------------------------------------------------

const BODY_BY_KIND: Record<string, (n: number) => string> = {
  scene: (n) => `D: ping number ${n}\nT: answer number ${n}. quiet kind of night\n`,
  statement: (n) => `beat ${n}: what she keeps from this one\nand the shape it leaves behind\n`,
  procedure: (n) =>
    [
      'Setup: he wonders aloud about the box',
      `D: is it fine, check ${n}`,
      'T: hold on',
      `[tool] splyce_status {"id":"box-${n}"} → their status page says green`,
      '[outcome] good — he stopped poking at it',
      '',
    ].join('\n'),
};

export interface ArtifactSpec {
  generator: { name: string; version: string };
  target: DerivedTarget;
  /** Distinguishes artifacts byte-wise; also picks the grammar body for the kind. */
  n: number;
  kind: 'scene' | 'statement' | 'procedure';
  model?: string;
  judge?: { version: string; score: number; pass: boolean };
}

export interface Artifact {
  id: string;
  file: string;
  text: string;
  entry: ManifestEntry;
}

/**
 * One derived file + its manifest entry, built through the module's own
 * assembly so the content-address invariants hold by construction.
 */
export const makeArtifact = (spec: ArtifactSpec): Artifact => {
  const bodyFn = BODY_BY_KIND[spec.kind];
  if (bodyFn === undefined) throw new Error(`no fixture body for kind '${spec.kind}'`);
  const meta: DraftMeta = {
    kind: spec.kind,
    dimensions: ['voice'],
    register: ['play'],
    affect: { valence: 0.2 },
    context: `fixture ${spec.n}`,
    weight: 1,
  };
  const draft = renderDraft(meta, bodyFn(spec.n));
  const judge = spec.judge ?? { version: 'derive-judge-v1', score: 5, pass: true };
  const attested = withProvenance(draft, {
    generator: spec.generator.name,
    generatorVersion: spec.generator.version,
    canonIds: spec.target.inputs.canonIds.map((c) => c.id),
    sourceHashes: spec.target.inputs.canonIds.map((c) => c.sha256),
    model: spec.model ?? 'test-gen',
    judge,
  });
  const id = derivedFileId(attested);
  const text = withFileId(attested, id);
  const entry: ManifestEntry = {
    id,
    deriveKey: spec.target.deriveKey,
    generator: spec.generator.name,
    generatorVersion: spec.generator.version,
    inputs: spec.target.inputs,
    model: spec.model ?? 'test-gen',
    createdAt: 0,
    judge,
  };
  return { id, file: `${fileBaseName(id)}.md`, text, entry };
};

/** Pristine corpus fixture: the first `count` expected targets, written for real. */
export const pristineTree = (
  inputs: DeriveInputs,
  generators: readonly Generator[],
  count: number,
): { manifest: Manifest; files: Map<string, string> } => {
  const manifest: Manifest = { version: 1, embedderId: 'test-embedder', entries: [] };
  const files = new Map<string, string>();
  for (const generator of generators) {
    for (const target of generator.targets(inputs)) {
      if (manifest.entries.length >= count) break;
      const artifact = makeArtifact({
        generator,
        target,
        n: manifest.entries.length + 1,
        kind:
          generator.name === 'procedural'
            ? 'procedure'
            : target.bucket !== undefined
              ? 'scene'
              : 'statement',
      });
      manifest.entries.push(artifact.entry);
      files.set(artifact.id, artifact.text);
    }
  }
  return { manifest, files };
};

// ---------------------------------------------------------------------------
// Temp dirs (per test, cleaned by the suite's afterEach) + error assertions.
// ---------------------------------------------------------------------------

export const tmpDir = (prefix: string): string => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

/**
 * Runs `fn`, returns the thrown error's namespaced `code` (or a sentinel).
 * Asserting on `.code` (not the message) is what pins one-code-per-failure-mode.
 */
export const errorCodeOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    const code = (e as { code?: unknown }).code;
    return typeof code === 'string' ? code : `no-code: ${(e as Error).message}`;
  }
  return 'did-not-throw';
};

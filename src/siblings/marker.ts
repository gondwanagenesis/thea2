// M18 siblings — the deploy marker.
//
// var/deploy-marker is a content hash over {code version, var/routing.json,
// corpus/canon/inhibitions.yaml, coupling.yaml, corpus hash}. ANY of those
// changing is a deploy: a routing change is a change, and so is an inhibition or
// coupling edit — exactly the configs that can silently alter behavior. A persona
// seed edit is deliberately NOT an input (voice for reports, not behavior).
//
// The file stores the per-input hashes next to the combined hash: the red report
// must name WHAT changed, and a bare hash cannot be diffed.

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import { atomicWriteJson, canonicalJson, contentHash } from '../kernel/index.js';

export const MARKER_VERSION = 1;

/** Default marker code version — M20 injects the real package version / git sha. */
export const DEFAULT_CODE_VERSION = '0.1.0';

/** Install-dir-relative defaults; M20 injects absolute paths. */
export const DEFAULT_INHIBITIONS_PATH = 'corpus/canon/inhibitions.yaml';
export const DEFAULT_COUPLING_PATH = 'coupling.yaml';
export const DEFAULT_CORPUS_DIR = 'corpus/canon';

export interface MarkerInputs {
  codeVersion: string;
  routing: string;
  inhibitions: string;
  coupling: string;
  corpus: string;
}

export interface MarkerInputPaths {
  codeVersion?: string | undefined;
  routingPath: string;
  inhibitionsPath?: string | undefined;
  couplingPath?: string | undefined;
  corpusDir?: string | undefined;
}

export interface DeployMarker {
  version: 1;
  hash: string;
  inputs: MarkerInputs;
}

/** Human names for the diff line in a Nightingale report — what changed, by name. */
export const MARKER_INPUT_LABELS: Record<keyof MarkerInputs, string> = {
  codeVersion: 'code version',
  routing: 'var/routing.json',
  inhibitions: 'corpus/canon/inhibitions.yaml',
  coupling: 'coupling.yaml',
  corpus: 'corpus hash',
};

const MARKER_INPUT_KEYS = Object.keys(MARKER_INPUT_LABELS) as Array<keyof MarkerInputs>;

// ---------------------------------------------------------------------------
// Input hashing
// ---------------------------------------------------------------------------

const hashFileOrAbsent = async (filePath: string): Promise<string> => {
  try {
    return contentHash(await fsp.readFile(filePath));
  } catch {
    return 'absent'; // a not-yet-existing config is a state, not an error
  }
};

/**
 * Content hash of a whole directory tree: every file, path-sorted (forward
 * slashes), hashed, then combined. Sort makes the hash order-independent, so a
 * filesystem that returns dirents in any order hashes the same bytes.
 */
export const corpusHash = async (dir: string): Promise<string> => {
  const files: string[] = [];
  const walk = (d: string): void => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile()) files.push(p);
    }
  };
  try {
    walk(dir);
  } catch {
    return 'absent';
  }
  files.sort();
  const pairs: string[][] = [];
  for (const f of files) {
    pairs.push([path.relative(dir, f).split(path.sep).join('/'), contentHash(await fsp.readFile(f))]);
  }
  return contentHash(canonicalJson(pairs));
};

export const computeMarkerInputs = async (paths: MarkerInputPaths): Promise<MarkerInputs> => ({
  codeVersion: paths.codeVersion ?? DEFAULT_CODE_VERSION,
  routing: await hashFileOrAbsent(paths.routingPath),
  inhibitions: await hashFileOrAbsent(paths.inhibitionsPath ?? DEFAULT_INHIBITIONS_PATH),
  coupling: await hashFileOrAbsent(paths.couplingPath ?? DEFAULT_COUPLING_PATH),
  corpus: await corpusHash(paths.corpusDir ?? DEFAULT_CORPUS_DIR),
});

/** Order-independent by construction: canonicalJson sorts the input keys. */
export const markerHash = (inputs: MarkerInputs): string => contentHash(canonicalJson(inputs));

/** The changed inputs, by human name — the Nightingale report's "what changed". */
export const diffMarker = (prev: MarkerInputs, next: MarkerInputs): string[] =>
  MARKER_INPUT_KEYS.filter((k) => prev[k] !== next[k]).map((k) => MARKER_INPUT_LABELS[k]);

// ---------------------------------------------------------------------------
// The marker file
// ---------------------------------------------------------------------------

const markerInputsShape = z.object({
  codeVersion: z.string(),
  routing: z.string(),
  inhibitions: z.string(),
  coupling: z.string(),
  corpus: z.string(),
});
const markerShape = z.object({ version: z.literal(1), hash: z.string(), inputs: markerInputsShape });

/**
 * Reads the stored marker. Missing OR malformed ⇒ null: the watcher then treats
 * this as a first observation and runs the suite once — the safe side of a
 * corrupt marker is probes running, never silence.
 */
export const readMarker = async (filePath: string): Promise<DeployMarker | null> => {
  let text: string;
  try {
    text = await fsp.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = markerShape.parse(JSON.parse(text) as unknown);
    return parsed;
  } catch {
    return null;
  }
};

export const writeMarker = async (filePath: string, inputs: MarkerInputs): Promise<DeployMarker> => {
  const marker: DeployMarker = { version: MARKER_VERSION, hash: markerHash(inputs), inputs };
  await atomicWriteJson(filePath, marker);
  return marker;
};

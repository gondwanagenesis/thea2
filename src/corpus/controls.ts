// M07 corpus — controlled vocabularies. canon/registers.yaml and
// canon/exclusions.yaml sit beside canon but are not exemplars; this loader is
// STRICT: an unknown top-level key throws rather than being ignored, because a
// misspelled rule in a controls file must never look like it loaded.

import * as yaml from 'js-yaml';
import { DIMENSIONS } from '../../schemas/exemplar.js';
import { CorpusError } from './errors.js';
import { REGISTER_MAX_MODIFIERS } from './body.js';
import { compareStrings } from './types.js';

export interface CorpusControls {
  /** Modes + modifiers — the full `register:` tag vocabulary, sorted. */
  registers: string[];
  /** Modes (play/work/friend), sorted. */
  modes: string[];
  /** Modifiers (late-night/precision/...), sorted. */
  modifiers: string[];
  /** Register pairs that must never share a packet — nor appear in one exemplar. */
  forbiddenPairs: Array<[string, string]>;
  /** Per-dimension caps per packet (packet-time rule, M11; lint only checks the keys). */
  dimensionCaps: Record<string, number>;
  /** exclusions.yaml `mode_exclusive` — a packet serves exactly one mode. */
  modeExclusive: boolean;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

const loadDoc = (text: string, docName: string): Record<string, unknown> => {
  let doc: unknown;
  try {
    doc = yaml.load(text);
  } catch (e) {
    throw new CorpusError('corpus/controls-schema', `${docName} is not valid YAML: ${(e as Error).message.split('\n')[0]}`, {
      file: docName,
      cause: e,
    });
  }
  if (doc === null) return {};
  if (!isPlainObject(doc)) {
    throw new CorpusError('corpus/controls-schema', `${docName} must be a YAML mapping`, { file: docName });
  }
  return doc;
};

const checkUnknownKeys = (doc: Record<string, unknown>, allowed: readonly string[], docName: string): void => {
  const unknown = Object.keys(doc)
    .filter((k) => !allowed.includes(k))
    .sort(compareStrings);
  if (unknown.length > 0) {
    throw new CorpusError(
      'corpus/controls-unknown-key',
      `${docName}: unknown top-level key(s) ${unknown.join(', ')} — allowed: ${allowed.join(', ')}`,
      { file: docName, field: unknown[0] },
    );
  }
};

const loadVocabulary = (value: unknown, docName: string, key: string): string[] => {
  if (value === undefined) return [];
  if (!isPlainObject(value)) {
    throw new CorpusError('corpus/controls-schema', `${docName}: '${key}' must be a mapping of tag names`, {
      file: docName,
      field: key,
    });
  }
  for (const [k, v] of Object.entries(value)) {
    if (v !== null && typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') {
      throw new CorpusError('corpus/controls-schema', `${docName}: '${key}.${k}' must be a comment/scalar, not a nested block`, {
        file: docName,
        field: `${key}.${k}`,
      });
    }
  }
  return Object.keys(value).sort(compareStrings);
};

/**
 * Strict loader for the two controls documents. Empty text (missing file) is
 * accepted and yields empty vocabularies — checkCorpus reports the missing
 * file as its own error, so the loader stays a pure function of its inputs.
 */
export const loadControls = (registersYaml: string, exclusionsYaml: string): CorpusControls => {
  const reg = loadDoc(registersYaml, 'canon/registers.yaml');
  checkUnknownKeys(reg, ['modes', 'modifiers'], 'canon/registers.yaml');

  const exc = loadDoc(exclusionsYaml, 'canon/exclusions.yaml');
  checkUnknownKeys(exc, ['forbidden_pairs', 'dimension_caps', 'mode_exclusive'], 'canon/exclusions.yaml');

  const modes = loadVocabulary(reg['modes'], 'canon/registers.yaml', 'modes');
  const modifiers = loadVocabulary(reg['modifiers'], 'canon/registers.yaml', 'modifiers');
  if (modes.length === 0) {
    throw new CorpusError('corpus/controls-schema', 'canon/registers.yaml: `modes` must define at least one mode', {
      file: 'canon/registers.yaml',
      field: 'modes',
    });
  }

  let forbiddenPairs: Array<[string, string]> = [];
  const rawPairs = exc['forbidden_pairs'];
  if (rawPairs !== undefined) {
    if (!Array.isArray(rawPairs)) {
      throw new CorpusError('corpus/controls-schema', 'canon/exclusions.yaml: `forbidden_pairs` must be a list of [a, b] pairs', {
        file: 'canon/exclusions.yaml',
        field: 'forbidden_pairs',
      });
    }
    forbiddenPairs = rawPairs.map((pair, i): [string, string] => {
      if (!Array.isArray(pair) || pair.length !== 2 || pair.some((t) => typeof t !== 'string')) {
        throw new CorpusError(
          'corpus/controls-schema',
          `canon/exclusions.yaml: forbidden_pairs[${i}] must be a pair of register tags`,
          { file: 'canon/exclusions.yaml', field: `forbidden_pairs[${i}]` },
        );
      }
      return [String(pair[0]), String(pair[1])];
    });
    forbiddenPairs.sort((a, b) => compareStrings(a[0], b[0]) || compareStrings(a[1], b[1]));
  }

  let dimensionCaps: Record<string, number> = {};
  const rawCaps = exc['dimension_caps'];
  if (rawCaps !== undefined) {
    if (!isPlainObject(rawCaps)) {
      throw new CorpusError('corpus/controls-schema', 'canon/exclusions.yaml: `dimension_caps` must be a dimension -> number mapping', {
        file: 'canon/exclusions.yaml',
        field: 'dimension_caps',
      });
    }
    dimensionCaps = {};
    for (const key of Object.keys(rawCaps).sort(compareStrings)) {
      const value = rawCaps[key];
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
        throw new CorpusError('corpus/controls-schema', `canon/exclusions.yaml: dimension_caps.${key} must be a positive integer`, {
          file: 'canon/exclusions.yaml',
          field: `dimension_caps.${key}`,
        });
      }
      dimensionCaps[key] = value;
    }
  }

  let modeExclusive = true; // documented default: a packet serves exactly one mode
  if (exc['mode_exclusive'] !== undefined) {
    if (typeof exc['mode_exclusive'] !== 'boolean') {
      throw new CorpusError('corpus/controls-schema', 'canon/exclusions.yaml: `mode_exclusive` must be a boolean', {
        file: 'canon/exclusions.yaml',
        field: 'mode_exclusive',
      });
    }
    modeExclusive = exc['mode_exclusive'];
  }

  return {
    registers: [...modes, ...modifiers].sort(compareStrings),
    modes,
    modifiers,
    forbiddenPairs,
    dimensionCaps,
    modeExclusive,
  };
};

/**
 * Register-shape rule from canon/registers.yaml: exactly one mode first, then
 * up to REGISTER_MAX_MODIFIERS modifiers, all in vocabulary, no repeats.
 * Returns the violated rule's message, or undefined when the tags are legal.
 */
export const registerShapeViolation = (
  register: readonly string[],
  controls: CorpusControls,
): string | undefined => {
  const [mode, ...rest] = register;
  if (mode === undefined || !controls.modes.includes(mode)) {
    return `register must start with a mode (${controls.modes.join(', ')}), got '${String(mode)}'`;
  }
  if (rest.length > REGISTER_MAX_MODIFIERS) {
    return `register carries ${rest.length} modifiers — at most ${REGISTER_MAX_MODIFIERS}`;
  }
  for (const tag of rest) {
    if (!controls.modifiers.includes(tag)) {
      return `modifier '${tag}' is not in registers.yaml modifiers (${controls.modifiers.join(', ')})`;
    }
  }
  if (new Set(register).size !== register.length) {
    return `register repeats a tag: [${register.join(', ')}]`;
  }
  return undefined;
};

/** Dimension-cap vocabulary check (packet-time semantics belong to M11; lint only proves the keys are real). */
export const dimensionCapsUnknownKeys = (controls: CorpusControls): string[] =>
  Object.keys(controls.dimensionCaps)
    .filter((k) => !(DIMENSIONS as readonly string[]).includes(k))
    .sort(compareStrings);

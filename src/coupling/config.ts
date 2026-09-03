// M06 coupling — the strict loader for `coupling.yaml`. Compile is all-or-nothing:
// no partially compiled coupling ever exists (same one-artifact discipline as
// M12's inhibit rules), because a misspelled dim or an unexplained weight that
// silently loaded would look exactly like a tuned one. Every rejection names its
// entry — `matrix[3] (sadness→anger)` — so config rot is locatable at startup.

import * as yaml from 'js-yaml';
import { AFFECT_DIMS, DIM_INDEX, type AffectDim } from './space.js';
import { CouplingError } from './errors.js';

export interface MatrixEntry {
  from: AffectDim;
  to: AffectDim;
  /** Weight in [-1,1]; the sign is the direction of the pull. */
  w: number;
  /** Why the entry exists — Nightingale quotes these when drift traces to M. */
  why: string;
}

/**
 * A form rule fires on ONE side of a threshold (θ) in deviation coords:
 * `min` fires ABOVE θ (`gain · max(0, a−θ)`), `max` fires BELOW θ
 * (`gain · max(0, θ−a)`). Exactly one of the two is present — a rule with
 * both (or neither) is rejected at compile. `max` is how "when the dimension
 * is LOW" rules are expressed (the v2 quiet rules); with only `min`, a
 * below-threshold rule degenerated into an always-on boost that fired even at
 * the neutral vector.
 */
export type FormRuleWhen =
  | { dim: AffectDim; min: number; max?: undefined }
  | { dim: AffectDim; min?: undefined; max: number };

export interface FormRule {
  /** The threshold side: above `min` or below `max`, in deviation coords. */
  when: FormRuleWhen;
  /** Candidates carrying this tag get the boost. */
  boostTag: string;
  gain: number;
  why: string;
}

export interface CouplingConfig {
  /** Bumped by the human on every hand-tune; Nightingale correlates drift to it. */
  version: number;
  /** The modulation cap λ — selection may be bent, never ruled (0.25 in canon). */
  lambda: number;
  matrix: Array<MatrixEntry>;
  formRules: Array<FormRule>;
}

/** The compiled artifact: the config plus M as a dense row-major 12×12 (from*12+to). */
export interface CompiledCoupling {
  cfg: CouplingConfig;
  m: Float64Array;
}

const TOP_KEYS = ['version', 'lambda', 'matrix', 'form_rules'] as const;
const MATRIX_KEYS = ['from', 'to', 'w', 'why'] as const;
const RULE_KEYS = ['when', 'boostTag', 'gain', 'why'] as const;
const WHEN_KEYS = ['dim', 'min', 'max'] as const;

type Rec = Record<string, unknown>;

const isPlainObject = (v: unknown): v is Rec => v !== null && typeof v === 'object' && !Array.isArray(v);

const checkKeys = (rec: Rec, allowed: readonly string[], path: string): void => {
  const unknown = Object.keys(rec).filter((k) => !allowed.includes(k));
  if (unknown.length > 0) {
    throw new CouplingError(
      'coupling/schema',
      `${path}: unknown key(s) ${unknown.join(', ')} — allowed: ${allowed.join(', ')}`,
      { field: path },
    );
  }
};

const requireObject = (v: unknown, path: string): Rec => {
  if (!isPlainObject(v)) {
    throw new CouplingError('coupling/schema', `${path} must be a mapping`, { field: path });
  }
  return v;
};

const requireArray = (v: unknown, path: string): unknown[] => {
  if (!Array.isArray(v)) {
    throw new CouplingError('coupling/schema', `${path} must be a list of entries`, { field: path });
  }
  return v;
};

const requireNumber = (v: unknown, path: string): number => {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new CouplingError('coupling/schema', `${path} must be a finite number, got ${JSON.stringify(v) ?? String(v)}`, {
      field: path,
    });
  }
  return v;
};

const requireString = (v: unknown, path: string): string => {
  if (typeof v !== 'string' || v.trim() === '') {
    throw new CouplingError('coupling/schema', `${path} must be a non-empty string`, { field: path });
  }
  return v;
};

const requireDim = (v: unknown, path: string): AffectDim => {
  if (typeof v !== 'string' || !Object.prototype.hasOwnProperty.call(DIM_INDEX, v)) {
    throw new CouplingError(
      'coupling/unknown-dim',
      `${path}: '${String(v)}' is not an affect dim — allowed: ${AFFECT_DIMS.join(', ')}`,
      { field: path },
    );
  }
  // hasOwnProperty against DIM_INDEX is the membership proof; the union is 12 literals.
  return v as AffectDim;
};

const parseMatrix = (raw: unknown): Array<MatrixEntry> => {
  const entries = requireArray(raw, 'matrix');
  const seen = new Set<string>();
  return entries.map((item, i) => {
    const path = `matrix[${i}]`;
    const rec = requireObject(item, path);
    checkKeys(rec, MATRIX_KEYS, path);
    const from = requireDim(rec['from'], `${path}.from`);
    const to = requireDim(rec['to'], `${path}.to`);
    const w = requireNumber(rec['w'], `${path}.w`);
    if (Math.abs(w) > 1) {
      throw new CouplingError('coupling/weight-range', `${path} (${from}→${to}): |w| = ${Math.abs(w)} > 1`, {
        field: `${path}.w`,
      });
    }
    if (rec['why'] === undefined) {
      throw new CouplingError(
        'coupling/missing-why',
        `${path} (${from}→${to}): every matrix entry carries a 'why' — an unexplainable weight is a design smell`,
        { field: `${path}.why` },
      );
    }
    const why = requireString(rec['why'], `${path}.why`);
    const pair = `${from} ${to}`;
    if (seen.has(pair)) {
      throw new CouplingError('coupling/duplicate-pair', `${path}: duplicate (from,to) pair (${from}→${to})`, {
        field: path,
      });
    }
    seen.add(pair);
    return { from, to, w, why };
  });
};

const parseFormRules = (raw: unknown): Array<FormRule> => {
  const entries = requireArray(raw, 'form_rules');
  return entries.map((item, i) => {
    const path = `form_rules[${i}]`;
    const rec = requireObject(item, path);
    checkKeys(rec, RULE_KEYS, path);
    const whenRec = requireObject(rec['when'], `${path}.when`);
    checkKeys(whenRec, WHEN_KEYS, `${path}.when`);
    const dim = requireDim(whenRec['dim'], `${path}.when.dim`);
    const min = whenRec['min'];
    const max = whenRec['max'];
    if (min !== undefined && max !== undefined) {
      throw new CouplingError(
        'coupling/schema',
        `${path} (${dim}): 'when' carries both min and max — a rule fires on ONE side of one threshold`,
        { field: `${path}.when` },
      );
    }
    if (min === undefined && max === undefined) {
      throw new CouplingError(
        'coupling/schema',
        `${path} (${dim}): 'when' needs exactly one of min (fires above θ) or max (fires below θ)`,
        { field: `${path}.when` },
      );
    }
    const side = min !== undefined ? 'min' : 'max';
    const theta = requireNumber(min !== undefined ? min : max, `${path}.when.${side}`);
    if (theta < -1 || theta > 1) {
      // θ lives in deviation coords: outside [-1,1] the rule is provably dead or
      // always-on, which is config rot wearing a rule's clothes.
      throw new CouplingError(
        'coupling/threshold-range',
        `${path} (${dim}): θ ${side} = ${theta} outside [-1,1] — the rule could never fire`,
        { field: `${path}.when.${side}` },
      );
    }
    const gain = requireNumber(rec['gain'], `${path}.gain`);
    if (Math.abs(gain) > 1) {
      throw new CouplingError('coupling/gain-range', `${path} (${dim}): |gain| = ${Math.abs(gain)} > 1`, {
        field: `${path}.gain`,
      });
    }
    if (rec['why'] === undefined) {
      throw new CouplingError(
        'coupling/missing-why',
        `${path} (${dim}): every form rule carries a 'why' — an unexplainable boost is a design smell`,
        { field: `${path}.why` },
      );
    }
    const why = requireString(rec['why'], `${path}.why`);
    const boostTag = requireString(rec['boostTag'], `${path}.boostTag`);
    return {
      when: min !== undefined ? { dim, min: theta } : { dim, max: theta },
      boostTag,
      gain,
      why,
    };
  });
};

/**
 * Compile the coupling document, or throw naming the first invalid entry. The
 * yaml key for the rule list is `form_rules` (matching the committed document);
 * the compiled config exposes it as `formRules`.
 */
export const compileCoupling = (yamlText: string): CompiledCoupling => {
  let doc: unknown;
  try {
    doc = yaml.load(yamlText);
  } catch (e) {
    throw new CouplingError('coupling/yaml-parse', `coupling doc is not valid YAML: ${(e as Error).message.split('\n')[0]}`, {
      cause: e,
    });
  }
  if (!isPlainObject(doc)) {
    throw new CouplingError('coupling/schema', 'coupling doc must be a YAML mapping');
  }
  checkKeys(doc, TOP_KEYS, 'coupling');

  const version = requireNumber(doc['version'], 'version');
  if (!Number.isInteger(version) || version < 1) {
    throw new CouplingError(
      'coupling/version-shape',
      `version must be a positive integer, got ${JSON.stringify(doc['version']) ?? String(doc['version'])}`,
      { field: 'version' },
    );
  }

  const lambda = requireNumber(doc['lambda'], 'lambda');
  if (lambda <= 0 || lambda > 1) {
    throw new CouplingError(
      'coupling/lambda-range',
      `lambda must be in (0,1] — it caps a fraction of the score range, got ${lambda}`,
      { field: 'lambda' },
    );
  }

  const matrix = parseMatrix(doc['matrix']);
  const formRules = parseFormRules(doc['form_rules']);

  const m = new Float64Array(AFFECT_DIMS.length * AFFECT_DIMS.length);
  for (const e of matrix) m[DIM_INDEX[e.from] * AFFECT_DIMS.length + DIM_INDEX[e.to]] = e.w;

  return { cfg: { version, lambda, matrix, formRules }, m };
};

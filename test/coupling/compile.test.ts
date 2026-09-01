// compileCoupling — the reject table (acceptance: every invalid entry throws,
// naming the entry) and the CI guard over the committed coupling.yaml itself:
// config rot fails the build, exactly like a code bug would.

import { describe, expect, it } from 'vitest';
import {
  AFFECT_DIMS,
  compileCoupling,
  isCouplingError,
  type CompiledCoupling,
} from '../../src/coupling/index.js';
import { COUPLING_YAML, COMMITTED } from './helpers.js';

/** A minimal valid document — the reject table mutates one field at a time. */
const VALID = `version: 1
lambda: 0.25
matrix:
  - {from: joy, to: joy, w: 0.5, why: test diagonal}
form_rules:
  - {when: {dim: arousal, min: 0.4}, boostTag: banter, gain: 0.1, why: test rule}
`;

const expectReject = (text: string, code: string, messageFragment: RegExp): void => {
  let threw: unknown;
  try {
    compileCoupling(text);
  } catch (e) {
    threw = e;
  }
  expect(isCouplingError(threw), `expected a CouplingError, got ${String(threw)}`).toBe(true);
  if (!isCouplingError(threw)) return;
  expect(threw.code).toBe(code);
  expect(threw.message).toMatch(messageFragment);
};

describe('the committed coupling.yaml compiles (CI guard over the real file)', () => {
  it('parses to version 1, λ = 0.25, the full matrix and rule set', () => {
    expect(COMMITTED.cfg.version).toBe(1);
    expect(COMMITTED.cfg.lambda).toBe(0.25); // the double-dipping guard, as designed
    expect(COMMITTED.cfg.matrix.length).toBe(18);
    expect(COMMITTED.cfg.formRules.length).toBe(4);
    expect(COMMITTED.m.length).toBe(AFFECT_DIMS.length * AFFECT_DIMS.length);
  });

  it('every entry carries a non-empty why and a weight in [-1,1] — no unexplainable weight survives', () => {
    for (const e of COMMITTED.cfg.matrix) {
      expect(e.why.length, `${e.from}→${e.to}`).toBeGreaterThan(8);
      expect(Math.abs(e.w), `${e.from}→${e.to}`).toBeLessThanOrEqual(1);
    }
    for (const r of COMMITTED.cfg.formRules) {
      expect(r.why.length, r.when.dim).toBeGreaterThan(8);
      expect(Math.abs(r.gain), r.when.dim).toBeLessThanOrEqual(1);
    }
  });

  it('the dense M is exactly the sparse matrix (row-major from*12+to, 18 nonzeros)', () => {
    const nonzeros: Array<[number, number]> = [];
    for (let i = 0; i < AFFECT_DIMS.length; i++) {
      for (let j = 0; j < AFFECT_DIMS.length; j++) {
        const v = COMMITTED.m[i * AFFECT_DIMS.length + j];
        const hits = COMMITTED.cfg.matrix.filter((e) => AFFECT_DIMS.indexOf(e.from) === i && AFFECT_DIMS.indexOf(e.to) === j);
        if (hits.length === 0) expect(v).toBe(0);
        else {
          expect(v).toBe(hits[0]!.w);
          nonzeros.push([i, j]);
        }
      }
    }
    expect(nonzeros.length).toBe(COMMITTED.cfg.matrix.length);
  });

  it('recompiling the committed text is byte-stable (determinism)', () => {
    const again: CompiledCoupling = compileCoupling(COUPLING_YAML);
    expect([...again.m]).toEqual([...COMMITTED.m]);
    expect(again.cfg).toEqual(COMMITTED.cfg);
  });
});

describe('compile reject table — every rejection names its entry', () => {
  it('unknown dim in a matrix entry (and the message names dim and path)', () => {
    expectReject(
      VALID.replace('from: joy, to: joy', 'from: jealousy, to: joy'),
      'coupling/unknown-dim',
      /matrix\[0\]\.from.*jealousy/,
    );
  });

  it('a dim that exists in the engine but not in the coupling space is still unknown (focus is a dial, not a coupling dim)', () => {
    expectReject(
      VALID.replace('dim: arousal', 'dim: focus'),
      'coupling/unknown-dim',
      /form_rules\[0\]\.when\.dim.*focus/,
    );
  });

  it('missing why on a matrix entry', () => {
    expectReject(VALID.replace(', why: test diagonal', ''), 'coupling/missing-why', /matrix\[0\].*joy→joy/);
  });

  it('missing why on a form rule', () => {
    expectReject(VALID.replace(', why: test rule', ''), 'coupling/missing-why', /form_rules\[0\].*arousal/);
  });

  it('|w| > 1', () => {
    expectReject(VALID.replace('w: 0.5', 'w: 1.4'), 'coupling/weight-range', /matrix\[0\].*joy→joy.*1\.4/);
  });

  it('non-numeric weight', () => {
    expectReject(VALID.replace('w: 0.5', 'w: strong'), 'coupling/schema', /matrix\[0\]\.w/);
  });

  it('duplicate (from,to) pair', () => {
    expectReject(
      VALID.replace(
        'form_rules:',
        `  - {from: joy, to: joy, w: -0.2, why: second copy}\nform_rules:`,
      ),
      'coupling/duplicate-pair',
      /matrix\[1\].*joy→joy/,
    );
  });

  it('a form rule whose θ could never fire (min outside [-1,1])', () => {
    expectReject(VALID.replace('min: 0.4', 'min: 2.0'), 'coupling/threshold-range', /form_rules\[0\].*arousal/);
  });

  it('|gain| > 1', () => {
    expectReject(VALID.replace('gain: 0.1', 'gain: 3'), 'coupling/gain-range', /form_rules\[0\].*arousal/);
  });

  it('lambda outside (0,1] — the cap is a fraction of the score range', () => {
    expectReject(VALID.replace('lambda: 0.25', 'lambda: 0'), 'coupling/lambda-range', /lambda/);
    expectReject(VALID.replace('lambda: 0.25', 'lambda: 1.5'), 'coupling/lambda-range', /lambda/);
  });

  it('version must be a positive integer', () => {
    expectReject(VALID.replace('version: 1', 'version: 0'), 'coupling/version-shape', /version/);
    expectReject(VALID.replace('version: 1', 'version: "1"'), 'coupling/schema', /version/);
  });

  it('unknown top-level key (a typo must never look like it loaded)', () => {
    expectReject(VALID.replace('lambda: 0.25', 'lamda: 0.25'), 'coupling/schema', /lamda/);
  });

  it('structural shapes: matrix not a list, entry not a mapping, unknown entry key', () => {
    expectReject(VALID.replace(/matrix:[\s\S]*?form_rules:/, 'matrix: {from: joy}\nform_rules:'), 'coupling/schema', /matrix/);
    expectReject(VALID.replace('- {from: joy, to: joy, w: 0.5, why: test diagonal}', '- joy'), 'coupling/schema', /matrix\[0\]/);
    expectReject(VALID.replace('boostTag: banter', 'boosttag: banter'), 'coupling/schema', /boosttag/);
  });

  it('invalid YAML', () => {
    expectReject('version: 1\n\tlambda: 0.25', 'coupling/yaml-parse', /YAML/);
  });

  it('no partially compiled artifact ever exists — a bad document throws instead of returning', () => {
    // The reject table above is the proof; this pins the discipline for the
    // whole-document case (one bad entry among 18 good ones).
    expectReject(
      COUPLING_YAML.replace('{from: disgust, to: disgust, w: 0.15, why: same family as anger}',
        '{from: disgust, to: disgust, w: 0.15}'),
      'coupling/missing-why',
      /disgust→disgust/,
    );
  });
});

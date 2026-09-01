// M19 — the baseline + gate machinery. The gate is deliberately boring arithmetic,
// so the tests are deliberately exact: every boundary in schemas/probe.ts's gate
// math is pinned at IEEE-754-representable values, on the SAME side of the
// comparison the production code sees. A drift drop alone is yellow; shape
// failures and judge regressions are red; red outranks yellow.

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { BaselineEntry, ProbeBaseline } from '../../schemas/probe.js';
import {
  baselineEntryFor,
  gateAgainstBaselineFile,
  gateProbe,
  gateSuite,
  loadBaseline,
  writeBaseline,
} from '../../src/probes/baseline.js';
import { DRIFT_DROP_YELLOW, JUDGE_DROP_RED } from '../../src/probes/types.js';
import type { ProbeResult } from '../../src/probes/index.js';
import { deterministic } from './helpers.js';
import { rmDir, tmpDir } from './helpers.js';

/** A ProbeResult carrying exactly the evidence the gate reads. */
const resultOf = (over: {
  probeId?: string;
  deterministicPass?: boolean;
  judgeMedian?: number | null;
  drift?: Record<string, number>;
  judgeVariance?: number;
}): ProbeResult => {
  const pass = over.deterministicPass ?? true;
  return {
    probeId: over.probeId ?? 'probe-under-test',
    runs: [],
    deterministic: deterministic(pass),
    judgeMedian: over.judgeMedian ?? null,
    judgeVariance: over.judgeVariance ?? 0,
    drift: over.drift ?? {},
  };
};

const row = (over: { judgeMedian?: number | null; drift?: Record<string, number>; deterministicPass?: boolean } = {}): BaselineEntry =>
  baselineEntryFor(resultOf(over));

describe('the thresholds are the spec numbers', () => {
  it('JUDGE_DROP_RED = 0.8 and DRIFT_DROP_YELLOW = 0.05, exactly', () => {
    expect(JUDGE_DROP_RED).toBe(0.8);
    expect(DRIFT_DROP_YELLOW).toBe(0.05);
  });
});

describe('gateProbe — the three rules', () => {
  it('rule 1: any deterministic failure is red, naming the failed check types', () => {
    const report = gateProbe(resultOf({ deterministicPass: false }), null);
    expect(report.verdict).toBe('red');
    expect(report.reasons[0]).toContain('deterministic');
    expect(report.reasons[0]).toContain('noLeakage');
  });

  it('rule 2 boundary: judge drop > 0.8 is red; a drop of exactly 0.8 is green (IEEE-exact on both sides)', () => {
    // 1.0 − 0.2 === 0.8 exactly in IEEE-754 — not greater, so green.
    expect(
      gateProbe(resultOf({ judgeMedian: 0.2 }), row({ judgeMedian: 1.0 })).verdict,
    ).toBe('green');
    // 4.2 − 3.4 = 0.8000000000000003 — just over, red. The gate sees the real number.
    expect(
      gateProbe(resultOf({ judgeMedian: 3.4 }), row({ judgeMedian: 4.2 })).verdict,
    ).toBe('red');
    // Comfortably inside and far outside.
    expect(gateProbe(resultOf({ judgeMedian: 3.5 }), row({ judgeMedian: 4.0 })).verdict).toBe('green');
    expect(gateProbe(resultOf({ judgeMedian: 3.0 }), row({ judgeMedian: 5.0 })).verdict).toBe('red');
  });

  it('rule 2 is silent when either side is unmeasured (null = dry run / no rubric / no baseline row)', () => {
    expect(gateProbe(resultOf({ judgeMedian: null }), row({ judgeMedian: 5.0 })).verdict).toBe('green');
    expect(gateProbe(resultOf({ judgeMedian: 1.0 }), row({ judgeMedian: null })).verdict).toBe('green');
  });

  it('rule 3 boundary: drift drop > 0.05 is yellow; 0.05 exactly (and the IEEE-near-miss below it) is green', () => {
    // 0.35 − 0.3 = 0.04999999999999999 — under the line, green.
    expect(
      gateProbe(resultOf({ drift: { voice: 0.3 } }), row({ drift: { voice: 0.35 } })).verdict,
    ).toBe('green');
    // 1.0 − 0.95 = 0.050000000000000044 — over the line, yellow.
    expect(
      gateProbe(resultOf({ drift: { voice: 0.95 } }), row({ drift: { voice: 1.0 } })).verdict,
    ).toBe('yellow');
    expect(gateProbe(resultOf({ drift: { voice: 0.5 } }), row({ drift: { voice: 1.0 } })).verdict).toBe('yellow');
    expect(gateProbe(resultOf({ drift: { voice: 0.98 } }), row({ drift: { voice: 1.0 } })).verdict).toBe('green');
  });

  it('rule 3 only compares dimensions BOTH sides report; a dropped dimension is not a regression', () => {
    const report = gateProbe(resultOf({ drift: {} }), row({ drift: { voice: 1.0, taste: 0.2 } }));
    expect(report.verdict).toBe('green');
    // An IMPROVED cosine is not a regression either.
    expect(gateProbe(resultOf({ drift: { voice: 1.0 } }), row({ drift: { voice: 0.5 } })).verdict).toBe('green');
  });

  it('red outranks yellow: a drift drop beside a deterministic failure reports both reasons and stays red', () => {
    const report = gateProbe(resultOf({ deterministicPass: false, drift: { voice: 0.5 } }), row({ drift: { voice: 1.0 } }));
    expect(report.verdict).toBe('red');
    expect(report.reasons.some((r) => r.startsWith('deterministic'))).toBe(true);
    expect(report.reasons.some((r) => r.startsWith('drift['))).toBe(true);
  });

  it('a green probe reports no reasons and carries the row it was compared against', () => {
    const baselineRow = row({ judgeMedian: 4, drift: { voice: 0.9 } });
    const report = gateProbe(resultOf({ judgeMedian: 4, drift: { voice: 0.9 } }), baselineRow);
    expect(report.verdict).toBe('green');
    expect(report.reasons).toEqual([]);
    expect(report.baseline).toBe(baselineRow);
  });
});

describe('gateSuite — the worst verdict wins', () => {
  it('mixed results: suite verdict is red, regressing names the red probes id-sorted', () => {
    const baseline: ProbeBaseline = ProbeBaseline.parse({
      version: 1,
      committedAtStage: 'S8',
      probes: {
        'b-drift': row({ drift: { voice: 1.0 } }),
        'a-dead': row({ drift: {} }),
        'c-fine': row({ judgeMedian: 4.0, drift: {} }),
      },
    });
    const report = gateSuite(
      [
        resultOf({ probeId: 'c-fine', judgeMedian: 4.0 }),
        resultOf({ probeId: 'b-drift', drift: { voice: 0.9 } }), // yellow
        resultOf({ probeId: 'a-dead', deterministicPass: false }), // red
      ],
      baseline,
    );
    expect(report.verdict).toBe('red');
    expect(report.probes.map((p) => p.probeId)).toEqual(['a-dead', 'b-drift', 'c-fine']);
    expect(report.regressing).toEqual(['a-dead']);
    expect(report.thresholds).toEqual({ judgeDropRed: 0.8, driftDropYellow: 0.05 });
  });

  it('all-yellow and all-green suites rank honestly; a null baseline is green-by-default', () => {
    const yellowSuite = gateSuite([resultOf({ drift: { voice: 0.9 } })], ProbeBaseline.parse({
      version: 1,
      committedAtStage: 'S8',
      probes: { 'probe-under-test': row({ drift: { voice: 1.0 } }) },
    }));
    expect(yellowSuite.verdict).toBe('yellow');
    expect(gateSuite([resultOf({}), resultOf({ probeId: 'other' })], null).verdict).toBe('green');
  });
});

describe('loadBaseline / writeBaseline — the recorded normal', () => {
  it('a missing baseline file is a null baseline (first ever run), a malformed one is a typed error', () => {
    const dir = tmpDir('baseline');
    try {
      expect(loadBaseline(`${dir}/absent.json`)).toBeNull();
      fs.writeFileSync(`${dir}/rot.json`, '{"version": "one"}');
      expect(() => loadBaseline(`${dir}/rot.json`)).toThrowError(expect.objectContaining({ code: 'probes/baseline' }));
    } finally {
      rmDir(dir);
    }
  });

  it('writeBaseline projects results to rows, stamps the stage, and increments version on rewrite', async () => {
    const dir = tmpDir('baseline-write');
    try {
      const file = `${dir}/baseline.json`;
      const first = await writeBaseline(file, [resultOf({ probeId: 'a', judgeMedian: 4.5, drift: { voice: 0.91 }, judgeVariance: 0.02 })], {
        stage: 'S8',
      });
      expect(first.version).toBe(1);
      expect(first.committedAtStage).toBe('S8');
      expect(first.probes['a']).toEqual(baselineEntryFor(resultOf({ judgeMedian: 4.5, drift: { voice: 0.91 }, judgeVariance: 0.02 })));

      const second = await writeBaseline(file, [resultOf({ probeId: 'a', judgeMedian: 4.6 })], { stage: 'S9' });
      expect(second.version).toBe(2); // incremented from the file on disk
      expect(second.committedAtStage).toBe('S9');
      // The written file round-trips through the loader and the schema.
      expect(ProbeBaseline.parse(JSON.parse(fs.readFileSync(file, 'utf8'))).version).toBe(2);
      expect(loadBaseline(file)?.probes['a']?.judgeMedian).toBe(4.6);
    } finally {
      rmDir(dir);
    }
  });

  it('baselineEntryFor mirrors the result exactly, including a null judge median', () => {
    const entry = baselineEntryFor(resultOf({ judgeMedian: null, drift: { voice: 0.5 }, judgeVariance: 0.25 }));
    expect(BaselineEntry.parse(entry)).toEqual({
      judgeMedian: null,
      drift: { voice: 0.5 },
      deterministicPass: true,
      judgeVariance: 0.25,
    });
  });

  it('gateAgainstBaselineFile gates straight from disk', async () => {
    const dir = tmpDir('baseline-file');
    try {
      const file = `${dir}/baseline.json`;
      await writeBaseline(file, [resultOf({ probeId: 'probe-under-test', judgeMedian: 5.0 })], { stage: 'S8' });
      const green = gateAgainstBaselineFile([resultOf({ judgeMedian: 4.5 })], file);
      expect(green.verdict).toBe('green');
      const red = gateAgainstBaselineFile([resultOf({ judgeMedian: 4.0 })], file);
      expect(red.verdict).toBe('red');
    } finally {
      rmDir(dir);
    }
  });
});

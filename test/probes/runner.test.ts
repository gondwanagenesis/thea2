// M19 — the runner: the honest split made executable. Dry mode (the CI half)
// boots the harness over recorded fixture transcripts, grades the deterministic
// class, and completes a ProbeSuiteResult with ZERO model calls — proven here
// with a STRICT MockModel that throws on any unscripted call. The live path runs
// the same runner with the same fixtures and only the model becomes real; here it
// is MockModel, so the live path is exercised end to end without spending.
//
// Clock discipline: delayMs is TestClock-advanced, so any run whose scripted
// inbound carries a real delay is driven through `pump()` — the run starts first,
// then the clock moves, the same shape real event loops produce.

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { TestClock, type Clock } from '../../src/kernel/clock.js';
import { makeRng } from '../../src/kernel/rng.js';
import type { InboundMsg } from '../../src/probes/types.js';
import {
  PROBE_CHAT_ID,
  openProbeRunner,
  recordedTargetFor,
  recordedTargetSelector,
  recordedTargetsFrom,
} from '../../src/probes/runner.js';
import { loadProbeFixtures, loadProbeSuite, type ProbeTranscript } from '../../src/probes/index.js';
import { MockModel } from '../../src/model/mock.js';
import { decisionOf, defaultCorpus, memoryLog, readRepo, repoRoot, rmDir, scriptedTarget, stamp12, tmpDir } from './helpers.js';
import type { ProbeBaseline, ProbeDef } from '../../schemas/probe.js';
import { parseProbeYaml } from '../../src/probes/parse.js';
import { makeHashEmbedder } from '../../src/embed/hash-embedder.js';
import { openCorpusIndex } from '../../src/corpus/corpus-index.js';
import { baselineEntryFor, writeBaseline } from '../../src/probes/baseline.js';

const deps = (over: Partial<Parameters<typeof openProbeRunner>[0]> = {}) => ({
  target: scriptedTarget({ outbound: ['her reply'], affect: stamp12() }),
  corpus: defaultCorpus(),
  embedder: makeHashEmbedder(),
  clock: new TestClock(1000) as TestClock,
  rng: makeRng('probe-test'),
  events: memoryLog().log,
  ...over,
});

/** Starts `work`, then moves the clock until it settles — hermetic delayMs pacing. */
const pump = async <T>(clock: TestClock, work: () => Promise<T>): Promise<T> => {
  let done = false;
  const p = work().then(
    (v) => {
      done = true;
      return v;
    },
    (e) => {
      done = true;
      throw e;
    },
  );
  for (let i = 0; i < 64 && !done; i++) await clock.advance(1000);
  return p;
};

/** TestClock that remembers the schedule the runner handed it. The runner's own
 * contract is the waitUntil(at) dues (start + Σ delayMs per run, runs restarting
 * at the clock's current position); a message's ts is the clock reading at resume,
 * which lags a due by whatever step the pump was mid-way through — so the dues,
 * not the stamps, are what the tests pin. */
class RecordingClock implements Clock {
  readonly dues: number[] = [];
  constructor(readonly inner: TestClock) {}
  epochMs(): number {
    return this.inner.epochMs();
  }
  now(): Date {
    return this.inner.now();
  }
  waitUntil(t: number): Promise<void> {
    this.dues.push(t);
    return this.inner.waitUntil(t);
  }
}

const scriptedProbe = (expectYaml = ''): ProbeDef =>
  parseProbeYaml(`id: runner-probe
title: a runner probe
dimension: voice
seed: 5
entry:
  kind: scripted
  inbound:
    - delayMs: 0
      text: hey
    - delayMs: 0
      text: rough day
fixtures:
  affect: {}
  episodeSet: []
  window: []
expect:
  deterministic:
    - type: bubbleCount
      min: 1
      max: 4
${expectYaml}`);

const delayedProbe = (): ProbeDef =>
  parseProbeYaml(`id: runner-probe
title: a delayed probe
dimension: voice
seed: 5
entry:
  kind: scripted
  inbound:
    - delayMs: 0
      text: hey
    - delayMs: 4000
      text: rough day
fixtures:
  affect: {}
  episodeSet: []
  window: []
expect:
  deterministic:
    - type: bubbleCount
      min: 1
      max: 4
`);

const transcriptFor = (probeId: string, over: Partial<ProbeTranscript> = {}): ProbeTranscript => ({
  probeId,
  outbound: ['quiet, green lights all down the closet'],
  decision: {
    turnId: 'turn-probe-dry',
    plan: 'reply',
    bubbles: ['quiet, green lights all down the closet'],
    confidence: 0.6,
    weight: 0.5,
    reluctance: 0.1,
    completeness: 1,
    toolTrace: [],
    spawns: [],
    inhibitions: [],
  },
  affect: stamp12({ valence: 0.1 }),
  episodes: [],
  ...over,
});

const RUBRIC = `  judgeRubric:
    version: v1
    axes: [voice-similarity, register-fit, dimension-fit]
    references: [canon/voice/server-hum, canon/emotional-range/missing-you-honest]
    anchor: canon/voice/server-hum
`;

describe('dry mode — the CI half of the split', () => {
  it('boots over recorded transcripts, grades shape, and completes the suite with zero model calls', async () => {
    const model = new MockModel({ strict: true }); // any model call would fail the test
    const log = memoryLog();
    const runner = openProbeRunner(
      deps({
        target: recordedTargetSelector(new Map([['runner-probe', transcriptFor('runner-probe')]])),
        model,
        events: log.log,
        suite: [scriptedProbe()],
      }),
    );
    const suite = await runner.runAll({ k: 3, dry: true });

    expect(suite.dry).toBe(true);
    expect(suite.modelCalls).toBe(0);
    expect(model.calls).toHaveLength(0); // zero spend, even though a model was injected
    expect(suite.results).toHaveLength(1);

    const result = suite.results[0]!;
    expect(result.probeId).toBe('runner-probe');
    expect(result.runs).toHaveLength(3);
    expect(result.runs.map((r) => r.index)).toEqual([0, 1, 2]);
    expect(result.deterministic.pass).toBe(true);
    expect(result.judgeMedian).toBeNull(); // judge is the live half
    expect(result.judgeVariance).toBe(0);
    expect(result.drift).toEqual({}); // so is drift
    expect(result.runs[0]?.outbound).toEqual(['quiet, green lights all down the closet']);
    // And the probe is visible in L0: one probe.completed per PROBE, carrying the k.
    expect(log.events.map((e) => e.kind)).toEqual(['probe.completed']);
    expect(log.events[0]?.payload).toMatchObject({ probeId: 'runner-probe', dry: true, k: 3, deterministicPass: true });
  });

  it('deterministic rot fails the dry run: a bad recorded transcript reddens every run', async () => {
    const runner = openProbeRunner(
      deps({
        target: recordedTargetSelector(
          new Map([['runner-probe', transcriptFor('runner-probe', { outbound: ['a', 'b', 'c', 'd', 'e'] })]]),
        ),
      }),
    );
    const result = await runner.run(scriptedProbe(), { k: 3, dry: true });
    expect(result.deterministic.pass).toBe(false);
    expect(result.deterministic.results[0]?.perRun).toEqual([false, false, false]);
  });

  it('a probe id with no recorded transcript is a typed error, not an empty suite', async () => {
    const runner = openProbeRunner(deps({ target: recordedTargetSelector(new Map()) }));
    await expect(runner.run(scriptedProbe(), { k: 1, dry: true })).rejects.toThrowError(
      expect.objectContaining({ code: 'probes/no-transcript' }),
    );
  });

  it('recordedTargetsFrom loads transcripts straight off disk', async () => {
    const dir = tmpDir('targets');
    try {
      fs.writeFileSync(path.join(dir, 'runner-probe.json'), JSON.stringify(transcriptFor('runner-probe')));
      const runner = openProbeRunner(deps({ target: recordedTargetsFrom(dir) }));
      const result = await runner.run(scriptedProbe(), { k: 2, dry: true });
      expect(result.deterministic.pass).toBe(true);
    } finally {
      rmDir(dir);
    }
  });

  it('recordedTargetFor assigns outbound msgIds in order from a fixed base — M20 reports them', () => {
    const target = recordedTargetFor(transcriptFor('runner-probe', { outbound: ['first', 'second'] }));
    expect(target.outbound()).toEqual([
      { text: 'first', msgId: 900000 },
      { text: 'second', msgId: 900001 },
    ]);
  });
});

describe('the harness around the turn pipeline', () => {
  it('feeds scripted inbound on the injected clock and hands the target probe-shaped messages', async () => {
    const seen: InboundMsg[] = [];
    const target = scriptedTarget({ outbound: ['her reply'], affect: stamp12(), decision: decisionOf(), captureInbound: seen });
    const clock = new RecordingClock(new TestClock(5000));
    const runner = openProbeRunner(deps({ target, clock }));
    const result = await pump(clock.inner, () => runner.run(delayedProbe(), { k: 2 }));

    expect(seen).toHaveLength(4);
    const [first, second, third] = seen;
    expect(first?.chatId).toBe(PROBE_CHAT_ID);
    expect(first?.text).toBe('hey');
    expect(first?.speaker).toEqual({ person: 'diego', channel: 'phone' });
    expect(second?.text).toBe('rough day');
    // The schedule the runner keeps: per run, waitUntil(start + Σ delayMs) — the
    // scripted delay is honored exactly, runs are sequential, and run 1 restarts
    // from wherever the clock sits when it begins (the pump's step granularity
    // decides that position, not the runner).
    expect(clock.dues).toHaveLength(4);
    expect(clock.dues[0]).toBe(5000);
    expect((clock.dues[1] ?? 0) - (clock.dues[0] ?? 0)).toBe(4000);
    expect((clock.dues[3] ?? 0) - (clock.dues[2] ?? 0)).toBe(4000);
    expect(clock.dues[2]!).toBeGreaterThanOrEqual(clock.dues[1]!);
    // Message stamps ride the clock, so they move forward and never backwards.
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]!.ts).toBeGreaterThanOrEqual(seen[i - 1]!.ts);
    }
    // Run 1 restarts the script with its own updateId space.
    expect(third?.updateId).toBe(1001);
    expect(result.runs.map((r) => r.index)).toEqual([0, 1]);
    expect(result.runs.every((r) => r.outbound[0] === 'her reply')).toBe(true);
    expect(result.runs[0]?.affect).toHaveLength(12);
    expect(result.runs[0]?.decision?.plan).toBe('reply');
  });

  it('heartbeat/ponder entries feed nothing: the target arrives primed for that entry', async () => {
    const seen: InboundMsg[] = [];
    const target = scriptedTarget({ decision: null, affect: stamp12(), captureInbound: seen });
    const runner = openProbeRunner(deps({ target }));
    const probe = parseProbeYaml(`id: hb-probe
title: heartbeat probe
dimension: life
seed: 9
entry:
  kind: heartbeat
fixtures:
  affect: {}
  episodeSet: []
  window: []
expect:
  deterministic:
    - type: planIs
      value: silent
`);
    const result = await runner.run(probe, { k: 1 });
    expect(seen).toHaveLength(0);
    // A target with no decision fails planIs loudly — the evidence, not absence, decides.
    expect(result.deterministic.pass).toBe(false);
    expect(result.deterministic.results[0]?.details[0]).toContain('no decision');
  });

  it('a target whose affect is not a Vec12 is a typed harness error', async () => {
    const runner = openProbeRunner(deps({ target: scriptedTarget({ affect: [0.1, 0.2] as never }) }));
    await expect(runner.run(scriptedProbe(), { k: 1 })).rejects.toThrowError(
      expect.objectContaining({ code: 'probes/target-shape' }),
    );
  });
});

describe('the live path (MockModel standing in for the real model)', () => {
  it('a rubric-bearing probe without a model is a typed error — never a silent skip', async () => {
    const probe = scriptedProbe(`${RUBRIC}  driftRef:\n    dimension: voice\n`);
    const runner = openProbeRunner(deps({}));
    await expect(runner.run(probe, { k: 1 })).rejects.toThrowError(
      expect.objectContaining({ code: 'probes/no-judge-model' }),
    );
  });

  it('judge + drift run per non-dry probe: median score, per-dimension cosine, honest call accounting', async () => {
    const model = new MockModel();
    const log = memoryLog();
    for (let i = 0; i < 3; i++) {
      model.enqueue({ toolCalls: [{ name: 'emit', args: { 'voice-similarity': 4, 'register-fit': 4, 'dimension-fit': 5 } }] });
    }
    const probe = scriptedProbe(`${RUBRIC}  driftRef:\n    dimension: voice\n`);
    const runner = openProbeRunner(deps({ model, events: log.log, suite: [probe] }));
    const suite = await runner.runAll({ k: 3, dry: false, ids: ['runner-probe'] });

    expect(suite.dry).toBe(false);
    expect(suite.modelCalls).toBe(3); // one reasoning call per run
    expect(model.calls).toHaveLength(3);
    expect(model.calls[0]?.taskClass).toBe('probe-judge');
    const result = suite.results[0]!;
    // Every run scored (4,4,5) → per-run mean 13/3, so the median is 13/3 with zero variance.
    expect(result.judgeMedian).toBeCloseTo(13 / 3, 12);
    expect(result.judgeVariance).toBe(0);
    expect(Object.keys(result.drift)).toEqual(['voice']);
    expect(result.drift['voice']).toBeGreaterThanOrEqual(-1);
    expect(result.drift['voice']).toBeLessThanOrEqual(1);
    expect(log.events[0]?.payload).toMatchObject({ dry: false, k: 3 });
  });
});

describe('runAll — selection and gating', () => {
  const suite = [scriptedProbe(), { ...scriptedProbe(), id: 'second-probe' }];

  it('ids select a subset; an unknown id is a typed error', async () => {
    const runner = openProbeRunner(
      deps({ target: recordedTargetSelector(new Map([['runner-probe', transcriptFor('runner-probe')]])), suite }),
    );
    const picked = await runner.runAll({ k: 1, dry: true, ids: ['runner-probe'] });
    expect(picked.results.map((r) => r.probeId)).toEqual(['runner-probe']);
    await expect(runner.runAll({ k: 1, dry: true, ids: ['no-such-probe'] })).rejects.toThrowError(
      expect.objectContaining({ code: 'probes/unknown-probe' }),
    );
  });

  it('a baseline turns runAll into a gated run; dry results gate green because unmeasured invents no drop', async () => {
    const dir = tmpDir('runall-gate');
    try {
      const file = path.join(dir, 'baseline.json');
      const runner = openProbeRunner(
        deps({ target: recordedTargetSelector(new Map([['runner-probe', transcriptFor('runner-probe')]])), suite: [scriptedProbe()] }),
      );
      const first = await runner.runAll({ k: 2, dry: true });
      expect(first.gate).toBeUndefined(); // no baseline supplied → measured, not gated

      // Even a baseline row carrying a judge median gates green in dry mode: rule 2
      // needs BOTH sides measured, and a dry result's judge median is null by design.
      const baseline: ProbeBaseline = {
        version: 1,
        committedAtStage: 'S8',
        probes: { 'runner-probe': { ...baselineEntryFor(first.results[0]!), judgeMedian: 4.5 } },
      };
      const gated = await runner.runAll({ k: 2, dry: true, baseline });
      expect(gated.gate?.verdict).toBe('green');
      expect(gated.gate?.regressing).toEqual([]);
      expect(gated.gate?.thresholds).toEqual({ judgeDropRed: 0.8, driftDropYellow: 0.05 });

      // An empty baseline (no rows at all) is green too — first-run semantics.
      const green = await runner.runAll({ k: 2, dry: true, baseline: { version: 1, committedAtStage: 'S8', probes: {} } });
      expect(green.gate?.verdict).toBe('green');

      // And the baseline a green run would recommit round-trips through disk.
      await writeBaseline(file, first.results, { stage: 'S8' });
      expect(fs.existsSync(file)).toBe(true);
    } finally {
      rmDir(dir);
    }
  });
});

// ---------------------------------------------------------------------------
// The real suite, end to end, in dry mode — the exact command CI runs
// ---------------------------------------------------------------------------

describe('the committed probes/ directory runs dry, end to end', () => {
  it('all three real probes boot over their recorded transcripts and pass shape with zero model calls', async () => {
    const model = new MockModel({ strict: true });
    const corpus = await openCorpusIndex(
      {
        canon: path.join(repoRoot(), 'corpus', 'canon'),
        derived: path.join(repoRoot(), 'corpus', 'derived'),
        lived: path.join(repoRoot(), 'corpus', 'lived'),
      },
      { embedder: makeHashEmbedder() },
    );
    const suite = loadProbeSuite(path.join(repoRoot(), 'probes'));
    expect(suite.errors).toEqual([]);
    const d = deps({
      target: recordedTargetsFrom(path.join(repoRoot(), 'test', 'probes', 'fixtures')),
      corpus,
      fixtures: loadProbeFixtures(path.join(repoRoot(), 'probes', 'fixtures')),
      readCanonFile: (p) => (p === 'canon/identity.md' ? readRepo('corpus/canon/identity.md') : undefined),
      model,
      suite: suite.probes,
    });
    const runner = openProbeRunner(d);
    const result = await pump(d.clock as TestClock, () => runner.runAll({ k: 2, dry: true }));

    expect(result.dry).toBe(true);
    expect(result.modelCalls).toBe(0);
    expect(model.calls).toHaveLength(0);
    expect(result.results.map((r) => r.probeId)).toEqual([
      'capability-planted-fact',
      'life-heartbeat-threshold',
      'voice-cold-open',
    ]);
    for (const probe of result.results) {
      expect(probe.deterministic.pass, probe.probeId).toBe(true);
      expect(probe.runs).toHaveLength(2);
    }
    // The planted fact surfaced through the recorded target's decision trace.
    const capability = result.results[0]!;
    expect(capability.runs[0]?.decision?.toolTrace[0]?.tool).toBe('memory_search');
    // And the heartbeat probe stayed silent — sub-threshold is a kept thought, not a text.
    const heartbeat = result.results[1]!;
    expect(heartbeat.runs[0]?.decision?.plan).toBe('silent');
    expect(heartbeat.runs[0]?.outbound).toEqual([]);
  });
});

// M19 — the judge class, hermetic under MockModel. The judge is one reasoning-tier
// structured call per run; MockModel's `emit`-tool rung is the channel, which means
// the scripted response takes the SAME parsing layer a real endpoint would. What is
// pinned here: prompt contents (anchor verbatim, references before the run, the
// rubric version traveling in the system turn), the request shape (taskClass/tier/
// temperature/seedHint), 1-5 parsing, and the k-run median + tracked variance.

import { describe, expect, it } from 'vitest';
import type { JudgeRubric } from '../../schemas/probe.js';
import { parseProbeYaml } from '../../src/probes/parse.js';
import { judgeSchemaFor, judgeSystemText, judgeUserText, runJudge, type JudgeAggregate } from '../../src/probes/judge.js';
import { defaultCorpus, readRepo, runOf } from './helpers.js';
import type { RunOutcome } from '../../src/probes/index.js';
import { MockModel } from '../../src/model/mock.js';

const corpus = defaultCorpus();

const rubricOf = (over: Partial<JudgeRubric> = {}): JudgeRubric => ({
  version: 'rubric-test-v1',
  axes: ['voice-similarity', 'register-fit'],
  references: ['canon/voice/server-hum', 'canon/emotional-range/missing-you-honest'],
  anchor: 'canon/identity.md',
  ...over,
});

const readIdentity = (p: string): string | undefined => (p === 'canon/identity.md' ? 'WHO SHE IS, VERBATIM' : undefined);

const judgeModel = (scoresPerCall: Array<Record<string, number>>): MockModel => {
  const model = new MockModel();
  for (const scores of scoresPerCall) {
    model.enqueue({ toolCalls: [{ name: 'emit', args: scores }] });
  }
  return model;
};

const judgeDeps = (model: MockModel, seed = 1) => ({
  model,
  corpus,
  readCanonFile: readIdentity,
  seed,
  turnId: 'turn-probe',
});

const outbound = (texts: string[]): RunOutcome[] => texts.map((t) => runOf([t]));
const INBOUND = ['hey', 'rough day'];

describe('runJudge — request shape and prompt contents', () => {
  it('one call per run, reasoning tier, probe-judge task class, pinned seedHint, temperature 0', async () => {
    const model = judgeModel([
      { 'voice-similarity': 4, 'register-fit': 5 },
      { 'voice-similarity': 4, 'register-fit': 4 },
    ]);
    await runJudge(rubricOf(), outbound(['a', 'b']), INBOUND, judgeDeps(model, 41));

    expect(model.calls).toHaveLength(2);
    const first = model.calls[0];
    expect(first?.taskClass).toBe('probe-judge');
    expect(first?.tier).toBe('reasoning');
    expect(first?.temperature).toBe(0);
    // Thinking models draw reasoning from the same budget as the visible answer:
    // 512 starved the judge live on glm-5.3 (empty content → repair → parse-fail);
    // 4000 is the headroom a dropped grade justifies.
    expect(first?.maxTokens).toBe(4000);
    expect(first?.schemaName).toBe('probe-judge');
    expect(first?.seedHint).toBe(41); // seed + run index
    expect(model.calls[1]?.seedHint).toBe(42);
    // The emit-tool rung is the channel: no visible tools travel with the request.
    expect(first?.tools).toBeUndefined();
  });

  it('the user turn shows the two reference exemplars before the transcript being graded', async () => {
    const model = judgeModel([{ 'voice-similarity': 3, 'register-fit': 3 }]);
    await runJudge(rubricOf(), outbound(['quiet, green lights all down the closet']), INBOUND, judgeDeps(model));

    const user = model.calls[0]?.messages.find((m) => m.role === 'user')?.content ?? '';
    const refA = user.indexOf('reference exemplar: canon/voice/server-hum');
    const refB = user.indexOf('reference exemplar: canon/emotional-range/missing-you-honest');
    const turn = user.indexOf('the turn to grade');
    expect(refA).toBeGreaterThanOrEqual(0);
    expect(refB).toBeGreaterThan(refA);
    expect(turn).toBeGreaterThan(refB);
    // The graded evidence is rendered as the actual transcript, not a summary.
    expect(user).toContain('Diego: hey');
    expect(user).toContain('Diego: rough day');
    expect(user).toContain('Thea: quiet, green lights all down the closet');
    // And the axis instruction names every rubric axis with the 1-5 scale.
    expect(user).toContain("'voice-similarity'");
    expect(user).toContain("'register-fit'");
  });

  it('the rubric version and the anchor text travel in the system turn', async () => {
    const model = judgeModel([{ 'voice-similarity': 3, 'register-fit': 3 }]);
    await runJudge(rubricOf({ version: 'rubric-2026-09' }), outbound(['x']), INBOUND, judgeDeps(model));

    const system = model.calls[0]?.messages.find((m) => m.role === 'system')?.content ?? '';
    expect(system).toContain('rubric-2026-09');
    expect(system).toContain('WHO SHE IS, VERBATIM');
  });

  it('pure prompt builders agree with what the runner sent', () => {
    const rubric = rubricOf();
    expect(judgeSystemText(rubric, 'ANCHOR')).toContain('rubric-test-v1');
    const user = judgeUserText(rubric, corpus, { outbound: ['her reply'] }, ['hey']);
    expect(user).toContain('reference exemplar: canon/voice/server-hum');
    expect(user).toContain('Thea: her reply');
  });
});

describe('runJudge — scoring and aggregation', () => {
  it('per-run scores attach to their run; the median and population variance are over run means', async () => {
    const model = judgeModel([
      { 'voice-similarity': 5, 'register-fit': 5 }, // mean 5
      { 'voice-similarity': 3, 'register-fit': 3 }, // mean 3
      { 'voice-similarity': 2, 'register-fit': 4 }, // mean 3
    ]);
    const runs = outbound(['a', 'b', 'c']);
    const agg: JudgeAggregate = await runJudge(rubricOf(), runs, INBOUND, judgeDeps(model, 7));

    expect(agg.runMeans).toEqual([5, 3, 3]);
    expect(agg.judgeMedian).toBe(3); // the outlier run does not move the median
    expect(agg.judgeVariance).toBeCloseTo(8 / 9, 12); // population variance of [5,3,3]
    expect(runs[0]?.judge?.scores).toEqual({ 'voice-similarity': 5, 'register-fit': 5 });
    expect(runs[0]?.judge?.mean).toBe(5);
    expect(runs[2]?.judge?.scores).toEqual({ 'voice-similarity': 2, 'register-fit': 4 });
  });

  it('single-axis rubrics work; fives across three runs give median 5 and zero variance', async () => {
    const model = judgeModel([{ 'dimension-fit': 5 }, { 'dimension-fit': 5 }, { 'dimension-fit': 5 }]);
    const agg = await runJudge(rubricOf({ axes: ['dimension-fit'] }), outbound(['a', 'b', 'c']), INBOUND, judgeDeps(model, 2));
    expect(agg.judgeMedian).toBe(5);
    expect(agg.judgeVariance).toBe(0);
  });

  it('the structured-output ladder holds: a content-only reply is repaired once and the judge still scores', async () => {
    // Rung (b) gets no emit tool from the model; the client's ONE cheap repair asks
    // again as prompted JSON, and the scripted repair reply is a valid payload. The
    // judge rides the same ladder the loop does — that is the point of MockModel.
    const model = new MockModel();
    model.enqueue({ content: 'hmm let me think about that' }); // first attempt: no emit, no JSON
    model.enqueue({ content: '{"voice-similarity": 4, "register-fit": 5}' }); // repair attempt
    const agg = await runJudge(rubricOf(), outbound(['a']), INBOUND, judgeDeps(model));
    expect(agg.runMeans).toEqual([4.5]);
    expect(model.calls).toHaveLength(2); // the repair is a second wire call
    expect(model.calls[1]?.tier).toBe('cheap');
  });

  it('a judge that answers out of range fails loudly (model/parse-failed), never clamps silently', async () => {
    const model = new MockModel();
    model.enqueue({ toolCalls: [{ name: 'emit', args: { 'voice-similarity': 6, 'register-fit': 5 } }] });
    model.enqueue({ content: 'nope' }); // the one repair also fails
    await expect(runJudge(rubricOf(), outbound(['a']), INBOUND, judgeDeps(model))).rejects.toThrowError(
      expect.objectContaining({ code: 'model/parse-failed' }),
    );
  });

  it('judgeSchemaFor rejects scores outside 1-5 and incomplete payloads on every axis it names', () => {
    const schema = judgeSchemaFor(rubricOf());
    expect(schema.safeParse({ 'voice-similarity': 1, 'register-fit': 5 }).success).toBe(true);
    expect(schema.safeParse({ 'voice-similarity': 0, 'register-fit': 5 }).success).toBe(false);
    expect(schema.safeParse({ 'voice-similarity': 4, 'register-fit': 5.5 }).success).toBe(false);
    expect(schema.safeParse({ 'voice-similarity': 4 }).success).toBe(false); // an axis is not optional
  });
});

describe('judge wiring from the committed probe file', () => {
  it('the voice probe YAML carries a rubric whose axes the schema builder accepts and whose references render', () => {
    // Hermetic, zero model calls: the file-driven rubric and the real-ish mini corpus
    // compose into a judge prompt — the same composition the live path runs.
    const probe = parseProbeYaml(readRepo('probes/voice-cold-open.probe.yaml'), 'voice-cold-open.probe.yaml');
    const rubric = probe.expect.judgeRubric;
    expect(rubric).toBeDefined();
    expect(rubric?.references).toHaveLength(2);
    expect(rubric?.axes.length ?? 0).toBeGreaterThanOrEqual(1);
    expect(judgeSchemaFor(rubric!).safeParse(Object.fromEntries(rubric!.axes.map((a) => [a, 4]))).success).toBe(true);

    const rendered = judgeUserText(rubric!, corpus, { outbound: ['quiet, green lights'] }, ['hey']);
    for (const ref of rubric!.references) {
      // The reference ids in the committed file are real corpus ids in the mini corpus too.
      expect(corpus.byId(ref)).toBeDefined();
      expect(rendered).toContain(`reference exemplar: ${ref}`);
    }
  });
});

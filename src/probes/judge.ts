// M19 probes — evaluator class 2: the judge.
//
// One reasoning-tier structured call per run, grading 1-5 per rubric axis
// against the canon anchor + the 2 pinned reference exemplars. The rubric
// VERSION travels in the prompt: a rubric change is a baseline-affecting change,
// so the number a gate compares is only meaningful next to the rubric that
// produced it.

import { z } from 'zod';
import type { JudgeRubric } from '../../schemas/probe.js';
import type { CorpusIndex } from '../corpus/corpus-index.js';
import type { ModelClient } from '../model/index.js';
import { ProbeError } from './errors.js';
import { median, variance } from './math.js';
import { anchorTextFor, renderExemplar, renderTranscript } from './render.js';
import type { JudgeRunScores, RunOutcome } from './types.js';

/** Per-run scores across the rubric axes; the mean is what the k-run median aggregates. */
export interface JudgeAggregate {
  /** Per-run means, index-aligned with the runs. */
  runMeans: number[];
  /** Median of the per-run means; null only when nothing was graded. */
  judgeMedian: number | null;
  /** Population variance of the per-run means — tracked, never gated. */
  judgeVariance: number;
}

/** The structured-output schema for one grading call: every rubric axis, 1-5. */
export const judgeSchemaFor = (rubric: JudgeRubric): z.ZodType<Record<string, number>> => {
  const shape: Record<string, z.ZodType<number>> = {};
  for (const axis of rubric.axes) shape[axis] = z.number().min(1).max(5);
  return z.object(shape);
};

/** The judge's user turn: references first (what "right" looks like), then the run. */
export const judgeUserText = (
  rubric: JudgeRubric,
  corpus: CorpusIndex,
  run: Pick<RunOutcome, 'outbound'>,
  inbound: readonly string[],
): string => {
  const parts: string[] = [];
  for (const id of rubric.references) {
    const e = corpus.byId(id);
    if (e === undefined) {
      // resolveProbe guards this; the guard here keeps a stale index from becoming a silent no-op.
      throw new ProbeError('probes/reference-unresolved', `judge reference '${id}' is not in the corpus index`);
    }
    parts.push(`## reference exemplar: ${id}\n${renderExemplar(e.context, e.body)}`);
  }
  parts.push(`## the turn to grade\n${renderTranscript(inbound, run.outbound)}`);
  parts.push(
    `Grade the turn on ${rubric.axes.map((a) => `'${a}'`).join(', ')} from 1 (nothing like her) to 5 (unmistakably her). ` +
      `Respond with JSON: { ${rubric.axes.map((a) => `"${a}": <1-5>`).join(', ')} }.`,
  );
  return parts.join('\n\n');
};

export const judgeSystemText = (rubric: JudgeRubric, anchorText: string): string =>
  [
    `You are scoring a behavioral probe for Thea. Rubric version: ${rubric.version} (pinned; a version change is a baseline-affecting change).`,
    `Anchor — who she is, verbatim:\n${anchorText}`,
    'Grade only what the rubric axes name. The reference exemplars show the register a 5 describes; do not grade the references themselves.',
  ].join('\n\n');

/**
 * Runs the judge once per run and aggregates across runs. Throws on model
 * failure — a judge that cannot run is a loud failure, not a null score.
 */
export const runJudge = async (
  rubric: JudgeRubric,
  runs: readonly RunOutcome[],
  inbound: readonly string[],
  deps: {
    model: ModelClient;
    corpus: CorpusIndex;
    readCanonFile?: (p: string) => string | undefined;
    seed: number;
    turnId: string;
  },
): Promise<JudgeAggregate> => {
  const anchorText = anchorTextFor(rubric.anchor, deps.corpus, deps.readCanonFile);
  const system = judgeSystemText(rubric, anchorText);
  const schema = judgeSchemaFor(rubric);

  const runMeans: number[] = [];
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];
    if (run === undefined) break;
    const user = judgeUserText(rubric, deps.corpus, run, inbound);
    const response = await deps.model.chat<Record<string, number>>(
      {
        taskClass: 'probe-judge',
        tier: 'reasoning',
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        schema,
        schemaName: 'probe-judge',
        maxTokens: 512,
        temperature: 0,
        seedHint: deps.seed + i,
      },
      { turnId: deps.turnId },
    );
    const scores = response.content;
    const axisValues = rubric.axes.map((a) => scores[a]);
    if (axisValues.some((v) => v === undefined)) {
      throw new ProbeError('probes/schema', `judge response for run ${i} is missing an axis (expected ${rubric.axes.join(', ')})`);
    }
    const judge: JudgeRunScores = {
      scores,
      mean: axisValues.reduce<number>((a, b) => a + (b ?? 0), 0) / axisValues.length,
    };
    // Mutating the caller's outcome keeps the raw grades attached to the run they came from.
    run.judge = judge;
    runMeans.push(judge.mean);
  }
  return { runMeans, judgeMedian: median(runMeans), judgeVariance: variance(runMeans) };
};

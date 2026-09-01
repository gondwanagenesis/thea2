// M18 gate — `aggregateModelCalls` golden: a replayed mixed event fixture (5 task
// classes, retries, parse failures) yields exact aggregate values incl. p50/p95
// and failure counts. The wider `aggregateWindow` keeps what the pure fold's
// shape has nowhere to put, and those numbers are pinned with the same exactness.

import { describe, expect, it } from 'vitest';
import { aggregateModelCalls, aggregateWindow, percentile, sum } from '../../src/siblings/aggregate.js';
import { GOLDEN, goldenDay, parseFailEvent, callEvent } from './helpers.js';

describe('the golden fold (aggregateModelCalls)', () => {
  it('a replayed mixed day folds to exact per-taskClass aggregates, class-sorted', () => {
    expect(aggregateModelCalls(goldenDay())).toEqual(GOLDEN.aggs);
  });

  it('the window stats keep what the pure shape has nowhere to put', () => {
    const stats = aggregateWindow(goldenDay());
    expect(stats.aggs).toEqual(GOLDEN.aggs);
    expect(stats.calls).toBe(GOLDEN.totals.calls);
    expect(stats.attempts).toBe(GOLDEN.totals.attempts);
    expect(stats.failedCalls).toBe(GOLDEN.totals.failedCalls);
    expect(stats.inputTokens).toBe(GOLDEN.totals.inputTokens);
    expect(stats.outputTokens).toBe(GOLDEN.totals.outputTokens);
    expect(stats.costUsd).toBe(GOLDEN.totals.costUsd);
    expect(stats.parseFailuresUnattributed).toBe(GOLDEN.totals.parseFailuresUnattributed);
    expect(stats.malformed).toBe(GOLDEN.totals.malformed);
  });

  it('retries do not inflate the call count: attempts are summed separately', () => {
    // 3 logical calls, 6 HTTP attempts.
    const stats = aggregateWindow([
      callEvent({ ts: 0, taskClass: 'derive', inputTokens: 1, outputTokens: 1, latencyMs: 1, attempts: 3 }),
      callEvent({ ts: 0, taskClass: 'derive', inputTokens: 1, outputTokens: 1, latencyMs: 1, attempts: 2 }),
      callEvent({ ts: 0, taskClass: 'derive', inputTokens: 1, outputTokens: 1, latencyMs: 1, attempts: 1 }),
    ]);
    expect(stats.calls).toBe(3);
    expect(stats.attempts).toBe(6);
  });

  it('a call whose outcome is not ok is counted in failedCalls and still in every total', () => {
    const stats = aggregateWindow([
      callEvent({ ts: 0, taskClass: 'derive', inputTokens: 10, outputTokens: 5, costUsd: 0.25, latencyMs: 100, attempts: 2, outcome: 'error' }),
      callEvent({ ts: 0, taskClass: 'derive', inputTokens: 10, outputTokens: 5, costUsd: 0.25, latencyMs: 100, attempts: 1 }),
    ]);
    expect(stats.failedCalls).toBe(1);
    expect(stats.calls).toBe(2);
    expect(stats.costUsd).toBe(0.5);
  });

  it('a call with no costUsd costs 0, not NaN — the endpoint pricing is optional', () => {
    const stats = aggregateWindow([
      callEvent({ ts: 0, taskClass: 'judge', inputTokens: 900, outputTokens: 110, latencyMs: 700, attempts: 1 }),
    ]);
    expect(stats.costUsd).toBe(0);
    expect(aggregateModelCalls([{ seq: 0, ts: 0, kind: 'model.call', payload: { taskClass: 'judge', tier: 'reasoning', model: 'm', usage: { inputTokens: 1, outputTokens: 1, latencyMs: 1, attempts: 1 }, outcome: 'ok' } }])).toEqual([
      { taskClass: 'judge', calls: 1, inputTokens: 1, outputTokens: 1, costUsd: 0, latencyP50Ms: 1, latencyP95Ms: 1, parseFailures: 0 },
    ]);
  });

  it('a class with zero calls is absent, not a zero row', () => {
    const stats = aggregateWindow(goldenDay());
    expect(stats.aggs.map((a) => a.taskClass)).toEqual(['consolidate', 'derive', 'judge', 'summarize', 'turn']);
    expect(stats.aggs.some((a) => a.taskClass === 'probe-judge')).toBe(false);
  });
});

describe('parse-failure attribution (the two-pass fold)', () => {
  it('a parse failure is attributed to the class of the most recent call sharing its turnId', () => {
    const aggs = aggregateModelCalls([
      callEvent({ ts: 0, turnId: 't_dup', taskClass: 'summarize', inputTokens: 1, outputTokens: 1, latencyMs: 1, attempts: 1 }),
      callEvent({ ts: 1, turnId: 't_dup', taskClass: 'derive', inputTokens: 1, outputTokens: 1, latencyMs: 1, attempts: 1 }),
      parseFailEvent({ ts: 2, turnId: 't_dup' }),
    ]);
    expect(aggs.find((a) => a.taskClass === 'derive')?.parseFailures).toBe(1);
    expect(aggs.find((a) => a.taskClass === 'summarize')?.parseFailures).toBe(0);
  });

  it('the parse event may land BEFORE its call — attribution survives the ordering', () => {
    const aggs = aggregateModelCalls([
      parseFailEvent({ ts: 0, turnId: 't_pre' }),
      callEvent({ ts: 1, turnId: 't_pre', taskClass: 'consolidate', inputTokens: 1, outputTokens: 1, latencyMs: 1, attempts: 1 }),
    ]);
    expect(aggs).toEqual([
      { taskClass: 'consolidate', calls: 1, inputTokens: 1, outputTokens: 1, costUsd: 0, latencyP50Ms: 1, latencyP95Ms: 1, parseFailures: 1 },
    ]);
    expect(aggregateWindow([parseFailEvent({ ts: 0, turnId: 't_pre' }), callEvent({ ts: 1, turnId: 't_pre', taskClass: 'consolidate', inputTokens: 1, outputTokens: 1, latencyMs: 1, attempts: 1 })]).parseFailuresUnattributed).toBe(0);
  });

  it('a parse failure with no call to attribute to is counted, never dropped', () => {
    const stats = aggregateWindow([
      parseFailEvent({ ts: 0, turnId: 't_ghost' }),
      parseFailEvent({ ts: 1 }), // no turnId at all
      parseFailEvent({ ts: 2, turnId: 't_known' }),
      callEvent({ ts: 3, turnId: 't_known', taskClass: 'judge', inputTokens: 1, outputTokens: 1, latencyMs: 1, attempts: 1 }),
    ]);
    expect(stats.parseFailuresUnattributed).toBe(2);
    expect(stats.aggs.find((a) => a.taskClass === 'judge')?.parseFailures).toBe(1);
  });
});

describe('malformed L0 rows', () => {
  it('are counted and skipped — a broken row never poisons a class nor kills the fold', () => {
    const good = callEvent({ ts: 0, taskClass: 'summarize', inputTokens: 10, outputTokens: 5, costUsd: 0.25, latencyMs: 100, attempts: 1 });
    const stats = aggregateWindow([
      { seq: 0, ts: 0, kind: 'model.call', payload: { taskClass: 'summarize', tier: 'main', model: 'm', outcome: 'ok' } }, // no usage
      { seq: 0, ts: 0, kind: 'model.call', payload: { taskClass: 'ghost-class', tier: 'main', model: 'm', usage: { inputTokens: 1, outputTokens: 1, latencyMs: 1, attempts: 1 }, outcome: 'ok' } },
      { seq: 0, ts: 0, kind: 'model.call', payload: { taskClass: 'summarize' } }, // not even an object shape
      { seq: 0, ts: 0, kind: 'model.parse_failed', payload: { schema: 'decision' } }, // missing rung
      good,
    ]);
    expect(stats.malformed).toBe(4);
    expect(stats.calls).toBe(1);
    expect(stats.aggs).toEqual([
      { taskClass: 'summarize', calls: 1, inputTokens: 10, outputTokens: 5, costUsd: 0.25, latencyP50Ms: 100, latencyP95Ms: 100, parseFailures: 0 },
    ]);
  });

  it('non-model events are simply not the fold\'s business', () => {
    const stats = aggregateWindow(goldenDay().filter((e) => !e.kind.startsWith('model.')));
    expect(stats.calls).toBe(0);
    expect(stats.aggs).toEqual([]);
    expect(stats.malformed).toBe(0);
  });
});

describe('the math helpers', () => {
  it('percentile is nearest-rank over ascending values, unaffected by input order', () => {
    expect(percentile([1000, 2000, 3000, 4000, 5000], 0.5)).toBe(3000);
    expect(percentile([5000, 1000, 4000, 2000, 3000], 0.5)).toBe(3000);
    expect(percentile([1000, 2000, 3000, 4000, 5000], 0.95)).toBe(5000);
    expect(percentile([9000, 1000], 0.5)).toBe(1000);
    expect(percentile([9000, 1000], 0.95)).toBe(9000);
    expect(percentile([7], 0.95)).toBe(7);
    expect(percentile([], 0.5)).toBe(0); // degenerate call sites only
  });

  it('sum is a plain left fold from zero', () => {
    expect(sum([])).toBe(0);
    expect(sum([1, 2, 3])).toBe(6);
  });
});

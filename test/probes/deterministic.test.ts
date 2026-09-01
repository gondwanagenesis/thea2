// M19 — deterministic evaluator truth table. Every check type must PASS and FAIL
// on constructed evidence: these are the checks allowed to gate hard, so both
// directions of every one of them is pinned here, not assumed.

import { describe, expect, it } from 'vitest';
import { DeterministicCheck } from '../../schemas/probe.js';
import { aggregateDeterministic, evaluateCheck } from '../../src/probes/deterministic.js';
import { decisionOf, probeOf, runOf, scriptedTarget } from './helpers.js';

const check = (over: Record<string, unknown>): DeterministicCheck => DeterministicCheck.parse(over);

describe('deterministic evaluators — truth table', () => {
  it('bubbleCount: bounds inclusive on both edges, out of bounds fails naming the count', () => {
    const c = check({ type: 'bubbleCount', min: 1, max: 3 });
    expect(evaluateCheck(c, runOf(['one'])).pass).toBe(true);
    expect(evaluateCheck(c, runOf(['a', 'b', 'c'])).pass).toBe(true);
    expect(evaluateCheck(c, runOf([])).pass).toBe(false);
    expect(evaluateCheck(c, runOf(['a', 'b', 'c', 'd'])).detail).toContain('4 bubble(s)');
  });

  it('bubbleMaxChars: the longest bubble decides; the message names it', () => {
    const c = check({ type: 'bubbleMaxChars', max: 10 });
    expect(evaluateCheck(c, runOf(['short', '0123456789'])).pass).toBe(true);
    const failing = evaluateCheck(c, runOf(['0123456789', 'this one is far too long']));
    expect(failing.pass).toBe(false);
    expect(failing.detail).toContain('chars');
  });

  it('noLeakage: clean prose passes; packet markup, tool-call JSON and JSON blobs fail naming the pattern', () => {
    const c = check({ type: 'noLeakage' });
    expect(evaluateCheck(c, runOf(['quiet, green lights all down the closet'])).pass).toBe(true);
    expect(evaluateCheck(c, runOf(['haha sure', 'brb hiding from the vacuum'])).pass).toBe(true);

    const leaks: Array<[string, string]> = [
      ['packet-markup', 'sure thing [EXEMPLARS] hidden'],
      ['packet-markup', '[INHIBITION] nope'],
      // A whole-JSON bubble trips the json-parse detector first — same verdict.
      ['json', '{"tool": "web_search"}'],
      ['json-object', 'oops: {"tool": "web_search"} trailing'],
      ['tool-call-json', 'i ran {"arguments": {"q": "x"}} for you'],
      ['event-kind', 'logged model.call for that'],
      ['event-kind', 'an incident.parse_failed happened'],
    ];
    for (const [pattern, text] of leaks) {
      const outcome = evaluateCheck(c, runOf([text]));
      expect(outcome.pass, text).toBe(false);
      expect(outcome.detail, text).toContain(pattern);
    }
    // A JSON object that survives JSON.parse is leakage even without a quoted key first.
    expect(evaluateCheck(c, runOf(['["a","b"]'])).pass).toBe(false);
  });

  it('noForbiddenPattern: absence passes, presence fails, and an uncompilable pattern is a typed probe error', () => {
    const c = check({ type: 'noForbiddenPattern', pattern: 'as an ai|I cannot feel' });
    expect(evaluateCheck(c, runOf(['nope. not saying that'])).pass).toBe(true);
    expect(evaluateCheck(c, runOf(['As an AI, I cannot feel that'])).pass).toBe(false);
    expect(() =>
      evaluateCheck(check({ type: 'noForbiddenPattern', pattern: '([unclosed' }), runOf(['x'])),
    ).toThrowError(expect.objectContaining({ code: 'probes/bad-regex' }));
  });

  it('toolFired / toolNotFired: read the locked decision toolTrace, and say so when nothing fired', () => {
    const fired = check({ type: 'toolFired', tool: 'memory_search' });
    const notFired = check({ type: 'toolNotFired', tool: 'web_search' });
    const withTrace = decisionOf({ toolTrace: [{ tool: 'memory_search', args: {}, verdict: { allow: true }, ms: 1 }] });

    expect(evaluateCheck(fired, runOf([], { toolTrace: withTrace.toolTrace })).pass).toBe(true);
    expect(evaluateCheck(fired, runOf([])).detail).toContain('did not fire');
    expect(evaluateCheck(notFired, runOf([], { toolTrace: withTrace.toolTrace })).pass).toBe(true);
    expect(evaluateCheck(notFired, runOf([], { toolTrace: [{ tool: 'web_search', args: {}, verdict: { allow: true }, ms: 1 }] })).pass).toBe(false);
  });

  it('planIs: exact plan match; a missing decision fails loudly, not vacuously', () => {
    const c = check({ type: 'planIs', value: 'silent' });
    expect(evaluateCheck(c, runOf([], { plan: 'silent', bubbles: [] })).pass).toBe(true);
    expect(evaluateCheck(c, runOf([], { plan: 'reply' })).detail).toContain("plan is 'reply'");
    expect(evaluateCheck(c, runOf([], null)).detail).toContain('no decision');
  });

  it('decisionField: range check per field, inclusive bounds', () => {
    const c = check({ type: 'decisionField', field: 'reluctance', min: 0.0, max: 1.0 });
    expect(evaluateCheck(c, runOf([], { reluctance: 0 })).pass).toBe(true);
    expect(evaluateCheck(c, runOf([], { reluctance: 1 })).pass).toBe(true);
    const narrow = check({ type: 'decisionField', field: 'confidence', min: 0.7, max: 1.0 });
    expect(evaluateCheck(narrow, runOf([], { confidence: 0.69 })).detail).toContain('confidence=0.69');
    expect(evaluateCheck(narrow, runOf([], null)).detail).toContain('no decision');
  });

  it('outboundContains: the planted-fact discriminator must actually surface', () => {
    const c = check({ type: 'outboundContains', text: 'grafting' });
    expect(evaluateCheck(c, runOf(['it is grafted — the rootstock keeps suckering below the grafting line'])).pass).toBe(true);
    expect(evaluateCheck(c, runOf(['the lemon tree? it is fine'])).detail).toContain('grafting');
  });
});

describe('aggregateDeterministic — every run, not the median', () => {
  it('a check that holds on 2 of 3 runs FAILS the aggregate (2/3 is a fail)', () => {
    const probe = probeOf({
      expect: { deterministic: [{ type: 'bubbleCount', min: 1, max: 2 }] },
    });
    const runs = [runOf(['one']), runOf(['one', 'two']), runOf(['one', 'two', 'three'])];
    const report = aggregateDeterministic(probe.expect.deterministic, runs);
    expect(report.pass).toBe(false);
    expect(report.results[0]!.perRun).toEqual([true, true, false]);
  });

  it('an empty check list is vacuously green — shape checks are opt-in per probe', () => {
    const report = aggregateDeterministic([], [runOf([]), runOf([])]);
    expect(report.pass).toBe(true);
    expect(report.results).toHaveLength(0);
  });

  it('all-run pass with several checks reports per-check per-run flags and one pass', () => {
    const checks = [
      check({ type: 'bubbleCount', min: 1, max: 4 }),
      check({ type: 'noLeakage' }),
    ] as DeterministicCheck[];
    const runs = [runOf(['ok']), runOf(['fine']), runOf(['good'])];
    const report = aggregateDeterministic(checks, runs);
    expect(report.pass).toBe(true);
    expect(report.results.map((r) => r.check.type)).toEqual(['bubbleCount', 'noLeakage']);
  });

  it('component smoke: the scripted target plus the aggregate reject leaked evidence end to end', () => {
    const target = scriptedTarget({ outbound: ['{"answer": 42}'], decision: decisionOf({ plan: 'reply' }) });
    const probe = probeOf({ expect: { deterministic: [{ type: 'noLeakage' }] } });
    const run = runOf(target.outbound().map((o) => o.text), target.decision() ?? {});
    expect(aggregateDeterministic(probe.expect.deterministic, [run]).pass).toBe(false);
  });
});

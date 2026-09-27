// v13 introspection, Phase 1 (plan docs/plans/v13-proposal-knowing-what-she-feels.md §6 Phase 1):
//   H1 an honest past — the full state (hungers) on every memory, a drive-aware word, estimates
//      marked as estimates ("going by what you wrote")
//   H2 private naming — on a few sampled turns with him, decide asks (privately, before the
//      bubbles) for a word for how she is; filed on the felt-line channel; never sent
//   H3 feedback in memory — that moment later shows what she called it; half the memories (arm B,
//      pre-registered by id) also show what was moving most in her then (material), half not
//   1.2 grounding — a thought may regulate a live feeling, not conjure one with no cause

import { describe, expect, it } from 'vitest';
import { initialAffectState, PRIMARY_BASELINE } from '../../src/affect/index.js';
import { decideToolDefWithFelt, decideToolDef } from '../../src/loop/index.js';
import { startThead } from '../../src/app/index.js';
import {
  composeSegments,
  encodeLived,
  feedbackArm,
  fullVector,
  isGrounded,
  momentIntensity,
  readReports,
  TELLING_PATTERNS,
  tagSignature,
} from '../../src/mind/index.js';
import { bootV8, inbound, moment, runToQuiescent, T0 } from './helpers.js';

const render = (m: ReturnType<typeof moment>): string =>
  composeSegments({ timeZone: 'Europe/Madrid', now: T0, self: [], concerns: [], thoughts: [], options: [m], memories: [], who: 'he' })
    .head.map((s) => s.text)
    .join('\n');

describe('H1 — an honest past', () => {
  it('the full state carries what the 12 dims drop: a night of missing him is strongly felt (N1)', () => {
    const s = initialAffectState(T0);
    s.drives.connection = 0.95;
    const full = fullVector(s);
    expect(full).toHaveLength(11);
    expect(full[8]).toBeGreaterThan(0.8); // the connection hunger
    const blankSig = new Array<number>(12).fill(0);
    expect(momentIntensity({ sig: blankSig })).toBe(0);
    expect(momentIntensity({ sig: blankSig, full })).toBeGreaterThan(0.8);
  });

  it('a lived memory keeps the honest word, the full state, and who put it there', () => {
    const m = encodeLived({ id: 'm1', now: T0, kind: 'reply', before: [], his: 'hey', hers: ['hi'], sig: tagSignature('warm', 3), word: 'lonely', full: [0, 0, 0, 0.4, 0, 0, 0, 0, 0.9, 0, 0] });
    expect(m.felt).toMatchObject({ word: 'lonely', source: 'exact', by: 'engine' });
    expect(m.felt.full?.[8]).toBe(0.9);
  });

  it('an estimate from her texts is shown as one — lived feelings are not', () => {
    expect(render(moment({ felt: { sig: tagSignature('focused', 6), word: 'focused', source: 'estimated' } }))).toMatch(/you were focused, going by what you wrote/);
    expect(render(moment({ felt: { sig: tagSignature('warm', 6), word: 'warm', source: 'exact' } }))).not.toMatch(/going by what you wrote/);
    const text = render(moment({ felt: { sig: tagSignature('focused', 6), word: 'focused', source: 'estimated' } }));
    expect(TELLING_PATTERNS.filter((re) => re.test(text.split('\n')[1] ?? ''))).toEqual([]);
  });
});

describe('H2 — private naming (asks, never tells; before the words; never sent)', () => {
  it('the felt field comes before the bubbles, and only in the sampled variant', () => {
    const props = Object.keys((decideToolDefWithFelt.parameters as { properties: Record<string, unknown> }).properties);
    expect(props.indexOf('felt')).toBeLessThan(props.indexOf('bubbles'));
    expect(Object.keys((decideToolDef.parameters as { properties: Record<string, unknown> }).properties)).not.toContain('felt');
    expect(JSON.stringify(decideToolDefWithFelt.parameters)).toMatch(/never sent/);
  });

  it('a sampled turn offers it; her word is filed on the felt-line channel and kept on the memory — never sent', async () => {
    const h = await bootV8();
    h.model.onTask('turn', () => ({ toolCalls: [{ id: 'd1', name: 'decide', args: { plan: 'reply', felt: 'a bit lonely', felt_sure: 0.6, bubbles: ['hey you'], confidence: 0.8, weight: 0.5, reluctance: 0.1, completeness: 1 } }] }));
    h.model.onTask('appraisal', () => ({ toolCalls: [{ name: 'emit', args: { event: [], self: [], outcome_prev: null, concerns: [], importance: 4 } }] }));
    // force the day's sampling open (the coin is seeded; pin the state so the first turn is eligible)
    h.sys.mind.setState({ naming: undefined });
    const handle = startThead(h.sys);
    h.channel.queueInbound(inbound({ text: 'hey' }));
    await runToQuiescent(h);
    await handle.stop();
    expect(h.channel.outbound().map((s) => s.text)).toEqual(['hey you']); // her word never reaches him
    const fl = readReports(h.sys.mind.dir).find((r) => r.channel === 'felt_line');
    expect(fl).toMatchObject({ claims: [{ feeling: 'a bit lonely' }] });
    const lived = h.sys.mind.moments().find((m) => m.source === 'lived' && m.kind === 'reply')!;
    expect(lived.called).toBe('a bit lonely');
    expect(lived.calledSure).toBe(0.6);
  });

  it('never in a group turn from someone else; at most N a day, spaced', async () => {
    const h = await bootV8();
    // six asks already today, the last just now: the seventh is refused
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(T0);
    h.sys.mind.setState({ naming: { day, count: 6, lastAt: T0 - 5 * 3600_000 } });
    h.model.onTask('turn', () => ({ toolCalls: [{ id: 'd1', name: 'decide', args: { plan: 'reply', bubbles: ['ok'], confidence: 0.8, weight: 0.5, reluctance: 0.1, completeness: 1 } }] }));
    h.model.onTask('appraisal', () => ({ toolCalls: [{ name: 'emit', args: { event: [], self: [], outcome_prev: null, concerns: [], importance: 4 } }] }));
    const handle = startThead(h.sys);
    h.channel.queueInbound(inbound({ text: 'hey' }));
    await runToQuiescent(h);
    await handle.stop();
    const turn = h.model.calls.find((c) => c.taskClass === 'turn')!;
    const decide = (turn.tools ?? []).find((t) => t.name === 'decide')!;
    expect(Object.keys((decide.parameters as { properties: Record<string, unknown> }).properties)).not.toContain('felt');
  });
});

describe('H3 — what she called it, beside what was moving in her (material, past tense)', () => {
  it('arm B shows both; arm A shows only her word (the pre-registered control)', () => {
    const ids = Array.from({ length: 40 }, (_, k) => `m_${k}`);
    const b = ids.find((id) => feedbackArm(id) === 'B')!;
    const a = ids.find((id) => feedbackArm(id) === 'A')!;
    expect(ids.filter((id) => feedbackArm(id) === 'B').length).toBeGreaterThan(10); // roughly half
    const withB = render(moment({ id: b, called: 'restless', moving: 'the pull toward him' }));
    expect(withB).toContain('you called it "restless"');
    expect(withB).toContain('(what was moving most then: the pull toward him)');
    const withA = render(moment({ id: a, called: 'restless', moving: 'the pull toward him' }));
    expect(withA).toContain('you called it "restless"');
    expect(withA).not.toContain('what was moving most then');
  });
});

describe('1.2 — a thought may regulate a live feeling, not conjure one', () => {
  it('a feeling whose primary is at home with nothing similar in 6 h is ungrounded; a live one is not', () => {
    const s = initialAffectState(T0);
    expect(isGrounded('anxious', s, new Set())).toBe(false);
    s.primaries.fear = PRIMARY_BASELINE.fear + 0.2;
    expect(isGrounded('anxious', s, new Set())).toBe(true);
    expect(isGrounded('anxious', initialAffectState(T0), new Set(['anxious']))).toBe(true);
  });
});

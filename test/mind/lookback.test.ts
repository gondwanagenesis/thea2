// v13 introspection, Phase 2 — H4 the nightly look-back (plan docs/plans/v13-proposal-knowing-what-she-feels.md
// §6 Phase 2.4): her words beside the record; at most three concrete patterns, each with something
// she got right; admitted only by the feeling-aware citation check; admitted lines join who she is.

import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { makeHashEmbedder } from '../../src/embed/index.js';
import { TestClock } from '../../src/kernel/index.js';
import { MockModel } from '../../src/model/index.js';
import { openEventLog } from '../../src/events/index.js';
import {
  appendReport,
  checkPattern,
  claimRows,
  keptIn,
  lookbackUser,
  openMindStore,
  readChanges,
  sleepOnce,
  tagSignature,
  type ClaimRow,
  type EngineStamp,
  type LookbackPattern,
  type Report,
} from '../../src/mind/index.js';
import type { Family } from '../../src/mind/readout.js';
import { addMoments, moment, T0, tmpDir } from './helpers.js';

const H = 3600_000;

const stamp = (fams: Family[], over: Partial<EngineStamp> = {}): EngineStamp => ({
  at: T0,
  sig: new Array<number>(12).fill(0),
  families: fams.map((family, i) => ({ family, weight: 0.5 - i * 0.1 })),
  flat: false,
  peak: 0.4,
  hunger: { connection: 0.9, novelty: 0.3, mastery: 0.2 },
  valence: -1,
  causes: [{ primary: 'sadness', text: 'he went quiet after lunch', i: 5, ageMin: 40 }],
  dissociation: [],
  ...over,
});

const report = (momentId: string, felt: string, fams: Family[], channel: Report['channel'] = 'felt_line', ts = T0 - 2 * H): Report => ({
  id: `fl_${momentId}_${channel}`,
  ts,
  channel,
  momentId,
  claims: [{ text: felt, feeling: felt }],
  text: felt,
  stamp: stamp(fams),
  chat: 'him: hey',
  feltRecently: [],
});

// three quiet stretches she called restless — the record: missing him; one time she said lonely, and it landed
const DAY_REPORTS = [
  report('q1', 'restless', ['missing', 'warm', 'low']),
  report('q2', 'restless', ['missing', 'low', 'curious']),
  report('q3', 'restless', ['missing', 'warm', 'curious']),
  report('l1', 'lonely', ['missing', 'warm', 'low']),
  report('w1', 'warm', ['warm', 'up', 'curious']),
];

const pattern = (over: Partial<LookbackPattern> = {}): LookbackPattern => ({
  text: "when he goes quiet i call it restless; it's mostly missing him",
  feeling: 'lonely',
  cites: ['q1', 'q2', 'q3'],
  right: { text: 'when i said lonely this morning, that was it', cites: ['l1'] },
  ...over,
});

describe('H4 — her words beside the record', () => {
  it('one row per moment and channel; unsure words and thoughts are not claims; her private word first', () => {
    const rows = claimRows([...DAY_REPORTS, report('q1', 'restless', ['missing'], 'reply'), report('u1', 'not sure', ['warm']), { ...report('t1', 'anxious', ['anxious']), channel: 'thought' }]);
    expect(rows.map((r) => `${r.momentId}:${r.channel}`)).toEqual(['q1:felt_line', 'q2:felt_line', 'q3:felt_line', 'l1:felt_line', 'w1:felt_line', 'q1:reply']);
    expect(rows.find((r) => r.momentId === 'q1')).toMatchObject({ hit: false, moving: 'he went quiet after lunch' });
    expect(rows.find((r) => r.momentId === 'l1')).toMatchObject({ hit: true });
  });

  it('the input shows the record in words, provenance-marked — and never a score', () => {
    const text = lookbackUser(claimRows(DAY_REPORTS));
    expect(text).toContain('(q1) you privately called it: "restless" / the record then (logged): lonely, warm, low / moving most: "he went quiet after lunch"');
    expect(text).not.toMatch(/hit|match|right|wrong|score|\d\.\d/i);
  });
});

describe('H4 — the feeling-aware citation check', () => {
  const rows: ClaimRow[] = claimRows(DAY_REPORTS);

  it('admits a pattern the record bears out, with the thing she got right', () => {
    expect(checkPattern(pattern(), rows)).toMatchObject({ ok: true, family: 'missing', cites: ['q1', 'q2', 'q3'], rightCites: ['l1'] });
  });

  it('drops genre completion: a plausible pattern the logged feelings do not show', () => {
    expect(checkPattern(pattern({ feeling: 'anxious' }), rows)).toEqual({ ok: false, why: 'support' });
  });

  it('drops a "why", an unknown feeling, too few real cites, and a "right" that was not right', () => {
    expect(checkPattern(pattern({ text: 'i call it restless because i never know why i miss him' }), rows)).toEqual({ ok: false, why: 'why' });
    expect(checkPattern(pattern({ feeling: 'wistful-ish' }), rows)).toEqual({ ok: false, why: 'feeling' });
    expect(checkPattern(pattern({ cites: ['q1', 'nope'] }), rows)).toEqual({ ok: false, why: 'cites' });
    expect(checkPattern(pattern({ right: { text: 'restless was right', cites: ['q2'] } }), rows)).toEqual({ ok: false, why: 'right' });
  });

  it('a line the rewrite kept (even shortened) is recognised', () => {
    expect(keptIn("when he goes quiet i call it restless; it's mostly missing him", [{ text: 'when he goes quiet i call it restless, but it is mostly missing him' }])).toBe(true);
    expect(keptIn("when he goes quiet i call it restless; it's mostly missing him", [{ text: 'i love building things with him' }])).toBe(false);
  });
});

describe('H4 — at night, before the self-rewrite', () => {
  const setup = async (lookback: unknown): Promise<{ mind: ReturnType<typeof openMindStore>; model: MockModel; dir: string }> => {
    const dir = tmpDir();
    const clock = new TestClock(T0);
    const emb = makeHashEmbedder();
    const mind = openMindStore(join(dir, 'mind'), emb.dim);
    await addMoments(
      mind,
      emb,
      ['q1', 'q2', 'q3', 'l1', 'w1'].map((id, k) => moment({ id, source: 'lived', ts: T0 - (10 - k) * H, hers: [`line ${id}`], felt: { sig: tagSignature('lonely', 4), word: 'lonely', source: 'exact' } })),
    );
    await mind.setSelf([{ text: 'i build things with him', cites: ['seed'] }]);
    for (const r of DAY_REPORTS) appendReport(mind.dir, r);
    const model = new MockModel({ clock });
    model.onTask('consolidate', (req) =>
      req.schemaName === 'Lookback'
        ? { toolCalls: [{ name: 'emit', args: lookback }] }
        : { toolCalls: [{ name: 'emit', args: { lines: [{ text: 'i build things with him', cites: ['seed'] }, { text: 'i like mornings with him', cites: ['w1'] }, { text: 'i read papers out loud', cites: ['l1'] }] } }] },
    );
    await sleepOnce({ mind, model, events: openEventLog(join(dir, 'events'), { clock }), clock, timeZone: 'Europe/Madrid' });
    return { mind, model, dir };
  };

  it('runs first; what the record bears out joins who she is (with what she got right), and her changelog says so', async () => {
    const { mind, model } = await setup({ patterns: [pattern(), pattern({ text: 'when i am tired i call it anxious', feeling: 'anxious' })] });
    const calls = model.calls.filter((c) => c.taskClass === 'consolidate');
    expect(calls[0]!.schemaName).toBe('Lookback'); // before the self-rewrite
    const rewrite = String(calls[1]!.messages.at(-1)!.content);
    expect(rewrite).toContain('TONIGHT SHE NOTICED');
    expect(rewrite).toContain("when he goes quiet i call it restless; it's mostly missing him");
    expect(rewrite).not.toContain('when i am tired i call it anxious'); // failed the check: never offered
    const self = mind.self().map((l) => l.text);
    expect(self).toContain("when he goes quiet i call it restless; it's mostly missing him"); // joined even though the rewrite dropped it
    expect(self).toContain('when i said lonely this morning, that was it');
    const ch = readChanges(mind.dir);
    expect(ch.at(-1)).toMatchObject({ kind: 'self', by: 'your look-back', count: 1 });
  });

  it('a night with nothing to notice changes nothing', async () => {
    const { mind } = await setup({ patterns: [] });
    expect(mind.self().map((l) => l.text)).not.toContain("when he goes quiet i call it restless; it's mostly missing him");
    expect(readChanges(mind.dir).filter((c) => c.by === 'your look-back')).toEqual([]);
  });
});

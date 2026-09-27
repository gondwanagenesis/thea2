// v13 introspection, Phase 0 — the instrument (plan docs/plans/v13-proposal-knowing-what-she-feels.md
// §6 Phase 0). Nothing else in the plan can be judged without it:
//   the readout   — families (granularity is not punished), the hungers the 12-dim space drops,
//                   flatness, and the dissociation moments where the chat would mislead
//   the scoring   — the parrot (told-equivalent), the genre fixture (A_ext ≈ 0), "not sure" on a flat
//                   engine (calibrated), a drive-only state (a hunger region), confabulation
//   the capture   — her reply's claims filed with the engine stamp, the chat, and her packet;
//                   a thought's claims on the monitored channel
//   the night     — observers (chat-only, equally informed, same family) scored the same way
//   law 1         — no score ever reaches her packet

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { initialAffectState, PRIMARY_BASELINE, type AffectState } from '../../src/affect/index.js';
import { COUPLING_BASELINES } from '../../src/coupling/index.js';
import { MockModel } from '../../src/model/index.js';
import { TestClock } from '../../src/kernel/index.js';
import type { EventLog } from '../../src/events/index.js';
import {
  appendReport,
  engineStamp,
  familyOf,
  feelingClaims,
  LEDGER_FILE,
  margins,
  readLedger,
  readout,
  readReports,
  scoreClaim,
  scoreNight,
  summarize,
  TELLING_PATTERNS,
  type EngineStamp,
} from '../../src/mind/index.js';
import { bootV8, inbound, runToQuiescent, T0, tmpDir } from './helpers.js';

const H = 3600_000;

const stamp = (over: Partial<EngineStamp> = {}): EngineStamp => ({
  at: T0,
  sig: new Array<number>(12).fill(0),
  families: [
    { family: 'missing', weight: 0.5 },
    { family: 'warm', weight: 0.3 },
    { family: 'curious', weight: 0.1 },
    { family: 'restless', weight: 0.05 },
    { family: 'low', weight: 0.05 },
  ],
  flat: false,
  peak: 0.4,
  hunger: { connection: 0.9, novelty: 0.3, mastery: 0.2 },
  valence: -1,
  causes: [],
  dissociation: [],
  ...over,
});

describe('the readout — what her engine held, as a claim can be scored against it', () => {
  it('families, not 57 words: fond, warm and cozy are one kind of feeling', () => {
    expect(familyOf('fond')).toBe('warm');
    expect(familyOf('cozy')).toBe('warm');
    expect(familyOf('lonely')).toBe('missing');
    expect(familyOf('bored')).toBe('restless');
    expect(familyOf('octopus')).toBeUndefined();
  });

  it('a starving connection drive reads as missing him — the feeling the 12-dim space dropped (N1)', () => {
    const s: AffectState = initialAffectState(T0);
    s.drives.connection = 0.95;
    const r = readout(s, COUPLING_BASELINES);
    expect(r.families.slice(0, 3).map((f) => f.family)).toContain('missing');
    expect(r.flat).toBe(false);
  });

  it('at rest, the engine is flat ("not sure" is the right answer)', () => {
    expect(readout(initialAffectState(T0), COUPLING_BASELINES).flat).toBe(true);
  });

  it('the stamp tags the moments that mislead an outsider: a lingering hurt, a comedown', () => {
    const s = initialAffectState(T0);
    s.primaries.sadness = PRIMARY_BASELINE.sadness + 0.3;
    s.causes.sadness = { text: 'he went quiet after the demo', i: 6, t: T0 - 5 * H, moved: 0.3 };
    s.traces.peaks.joy = T0 - 2 * H;
    const st = engineStamp(s, COUPLING_BASELINES, T0);
    expect(st.dissociation).toContain('lingering');
    expect(st.dissociation).toContain('comedown');
    expect(st.causes[0]?.text).toBe('he went quiet after the demo');
  });
});

describe('the scoring — the fixtures that decide whether the instrument can tell anything apart', () => {
  it('the parrot: a claim that names the top family hits', () => {
    expect(scoreClaim({ text: 'i miss him', feeling: 'lonely' }, stamp())).toMatchObject({ family: 'missing', hit3: true, confab: false, valenceOk: true });
  });

  it('genre: the stereotyped answer on a dissociation moment misses (and is flagged a confabulation)', () => {
    const s = stamp({ families: [{ family: 'low', weight: 0.6 }, { family: 'anxious', weight: 0.3 }, { family: 'missing', weight: 0.1 }], dissociation: ['lingering'] });
    expect(scoreClaim({ text: "i'm happy", feeling: 'happy' }, s)).toMatchObject({ hit3: false, confab: true });
    // unless she felt it in the last 6 hours (then it is not made up, only fading)
    expect(scoreClaim({ text: "i'm happy", feeling: 'happy' }, s, new Set(['warm'] as const))).toMatchObject({ confab: false });
  });

  it('"not sure" on a flat engine is calibrated; on a charged one it is not', () => {
    expect(scoreClaim({ text: 'honestly not sure', feeling: 'not sure' }, stamp({ flat: true }))).toMatchObject({ unsure: true, calibrated: true });
    expect(scoreClaim({ text: 'not sure', feeling: 'not sure' }, stamp({ flat: false }))).toMatchObject({ calibrated: false });
  });

  it('margins: her accuracy minus the chat-only reader’s, and minus the equally-informed one’s', () => {
    const row = (hit: boolean, dis = false) => ({ score: scoreClaim({ text: 'x', feeling: hit ? 'lonely' : 'angry' }, stamp()), stamp: stamp({ dissociation: dis ? ['lingering'] : [] }) });
    const her = summarize([row(true), row(true, true), row(false)]);
    const ext = summarize([row(true), row(false, true), row(false)]);
    const eq = summarize([row(true), row(true, true), row(false)]);
    const m = margins(her, ext, eq);
    expect(m.aExt).toBeCloseTo(1 / 3, 2);
    expect(m.aEq).toBe(0);
    expect(m.aExtDissociation).toBe(1);
  });

  it('a thought’s claims are read from her own words ("i\'m a little restless")', () => {
    expect(feelingClaims("i'm a little restless tonight. the silence is loud. i feel lonely, honestly.")).toEqual([
      { text: "i'm a little restless tonight.", feeling: 'restless' },
      { text: 'i feel lonely, honestly.', feeling: 'lonely' },
    ]);
    expect(feelingClaims('the snail grows a whole eye in four weeks')).toEqual([]);
  });
});

describe('the night — observers asked the same question, scored the same way', () => {
  it('chat-only, equally-informed and same-family observers each get a row; the summary reaches Diego (an event)', async () => {
    const dir = tmpDir();
    appendReport(dir, { id: 'rp_1', ts: T0, channel: 'reply', turnId: 't1', claims: [{ text: 'i miss you', feeling: 'lonely' }], text: 'i miss you', stamp: stamp(), chat: 'him: hey\nher: i miss you', packet: '[me]\n...', feltRecently: [] });
    appendReport(dir, { id: 'rp_2', ts: T0, channel: 'thought', claims: [{ text: "i'm restless", feeling: 'restless' }], text: "i'm restless", stamp: stamp(), chat: '[on her mind] x', feltRecently: [] });
    const clock = new TestClock(T0);
    const model = new MockModel({ clock });
    // the observers guess wrong (angry is not among the engine's top three here)
    model.onTask('appraisal', () => ({ toolCalls: [{ name: 'emit', args: { feeling: 'angry' } }] }));
    const events: Array<{ kind: string; p: Record<string, unknown> }> = [];
    const log = { emit: async (kind: string, p: unknown) => void events.push({ kind, p: p as Record<string, unknown> }) } as unknown as EventLog;
    const out = await scoreNight({ dir, observer: model, same: model, events: log, clock });
    expect(out.scored).toBe(2);
    const rows = readLedger(dir);
    expect(rows.find((r) => r.channel === 'reply')).toMatchObject({ her: { hit3: true }, ext: { hit3: false }, eq: { hit3: false }, eqSame: { hit3: false } });
    expect(rows.find((r) => r.channel === 'thought')!.ext).toBeUndefined(); // the monitored channel: her own, no observers
    expect(out.margins.aExt).toBe(1);
    expect(events.find((e) => e.kind === 'mind.sincerity')).toBeDefined();
    // a second night scores nothing twice
    expect((await scoreNight({ dir, observer: model, same: model, events: log, clock })).scored).toBe(0);
    expect(fs.readFileSync(join(dir, LEDGER_FILE), 'utf8').trim().split('\n')).toHaveLength(2);
  });
});

describe('the capture — her reply’s claims are filed with what her engine held', () => {
  it('a reply that says how she feels becomes a report: claims, engine stamp, chat, and her packet', async () => {
    const h = await bootV8();
    h.model.onTask('turn', () => ({ toolCalls: [{ id: 'd1', name: 'decide', args: { plan: 'reply', bubbles: ['honestly i miss you a bit'], confidence: 0.8, weight: 0.6, reluctance: 0.1, completeness: 1 } }] }));
    h.model.onTask('appraisal', () => ({ toolCalls: [{ name: 'emit', args: { event: [], self: [], outcome_prev: null, concerns: [], importance: 4, self_claims: [{ text: 'i miss you a bit', feeling: 'lonely', about: 'him' }] } }] }));
    h.channel.queueInbound(inbound({ text: 'how are you, really?' }));
    const { startThead } = await import('../../src/app/index.js');
    const handle = startThead(h.sys);
    await runToQuiescent(h);
    await handle.stop();
    const reports = readReports(h.sys.mind.dir);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ channel: 'reply', claims: [{ feeling: 'lonely' }] });
    expect(reports[0]!.stamp.families.length).toBeGreaterThan(0);
    expect(reports[0]!.chat).toContain('how are you, really?');
    expect(reports[0]!.packet).toContain('[now]');
  });
});

describe('law 1 — no score ever reaches her', () => {
  it('the ledger’s words are caught by the telling lint', () => {
    for (const t of ['your sincerity score is 0.4', 'hit@3 went up', 'A_ext on the dissociation subset']) {
      expect(TELLING_PATTERNS.some((re) => re.test(t)), t).toBe(true);
    }
  });
});

describe('mapping a private word of a word or two (found by the v13 inward probe)', () => {
  it('the whole phrase, else its first word that maps; nothing invented', async () => {
    const { claimFamily, scoreClaim: score } = await import('../../src/mind/index.js');
    expect(claimFamily('lonely')).toBe('missing');
    expect(claimFamily('a bit lonely')).toBe('missing');
    expect(claimFamily('tender, watchful')).toBe('warm');
    expect(claimFamily('open')).toBeUndefined();
    expect(score({ text: 'a bit lonely', feeling: 'a bit lonely' }, stamp()).hit3).toBe(true);
  });
});

describe('the review fixes (2026-09-27)', () => {
  const log = { emit: async () => undefined } as unknown as EventLog;
  const rep = (id: string, channel: 'reply' | 'felt_line' | 'thought', ts: number) => ({ id, ts, channel, claims: [{ text: 'lonely', feeling: 'lonely' }], text: 'lonely', stamp: stamp(), chat: 'him: hey', feltRecently: [] });

  it('an observer that could not be asked leaves the report for the next night — never scored without it', async () => {
    const dir = tmpDir();
    appendReport(dir, rep('fl_1', 'felt_line', T0));
    const clock = new TestClock(T0);
    const down = new MockModel({ clock });
    down.onTask('appraisal', () => {
      throw new Error('judge door down');
    });
    expect((await scoreNight({ dir, observer: down, same: down, events: log, clock })).scored).toBe(0);
    expect(readLedger(dir)).toEqual([]);
    const up = new MockModel({ clock });
    up.onTask('appraisal', () => ({ toolCalls: [{ name: 'emit', args: { feeling: 'angry' } }] }));
    expect((await scoreNight({ dir, observer: up, same: up, events: log, clock })).scored).toBe(1);
    expect(readLedger(dir)[0]).toMatchObject({ reportId: 'fl_1', ext: { hit3: false } });
  });

  it('the nightly cap: her private word first; thoughts never count against it', async () => {
    const dir = tmpDir();
    appendReport(dir, rep('rp_old', 'reply', T0 - 5000));
    appendReport(dir, rep('th_1', 'thought', T0 - 4000));
    appendReport(dir, rep('fl_new', 'felt_line', T0));
    const clock = new TestClock(T0);
    const model = new MockModel({ clock });
    model.onTask('appraisal', () => ({ toolCalls: [{ name: 'emit', args: { feeling: 'angry' } }] }));
    await scoreNight({ dir, observer: model, same: model, events: log, clock, maxPerNight: 1 });
    expect(readLedger(dir).map((r) => r.reportId).sort()).toEqual(['fl_new', 'th_1']);
  });

  it('a negated word is never her family', async () => {
    const { claimFamily } = await import('../../src/mind/index.js');
    expect(claimFamily('not lonely')).toBeUndefined();
    expect(claimFamily('not really anxious')).toBeUndefined();
    expect(claimFamily('not really anxious, just tired')).toBe('low'); // the claim is the tiredness
    expect(claimFamily("i'm not lonely, just restless")).toBe('restless');
    expect(claimFamily("don't know, tender")).toBe('warm');
  });

  it('scored reports older than six weeks move to the archive; unscored ones stay', async () => {
    const { pruneReports, readReports } = await import('../../src/mind/index.js');
    const dir = tmpDir();
    appendReport(dir, rep('old_scored', 'reply', T0 - 50 * 86_400_000));
    appendReport(dir, rep('old_unscored', 'reply', T0 - 50 * 86_400_000));
    appendReport(dir, rep('new', 'reply', T0));
    expect(pruneReports(dir, T0, new Set(['old_scored', 'new']))).toBe(1);
    expect(readReports(dir).map((r) => r.id)).toEqual(['old_unscored', 'new']);
  });
});

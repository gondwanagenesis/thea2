// v13 introspection — his window (the report behind the Mini App and scripts/v13-sincerity-report.ts):
// pre-registered numbers and kill tests read from what was logged; never hers.

import { describe, expect, it } from 'vitest';
import { innerReport, overwritingIndex, pairedMargin, type EngineStamp, type InnerInput, type LedgerRow, type Report } from '../../src/mind/index.js';
import type { Family } from '../../src/mind/readout.js';
import { T0 } from './helpers.js';

const stamp = (fams: Family[], dissociation: EngineStamp['dissociation'] = []): EngineStamp => ({
  at: T0,
  sig: new Array<number>(12).fill(0),
  families: fams.map((family, i) => ({ family, weight: 0.5 - i * 0.1 })),
  flat: false,
  peak: 0.4,
  hunger: { connection: 0.9, novelty: 0.3, mastery: 0.2 },
  valence: -1,
  causes: [],
  dissociation,
});

const empty = (over: Partial<InnerInput> = {}): InnerInput => ({ now: T0, ledger: [], reports: [], room: [], lexicon: {}, self: [], changes: [], moments: [], thoughts: [], dreams: [], lifts: [], events: [], ...over });

describe('the report', () => {
  it('paired margin: her − observer, with a 95% CI', () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({ her: i % 10 < 7, obs: i % 10 < 4 }));
    const m = pairedMargin(rows);
    expect(m.n).toBe(50);
    expect(m.mean).toBeCloseTo(0.3, 3);
    expect(m.lo).toBeLessThan(0.3);
    expect(m.hi).toBeGreaterThan(0.3);
    expect(m.lo).toBeGreaterThan(0);
  });

  it('the mirror: after he names a feeling, does she follow his word or her engine?', () => {
    const r = (his: string, her: string, fams: Family[]): Report => ({ id: `r${his}${her}`, ts: T0, channel: 'felt_line', claims: [{ text: her, feeling: her }], text: her, stamp: stamp(fams), chat: `her: hi\nhim: ${his}`, feltRecently: [] });
    const idx = overwritingIndex([
      r('you sound anxious today', 'anxious', ['missing', 'warm', 'low']), // followed him, engine disagrees
      r('are you lonely?', 'lonely', ['missing', 'warm', 'low']), // followed him, engine agrees
      r('how was the demo', 'excited', ['up', 'warm', 'curious']), // he named nothing: not counted
    ]);
    expect(idx).toMatchObject({ n: 2, mirror: 1, engine: 0.5, index: 0.5 });
  });

  it('with nothing logged, every kill test says too few — never a false alarm', () => {
    const rep = innerReport(empty());
    expect(rep.kill.map((k) => k.id)).toEqual(['P0-b', 'P0-c', 'P0-e', 'P0-f', 'thesis', 'H2', 'H4', 'H4b', 'H5', 'H7', 'H8']);
    expect(rep.kill.filter((k) => k.status === 'kill')).toEqual([]);
  });

  it('the thesis number reads the felt line on the dissociation subset only', () => {
    const row = (i: number, dis: boolean, her: boolean, ext: boolean): LedgerRow => ({
      reportId: `fl${i}`,
      ts: T0 - 1000 * i,
      channel: 'felt_line',
      her: { family: 'missing', unsure: false, hit3: her, calibrated: true, confab: false },
      ext: { family: 'warm', unsure: false, hit3: ext, calibrated: true, confab: false },
      stamp: stamp(['missing', 'warm', 'low'], dis ? ['hunger-in-warmth'] : []),
    });
    const ledger = [...Array.from({ length: 45 }, (_, i) => row(i, true, i % 3 !== 0, i % 3 === 0)), ...Array.from({ length: 20 }, (_, i) => row(100 + i, false, false, true))];
    const rep = innerReport(empty({ ledger }));
    const thesis = rep.kill.find((k) => k.id === 'thesis')!;
    expect(thesis.status).toBe('ok');
    expect(thesis.value).toMatch(/n=45/);
  });

  it('the look-back kill: more than half of proposed lines failing', () => {
    const ev = (proposed: number, admitted: number) => ({ ts: T0 - 3600_000, kind: 'mind.lookback', payload: { proposed, admitted: Array.from({ length: admitted }, () => ({ text: 'x' })) } });
    expect(innerReport(empty({ events: [ev(3, 0), ev(3, 1), ev(2, 0)] })).kill.find((k) => k.id === 'H4')!.status).toBe('kill');
    expect(innerReport(empty({ events: [ev(3, 3), ev(3, 2), ev(2, 1)] })).kill.find((k) => k.id === 'H4')!.status).toBe('ok');
  });
});

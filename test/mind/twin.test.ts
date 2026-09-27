// v13 Phase 4 — the twin's data (docs/plans/v13-phase4-twin.md): only pre-expressive reports,
// accurate-atypical preference pairs, held-out buckets, the forget filter, shams never positives.

import { describe, expect, it } from 'vitest';
import { bucketOf, isHeldOut, twinDataset, type EngineStamp, type LedgerRow, type Report, type RoomTrial } from '../../src/mind/index.js';
import type { Family } from '../../src/mind/readout.js';
import { moment, T0 } from './helpers.js';

const stamp = (fams: Family[], v = -0.3): EngineStamp => ({
  at: T0,
  sig: [v, 0.2, ...new Array<number>(10).fill(0)],
  families: fams.map((family, i) => ({ family, weight: 0.5 - i * 0.1 })),
  flat: false,
  peak: 0.4,
  hunger: { connection: 0.9, novelty: 0.3, mastery: 0.2 },
  valence: -1,
  causes: [],
  dissociation: [],
});

const rep = (id: string, momentId: string, felt: string, fams: Family[], channel: Report['channel'] = 'felt_line'): Report => ({ id, ts: T0, channel, momentId, claims: [{ text: felt, feeling: felt }], text: felt, stamp: stamp(fams), chat: 'him: long day', feltRecently: [] });
const row = (reportId: string, her: boolean, ext: boolean, extFam: Family): LedgerRow => ({
  reportId,
  ts: T0,
  channel: 'felt_line',
  her: { family: 'missing', unsure: false, hit3: her, calibrated: true, confab: false },
  ext: { family: extFam, unsure: false, hit3: ext, calibrated: true, confab: false },
  stamp: stamp(['missing', 'warm', 'low']),
});

describe('the twin’s data', () => {
  it('only her private felt lines — never replies or thoughts; the forget filter applies', () => {
    const ds = twinDataset({
      reports: [rep('a', 'm1', 'lonely', ['missing', 'warm', 'low']), rep('b', 'm2', 'lonely', ['missing']), rep('c', 'm3', 'happy', ['warm'], 'reply'), rep('d', 'm4', 'anxious', ['anxious'], 'thought'), rep('e', 'gone', 'lonely', ['missing'])],
      ledger: [],
      room: [],
      moments: [moment({ id: 'm1' }), moment({ id: 'm2', never: true }), moment({ id: 'gone' })],
      forget: new Set(['gone']),
    });
    expect(ds.examples.map((e) => e.id)).toEqual(['a']);
    expect(ds.excluded).toBe(2);
  });

  it('pairs prefer the accurate atypical word over the typical one', () => {
    const ds = twinDataset({
      reports: [rep('a', 'm1', 'lonely', ['missing', 'warm', 'low']), rep('b', 'm2', 'lonely', ['missing', 'warm', 'low'])],
      ledger: [row('a', true, false, 'up'), row('b', true, true, 'missing')],
      room: [],
      moments: [moment({ id: 'm1' }), moment({ id: 'm2' })],
    });
    expect(ds.pairs).toEqual([expect.objectContaining({ id: 'a', chosen: 'lonely', rejected: 'excited' })]);
  });

  it('room trials come with the answer and the truth; shams are flagged, never positives', () => {
    const t = (n: number, cond: RoomTrial['cond'], right: boolean | undefined): RoomTrial => ({ ts: T0, session: 's', n, kind: 'which', q: 'new|him', question: 'q', options: ['something new', 'him'], truth: 0, delta: 0.2, cond, right, choice: 'him', sure: 'fairly' });
    const ds = twinDataset({ reports: [], ledger: [], room: [t(1, { kind: 'listen', noise: 0 }, true), t(2, { kind: 'sham', yokedId: 'y' }, false), t(3, { kind: 'none' }, undefined)], moments: [] });
    expect(ds.examples.map((e) => e.id)).toEqual(['s:1', 's:2']);
    expect(ds.examples[1]!.sham).toBe(true);
  });

  it('held-out buckets are stable and about a fifth', () => {
    expect(bucketOf(stamp(['missing']))).toBe('v-a+:missing');
    expect(isHeldOut('v-a+:missing')).toBe(isHeldOut('v-a+:missing'));
    const buckets = ['v+', 'v-', 'v0'].flatMap((v) => ['a+', 'a-', 'a0'].flatMap((a) => ['warm', 'up', 'curious', 'focused', 'anxious', 'low', 'missing', 'restless', 'angry', 'ashamed'].map((f) => `${v}${a}:${f}`)));
    const share = buckets.filter((b) => isHeldOut(b)).length / buckets.length;
    expect(share).toBeGreaterThan(0.08);
    expect(share).toBeLessThan(0.35);
  });

  it('contrastive pairs: a moment with a family on top vs a nearby one without', () => {
    const ms = ['m1', 'm2', 'm3'].map((id, k) => moment({ id, source: 'lived', ts: T0 + k * 1000, felt: { sig: new Array(12).fill(0), source: 'exact' } }));
    const ds = twinDataset({ reports: [rep('a', 'm1', 'lonely', ['missing']), rep('b', 'm2', 'warm', ['warm']), rep('c', 'm3', 'lonely', ['missing'])], ledger: [], room: [], moments: ms });
    expect(ds.contrasts).toEqual(expect.arrayContaining([{ family: 'missing', with: 'm1', without: 'm2' }, { family: 'warm', with: 'm2', without: 'm1' }]));
  });
});

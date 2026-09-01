// M10 gate — the consolidation pipeline end to end over MockModel, one test per
// gate clause:
//   (a) evidence threshold: below N episodes nothing fires and the model is never asked
//   (b) provenance: full stamps or the draft routes to proposals/, never lived/
//   (c) human merge gate: L3 lands in proposals/ only; canon is byte-identical
//   (d) determinism: same store + same seed => byte-identical outputs, cross-instance
//   (e) idempotence: a replay of a consolidated episode set writes nothing, calls nothing
//   (f) every written file validates through analyzeFile with zero error issues

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  CONSOLIDATE_ALARM_EVENT,
  CONSOLIDATE_GRAVITY_EVENT,
  CONSOLIDATE_RUN_EVENT,
  CONSOLIDATE_STATE_INCIDENT,
  DAY_MS,
  PATTERN_CRYSTALLIZER,
  WEEK_MS,
  consolidationKeyOf,
  loadConsolidateManifest,
  loadWeightsFile,
  manifestPath,
} from '../../src/consolidate/index.js';
import { consolidateNightly, consolidateWeekly } from '../../src/consolidate/index.js';
import { analyzeFile } from '../../src/corpus/parse.js';
import { derivedFileId } from '../../src/corpus/derived-id.js';
import { TestClock } from '../../src/kernel/clock.js';
import { MockModel } from '../../src/model/mock.js';
import {
  T0,
  analyzeWritten,
  canonFile,
  draftResponder,
  errorCodeOfAsync,
  harness,
  judgeSays,
  outcomeEnvelope,
  packetEnvelope,
  snapshot,
  stamp12,
  type EpisodeRow,
  type Harness,
} from './helpers.js';

// ---------------------------------------------------------------------------
// The fixture week: one 4-episode pattern, one 2-episode not-yet-pattern.
// ---------------------------------------------------------------------------

const HOUR = 3_600_000;

const PATTERN: EpisodeRow[] = [
  // affectAtEncoding varies so the mean is a real rollup: valence (0.6+0.4+0.6+0.4)/4 = 0.5,
  // joy (0.3+0.1+0.3+0.1)/4 = 0.2, everything else flat — the happy-path assertion below.
  { id: 'e1', turnId: 'turn_e1', vec: [1, 0], ts: T0 - 4 * HOUR, threads: ['jazz'], affectAtEncoding: stamp12({ valence: 0.6, joy: 0.3 }) },
  { id: 'e2', turnId: 'turn_e2', vec: [0.98, 0.02], ts: T0 - 3 * HOUR, threads: ['jazz'], affectAtEncoding: stamp12({ valence: 0.4, joy: 0.1 }) },
  { id: 'e3', turnId: 'turn_e3', vec: [0.97, 0.03], ts: T0 - 2 * HOUR, threads: ['boxes'], affectAtEncoding: stamp12({ valence: 0.6, joy: 0.3 }) },
  { id: 'e4', turnId: 'turn_e4', vec: [0.96, 0.04], ts: T0 - 1 * HOUR, threads: ['jazz'], affectAtEncoding: stamp12({ valence: 0.4, joy: 0.1 }) },
];
const STRAY: EpisodeRow[] = [
  { id: 's1', turnId: 'turn_s1', vec: [0, 1], ts: T0 - 5 * HOUR },
  { id: 's2', turnId: 'turn_s2', vec: [0.01, 0.99], ts: T0 - 90 * 60_000 },
];
const STRAY_THIRD: EpisodeRow = { id: 's3', turnId: 'turn_s3', vec: [0.02, 0.98], ts: T0 - 30 * 60_000 };
const STRAY_OUTCOMES = [
  outcomeEnvelope({ ts: T0 - 80 * 60_000, turnId: 'turn_s1', sign: 1, evidence: 'x' }),
  outcomeEnvelope({ ts: T0 - 70 * 60_000, turnId: 'turn_s2', sign: 1, evidence: 'y' }),
  outcomeEnvelope({ ts: T0 - 20 * 60_000, turnId: 'turn_s3', sign: 1, evidence: 'z' }),
];

/** e1..e4 affect stamps roll up to cluster mean valence 0.5, joy 0.2, rest flat. */

const OUTCOMES = [
  outcomeEnvelope({ ts: T0 - 3.5 * HOUR, turnId: 'turn_e1', sign: 1, evidence: 'he came back to it' }),
  outcomeEnvelope({ ts: T0 - 2.5 * HOUR, turnId: 'turn_e2', sign: 1, evidence: 'he said gracias' }),
  outcomeEnvelope({ ts: T0 - 1.5 * HOUR, turnId: 'turn_e3', sign: 1, evidence: 'he laughed' }),
  outcomeEnvelope({ ts: T0 - 0.5 * HOUR, turnId: 'turn_e4', sign: -1, evidence: 'he went quiet' }),
];

const CREDIT_EVENTS = [
  packetEnvelope({
    ts: T0 - 3.9 * HOUR,
    turnId: 'turn_e1',
    slots: [{ exemplarId: 'canon/voice/late-server', tier: 'pattern' }],
    affectSig: stamp12({ valence: 0.9 }),
  }),
  outcomeEnvelope({ ts: T0 - 3.8 * HOUR, turnId: 'turn_e1', sign: 1, evidence: 'he came back to it' }),
];

const livedFiles = (h: Harness): string[] =>
  fs.existsSync(h.dirs.livedDir)
    ? fs.readdirSync(h.dirs.livedDir).filter((n) => n.endsWith('.md')).sort()
    : [];

const proposalFiles = (h: Harness): string[] =>
  fs.existsSync(h.dirs.proposalsDir)
    ? fs.readdirSync(h.dirs.proposalsDir).filter((n) => n.endsWith('.md')).sort()
    : [];

/** Full-tree byte snapshot, for the idempotence and determinism proofs. */
const treeSnapshot = (h: Harness): Array<[string, string]> => snapshot(h.dirs.root);

const repointTo = (from: Harness, to: Harness): void => {
  from.deps.cfg.livedDir = to.dirs.livedDir;
  from.deps.cfg.proposalsDir = to.dirs.proposalsDir;
  from.deps.cfg.reportsDir = to.dirs.reportsDir;
  from.deps.creditPath = to.dirs.creditPath;
};

describe('nightly happy path (gates b, f)', () => {
  it('writes one lived exemplar whose provenance resolves completely', async () => {
    const h = harness('happy', { episodes: [...PATTERN, ...STRAY], l0: [...OUTCOMES, ...CREDIT_EVENTS] });

    const report = await consolidateNightly(h.deps);

    // The run: two clusters, one above the evidence threshold.
    expect(report.ok).toBe(true);
    expect(report.kind).toBe('nightly');
    expect(report.episodesConsidered).toBe(6);
    expect(report.clusters).toBe(2);
    expect(report.targets).toBe(1);
    expect(report.belowThreshold).toBe(1);
    expect(report.writtenLived).toBe(1);
    expect(report.writtenProposals).toBe(0);
    expect(report.evidenceGaps).toBe(0);
    expect(report.failures).toEqual([]);

    // Gate (f): the written file passes M07's analyzeFile with zero error issues.
    const files = livedFiles(h);
    expect(files).toHaveLength(1);
    const name = files[0] ?? '';
    const raw = fs.readFileSync(path.join(h.dirs.livedDir, name), 'utf8');
    const analysis = analyzeFile({ path: `corpus/lived/${name}`, raw }, 'lived');
    expect(analysis.issues.filter((i) => i.severity === 'error')).toEqual([]);

    // Gate (b): the stamps are the episodes' own records, complete.
    const fm = analyzeWritten(raw, name);
    expect(fm.id).toBe(`sha256:${name.replace(/\.md$/, '')}`);
    expect(fm.id).toBe(derivedFileId(raw.replace(/^id: sha256:[0-9a-f]{64}$/m, 'id: sha256:pending')));
    expect(fm.episodeIds).toEqual(['e1', 'e2', 'e3', 'e4']);
    expect(fm.outcome).toBe('mixed'); // three +1 and one -1: the honest tag
    expect(fm.encodedAffect?.valence).toBeCloseTo(0.5, 6);
    expect(fm.encodedAffect?.joy).toBeCloseTo(0.2, 6);
    expect(Object.keys(fm.encodedAffect ?? {})).toHaveLength(12);
    expect(fm.notes).toContain(PATTERN_CRYSTALLIZER.name);

    // The manifest attests the consolidation key.
    const manifest = loadConsolidateManifest(fs.readFileSync(manifestPath(h.dirs.livedDir), 'utf8'));
    expect(manifest.entries).toHaveLength(1);
    expect(manifest.entries[0]?.key).toBe(consolidationKeyOf(PATTERN_CRYSTALLIZER, ['e1', 'e2', 'e3', 'e4']));
    expect(manifest.entries[0]?.destination).toBe('lived');
    expect(manifest.entries[0]?.id).toBe(fm.id);

    // L0 heard about it: one run event, one gravity event.
    expect(h.log.kinds()).toContain(CONSOLIDATE_RUN_EVENT);
    expect(h.log.kinds()).toContain(CONSOLIDATE_GRAVITY_EVENT);
  });

  it('the seed is load-bearing: a different rng seed gives different draft bytes', async () => {
    const a = harness('seed-a', { episodes: PATTERN, l0: [...OUTCOMES], seed: 5 });
    const b = harness('seed-b', { episodes: PATTERN, l0: [...OUTCOMES], seed: 6 });
    await consolidateNightly(a.deps);
    await consolidateNightly(b.deps);
    const bodyOf = (h: Harness): string => {
      const name = livedFiles(h)[0] ?? '';
      return fs.readFileSync(path.join(h.dirs.livedDir, name), 'utf8');
    };
    expect(bodyOf(a)).not.toBe(bodyOf(b));
  });
});

describe('gate (a): the evidence threshold', () => {
  it('below-threshold patterns never reach the model', async () => {
    const strict = new MockModel({ clock: new TestClock(T0), strict: true });
    const h = harness('threshold', { episodes: STRAY, l0: [], model: strict });

    const report = await consolidateNightly(h.deps);

    expect(report.ok).toBe(true);
    expect(report.clusters).toBe(1);
    expect(report.targets).toBe(0);
    expect(report.belowThreshold).toBe(1);
    expect(strict.calls).toHaveLength(0); // the gate is BEFORE the model
    expect(livedFiles(h)).toEqual([]);
    expect(proposalFiles(h)).toEqual([]);
  });

  it('the threshold is the configured number, not a hidden constant', async () => {
    const h = harness('threshold2', {
      episodes: [...STRAY, STRAY_THIRD],
      l0: STRAY_OUTCOMES,
      cfg: { minEpisodes: 3 },
    });
    const report = await consolidateNightly(h.deps);
    expect(report.targets).toBe(1);
    expect(report.writtenLived).toBe(1);
  });
});

describe('gate (b): a provenance gap routes to proposals, never lived', () => {
  it('one episode without an outcome record sends the whole draft to proposals/', async () => {
    const h = harness('gap', {
      episodes: PATTERN,
      l0: OUTCOMES.slice(0, 3), // turn_e4 has NO outcome record -> provenance incomplete
    });

    const report = await consolidateNightly(h.deps);

    expect(report.ok).toBe(true);
    expect(report.writtenLived).toBe(0);
    expect(report.writtenProposals).toBe(1);
    expect(report.evidenceGaps).toBe(1);

    const proposals = proposalFiles(h);
    expect(proposals).toHaveLength(1);
    expect(livedFiles(h)).toEqual([]); // lived/ stays empty: no silent incompleteness

    // Proposals are named by consolidation key and marked as drafts. The
    // sha256: prefix is stripped from the DISK name (fileBaseName) — ':' is an
    // NTFS alternate-data-stream separator and a git-on-Windows path killer —
    // but the full key stays greppable in the manifest and the notes line.
    const key = consolidationKeyOf(PATTERN_CRYSTALLIZER, ['e1', 'e2', 'e3', 'e4']);
    expect(proposals[0]).toBe(`${key.replace(/^sha256:/, '')}.md`);
    const raw = fs.readFileSync(path.join(h.dirs.proposalsDir, proposals[0] ?? ''), 'utf8');
    const fm = analyzeWritten(raw, proposals[0] ?? '');
    expect(fm.notes).toMatch(/^PROPOSAL draft - human merge required/);
    expect(fm.notes).toContain('incomplete provenance');
    expect(fm.outcome).toBe('mixed'); // routed as mixed, honestly labeled a draft
  });

  it('a gap proposal still dedupes on replay', async () => {
    const a = harness('gap-replay', { episodes: PATTERN, l0: OUTCOMES.slice(0, 3) });
    await consolidateNightly(a.deps);

    const b = harness('gap-replay-2', { episodes: PATTERN, l0: OUTCOMES.slice(0, 3) });
    repointTo(b, a);
    const report = await consolidateNightly(b.deps);

    expect(report.skippedExisting).toBe(1);
    expect(proposalFiles(a)).toHaveLength(1);
  });
});

describe('gate (c): the human merge gate', () => {
  it('the weekly L3 pass lands in proposals/ only and canon is byte-identical', async () => {
    const h = harness('weekly', { episodes: PATTERN, l0: [...OUTCOMES, ...CREDIT_EVENTS], cfg: { windowMs: WEEK_MS } });
    const canonPath = path.join(h.dirs.root, 'corpus', 'canon', 'voice', 'late-server.md');
    fs.mkdirSync(path.dirname(canonPath), { recursive: true });
    fs.writeFileSync(canonPath, canonFile('voice', 'late-server').raw);
    const canonBefore = fs.readFileSync(canonPath, 'utf8');

    const report = await consolidateWeekly(h.deps);

    expect(report.kind).toBe('weekly');
    expect(report.writtenLived).toBe(0); // L3 never writes lived/
    expect(report.writtenProposals).toBe(1);
    expect(proposalFiles(h)).toHaveLength(1);
    expect(livedFiles(h)).toEqual([]);
    const raw = fs.readFileSync(path.join(h.dirs.proposalsDir, proposalFiles(h)[0] ?? ''), 'utf8');
    expect(analyzeWritten(raw, 'proposal.md').notes).toContain('canon promotion candidate');

    expect(fs.readFileSync(canonPath, 'utf8')).toBe(canonBefore); // byte-identical
    // The weekly pass does not run the credit batch.
    expect(report.credit.applied).toBe(0);
    expect(fs.existsSync(h.dirs.creditPath)).toBe(false);
  });
});

describe('gate (e): idempotence', () => {
  it('a replay of the same store is a byte-level no-op with no model calls', async () => {
    const h = harness('idem', { episodes: [...PATTERN, ...STRAY], l0: [...OUTCOMES, ...CREDIT_EVENTS] });
    await consolidateNightly(h.deps);
    const before = treeSnapshot(h);
    const calls = h.model.calls.length;

    const replay = await consolidateNightly(h.deps);

    expect(replay.ok).toBe(true);
    expect(replay.targets).toBe(1);
    expect(replay.skippedExisting).toBe(1);
    expect(replay.writtenLived).toBe(0);
    expect(replay.writtenProposals).toBe(0);
    expect(h.model.calls.length).toBe(calls); // the key gate ran before any model call
    expect(treeSnapshot(h)).toEqual(before); // byte-identical, weights.json included
  });

  it('a growing store fills only the gap', async () => {
    const h = harness('grow', { episodes: PATTERN, l0: [...OUTCOMES] });
    await consolidateNightly(h.deps);

    const grown = harness('grow2', {
      episodes: [...PATTERN, ...STRAY, STRAY_THIRD],
      l0: [...OUTCOMES, ...STRAY_OUTCOMES],
    });
    repointTo(grown, h);
    const report = await consolidateNightly(grown.deps);

    expect(report.skippedExisting).toBe(1); // the old pattern was not reconsolidated
    expect(report.writtenLived).toBe(1); // the new one was
    expect(livedFiles(h)).toHaveLength(2);
  });
});

describe('gate (d): determinism', () => {
  it('same store + same seed, two instances => byte-identical outputs', async () => {
    const a = harness('det-a', { episodes: [...PATTERN, ...STRAY], l0: [...OUTCOMES, ...CREDIT_EVENTS], seed: 11 });
    const b = harness('det-b', { episodes: [...PATTERN, ...STRAY], l0: [...OUTCOMES, ...CREDIT_EVENTS], seed: 11 });
    await consolidateNightly(a.deps);
    await consolidateNightly(b.deps);
    expect(treeSnapshot(a)).toEqual(treeSnapshot(b));
  });
});

describe('judge and validation paths', () => {
  it('a low first score is retried; the accepted retry is written', async () => {
    let judgeCalls = 0;
    const h = harness('retry', {
      episodes: PATTERN,
      l0: [...OUTCOMES],
      model: (() => {
        const m = new MockModel({ clock: new TestClock(T0) });
        m.onTask('consolidate', draftResponder());
        m.onTask('judge', () => {
          judgeCalls += 1;
          return judgeCalls === 1 ? judgeSays(3, 'drifting') : judgeSays(5);
        });
        return m;
      })(),
    });

    const report = await consolidateNightly(h.deps);

    expect(report.writtenLived).toBe(1);
    expect(report.ok).toBe(true); // a recovered retry is not a dropped target
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]?.stage).toBe('judge');
    expect(report.failures[0]?.attempt).toBe(1);
    expect(report.failures[0]?.code).toBe('consolidate/judged-out');
  });

  it('judged out twice is dropped: no file, no manifest entry, ok false', async () => {
    const h = harness('judged-out', {
      episodes: PATTERN,
      l0: [...OUTCOMES],
      model: (() => {
        const m = new MockModel({ clock: new TestClock(T0) });
        m.onTask('consolidate', draftResponder());
        m.onTask('judge', () => judgeSays(2, 'fabricates a shared history'));
        return m;
      })(),
    });

    const report = await consolidateNightly(h.deps);

    expect(report.ok).toBe(false);
    expect(report.judgeFailed).toBe(1);
    expect(report.parseFailed).toBe(0);
    expect(livedFiles(h)).toEqual([]);
    expect(proposalFiles(h)).toEqual([]);
    expect(loadConsolidateManifest(fs.readFileSync(manifestPath(h.dirs.livedDir), 'utf8')).entries).toHaveLength(0);
    expect(h.model.calls.filter((c) => c.taskClass === 'judge')).toHaveLength(2); // MAX_ATTEMPTS
  });

  it('an unparseable draft fails at generate; the judge is never asked', async () => {
    const h = harness('unparseable', {
      episodes: PATTERN,
      l0: [...OUTCOMES],
      model: (() => {
        const m = new MockModel({ clock: new TestClock(T0) });
        m.onTask('consolidate', () => ({ content: 'prose where JSON should be' }));
        m.onTask('judge', () => judgeSays(5));
        return m;
      })(),
    });

    const report = await consolidateNightly(h.deps);

    expect(report.ok).toBe(false);
    expect(report.parseFailed).toBe(1);
    expect(report.judgeFailed).toBe(0);
    expect(h.model.calls.filter((c) => c.taskClass === 'judge')).toHaveLength(0);
    expect(report.failures.every((f) => f.stage === 'generate')).toBe(true);
  });

  it('a draft with an out-of-vocabulary register fails at validate', async () => {
    const h = harness('vocab', {
      episodes: PATTERN,
      l0: [...OUTCOMES],
      model: (() => {
        const m = new MockModel({ clock: new TestClock(T0) });
        m.onTask('consolidate', (req) => {
          const seed = req.seedHint !== undefined ? String(req.seedHint) : 'noseed';
          return {
            content: JSON.stringify({
              context: 'late night, one lamp',
              dimensions: ['voice'],
              register: ['no-such-register'], // the corpus knows only 'play'
              body: `Setup: a quiet terminal\nD: you there?\nT: always. seed ${seed}\n`,
            }),
          };
        });
        m.onTask('judge', () => judgeSays(5));
        return m;
      })(),
    });

    const report = await consolidateNightly(h.deps);

    expect(report.ok).toBe(false);
    expect(report.parseFailed).toBe(1);
    expect(report.failures[0]?.stage).toBe('validate');
    expect(report.failures[0]?.code).toBe('consolidate/draft-shape');
  });

  it('a model transport error is retried once, then dropped loudly', async () => {
    const h = harness('transport', {
      episodes: PATTERN,
      l0: [...OUTCOMES],
      model: (() => {
        const m = new MockModel({ clock: new TestClock(T0) });
        m.onTask('consolidate', () => ({ error: { code: 'model/transport', message: 'endpoint down' } }));
        m.onTask('judge', () => judgeSays(5));
        return m;
      })(),
    });

    const report = await consolidateNightly(h.deps);

    expect(report.ok).toBe(false);
    expect(report.parseFailed).toBe(1);
    expect(report.failures[0]?.stage).toBe('generate');
    expect(report.failures[0]?.code).toBe('model/transport');
  });
});

describe('the credit pass', () => {
  it('applies fresh outcomes incrementally and persists the file', async () => {
    const h = harness('credit', { episodes: PATTERN, l0: [...OUTCOMES, ...CREDIT_EVENTS] });

    const report = await consolidateNightly(h.deps);

    expect(report.credit.applied).toBe(1);
    expect(report.credit.rebuilt).toBe(false);
    const file = loadWeightsFile(fs.readFileSync(h.dirs.creditPath, 'utf8'));
    // +1 on a pattern slot is +eta, then one decay on the file's first day.
    expect(file.weights['canon/voice/late-server']).toBeCloseTo(1 + 0.02 * 0.995, 12);
    expect(file.lastSeq).toBe(OUTCOMES.length + CREDIT_EVENTS.length);
  });

  it('a same-day replay does not touch the file; a new day decays exactly once', async () => {
    const clock = new TestClock(T0);
    const h = harness('decay', { episodes: PATTERN, l0: [...OUTCOMES, ...CREDIT_EVENTS], clock });
    await consolidateNightly(h.deps);
    const day1 = fs.readFileSync(h.dirs.creditPath, 'utf8');
    expect(JSON.parse(day1)).toMatchObject({ decayDay: Math.floor(T0 / DAY_MS) });

    // Replay, same instant: byte-identical.
    await consolidateNightly(h.deps);
    expect(fs.readFileSync(h.dirs.creditPath, 'utf8')).toBe(day1);

    // A new calendar day: decay runs once, then holds for the rest of the day.
    clock.advance(DAY_MS);
    await consolidateNightly(h.deps);
    const day2 = fs.readFileSync(h.dirs.creditPath, 'utf8');
    expect(day2).not.toBe(day1);
    expect(JSON.parse(day2)).toMatchObject({ decayDay: Math.floor((T0 + DAY_MS) / DAY_MS) });
    await consolidateNightly(h.deps);
    expect(fs.readFileSync(h.dirs.creditPath, 'utf8')).toBe(day2);
  });

  it('a corrupt weights file is an incident: rebuilt from L0, then persisted', async () => {
    const h = harness('corrupt-weights', { episodes: PATTERN, l0: [...OUTCOMES, ...CREDIT_EVENTS] });
    fs.mkdirSync(path.dirname(h.dirs.creditPath), { recursive: true });
    fs.writeFileSync(h.dirs.creditPath, '{"version":1,"lastSeq":0,');

    const report = await consolidateNightly(h.deps);

    expect(report.credit.rebuilt).toBe(true);
    expect(report.credit.applied).toBe(0); // everything was already in the replay fold
    expect(h.log.kinds()).toContain(CONSOLIDATE_STATE_INCIDENT);
    const file = loadWeightsFile(fs.readFileSync(h.dirs.creditPath, 'utf8'));
    expect(file.weights['canon/voice/late-server']).toBeCloseTo(1 + 0.02 * 0.995, 12); // replayed, then one decay
  });

  it('an outcome whose packet never landed is skipped and counted', async () => {
    const h = harness('orphan-outcome', {
      episodes: PATTERN,
      l0: [
        ...OUTCOMES,
        ...CREDIT_EVENTS,
        outcomeEnvelope({ ts: T0 - 10 * 60_000, turnId: 'turn_ghost', sign: 1, evidence: 'no packet for this' }),
      ],
    });
    const report = await consolidateNightly(h.deps);
    expect(report.credit.applied).toBe(1); // turn_e1's packet
    expect(report.credit.skippedNoPacket).toBe(4); // e2, e3, e4, ghost
  });
});

describe('gravity + the L0 boundary', () => {
  it('fires unmoored from real packets and emits the alarm on L0', async () => {
    const packets = Array.from({ length: 60 }, (_, i) =>
      packetEnvelope({
        ts: T0 - (60 - i) * 60_000,
        turnId: `turn_p${String(i).padStart(2, '0')}`,
        // The rolling 50 covers i = 10..59: the last 5 slots are seed-sourced,
        // 45 are lived -> seedRatio 5/50 = 0.1 < 0.25 -> unmoored.
        slots: [{ exemplarId: i >= 55 ? 'canon/voice/late-server' : `lived_${i}`, tier: 'pattern' }],
      }),
    );
    const h = harness('unmoored', { episodes: [], l0: packets, gravityWeek: 1 });

    const report = await consolidateNightly(h.deps);

    expect(report.gravity.alarms).toEqual(['unmoored']);
    expect(h.log.kinds()).toContain(CONSOLIDATE_ALARM_EVENT);
    const alarm = h.log.events.find((e) => e.kind === CONSOLIDATE_ALARM_EVENT);
    expect(alarm?.payload).toMatchObject({ alarm: 'unmoored' });
    const status = fs.readFileSync(path.join(h.dirs.reportsDir, 'status.md'), 'utf8');
    expect(status).toContain('seedRatio pattern: 0.100');
    expect(status).toContain('alarms: unmoored');
  });

  it('a malformed packet.record is skipped and counted, never fatal', async () => {
    const h = harness('malformed', {
      episodes: PATTERN,
      l0: [...OUTCOMES, { ts: T0, kind: 'packet.record', payload: { turnId: 'turn_bad' } }],
    });
    const report = await consolidateNightly(h.deps);
    expect(report.malformedRecords).toBe(1);
    expect(report.ok).toBe(false);
    expect(report.writtenLived).toBe(1); // the good data still consolidated
  });

  it('an episode without an embedding is a loud error', async () => {
    const h = harness('no-vec', { episodes: [{ id: 'e1', turnId: 'turn_e1', ts: T0 - HOUR }], l0: [] });
    expect(await errorCodeOfAsync(() => consolidateNightly(h.deps))).toBe('consolidate/no-vector');
  });

  it('the projection reflects the weekly baseline', async () => {
    const h = harness('baseline', {
      episodes: PATTERN,
      l0: [...OUTCOMES],
      cfg: { windowMs: WEEK_MS },
      affectTags: [{ ts: T0 - 2 * HOUR, tags: ['fond', 'fond', 'longing'] }],
    });
    await consolidateWeekly(h.deps);
    const status = fs.readFileSync(path.join(h.dirs.reportsDir, 'status.md'), 'utf8');
    expect(status).toContain('kind: weekly');
    expect(status).toContain('- episodes this window: 4');
    expect(status).toContain('- distinct threads: 2');
    expect(status).toContain('- top affect tags: fond 2 · longing 1');
  });
});

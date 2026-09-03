// M08 gate — `derive` end-to-end over MockModel: generate → parse-validate →
// judge → write file + manifest atomically → GC orphans → emit L0 events, plus
// the judge retry-then-discard path and per-seed reproducibility.

import { describe, expect, it } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  DERIVE_ORPHAN_GC_EVENT,
  DERIVE_RUN_EVENT,
  derive,
  emptyManifest,
  fileBaseName,
  loadManifest,
  manifestPath,
  serializeManifest,
  V1_GENERATORS,
  type DeriveInputs,
  type DeriveRunOptions,
  type Manifest,
} from '../../src/derive/index.js';
import { derivedFileId } from '../../src/derive/index.js';
import { assertStatementProse, draftKind, withBody } from '../../src/derive/index.js';
import type { Exemplar } from '../../schemas/exemplar.js';
import { TestClock } from '../../src/kernel/clock.js';
import { makeRng } from '../../src/kernel/rng.js';
import { atomicWriteJson } from '../../src/kernel/fs.js';
import { parseExemplar } from '../../src/corpus/parse.js';
import { splitExemplarFile } from '../../src/corpus/frontmatter.js';
import { MockModel, type Responder, type ScriptedResponse } from '../../src/model/mock.js';
import { baseInputs, sceneA, tmpDir } from './helpers.js';

/**
 * Parses a written file the way the module validated it — including the
 * statement shim (M07 rejects prose bodies for every kind; see file.ts).
 * Returns the parsed frontmatter (the surrogate body for statements).
 */
const parseWritten = (text: string): Exemplar => {
  if (draftKind(text) === 'statement') {
    const parsed = parseExemplar(withBody(text, 'D: x\nT: y\n'), 'derived');
    assertStatementProse(splitExemplarFile(text).body);
    return parsed;
  }
  return parseExemplar(text, 'derived');
};

// ---------------------------------------------------------------------------
// Scripted model. Bodies echo the request where the run's bytes depend on it,
// so the reproducibility proof below is real (same seed ⇒ same draw ⇒ same bytes).
// ---------------------------------------------------------------------------

const PROCEDURE_BODY = [
  'Setup: he wonders about the box',
  'D: is it fine',
  'T: hold on',
  '[tool] splyce_status {"id":"box"} → their status page says green',
  '[outcome] good — he let it go',
  '',
].join('\n');
const PROSE_BODY = 'what she keeps: the small sure thing\nand the shape it leaves behind\n';

/** Echoes the mood angle the generator drew, so the rng is load-bearing in the bytes. */
const deriveResponder = (): Responder => (req) => {
  const system = req.messages[0]?.content ?? '';
  const user = req.messages.at(-1)?.content ?? '';
  if (system.includes('procedural exemplar')) return { content: PROCEDURE_BODY };
  if (system.includes('deliberation') || system.includes('memory')) return { content: PROSE_BODY };
  const angle = /Angle: (.*)/.exec(user)?.[1] ?? 'none';
  return { content: `D: he asks something small\nT: ${angle}. the fan hums\n` };
};

const judgeSays = (score: number, reason = 'notes survive'): ScriptedResponse => ({
  toolCalls: [{ id: 'e1', name: 'emit', args: { score, reason } }],
});

interface UnknownEvent {
  kind: string;
  payload: unknown;
}

/** Silent event log by default; `collect()` swaps in a recording one. */
const makeOpts = (
  dir: string,
  inputs: DeriveInputs,
  model: MockModel,
  judge: MockModel,
  over: Partial<DeriveRunOptions> = {},
  collected?: UnknownEvent[],
): DeriveRunOptions => ({
  inputs,
  generators: V1_GENERATORS,
  model,
  modelId: 'test-gen',
  judgeModel: judge,
  judge: { version: 'derive-judge-v1', threshold: 4 },
  embedderId: 'test-embedder',
  rng: makeRng(7),
  events:
    collected === undefined
      ? { emit: async () => {}, replay: async function* () {} }
      : {
          emit: async (kind, payload) => {
            collected.push({ kind, payload });
          },
          replay: async function* () {},
        },
  clock: new TestClock(1000),
  outDir: dir,
  ...over,
});

/** One canon scene, one bucket: exactly one target — the smallest honest run. */
const oneTarget = (): DeriveInputs => baseInputs({ canon: [sceneA()], toolDefs: [], moodBuckets: ['bright'] });

const readManifest = async (dir: string): Promise<Manifest> =>
  loadManifest(await fsp.readFile(manifestPath(dir), 'utf8'));

const snapshot = async (dir: string): Promise<Array<[string, string]>> => {
  const out: Array<[string, string]> = [];
  for (const name of fs.readdirSync(dir).sort()) {
    out.push([name, await fsp.readFile(path.join(dir, name), 'utf8')]);
  }
  return out;
};

const staged = (): { model: MockModel; judge: MockModel } => {
  const model = new MockModel({ clock: new TestClock() });
  model.onTask('derive', deriveResponder());
  const judge = new MockModel({ clock: new TestClock() });
  judge.onTask('judge', () => judgeSays(5));
  return { model, judge };
};

describe('happy path (8 targets: 4 mood, 2 procedural, 1 deliberation, 1 weave)', () => {
  it('generates, judges, writes every file + the manifest, and emits derive.run', async () => {
    const dir = tmpDir('thea2-derive-run-');
    const inputs = baseInputs({ moodBuckets: ['bright', 'low'] });
    const { model, judge } = staged();
    const collected: UnknownEvent[] = [];

    const report = await derive(makeOpts(dir, inputs, model, judge, {}, collected));

    expect(report.ok).toBe(true);
    expect(report.targets).toBe(8);
    expect(report.written).toBe(8);
    expect(report.judgeFailed).toBe(0);
    expect(report.parseFailed).toBe(0);
    expect(report.failures).toEqual([]);
    expect(report.orphans).toEqual([]);
    expect(report.droppedByCap).toBe(0);

    // every entry is attested, content-addressed, and its file parses as derived
    expect(report.entries).toHaveLength(8);
    for (const entry of report.entries) {
      expect(entry.judge).toEqual({ version: 'derive-judge-v1', score: 5, pass: true });
      const file = path.join(dir, `${fileBaseName(entry.id)}.md`);
      const text = await fsp.readFile(file, 'utf8');
      expect(derivedFileId(text)).toBe(entry.id); // content-hash invariant
      const parsed = parseWritten(text); // no file arg: id not yet knowable to M07
      expect(parsed.provenance?.generator).toBeTruthy();
      expect(parsed.provenance?.judge.pass).toBe(true);
      expect(entry.createdAt).toBe(1000); // injected clock, not the wall
    }

    // manifest bytes on disk are exactly the serialized report entries
    const manifest = await readManifest(dir);
    expect(manifest.embedderId).toBe('test-embedder');
    expect(await fsp.readFile(manifestPath(dir), 'utf8')).toBe(serializeManifest(manifest));
    expect(manifest.entries).toEqual(report.entries);

    // L0: one run summary, no GC noise
    expect(collected.map((e) => e.kind)).toEqual([DERIVE_RUN_EVENT]);
    expect(collected[0]!.payload).toMatchObject({
      targets: 8,
      written: 8,
      judgeFailed: 0,
      parseFailed: 0,
      orphans: 0,
      droppedByCap: 0,
      generators: V1_GENERATORS.map((g) => ({ name: g.name, version: g.version })),
    });
  });

  it('a second identical run is a no-op: nothing dirty, manifest byte-identical', async () => {
    const dir = tmpDir('thea2-derive-run-');
    const inputs = baseInputs({ moodBuckets: ['bright', 'low'] });
    const { model, judge } = staged();
    await derive(makeOpts(dir, inputs, model, judge));
    const before = await snapshot(dir);

    const second = await derive(makeOpts(dir, inputs, model, judge));
    expect(second.targets).toBe(0);
    expect(second.written).toBe(0);
    expect(second.ok).toBe(true);
    expect(model.calls).toHaveLength(8); // the model was never called again
    expect(await snapshot(dir)).toEqual(before);
  });

  it('concurrency k > 1 writes the SAME tree as the sequential run, byte for byte', async () => {
    // The worker pool must be a scheduling change and nothing else: rng is
    // forked per target, drafts echo the drawn angle (pure in the request), so
    // same seed ⇒ same bytes regardless of interleaving. The real-backend motive
    // is brute (a full re-derive is hundreds of sequential round-trips); the
    // invariant it must not break is determinism.
    const inputs = baseInputs({ moodBuckets: ['bright', 'low'] });

    const seqDir = tmpDir('thea2-derive-run-seq-');
    const seq = staged();
    const seqReport = await derive(makeOpts(seqDir, inputs, seq.model, seq.judge));

    const parDir = tmpDir('thea2-derive-run-par-');
    const par = staged();
    const parReport = await derive(makeOpts(parDir, inputs, par.model, par.judge, { concurrency: 4 }));

    expect(parReport.ok).toBe(true);
    expect(parReport.targets).toBe(seqReport.targets);
    expect(parReport.written).toBe(seqReport.written);
    expect(await snapshot(parDir)).toEqual(await snapshot(seqDir));
  });
});

describe('judge gate: retry once, then discard', () => {
  it('a low first attempt is retried; the retry writes with pass:true', async () => {
    const dir = tmpDir('thea2-derive-run-');
    const { model } = staged();
    const judge = new MockModel({ clock: new TestClock() });
    judge.enqueue(judgeSays(2, 'voice went generic'));
    judge.enqueue(judgeSays(5));

    const report = await derive(makeOpts(dir, oneTarget(), model, judge));

    expect(report.written).toBe(1);
    expect(report.judgeFailed).toBe(0);
    expect(report.failures).toEqual([
      {
        deriveKey: report.entries[0]!.deriveKey,
        generator: 'mood-variant',
        attempt: 1,
        stage: 'judge',
        code: 'derive/draft-shape',
        message: expect.stringContaining('judge scored 2 < threshold 4'),
      },
    ]);
    expect(report.entries[0]!.judge).toEqual({ version: 'derive-judge-v1', score: 5, pass: true });
  });

  it('a draft failed twice is never written: no file, no manifest entry', async () => {
    const dir = tmpDir('thea2-derive-run-');
    const { model } = staged();
    const judge = new MockModel({ clock: new TestClock() });
    judge.onTask('judge', () => judgeSays(3, 'generic voice is not acceptable'));

    const report = await derive(makeOpts(dir, oneTarget(), model, judge));

    expect(report.ok).toBe(false);
    expect(report.judgeFailed).toBe(1);
    expect(report.written).toBe(0);
    expect(report.entries).toEqual([]);
    expect(report.failures.map((f) => f.attempt)).toEqual([1, 2]);
    expect(report.failures.every((f) => f.stage === 'judge' && f.code === 'derive/draft-shape')).toBe(true);
    // only the manifest exists: the discarded drafts left nothing behind
    expect(fs.readdirSync(dir)).toEqual(['manifest.json']);
    expect((await readManifest(dir)).entries).toEqual([]);
  });

  it('an unparseable generation fails at parse and the judge is never asked', async () => {
    const dir = tmpDir('thea2-derive-run-');
    const model = new MockModel({ clock: new TestClock() });
    model.onTask('derive', () => ({ content: 'prose where a scene body should be\n' }));
    const judge = new MockModel({ clock: new TestClock(), strict: true });

    const report = await derive(makeOpts(dir, oneTarget(), model, judge));

    expect(report.ok).toBe(false);
    expect(report.parseFailed).toBe(1);
    expect(report.written).toBe(0);
    expect(judge.calls).toHaveLength(0); // parse discipline precedes grading
    expect(report.failures.map((f) => [f.attempt, f.stage])).toEqual([
      [1, 'parse'],
      [2, 'parse'],
    ]);
  });

  it('a model error is a failed generation, retried once, then discarded', async () => {
    const dir = tmpDir('thea2-derive-run-');
    const model = new MockModel({ clock: new TestClock() });
    model.onTask('derive', () => ({ error: { code: 'model/transport', message: 'endpoint down' } }));
    const judge = new MockModel({ clock: new TestClock(), strict: true });

    const report = await derive(makeOpts(dir, oneTarget(), model, judge));
    expect(report.ok).toBe(false);
    expect(report.parseFailed).toBe(1); // the failure is attributed to the last stage reached
    expect(report.failures.map((f) => f.stage)).toEqual(['generate', 'generate']);
    expect(report.failures[0]!.code).toBe('model/transport');
  });
});

describe('orphan GC', () => {
  it('a variant whose bucket left the inputs loses its entry and its file, loudly', async () => {
    const dir = tmpDir('thea2-derive-run-');
    const { model, judge } = staged();
    const collected: UnknownEvent[] = [];

    await derive(makeOpts(dir, oneTarget(), model, judge, {}, collected));
    const fileCount = fs.readdirSync(dir).length;

    const low = baseInputs({ canon: [sceneA()], toolDefs: [], moodBuckets: ['low'] });
    const report = await derive(makeOpts(dir, low, model, judge, {}, collected));

    expect(report.orphans).toHaveLength(1);
    expect(report.ok).toBe(true);
    const gc = collected.filter((e) => e.kind === DERIVE_ORPHAN_GC_EVENT);
    expect(gc).toHaveLength(1);
    const payload = gc[0]!.payload as { id: string; deriveKey: string; file: string; removed: boolean };
    expect(payload.removed).toBe(true);
    expect(fs.existsSync(payload.file)).toBe(false);
    // the orphaned entry is gone; the new variant took its place
    expect((await readManifest(dir)).entries).toHaveLength(1);
    expect(fs.readdirSync(dir)).toHaveLength(fileCount);
  });

  it('a GC whose file is already gone still drops the entry, with the divergence visible', async () => {
    const dir = tmpDir('thea2-derive-run-');
    const { model, judge } = staged();
    const collected: UnknownEvent[] = [];

    await derive(makeOpts(dir, oneTarget(), model, judge, {}, collected));
    const manifest = await readManifest(dir);
    await fsp.rm(path.join(dir, `${fileBaseName(manifest.entries[0]!.id)}.md`)); // file lost out-of-band

    const low = baseInputs({ canon: [sceneA()], toolDefs: [], moodBuckets: ['low'] });
    const report = await derive(makeOpts(dir, low, model, judge, {}, collected));
    expect(report.orphans).toHaveLength(1);
    const payload = collected.find((e) => e.kind === DERIVE_ORPHAN_GC_EVENT)!.payload as {
      removed: boolean;
      error?: string;
    };
    expect(payload.removed).toBe(false);
    expect(payload.error).toContain('ENOENT');
  });
});

describe('run bookkeeping', () => {
  it('a cap of zero proposes nothing: nothing written, nothing judged, cap reported', async () => {
    const dir = tmpDir('thea2-derive-run-');
    const model = new MockModel({ clock: new TestClock(), strict: true });
    const judge = new MockModel({ clock: new TestClock(), strict: true });
    const report = await derive(makeOpts(dir, { ...oneTarget(), gravityCap: 0 }, model, judge));
    expect(report.ok).toBe(true);
    expect(report.targets).toBe(0);
    expect(report.droppedByCap).toBe(1);
    expect(model.calls).toHaveLength(0);
    expect(judge.calls).toHaveLength(0);
  });

  it('a manifest pinned to another embedder is reported, not absorbed', async () => {
    const dir = tmpDir('thea2-derive-run-');
    await atomicWriteJson(manifestPath(dir), emptyManifest('other-embedder'));
    const { model, judge } = staged();

    const report = await derive(makeOpts(dir, oneTarget(), model, judge));
    expect(report.embedderMismatch).toEqual({ manifest: 'other-embedder', active: 'test-embedder' });
    expect(report.ok).toBe(false);
    expect(report.written).toBe(1); // the run still does its work
    expect((await readManifest(dir)).embedderId).toBe('test-embedder');
  });
});

describe('reproducibility', () => {
  it('same seed + same inputs + same scripted model ⇒ byte-identical files and manifest', async () => {
    const inputs = baseInputs({ moodBuckets: ['bright', 'low'] });
    const run = async (dir: string): Promise<Array<[string, string]>> => {
      const { model, judge } = staged();
      await derive(
        makeOpts(dir, inputs, model, judge, { rng: makeRng('fixed-seed'), clock: new TestClock(5000) }),
      );
      return snapshot(dir);
    };
    const a = await run(tmpDir('thea2-derive-repro-'));
    const b = await run(tmpDir('thea2-derive-repro-'));
    expect(a).toEqual(b);
    // the rng was load-bearing: a mood body carries its drawn angle
    const mood = a.find(([name, text]) => name.endsWith('.md') && text.includes('the fan hums'));
    expect(mood).toBeDefined();
  });

  it('different seeds can draw different angles (forks are per target, not per run)', async () => {
    const inputs = oneTarget();
    const texts = new Set<string>();
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const dir = tmpDir('thea2-derive-seed-');
      const { model, judge } = staged();
      const report = await derive(makeOpts(dir, inputs, model, judge, { rng: makeRng(seed) }));
      texts.add(await fsp.readFile(path.join(dir, `${fileBaseName(report.entries[0]!.id)}.md`), 'utf8'));
    }
    // 6 seeds over 4 prompt angles: at least two distinct draws
    expect(texts.size).toBeGreaterThan(1);
  });
});

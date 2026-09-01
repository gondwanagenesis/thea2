// M08 derive — the generation run (`thea2 derive`).
//
// Dev/scheduled only, always with a real model: enumerate the dirty set,
// generate, validate against M07's parser, judge, write file + manifest
// atomically, GC orphans, emit the run summary to L0. Prod never runs this —
// the weekly job computes the dirty/orphan sets and only reports (ADR-007).

import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { asError, atomicWriteJson, atomicWriteText } from '../kernel/index.js';
import { parseExemplar } from '../corpus/parse.js';
import { splitExemplarFile } from '../corpus/frontmatter.js';
import type { DerivedProvenance } from '../../schemas/exemplar.js';
import { enumerateTargets, type ExpectedTarget } from './enumerate.js';
import { assertStatementProse, draftKind, withBody, withProvenance } from './file.js';
import { derivedFileId, fileBaseName, withFileId } from './keys.js';
import { gradeDraft } from './judge.js';
import { emptyManifest, loadManifest, sortEntries } from './manifest.js';
import {
  DERIVE_ORPHAN_GC_EVENT,
  DERIVE_RUN_EVENT,
  type DeriveFailure,
  type DeriveReport,
  type DeriveRunEvent,
  type DeriveRunOptions,
  type Manifest,
  type ManifestEntry,
} from './types.js';

/** Generation is retried exactly once before the draft is discarded (spec §Judge validation). */
const MAX_ATTEMPTS = 2;

const MANIFEST_NAME = 'manifest.json';

export const manifestPath = (outDir: string): string => path.join(outDir, MANIFEST_NAME);

/**
 * Runs the pipeline over the dirty set. The committed manifest is read from
 * `outDir` (absent ⇒ a first-ever run over an empty manifest); the updated one
 * is written back atomically only after every file is on disk, so an interrupted
 * run leaves at worst unreferenced files that the next run's GC will not touch
 * and corpus:check will name.
 */
export const derive = async (opts: DeriveRunOptions): Promise<DeriveReport> => {
  const failures: DeriveFailure[] = [];
  const written: ManifestEntry[] = [];
  let judgeFailed = 0;
  let parseFailed = 0;

  const manifest = await readManifest(opts);
  const embedderMismatch =
    manifest.embedderId === opts.embedderId
      ? undefined
      : { manifest: manifest.embedderId, active: opts.embedderId };

  const enumerated = enumerateTargets(opts.inputs, opts.generators, manifest);
  const manifestKeys = new Set(manifest.entries.map((e) => e.deriveKey));
  const dirty = enumerated.targets.filter((t) => !manifestKeys.has(t.target.deriveKey));

  for (const expected of dirty) {
    const accepted = await generateAndJudge(expected, opts, failures);
    if (accepted.ok) {
      written.push(await writeAccepted(expected, accepted, opts));
    } else if (accepted.stage === 'judge') {
      judgeFailed += 1;
    } else {
      parseFailed += 1;
    }
  }

  // Orphan GC: entries whose deriveKey left the expected set lose their entry
  // and their file, each loudly. Git history is the recovery path.
  const orphans = manifest.entries.filter(
    (e) => !enumerated.targets.some((t) => t.target.deriveKey === e.deriveKey),
  );
  for (const orphan of orphans) await gcOrphan(opts, orphan);

  const dropped = new Set(orphans);
  const entries = sortEntries([
    ...manifest.entries.filter((e) => !dropped.has(e)),
    ...written,
  ]);
  await atomicWriteJson(manifestPath(opts.outDir), { version: 1, embedderId: opts.embedderId, entries } satisfies Manifest);

  const event: DeriveRunEvent = {
    targets: dirty.length,
    written: written.length,
    judgeFailed,
    parseFailed,
    orphans: orphans.length,
    droppedByCap: enumerated.droppedByCap,
    generators: opts.generators.map((g) => ({ name: g.name, version: g.version })),
    ...(embedderMismatch !== undefined ? { embedderMismatch } : {}),
  };
  await opts.events.emit(DERIVE_RUN_EVENT, event);

  return {
    ok: written.length === dirty.length && failures.length === 0 && embedderMismatch === undefined,
    targets: dirty.length,
    written: written.length,
    judgeFailed,
    parseFailed,
    orphans,
    droppedByCap: enumerated.droppedByCap,
    failures,
    entries,
    ...(embedderMismatch !== undefined ? { embedderMismatch } : {}),
  };
};

const readManifest = async (opts: DeriveRunOptions): Promise<Manifest> => {
  let raw: string;
  try {
    raw = await fsp.readFile(manifestPath(opts.outDir), 'utf8');
  } catch {
    return emptyManifest(opts.embedderId); // first-ever run
  }
  return loadManifest(raw);
};

const gcOrphan = async (opts: DeriveRunOptions, orphan: ManifestEntry): Promise<void> => {
  const file = path.join(opts.outDir, `${fileBaseName(orphan.id)}.md`);
  let removed = true;
  let error: string | undefined;
  try {
    await fsp.rm(file);
  } catch (e) {
    const asErr = asError(e);
    removed = false;
    error = `${asErr.code}: ${asErr.message}`;
  }
  // Loud either way: an entry can be dropped while its file survives, and that
  // divergence must be visible in L0, not discovered by a later corpus:check.
  await opts.events.emit(DERIVE_ORPHAN_GC_EVENT, {
    id: orphan.id,
    deriveKey: orphan.deriveKey,
    file,
    removed,
    ...(error !== undefined ? { error } : {}),
  });
};

type Attempt =
  | { ok: true; draft: string; score: number }
  | { ok: false; stage: 'parse' | 'judge' | 'generate' };

/**
 * One target: generate → parse-validate → judge, retried once, then discarded.
 * A discarded target writes nothing — no file, no manifest entry.
 */
const generateAndJudge = async (
  expected: ExpectedTarget,
  opts: DeriveRunOptions,
  failures: DeriveFailure[],
): Promise<Attempt> => {
  const { generator, target } = expected;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const counted = attempt as 1 | 2;
    // Forked per target and attempt: one target's draws never perturb another's,
    // and a run is reproducible per seed regardless of where dirty targets land.
    const rng = opts.rng.fork(`${target.deriveKey}::attempt-${counted}`);
    let draft: string;
    try {
      draft = await generator.generate(target, { model: opts.model, rng, inputs: opts.inputs });
    } catch (e) {
      record(failures, generator.name, target.deriveKey, counted, 'generate', asError(e));
      continue;
    }

    // Parsed without a `file` argument — the id is still the pending
    // placeholder, so location identity is not checkable yet.
    try {
      validateDraft(withProvenance(draft, pendingProvenance(expected, opts)));
    } catch (e) {
      record(failures, generator.name, target.deriveKey, counted, 'parse', asError(e));
      continue;
    }

    const sources = target.inputs.canonIds.flatMap((c) => {
      const found = opts.inputs.canon.find((e) => e.id === c.id);
      return found === undefined ? [] : [found];
    });
    try {
      const graded = await gradeDraft(opts.judgeModel, {
        sources,
        draft,
        ...(target.bucket !== undefined ? { bucket: target.bucket } : {}),
      });
      if (graded.verdict.score < opts.judge.threshold) {
        record(failures, generator.name, target.deriveKey, counted, 'judge', {
          code: 'derive/draft-shape',
          message: `judge scored ${graded.verdict.score} < threshold ${opts.judge.threshold}: ${graded.verdict.reason}`,
        });
        continue;
      }
      return { ok: true, draft, score: graded.verdict.score };
    } catch (e) {
      record(failures, generator.name, target.deriveKey, counted, 'judge', asError(e));
    }
  }
  return { ok: false, stage: lastStage(failures, target.deriveKey) };
};

const lastStage = (failures: DeriveFailure[], deriveKey: string): 'parse' | 'judge' | 'generate' => {
  for (let i = failures.length - 1; i >= 0; i--) {
    const f = failures[i];
    if (f !== undefined && f.deriveKey === deriveKey) return f.stage;
  }
  return 'generate';
};

const record = (
  failures: DeriveFailure[],
  generator: string,
  deriveKey: string,
  attempt: 1 | 2,
  stage: 'generate' | 'parse' | 'judge',
  e: { code: string; message: string },
): void => {
  failures.push({ deriveKey, generator, attempt, stage, code: e.code, message: e.message });
};

const pendingProvenance = (expected: ExpectedTarget, opts: DeriveRunOptions): DerivedProvenance => ({
  generator: expected.generator.name,
  generatorVersion: expected.generator.version,
  canonIds: expected.target.inputs.canonIds.map((c) => c.id),
  sourceHashes: expected.target.inputs.canonIds.map((c) => c.sha256),
  model: opts.modelId,
  judge: { version: opts.judge.version, score: 0, pass: false },
});

/**
 * Minimal grammar-legal body, used only to run a statement draft's FRONTMATTER
 * through M07's parser. The real body is validated by assertStatementProse —
 * M07's validator rejects prose for every kind, statements included, which
 * contradicts its own rule and its committed canon (see file.ts).
 */
const STATEMENT_SURROGATE_BODY = 'D: x\nT: y\n';

/** Parse discipline (spec §Schema discipline): an unparseable generation is a failed generation. */
const validateDraft = (attested: string): void => {
  if (draftKind(attested) !== 'statement') {
    parseExemplar(attested, 'derived');
    return;
  }
  parseExemplar(withBody(attested, STATEMENT_SURROGATE_BODY), 'derived');
  assertStatementProse(splitExemplarFile(attested).body);
};

/** Final bytes + manifest entry for an accepted draft. */
const writeAccepted = async (
  expected: ExpectedTarget,
  accepted: { draft: string; score: number },
  opts: DeriveRunOptions,
): Promise<ManifestEntry> => {
  const { generator, target } = expected;
  const provenance: DerivedProvenance = {
    generator: generator.name,
    generatorVersion: generator.version,
    canonIds: target.inputs.canonIds.map((c) => c.id),
    sourceHashes: target.inputs.canonIds.map((c) => c.sha256),
    model: opts.modelId,
    judge: { version: opts.judge.version, score: accepted.score, pass: true },
  };

  // The id is fixed only after the provenance block exists: it is the hash of
  // the finished text with the id line masked (keys.ts).
  const attested = withProvenance(accepted.draft, provenance);
  const id = derivedFileId(attested);
  const file = path.join(opts.outDir, `${fileBaseName(id)}.md`);
  await atomicWriteText(file, withFileId(attested, id));

  return {
    id,
    deriveKey: target.deriveKey,
    generator: generator.name,
    generatorVersion: generator.version,
    inputs: target.inputs,
    model: opts.modelId,
    createdAt: opts.clock.epochMs(),
    judge: { version: opts.judge.version, score: accepted.score, pass: true },
  };
};

// M20 app — the M08 derive verbs: `thea2 derive` (the flywheel spin, real
// model, dev/scheduled only) and `thea2 corpus:check` (hermetic — no model, no
// network, no config; this is what CI runs). Prod never auto-mutates the
// corpus (ADR-007): only `derive` writes, and only when a human runs it.
//
// Path law: canon lives at process.cwd()/corpus (compose.ts anchors it there —
// identity is not state) and the derived population at corpus/derived.

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { asError } from '../kernel/index.js';
import { createZaiClient, makeRouter, type ModelClient } from '../model/index.js';
import { readRoutingTable } from '../siblings/index.js';
import { makeHashEmbedder } from '../embed/index.js';
import { openCorpusIndex, type OpenedCorpus } from '../corpus/corpus-index.js';
import { createToolRegistry } from '../loop/index.js';
import {
  corpusCheck,
  derive,
  dirtySet,
  emptyManifest,
  JUDGE_PASS_THRESHOLD,
  JUDGE_VERSION,
  loadManifest,
  manifestPath,
  MAX_DERIVED_PER_CANON,
  MOOD_BUCKETS,
  renderCheckReport,
  V1_GENERATORS,
  type CheckReport,
  type DeriveInputs,
  type Generator,
  type Manifest,
} from '../derive/index.js';
import { loadConfig, type Thea2Config } from './config.js';
import { compose, type System } from './compose.js';
import { makeEmbedder } from './embedder.js';
import type { CliIo } from './cli.js';

// ---------------------------------------------------------------------------
// corpus:check — hermetic CI gate
// ---------------------------------------------------------------------------

/**
 * The check never composes: no model, no network, no config, no env. The canon
 * index is opened vector-free (the hash embedder is the deterministic local
 * one, and nothing is cached) because the check reads only parsed canon, never
 * embeddings.
 */
export const corpusCheckVerb = async (io: CliIo): Promise<number> => {
  const canonDir = path.resolve(process.cwd(), 'corpus', 'canon');
  const derivedDir = path.resolve(canonDir, '..', 'derived');

  // A derive run always writes manifest.json, even over an empty dirty set —
  // so a missing manifest means the flywheel has never been spun. That is a
  // FAIL, not an empty pass.
  if (!fs.existsSync(manifestPath(derivedDir))) {
    io.err(
      `corpus:check: no derived corpus at ${derivedDir} — the flywheel has never been spun; ` +
        'run `thea2 derive` (with a real model) to spin it',
    );
    return 1;
  }

  let manifest: Manifest;
  try {
    manifest = loadManifest(await fsp.readFile(manifestPath(derivedDir), 'utf8'));
  } catch (e) {
    const err = asError(e);
    io.err(`corpus:check: ${err.code}: ${err.message}`);
    return 1;
  }

  let corpus;
  try {
    corpus = await openCorpusIndex({ canon: canonDir }, { embedder: makeHashEmbedder() });
  } catch (e) {
    const err = asError(e);
    io.err(`corpus:check: ${err.code}: ${err.message}`);
    return 1;
  }
  // A quarantined canon file is silently OUT of the expected-target set — every
  // entry it sourced would read as an orphan with no reason given. Name it here.
  for (const q of corpus.quarantined()) {
    io.err(`corpus:check: WARNING canon file quarantined (excluded from the expected set): ${q.path}: ${q.message}`);
  }

  const files = await readDerivedFiles(derivedDir);
  const report = corpusCheck({ inputs: checkInputs(corpus), manifest, generators: V1_GENERATORS, files });
  io.out(renderCheckReport(report));
  if (!report.ok) {
    io.err(`corpus:check: ${problemCount(report)} problem(s)`);
    return 1;
  }
  return 0;
};

/** One derived file per manifest id: the file name is the id minus its `sha256:` prefix. */
const readDerivedFiles = async (derivedDir: string): Promise<Map<string, string>> => {
  const files = new Map<string, string>();
  for (const entry of await fsp.readdir(derivedDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const raw = await fsp.readFile(path.join(derivedDir, entry.name), 'utf8');
    // LF-normalized like every corpus loader (M07 listPopulationFiles) — the
    // content hash is over the text, never over checkout line endings.
    files.set(`sha256:${entry.name.replace(/\.md$/, '')}`, raw.replace(/\r\n/g, '\n'));
  }
  return files;
};

const checkInputs = (corpus: OpenedCorpus): DeriveInputs => ({
  canon: corpus.bySource('canon'),
  // M13's v1 registry registers no I/O tools yet (absent capability, rule 5);
  // when tools land, the procedural generator picks them up here.
  toolDefs: createToolRegistry().defs('user-turn'),
  gravityCap: MAX_DERIVED_PER_CANON,
  moodBuckets: MOOD_BUCKETS,
});

/** How many problem lines renderCheckReport printed — violations, orphans, dirty rows, cap breaches. */
const problemCount = (report: CheckReport): number =>
  report.violations.length +
  report.orphans.length +
  report.dirty.length +
  report.caps.scenesOver.length +
  (report.caps.derivedCount > report.caps.maxDerived ? 1 : 0);

// ---------------------------------------------------------------------------
// derive — the flywheel spin (real model, dev/scheduled)
// ---------------------------------------------------------------------------

export interface DeriveVerbOpts {
  /**
   * Hermetic escape for tests, mirroring ComposeOpts.model: the injected client
   * is passed INTO the composition, so the (idle) pipeline and the derive run
   * share one model. Absent, the prod client is built below.
   */
  model?: ModelClient | undefined;
}

export const deriveVerb = async (
  configPath: string,
  env: Record<string, string | undefined>,
  io: CliIo,
  opts: DeriveVerbOpts = {},
): Promise<number> => {
  const cfg = loadConfig(configPath, env);
  const sys = await compose(cfg, 'prod', opts.model !== undefined ? { model: opts.model } : {});
  try {
    const model = opts.model ?? (await prodModel(cfg, sys));
    const inputs = await runInputs(sys);
    const embedderId = makeEmbedder(cfg.embedder, {
      baseUrl: cfg.models.endpoint,
      apiKey: cfg.models.apiKey,
    }).id;
    const outDir = path.resolve(sys.paths.canon, '..', 'derived');
    fs.mkdirSync(outDir, { recursive: true });

    const total = dirtySet(inputs, await readManifest(outDir, embedderId), V1_GENERATORS).length;
    io.err(`derive: ${inputs.canon.length} canon exemplars, cap ${MAX_DERIVED_PER_CANON}:1 — ${total} target(s) to generate`);

    const report = await derive({
      inputs,
      generators: withProgress(V1_GENERATORS, total, io),
      model,
      modelId: cfg.models.tiers.main, // generation rides the main tier (taskClass 'derive')
      judgeModel: model, // the judge is the same client at tier 'reasoning' (taskClass 'judge')
      judge: { version: JUDGE_VERSION, threshold: JUDGE_PASS_THRESHOLD },
      embedderId,
      rng: sys.rng.fork('derive'),
      events: sys.events,
      clock: sys.clock,
      outDir,
    });

    for (const f of report.failures) {
      io.err(`derive: FAILED ${f.generator} attempt ${f.attempt} at ${f.stage} (${f.code}): ${f.message}`);
    }
    for (const o of report.orphans) io.err(`derive: orphan GC'd ${o.id} (${o.generator}@${o.generatorVersion})`);
    if (report.embedderMismatch !== undefined) {
      io.err(
        `derive: manifest pinned embedder ${report.embedderMismatch.manifest}, active is ${report.embedderMismatch.active} — ` +
          'the whole corpus is dirty by the re-embed contract',
      );
    }
    io.out(
      `derive: ${report.written}/${report.targets} written, ${report.judgeFailed} judge-failed, ` +
        `${report.parseFailed} parse-failed, ${report.orphans.length} orphaned, ${report.droppedByCap} dropped by cap` +
        ` — ${report.entries.length} entries in ${outDir}`,
    );
    return report.ok ? 0 : 1;
  } finally {
    await sys.stop();
  }
};

/**
 * The prod model client, built the way compose builds its own (same cfg, same
 * routing table, same jitter stream) because System does not expose the model
 * it wired — and derive talks to it directly. compose's own client idles: no
 * turn runs inside a derive invocation.
 */
const prodModel = async (cfg: Thea2Config, sys: System): Promise<ModelClient> => {
  const tiers = {
    main: cfg.models.tiers.main,
    cheap: cfg.models.tiers.cheap,
    reasoning: cfg.models.tiers.reasoning ?? cfg.models.tiers.main,
  };
  const routing = await readRoutingTable(path.resolve(sys.paths.base, 'var', 'routing.json'));
  return createZaiClient({
    apiKey: cfg.models.apiKey,
    endpoint: cfg.models.endpoint,
    log: sys.events,
    router: makeRouter({ log: sys.events, ...(routing.length > 0 ? { routing } : {}), tiers }),
    clock: sys.clock,
    rng: sys.rng.fork('model'),
  });
};

/** The run's canon comes from the composed index — canon population only, never derived or lived. */
const runInputs = async (sys: System): Promise<DeriveInputs> => ({
  canon: sys.corpus.bySource('canon'),
  toolDefs: createToolRegistry().defs('user-turn'), // M13's v1 registry: no I/O tools yet
  gravityCap: MAX_DERIVED_PER_CANON,
  moodBuckets: MOOD_BUCKETS,
});

/** The manifest as run.ts will find it: absent file is a first-ever run, a malformed one is fatal. */
const readManifest = async (outDir: string, embedderId: string): Promise<Manifest> => {
  try {
    return loadManifest(await fsp.readFile(manifestPath(outDir), 'utf8'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return emptyManifest(embedderId);
    throw e;
  }
};

/**
 * Wraps each generator so every generation announces itself on stderr — a
 * 100+ target run must not be silent. Name, version and targets are forwarded
 * untouched, so deriveKeys, caps and the run event are byte-identical to the
 * real set.
 */
const withProgress = (generators: readonly Generator[], total: number, io: CliIo): readonly Generator[] => {
  let done = 0;
  return generators.map((g) => ({
    name: g.name,
    version: g.version,
    targets: (inputs: DeriveInputs) => g.targets(inputs),
    generate: async (t, deps) => {
      done += 1;
      const sources = t.inputs.canonIds.map((c) => c.id);
      const label = t.bucket !== undefined ? [t.bucket, ...sources] : sources;
      io.err(`derive: [${done}/${total}] ${g.name} ${label.join(' ← ')}`);
      return g.generate(t, deps);
    },
  }));
};

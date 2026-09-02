// scratch/nightingale-live.ts — the S8 gate closer: one full LIVE Nightingale
// run (real model, everything else fake) that establishes probes/baseline.json.
// The probe-harness law holds: never live stores (var/ redirected to a tmp
// dir), never Telegram (FakeChannel). SystemClock, not TestClock — the harness
// preset defaults to TestClock(0), whose frozen time silently drains the event
// loop mid-turn. Life jobs are suppressed (jobs: []) so the probe suite runs
// alone: this measures HER, not a concurrent ponder. The model client is built
// here and injected into compose, so the pipeline and the judge share one
// client (System deliberately does not expose the model).
//
// k INDEPENDENCE: each k-run gets a FRESHLY COMPOSED system (its own tmp var,
// its own FakeChannel, empty episodes/ledger). The runner calls the target
// selector once per run, so a selector that pops a pre-built system per call
// gives true independence — without it, run 2 inherits run 1's channel history
// and memory (bubble counts 5→10→15; by run 3 she had noticed the replays:
// "you've now told me that twice"). Runner contract: one ProbeResult carries
// k runs, so the fresh systems are composed up front, k × live probes.
//
// Usage: npx tsx scratch/nightingale-live.ts [--k 3] [--dry]
// Env:   THEA2_MODEL_API_KEY + THEA2_BOT_TOKEN (config refuses without them).

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeRng, SystemClock } from '../src/kernel/index.js';
import { createZaiClient, makeRouter } from '../src/model/index.js';
import type { ModelClient } from '../src/model/index.js';
import { makeEmbedder } from '../src/app/embedder.js';
import { loadConfig } from '../src/app/config.js';
import { compose, type System } from '../src/app/compose.js';
import { loadProbeFixtures, loadProbeSuite, PROBE_CHAT_ID } from '../src/probes/index.js';
import { openProbeRunner, writeBaseline } from '../src/probes/index.js';
import type { ProbeTarget } from '../src/probes/index.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const k = Number(args[args.indexOf('--k') + 1] ?? '') || 3;
const dry = args.includes('--dry');

const cfg = loadConfig(path.join(repo, 'thea2.config.yaml'), process.env);
// Scripted inbound is stamped PROBE_CHAT_ID (runner.ts), and the real pipeline
// chat_denies anything outside bridge.allowedChatIds — the 0-bubble mystery: the
// live suite fed a wall. Hermetic tests never saw this (fake targets bypass the
// allowlist). Admit the probe chat, and nothing else, for this run.
cfg.bridge.allowedChatIds = [PROBE_CHAT_ID];
const clock = new SystemClock();
const rng = makeRng('nightingale-live');

// The shared real client — main tier for turns, reasoning tier (main model)
// for the judge, exactly as prod composes them.
const model: ModelClient = createZaiClient({
  apiKey: cfg.models.apiKey,
  endpoint: cfg.models.endpoint,
  protocol: cfg.models.protocol,
  router: makeRouter({
    tiers: {
      main: cfg.models.tiers.main,
      cheap: cfg.models.tiers.cheap,
      reasoning: cfg.models.tiers.reasoning ?? cfg.models.tiers.main,
    },
  }),
  clock,
  rng: rng.fork('model'),
});

interface RunSystem {
  sys: System;
  varDir: string;
}

const spawnRunSystem = async (label: string): Promise<RunSystem> => {
  const varDir = fs.mkdtempSync(path.join(os.tmpdir(), 'thea2-nightingale-'));
  const sys = await compose(cfg, 'probe-harness', {
    clock,
    varDir,
    rng: rng.fork(label),
    model,
    jobs: [],
  });
  return { sys, varDir };
};

const pool: RunSystem[] = [];
const scrap: RunSystem[] = [];

try {
  const suite = loadProbeSuite(path.join(repo, 'probes'));
  for (const e of suite.errors) console.error(`suite rot: ${e.file}: ${e.code} ${e.message}`);
  const live = dry ? suite.probes : suite.probes.filter((p) => !p.hermetic);
  console.log(`nightingale: ${live.length} probe(s), k=${k}${dry ? ' (dry — zero model spend)' : ' (LIVE model)'}`);
  for (const p of live) console.log(`  - ${p.id} [${p.dimension}]`);

  const embedder = makeEmbedder(cfg.embedder, {
    baseUrl: cfg.models.endpoint,
    apiKey: cfg.models.apiKey,
  });

  // The runner invokes the selector once per EXECUTED RUN (executeRun), so the
  // pool needs k systems per scripted live probe. heartbeat/ponder-entry probes
  // need no feed but still consume one target per run — same count.
  const needed = dry ? 0 : k * live.length;
  for (let i = 0; i < needed; i++) pool.push(await spawnRunSystem(`run-${i}`));
  const base = dry ? await spawnRunSystem('dry') : undefined;
  if (base !== undefined) pool.push(base);

  const nextTarget = (): ProbeTarget => {
    const rs = pool.shift();
    if (rs === undefined) throw new Error('nightingale: target pool exhausted — selector called more than k×probes');
    scrap.push(rs);
    return rs.sys.probeTarget();
  };

  const first = pool.length > 0 ? pool[0]! : undefined;
  const runner = openProbeRunner({
    target: dry && base !== undefined ? base.sys.probeTarget() : nextTarget,
    corpus: (first?.sys ?? base?.sys)?.corpus,
    embedder,
    clock,
    rng: rng.fork('probes'),
    events: (first?.sys ?? base?.sys)?.events,
    ...(dry ? {} : { model }),
    suite: live,
    fixtures: loadProbeFixtures(path.join(repo, 'probes', 'fixtures')),
    readCanonFile: (p) => {
      try {
        return fs.readFileSync(path.join(repo, 'corpus', p), 'utf8');
      } catch {
        return undefined;
      }
    },
  });

  const t0 = Date.now();
  const suiteResult = await runner.runAll({ k, ...(dry ? { dry: true } : {}) });
  const secs = Math.round((Date.now() - t0) / 1000);
  console.log(`nightingale: ${suiteResult.results.length} result(s), ${suiteResult.modelCalls} model call(s), ${secs}s`);

  for (const r of suiteResult.results) {
    const detFails = r.deterministic.results.filter((c) => !c.pass).flatMap((c) => c.details);
    const det = r.deterministic.pass ? 'det OK' : `det FAIL [${detFails.join('; ') || 'unspecified'}]`;
    const judge = r.judgeMedian === null ? ' judge —' : ` judge med ${r.judgeMedian.toFixed(2)} (var ${r.judgeVariance.toFixed(3)})`;
    const drifts = Object.entries(r.drift).map(([d, c]) => `${d} ${c.toFixed(3)}`).join(', ');
    console.log(`  ${r.probeId}: ${det}${judge} drift ${drifts || '—'} (k=${r.runs.length})`);
    for (const run of r.runs) {
      for (const b of run.outbound) console.log(`    | ${b.slice(0, 110)}`);
    }
  }

  if (!dry) {
    const baselinePath = path.join(repo, 'probes', 'baseline.json');
    const baseline = await writeBaseline(baselinePath, suiteResult.results, { stage: 'S8' });
    console.log(`nightingale: baseline v${baseline.version} written → ${path.relative(repo, baselinePath)}`);
  } else {
    console.log('nightingale: dry run — no baseline written');
  }
} finally {
  for (const rs of [...pool, ...scrap]) {
    await rs.sys.stop();
    fs.rmSync(rs.varDir, { recursive: true, force: true });
  }
}

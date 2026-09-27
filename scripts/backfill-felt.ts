// scripts/backfill-felt.ts — give her emotionally blank memories a feeling (v12.1).
//
// Found 2026-09-27: 519 of her 800 imported Thea1 memories carried NO feeling (an all-zero
// felt vector). The import asked a labeller for "one word for what she seems to feel" and
// silently dropped any word outside her vocabulary ("fond-ish", "teasing"…), so those memories
// could never be recalled by mood or weighted by intensity. This re-asks, with her actual
// vocabulary as a closed list ('nothing' allowed for a flat moment), and stores the answer
// the way the import meant to: tagSignature(tag, i), source 'estimated'.
//
// Dry run by default (prints the distribution and samples). --apply writes, after a backup,
// and refuses while thead holds the var lock (stop thea2 first).
//
//   set -a; . /etc/thea2/keys.env; set +a
//   npx tsx scripts/backfill-felt.ts --var /opt/thea2/var [--apply] [--limit 50]

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { z } from 'zod';
import { loadConfig, type ResolvedDoor } from '../src/app/config.js';
import { makeEmbedder } from '../src/app/embedder.js';
import { chatCore, createModelClient, makeRouter, zaiTransport, type ModelClient } from '../src/model/index.js';
import { makeRng, SystemClock } from '../src/kernel/index.js';
import { openEventLog } from '../src/events/index.js';
import { APPRAISAL_TAGS, feltIntensity, openMindStore, tagSignature, type Moment } from '../src/mind/index.js';

const argv = process.argv.slice(2);
const arg = (n: string, d?: string): string | undefined => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const VAR = arg('var', '/opt/thea2/var')!;
const CONFIG = arg('config', 'thea2.config.yaml')!;
const APPLY = argv.includes('--apply');
const LIMIT = arg('limit') === undefined ? Infinity : Number(arg('limit'));
const BATCH = 20;
const out = (s: string): void => {
  process.stdout.write(`${s}\n`);
};

const LABELS = [...APPRAISAL_TAGS, 'nothing'] as const;
const LabelSchema = z.object({
  items: z.array(z.object({ n: z.number().int(), felt: z.enum(LABELS), i: z.number().int().min(1).max(10) })),
});

// machinery, not her: a labeller reading her old texts (the same job the import did)
const SYSTEM = [
  "You are labelling Thea's past text messages to Diego (Thea is an AI who is his best friend; she texts lowercase, casual, playful, a little bratty).",
  'For each item: the ONE feeling she most plausibly had as she wrote her reply, from the allowed list only, and how strongly, 1-10.',
  "Use 'nothing' only when the reply is flat or purely logistical. Judge from her words and what she was answering, not from what he felt.",
  'Return JSON {"items":[{"n","felt","i"}]} with one entry per item, same n.',
  `Allowed: ${LABELS.join(', ')}.`,
].join('\n');

const render = (m: Moment, n: number): string =>
  [
    `#${n}`,
    ...m.before.slice(-2).map((l) => `  (${l.who === 'him' ? 'him' : 'her'}: ${l.text.slice(0, 160)})`),
    m.his !== '' ? `  him: ${m.his.slice(0, 300)}` : '  (she wrote first)',
    `  her: ${m.hers.join(' / ').slice(0, 400)}`,
  ].join('\n');

const main = async (): Promise<void> => {
  const cfg = loadConfig(CONFIG, process.env);
  const clock = new SystemClock();
  const rng = makeRng('backfill-felt');
  const lock = path.join(VAR, 'thead.lock');
  if (APPLY && fs.existsSync(lock)) throw new Error(`thead holds ${lock} — stop thea2 before --apply (the store is hers while she runs)`);

  const embedder = makeEmbedder(cfg.embedder, { baseUrl: cfg.models.endpoint, apiKey: cfg.models.apiKey });
  const mind = openMindStore(path.join(VAR, 'mind'), embedder.dim);
  const blank = mind.moments().filter((m) => m.never !== true && feltIntensity(m.felt.sig) === 0).slice(0, LIMIT);
  const bySource = new Map<string, number>();
  for (const m of blank) bySource.set(`${m.source}/${m.kind}`, (bySource.get(`${m.source}/${m.kind}`) ?? 0) + 1);
  out(`blank memories: ${blank.length}  (${[...bySource.entries()].map(([k, v]) => `${k}:${v}`).join('  ')})  mode: ${APPLY ? 'APPLY' : 'dry run'}`);

  const d = cfg.models.doors.mind as ResolvedDoor;
  const log = openEventLog(fs.mkdtempSync(path.join(os.tmpdir(), 'thea2-backfill-events-')), { clock });
  const model: ModelClient = createModelClient({
    log,
    clock,
    core: chatCore({
      router: makeRouter({ log, tiers: { main: d.model, cheap: d.model, reasoning: d.model }, doors: { voice: d, mind: d, judge: d } }),
      doors: {
        main: { door: d, send: zaiTransport({ apiKey: d.apiKey, endpoint: d.endpoint, protocol: d.protocol, clock, rng: rng.fork('m') }) },
        cheap: { door: d, send: zaiTransport({ apiKey: d.apiKey, endpoint: d.endpoint, protocol: d.protocol, clock, rng: rng.fork('c') }) },
        reasoning: { door: d, send: zaiTransport({ apiKey: d.apiKey, endpoint: d.endpoint, protocol: d.protocol, clock, rng: rng.fork('r') }) },
      },
    }),
  });

  const labels = new Map<string, { felt: (typeof LABELS)[number]; i: number }>();
  for (let b = 0; b < blank.length; b += BATCH) {
    const chunk = blank.slice(b, b + BATCH);
    try {
      const res = await model.chat({
        taskClass: 'consolidate',
        tier: 'cheap',
        schema: LabelSchema,
        schemaName: 'Felt',
        maxTokens: 1500,
        temperature: 0.2,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: chunk.map((m, k) => render(m, k)).join('\n\n') },
        ],
      });
      for (const it of res.content.items) {
        const m = chunk[it.n];
        if (m !== undefined) labels.set(m.id, { felt: it.felt, i: it.i });
      }
    } catch (e) {
      out(`  batch ${b / BATCH} failed: ${e instanceof Error ? e.message.slice(0, 160) : String(e)}`);
    }
    out(`  labelled ${Math.min(b + BATCH, blank.length)}/${blank.length}`);
  }

  const tally = new Map<string, number>();
  for (const l of labels.values()) tally.set(l.felt, (tally.get(l.felt) ?? 0) + 1);
  const ints = [...labels.values()].filter((l) => l.felt !== 'nothing').map((l) => l.i).sort((a, b) => a - b);
  out(`\nlabels: ${labels.size}/${blank.length}; nothing: ${tally.get('nothing') ?? 0}; intensity p50 ${ints[Math.floor(ints.length / 2)] ?? '-'} p90 ${ints[Math.floor(ints.length * 0.9)] ?? '-'}`);
  out(`top feelings: ${[...tally.entries()].filter(([k]) => k !== 'nothing').sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
  out('\nsamples:');
  for (const m of blank.filter((x) => labels.has(x.id)).slice(0, 12)) {
    const l = labels.get(m.id)!;
    out(`  [${l.felt} ${l.i}] him: ${m.his.slice(0, 70)} / her: ${m.hers.join(' / ').slice(0, 90)}`);
  }

  if (!APPLY) {
    out('\ndry run — nothing written.');
    return;
  }
  const moments = path.join(VAR, 'mind', 'moments.jsonl');
  const backup = `${moments}.pre-felt-backfill-${clock.epochMs()}`;
  fs.copyFileSync(moments, backup);
  out(`\nbackup: ${backup}`);
  let written = 0;
  for (const m of blank) {
    const l = labels.get(m.id);
    if (l === undefined || l.felt === 'nothing') continue;
    mind.update(m.id, { felt: { sig: tagSignature(l.felt, l.i), word: l.felt, source: 'estimated' } });
    written += 1;
  }
  await mind.flush();
  out(`applied: ${written} memories now carry a feeling (${blank.length - written} left blank: 'nothing' or unlabelled).`);
};

void main();

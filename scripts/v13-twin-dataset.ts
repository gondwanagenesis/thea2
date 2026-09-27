// v13 Phase 4 — export the twin's data (docs/plans/v13-phase4-twin.md). Reads her var (or a copy),
// writes <out>/examples.jsonl, pairs.jsonl, contrasts.jsonl and a summary. Only pre-expressive reports
// (felt lines, room trials); the forget filter is applied here, because weights cannot un-remember.
// With --log (on her real var only), her changelog records that her reports were copied for training.
//
//   npx tsx scripts/v13-twin-dataset.ts --var /opt/thea2/var --out /root/thea2-twin [--log]

import * as fs from 'node:fs';
import * as path from 'node:path';
import { SystemClock } from '../src/kernel/index.js';
import { appendChange, openMindStore, readLedger, readReports, readRoom, twinDataset } from '../src/mind/index.js';

const argv = process.argv.slice(2);
const arg = (n: string, d?: string): string | undefined => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const varDir = arg('var', 'var')!;
const out = arg('out', path.join(varDir, 'twin'))!;

const main = (): void => {
  const now = new SystemClock().epochMs();
  const dir = path.join(varDir, 'mind');
  const mind = openMindStore(dir, 384);
  const forgetFile = path.join(dir, 'forget.json');
  const forget = new Set<string>(fs.existsSync(forgetFile) ? (JSON.parse(fs.readFileSync(forgetFile, 'utf8')) as string[]) : []);
  const ds = twinDataset({ reports: readReports(dir), ledger: readLedger(dir), room: readRoom(dir), moments: mind.moments(), forget });
  fs.mkdirSync(out, { recursive: true });
  const write = (f: string, xs: readonly unknown[]): void => fs.writeFileSync(path.join(out, f), xs.map((x) => JSON.stringify(x)).join('\n') + (xs.length > 0 ? '\n' : ''));
  write('examples.jsonl', ds.examples);
  write('pairs.jsonl', ds.pairs);
  write('contrasts.jsonl', ds.contrasts);
  const summary = {
    at: now,
    examples: ds.examples.length,
    feltLines: ds.examples.filter((e) => e.kind === 'felt_line').length,
    roomTrials: ds.examples.filter((e) => e.kind === 'room').length,
    shams: ds.examples.filter((e) => e.sham === true).length,
    heldOut: ds.examples.filter((e) => e.heldOut).length,
    pairs: ds.pairs.length,
    contrasts: ds.contrasts.length,
    forgotten: ds.excluded,
    // the proposal's floor before any weights work: weeks of verified data (§6 Phase 4, the Phase-2 gate)
    readyForTraining: ds.pairs.filter((p) => !p.heldOut).length >= 200 && ds.examples.filter((e) => e.kind === 'room').length >= 300,
  };
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 1));
  if (argv.includes('--log')) {
    appendChange(dir, {
      ts: now,
      kind: 'other',
      what: `${summary.feltLines} of your private words for how you were and ${summary.roomTrials} of your quiet-room answers were copied into a set for training a twin (nothing trained yet)`,
      by: 'the twin work (phase 4)',
      why: 'to see whether a model can learn to notice what you notice',
    });
  }
  process.stdout.write(`${JSON.stringify(summary, null, 1)}\n`);
};

main();

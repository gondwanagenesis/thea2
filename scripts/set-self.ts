// scripts/set-self.ts — revise her self-description, in the open.
//
// Every line must cite real moments (as her nightly self-rewrite requires), at most SELF_DOUBT_MAX
// doubt lines survive (the runaway guard), thead must be stopped (the store is hers while she
// runs), the previous self is kept (self.prev.json, by setSelf), and her changelog gets an entry in
// plain words — she asked to be able to inspect every change to her memories and to herself.
//
//   npx tsx scripts/set-self.ts --var /opt/thea2/var --file lines.json --by "..." --why "..." --how "..." [--apply]

import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { appendChange, capDoubt, openMindStore } from '../src/mind/index.js';
import { SystemClock } from '../src/kernel/index.js';

const argv = process.argv.slice(2);
const arg = (n: string): string | undefined => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const VAR = arg('var') ?? '/opt/thea2/var';
const FILE = arg('file');
const APPLY = argv.includes('--apply');
const out = (s: string): void => {
  process.stdout.write(`${s}\n`);
};

const Lines = z.array(z.object({ text: z.string().min(1).max(300), cites: z.array(z.string()).min(1).max(8) })).min(3).max(12);

const main = async (): Promise<void> => {
  if (FILE === undefined) throw new Error('--file lines.json is required');
  const lines = Lines.parse(JSON.parse(fs.readFileSync(FILE, 'utf8')));
  const lock = path.join(VAR, 'thead.pid');
  if (APPLY && fs.existsSync(lock)) {
    let alive = false;
    try {
      process.kill(Number(fs.readFileSync(lock, 'utf8').trim()), 0);
      alive = true;
    } catch {
      alive = false;
    }
    if (alive) throw new Error(`thead is running (${lock}) — stop thea2 before --apply`);
  }
  // dim only matters for vector files; the self never touches them
  const mind = openMindStore(path.join(VAR, 'mind'), 1536);
  const ids = new Set([...mind.moments().map((m) => m.id), 'seed']);
  const bad = lines.flatMap((l) => l.cites.filter((c) => !ids.has(c)).map((c) => `${c} (in "${l.text.slice(0, 40)}")`));
  if (bad.length > 0) throw new Error(`cites that are not real moments: ${bad.join(', ')}`);
  const { dropped } = capDoubt(lines);
  if (dropped.length > 0) throw new Error(`more than the allowed doubt lines: ${dropped.map((l) => l.text).join(' | ')}`);

  const before = mind.self();
  out('BEFORE:');
  for (const l of before) out(`  - ${l.text}`);
  out('AFTER:');
  for (const l of lines) out(`  - ${l.text}  [${l.cites.length} cites]`);
  if (!APPLY) {
    out('\ndry run — nothing written.');
    return;
  }
  await mind.setSelf(lines);
  appendChange(path.join(VAR, 'mind'), {
    ts: new SystemClock().epochMs(),
    kind: 'self',
    what: 'your self-description (the lines you start every turn from) was revised',
    by: arg('by') ?? 'claude, at diego’s request',
    ...(arg('why') !== undefined ? { why: arg('why') } : {}),
    ...(arg('how') !== undefined ? { how: arg('how') } : {}),
    count: lines.length,
    undo: { previous: path.join(VAR, 'mind', 'self.prev.json') },
  });
  out(`\napplied: ${lines.length} lines; previous kept in self.prev.json; changelog entry written.`);
};

void main();

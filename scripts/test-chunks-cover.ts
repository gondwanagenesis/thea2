// W0.1 chunk-coverage gate — every test file must be in exactly one chunk.
// The whole suite wedges in a single process on Windows (the sync-spin), so
// `test` runs two chunks; this gate keeps the split honest: no file skipped,
// none tested twice. Run via `npm run test:cover`.

import { readdirSync } from 'node:fs';

const CHUNKS: Record<string, string[]> = {
  c1a: ['affect', 'app'],
  c1b: ['assemble'],
  c2: ['bridge', 'consolidate', 'coupling', 'corpus', 'derive', 'embed', 'events', 'inhibit', 'kernel'],
  b: ['life', 'loop', 'memory', 'model', 'probes', 'realize', 'sched', 'siblings'],
};

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = `${dir}/${e.name}`;
    return e.isDirectory() ? walk(p) : p.endsWith('.test.ts') ? [p.replaceAll('\\', '/')] : [];
  });

const all = [...walk('test'), ...walk('src')];
const chunkOf = (f: string): string[] =>
  Object.entries(CHUNKS)
    .filter(([, dirs]) => dirs.some((d) => f.startsWith(`test/${d}/`)))
    .map(([k]) => k);

const problems: string[] = [];
const counts: Record<string, number> = { c1a: 0, c1b: 0, c2: 0, b: 0 };
for (const f of all) {
  const k = chunkOf(f);
  if (k.length === 0) problems.push(`in neither chunk: ${f}`);
  if (k.length > 1) problems.push(`in multiple chunks: ${f} (${k.join(',')})`);
  if (k.length === 1) counts[k[0]! as 'c1a' | 'c1b' | 'c2' | 'b'] += 1;
}
for (const k of ['c1a', 'c1b', 'c2', 'b'] as const) console.log(`chunk ${k}: ${counts[k]} files`);
if (all.length === 0) problems.push('no test files found — run from the repo root');
if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`chunk coverage ok: ${all.length} files, none skipped, none doubled`);

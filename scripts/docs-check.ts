/**
 * docs-check — the generated-numbers gate (P-DOCS DC.2, plan v6/v7).
 *
 * Computes the repo's load-bearing facts from STABLE artifacts only — file
 * trees, `.dependency-cruiser.cjs`, `thea2.config.yaml`, `docs/decisions/*`
 * frontmatter, and narrow regex parses of `src/app/compose.ts`,
 * `src/loop/turn.ts` and the cadence-constant files. It never imports `src/`,
 * never boots the app, and never runs the test suite, so transient breakage in
 * in-flight `src/` work cannot red a docs gate.
 *
 * Method notes (stated per the package spec):
 * - Scheduler jobs are parsed from `src/app/compose.ts` (the `jobs = [...]`
 *   table), NOT from a hermetic boot: booting compose in a script would import
 *   all of src/ and couple this gate to every in-flight edit. The spec allows
 *   exactly this fallback.
 * - Test counts are a STATIC count of `it(`/`test(` declarations across the
 *   vitest include set (`test` and `src` trees, files ending `.test.ts`). It
 *   is an approximation of `npx vitest list` (which loads and executes test
 *   module graphs and therefore can fail on transient src/ breakage). Pass
 *   `--vitest` to print the command for the exact number when the tree is
 *   known-green.
 * - Every doc number lives inside a `<!-- gen:KEY:start -->` …
 *   `<!-- gen:KEY:end -->` block. The gate fails if any block's content
 *   differs from the computed value, or if a required block is missing.
 *   `tsx scripts/docs-check.ts --fix` rewrites stale blocks in place.
 *
 * Exit codes: 0 = every generated block agrees; 1 = any disagreement or
 * missing block; 2 = the repo's stable artifacts could not be read at all.
 */

import { readdirSync, readFileSync, statSync, writeFileSync, type Stats } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const MIN = 60_000;

export interface DoorRow {
  name: string;
  endpoint: string;
  protocol: string;
  model: string;
  effort: string;
  forcing: string;
}

export interface DocsFacts {
  testFiles: number;
  testDeclarations: number;
  canonScenes: number;
  derivedFiles: number;
  jobs: string[];
  jobCadences: Record<string, string>;
  modules: string[];
  dagEdges: number;
  doors: DoorRow[];
  ioToolsRegistered: number;
  spawnTools: string[];
  probes: string[];
  adrs: Array<{ id: string; status: string }>;
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

/** Recursively list files under `dir` whose name ends with `suffix`. */
const walk = (dir: string, suffix: string): string[] => {
  const out: string[] = [];
  const visit = (d: string): void => {
    let names: string[];
    try {
      names = readdirSync(d);
    } catch {
      return;
    }
    for (const name of names) {
      const p = join(d, name);
      let st: Stats;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) visit(p);
      else if (st.isFile() && name.endsWith(suffix)) out.push(p);
    }
  };
  visit(dir);
  return out;
};

/** First regex capture in `text`, or `fallback`. Never guesses. */
const firstMatch = (text: string, re: RegExp, fallback: string): string => {
  const m = text.match(re);
  return m?.[1] ?? fallback;
};

/** Evaluate the tiny expression grammar the cadence constants use (`5 * MIN`). */
const evalMsExpr = (expr: string): number | undefined => {
  const t = expr.trim().replace(/,$/, '');
  if (/^\d+$/.test(t)) return Number(t);
  const m = t.match(/^(\d+)\s*\*\s*(SECS?|MIN|HOURS?)$/i);
  if (m === null) return undefined;
  const n = Number(m[1]);
  const unit = (m[2] ?? '').toUpperCase();
  if (unit.startsWith('SEC')) return n * 1_000;
  if (unit === 'MIN') return n * MIN;
  return n * 3_600_000;
};

const read = (root: string, rel: string): string | null => {
  try {
    return readFileSync(join(root, rel), 'utf8');
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------------------
// fact computation
// ---------------------------------------------------------------------------

const countTestDeclarations = (files: string[], root: string): number => {
  // `it(`/`test(` with optional vitest modifiers (`.each`, `.skip`, …), in
  // both call and template-tag form. Lookbehind rejects `regex.test(...)` and
  // any identifier ending in `it`/`test`. Static approximation — see header.
  const re = /(?<![.\w$])(?:it|test)(?:\.\w+)*\s*[(`]/g;
  let n = 0;
  for (const f of files) {
    const text = read(root, f);
    if (text === null) continue;
    n += [...text.matchAll(re)].length;
  }
  return n;
};

const parseCadence = (
  text: string | null,
  decl: RegExp,
  format: (ms: number) => string,
): string => {
  if (text === null) return 'unparsed';
  const m = text.match(decl);
  if (m === null) return 'unparsed';
  const ms = evalMsExpr(m[1] ?? '');
  return ms === undefined ? 'unparsed' : format(ms);
};

const asMinutes = (ms: number): string => `${ms / MIN} min`;
const asDailyUtc = (minute: number): string =>
  `daily ${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')} UTC`;

const parseDailyMinute = (text: string | null, decl: RegExp): string => {
  if (text === null) return 'unparsed';
  const m = text.match(decl);
  if (m === null) return 'unparsed';
  const n = Number(m[1] ?? NaN);
  return Number.isFinite(n) ? asDailyUtc(n) : 'unparsed';
};

const parseDoors = (root: string): DoorRow[] => {
  const raw = read(root, 'thea2.config.yaml');
  if (raw === null) return [];
  let cfg: unknown;
  try {
    cfg = yaml.load(raw);
  } catch {
    return [];
  }
  const models = (cfg as { models?: Record<string, unknown> } | undefined)?.['models'];
  const doors = models?.['doors'] as Record<string, Record<string, unknown>> | undefined;
  if (doors !== undefined) {
    return Object.entries(doors).map(([name, d]) => ({
      name,
      endpoint: String(d['endpoint'] ?? 'unparsed'),
      protocol: String(d['protocol'] ?? 'unparsed'),
      model: String(d['model'] ?? 'unparsed'),
      effort: d['effort'] === undefined ? '-' : String(d['effort']),
      forcing: String(d['forcing'] ?? 'unparsed'),
    }));
  }
  // Legacy shape: models.endpoint/protocol/tiers — synthesize the tier doors.
  const tiers = models?.['tiers'] as Record<string, { model?: string }> | undefined;
  if (models !== undefined && tiers !== undefined) {
    const endpoint = String(models['endpoint'] ?? 'unparsed');
    const protocol = String(models['protocol'] ?? 'unparsed');
    const tierDoor = (name: string): DoorRow => ({
      name,
      endpoint,
      protocol,
      model: String(tiers[name]?.model ?? 'unparsed'),
      effort: '-',
      forcing: 'tool_choice',
    });
    return [tierDoor('voice'), tierDoor('mind'), tierDoor('judge')];
  }
  return [];
};

const parseModuleGraph = (root: string): { modules: string[]; edges: number } => {
  const raw = read(root, '.dependency-cruiser.cjs');
  if (raw === null) return { modules: [], edges: 0 };
  const modules: string[] = [];
  let edges = 0;
  const entry = /"src\/([\w-]+)":\s*\[([^\]]*)\]/g;
  for (const m of raw.matchAll(entry)) {
    modules.push(m[1] ?? '');
    const deps = m[2]?.match(/"([\w-]+)"/g);
    edges += deps?.length ?? 0;
  }
  return { modules, edges };
};

const parseJobs = (root: string): { jobs: string[]; cadences: Record<string, string> } => {
  const compose = read(root, join('src', 'app', 'compose.ts'));
  const jobs: string[] =
    compose === null
      ? []
      : [...compose.matchAll(/jobs\s*=\s*\[([\s\S]*?)\];/g)].flatMap((m) =>
          [...(m[1] ?? '').matchAll(/(\w+)Job\s*\(/g)].map((j) =>
            (j[1] ?? '').replace(/Job$/, '').replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase(),
          ),
        );
  const cadences: Record<string, string> = {};
  // Numeric-expression-only matches: the interface declarations of the same
  // names (`heartbeatEveryMs: number;`) must not shadow the default values.
  const valueRe = (name: string): RegExp =>
    new RegExp(`${name}:\\s*(\\d+\\s*\\*\\s*(?:SECS?|MIN|HOURS?)|\\d+)`, 'i');
  const life = read(root, join('src', 'life', 'config.ts'));
  const maint = read(root, join('src', 'app', 'maintenance-jobs.ts'));
  const siblings = read(root, join('src', 'siblings', 'types.ts'));
  if (jobs.includes('heartbeat'))
    cadences['heartbeat'] = parseCadence(life, valueRe('heartbeatEveryMs'), asMinutes);
  if (jobs.includes('ponder'))
    cadences['ponder'] = parseCadence(life, valueRe('ponderEveryMs'), asMinutes);
  if (jobs.includes('reflect'))
    cadences['reflect'] = parseDailyMinute(life, valueRe('reflectUtcMinute'));
  if (jobs.includes('reconcile'))
    cadences['reconcile'] = parseCadence(maint, /RECONCILE_EVERY_MS\s*=\s*([^;\n]+)/, asMinutes);
  if (jobs.includes('affect-snapshot'))
    cadences['affect-snapshot'] = parseCadence(
      maint,
      /AFFECT_SNAPSHOT_EVERY_MS\s*=\s*([^;\n]+)/,
      asMinutes,
    );
  if (jobs.includes('ledger'))
    cadences['ledger'] = parseDailyMinute(siblings, /LEDGER_UTC_MINUTE\s*=\s*(\d+)/);
  return { jobs, cadences };
};

const parseSpawnTools = (root: string): string[] => {
  const turn = read(root, join('src', 'loop', 'turn.ts'));
  if (turn === null) return [];
  const tools: string[] = [];
  if (/'fork'\s*\|\s*'task'/.test(turn)) tools.push('fork', 'task');
  if (/defOf\(\s*'committee'/s.test(turn)) tools.push('committee');
  return tools;
};

const parseAdrs = (root: string): Array<{ id: string; status: string }> => {
  let names: string[] = [];
  try {
    names = readdirSync(join(root, 'docs', 'decisions')).filter((n) => /^ADR-.*\.md$/.test(n));
  } catch {
    return [];
  }
  return names
    .sort()
    .map((n) => {
      const text = read(root, join('docs', 'decisions', n)) ?? '';
      const status = firstMatch(text, /^status:\s*([A-Za-z][\w-]*)/m, 'unparsed');
      return { id: firstMatch(n, /^(ADR-[\w-]+?)\.md$/, n), status };
    });
};

export const computeFacts = (root: string): DocsFacts => {
  const testFiles = [
    ...walk(join(root, 'test'), '.test.ts'),
    ...walk(join(root, 'src'), '.test.ts'),
  ].map((p) => p.slice(root.length + 1).replace(/\\/g, '/'));
  const canonFiles = walk(join(root, 'corpus', 'canon'), '.md').filter(
    (p) => !p.endsWith('TEMPLATE.md') && p.replace(/\\/g, '/').split('/').pop() !== 'identity.md',
  );
  const { modules, edges } = parseModuleGraph(root);
  const { jobs, cadences } = parseJobs(root);
  const compose = read(root, join('src', 'app', 'compose.ts'));
  return {
    testFiles: testFiles.length,
    testDeclarations: countTestDeclarations(testFiles, root),
    canonScenes: canonFiles.length,
    derivedFiles: walk(join(root, 'corpus', 'derived'), '.md').length,
    jobs,
    jobCadences: cadences,
    modules,
    dagEdges: edges,
    doors: parseDoors(root),
    ioToolsRegistered: compose === null ? -1 : [...compose.matchAll(/\btools\.register\s*\(/g)].length,
    spawnTools: parseSpawnTools(root),
    probes: walk(join(root, 'probes'), '.probe.yaml').map((p) => p.split(/[\\/]/).pop() ?? p),
    adrs: parseAdrs(root),
  };
};

// ---------------------------------------------------------------------------
// generated blocks
// ---------------------------------------------------------------------------

export type GenKey = 'tests-count' | 'canon-scenes' | 'job-table' | 'doors';

export const REQUIRED_GEN_BLOCKS: Record<string, GenKey[]> = {
  'README.md': ['tests-count', 'doors'],
  'ARCHITECTURE.md': ['tests-count', 'canon-scenes', 'job-table', 'doors'],
};

const GENERATED_NOTE =
  'Computed from code by `scripts/docs-check.ts` — never edit by hand; regenerate with `npx tsx scripts/docs-check.ts --fix` or update the code';

export const renderFactBlock = (key: GenKey, f: DocsFacts): string => {
  switch (key) {
    case 'tests-count':
      return (
        `**${f.testDeclarations} test declarations in ${f.testFiles} test files** ` +
        `(static count of \`it()\`/\`test()\` across \`test/**/*.test.ts\`; ` +
        `\`npx vitest list\` gives the exact live number). ${GENERATED_NOTE}.`
      );
    case 'canon-scenes':
      return (
        `**${f.canonScenes} canon scene files** under \`corpus/canon/\` ` +
        `(every \`.md\` except \`TEMPLATE.md\` and \`identity.md\`), plus **${f.derivedFiles} derived exemplar files** in \`corpus/derived/\` ` +
        `(machine-generated; manifest-tracked per ADR-007). ${GENERATED_NOTE}.`
      );
    case 'job-table': {
      const rows = f.jobs.map((j) => `| ${j} | ${f.jobCadences[j] ?? 'unparsed'} |`);
      return [
        `**${f.jobs.length} jobs registered** on a real boot (parsed from \`src/app/compose.ts\`):`,
        '',
        '| Job | Cadence |',
        '|---|---|',
        ...rows,
        '',
        GENERATED_NOTE + '.',
      ].join('\n');
    }
    case 'doors': {
      const rows = f.doors.map(
        (d) => `| ${d.name} | ${d.model} | ${d.protocol} | ${d.endpoint} | ${d.effort} | ${d.forcing} |`,
      );
      return [
        `**${f.doors.length} doors configured** (parsed from \`thea2.config.yaml\`, ADR-010):`,
        '',
        '| Door | Model | Protocol | Endpoint | Effort | Forcing |',
        '|---|---|---|---|---|---|',
        ...rows,
        '',
        GENERATED_NOTE + '.',
      ].join('\n');
    }
  }
};

const blockPattern = (key: string): RegExp =>
  new RegExp(`<!--\\s*gen:${key}:start\\s*-->[\\s\\S]*?<!--\\s*gen:${key}:end\\s*-->`, 'g');

export interface GenFailure {
  doc: string;
  key: string;
  reason: string;
  expected?: string;
  found?: string;
}

/** Check one doc's text against the computed facts. Pure; no repo access. */
export const checkDoc = (
  doc: string,
  text: string,
  facts: DocsFacts,
  required: readonly GenKey[],
): { ok: boolean; failures: GenFailure[] } => {
  const failures: GenFailure[] = [];
  for (const key of required) {
    const blocks = [...text.matchAll(blockPattern(key))];
    if (blocks.length === 0) {
      failures.push({ doc, key, reason: 'missing required generated block' });
      continue;
    }
    const expected = renderFactBlock(key, facts);
    for (const b of blocks) {
      const found = b[0]
        .replace(/<!--\s*gen:[\w-]+:start\s*-->/, '')
        .replace(/<!--\s*gen:[\w-]+:end\s*-->/, '')
        .trim();
      if (found !== expected.trim()) {
        failures.push({
          doc,
          key,
          reason: 'stale generated block',
          expected: expected.trim(),
          found,
        });
      }
    }
  }
  return { ok: failures.length === 0, failures };
};

/** Replace (or append) every required block in `text` with the computed one. */
export const applyFix = (
  doc: string,
  text: string,
  facts: DocsFacts,
  required: readonly GenKey[],
): string => {
  let out = text;
  for (const key of required) {
    const rendered = `<!-- gen:${key}:start -->\n${renderFactBlock(key, facts)}\n<!-- gen:${key}:end -->`;
    if (blockPattern(key).test(out)) {
      out = out.replace(blockPattern(key), rendered);
    } else {
      out = `${out.replace(/\s*$/, '')}\n\n${rendered}\n`;
    }
  }
  return out;
};

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const printFacts = (f: DocsFacts): void => {
  const cadenceLine =
    Object.entries(f.jobCadences)
      .map(([j, c]) => `${j}=${c}`)
      .join(', ') || 'unparsed';
  const lines = [
    `tests            : ${f.testDeclarations} declarations in ${f.testFiles} files (static count; --vitest for exact)`,
    `canon scenes     : ${f.canonScenes} (+${f.derivedFiles} derived .md, manifest not parsed here)`,
    `scheduler jobs   : ${f.jobs.length} registered — ${f.jobs.join(', ') || 'none parsed'}`,
    `  cadences       : ${cadenceLine}`,
    `modules / edges  : ${f.modules.length} / ${f.dagEdges} (from .dependency-cruiser.cjs)`,
    `doors            : ${f.doors.map((d) => `${d.name}=${d.model}@${d.endpoint} (${d.protocol})`).join(' · ') || 'none parsed'}`,
    `tools            : ${f.ioToolsRegistered} I/O tools registered in compose; spawn primitives: ${f.spawnTools.join(', ') || 'none parsed'}`,
    `probes           : ${f.probes.length} — ${f.probes.join(', ') || 'none'}`,
    `ADRs             : ${f.adrs.length} — ${f.adrs.map((a) => `${a.id}:${a.status}`).join(', ')}`,
  ];
  for (const line of lines) console.log(line);
};

const main = (argv: readonly string[]): number => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  let facts: DocsFacts;
  try {
    facts = computeFacts(root);
  } catch (err) {
    console.error(`docs-check: could not read the repo's stable artifacts: ${String(err)}`);
    return 2;
  }
  printFacts(facts);

  if (argv.includes('--vitest')) {
    console.log('\n(--vitest) exact suite size: run `npx vitest list | grep -c \">\"`.');
    console.log('  the static count above is the hermetic proxy (see the script header).');
  }

  const failures: GenFailure[] = [];
  for (const [doc, required] of Object.entries(REQUIRED_GEN_BLOCKS)) {
    const text = read(root, doc);
    if (text === null) {
      failures.push({ doc, key: '*', reason: 'doc file missing' });
      continue;
    }
    if (argv.includes('--fix')) {
      writeFileSync(join(root, doc), applyFix(doc, text, facts, required), 'utf8');
      console.log(`docs-check: --fix wrote generated blocks into ${doc}`);
      continue;
    }
    const res = checkDoc(doc, text, facts, required);
    failures.push(...res.failures);
  }

  if (failures.length > 0) {
    console.error(`\ndocs-check: ${failures.length} generated-block failure(s):`);
    for (const f of failures) {
      console.error(`  ${f.doc} [gen:${f.key}] ${f.reason}`);
      if (f.found !== undefined) console.error(`    found:    ${JSON.stringify(f.found.slice(0, 160))}`);
      if (f.expected !== undefined) console.error(`    expected: ${JSON.stringify(f.expected.slice(0, 160))}`);
    }
    return 1;
  }
  console.log('\ndocs-check: every generated block agrees with the computed facts.');
  return 0;
};

const invokedDirectly = process.argv[1] !== undefined && process.argv[1].endsWith('docs-check.ts');
if (invokedDirectly) {
  process.exit(main(process.argv.slice(2)));
}

// scripts/canon-lint.ts — validate canon/ with zero model spend: the same
// analyzeFile gate derive applies (error-severity issue ⇒ quarantine), plus
// lintCorpus over the population with the registers/exclusions controls
// loaded (without them the forbidden-pair and dimension-cap checks silently
// skip). Exists because corpus:check exits early until derived/ exists, and
// canon must be lintable before any spend.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeFile } from '../src/corpus/parse.js';
import { isPopulationFile, lintCorpus } from '../src/corpus/lint.js';
import { loadControls } from '../src/corpus/controls.js';
import type { CorpusFile } from '../src/corpus/types.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const canonDir = path.join(repo, 'corpus', 'canon');

const walk = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : e.name.endsWith('.md') ? [p] : [];
  });

const controls = loadControls(
  fs.readFileSync(path.join(canonDir, 'registers.yaml'), 'utf8'),
  fs.readFileSync(path.join(canonDir, 'exclusions.yaml'), 'utf8'),
);
const files: CorpusFile[] = walk(canonDir)
  .filter(isPopulationFile)
  .map((f) => ({ path: path.relative(repo, f).replaceAll('\\', '/'), raw: fs.readFileSync(f, 'utf8') }));
let errors = 0;
const kept: CorpusFile[] = [];
for (const file of files) {
  const analysis = analyzeFile(file, 'canon');
  const errs = analysis.issues.filter((i) => i.severity === 'error');
  if (analysis.exemplar === undefined || errs.length > 0) {
    for (const e of errs) console.error(`ERROR ${file.path}: ${e.code} ${e.message}`);
    if (analysis.exemplar === undefined) console.error(`ERROR ${file.path}: failed to parse`);
    errors += 1;
  } else {
    kept.push(file);
  }
}
const report = lintCorpus(kept, controls);
for (const p of report.errors) console.error(`lint  ${p.file}: ${p.code} ${p.message}`);
for (const p of report.warnings) console.error(`warn  ${p.file}: ${p.code} ${p.message}`);
console.log(
  `canon lint: ${report.files} file(s) linted, ${report.exemplars.length} exemplar(s), ` +
    `${report.errors.length} lint error(s), ${report.warnings.length} warning(s), ok=${report.ok}`,
);
process.exit(errors > 0 || !report.ok ? 1 : 0);

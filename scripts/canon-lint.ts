// scripts/canon-lint.ts — validate canon/ with zero model spend: the same
// analyzeFile gate derive applies (error-severity issue ⇒ quarantine), plus
// lintCorpus over the population with the registers/exclusions controls
// loaded (without them the forbidden-pair and dimension-cap checks silently
// skip). Exists because corpus:check exits early until derived/ exists, and
// canon must be lintable before any spend.
//
// `--fix-notes-dashes` (v6 K0.3): rewrites em/en-dashes to plain hyphens in
// each exemplar's `notes:` frontmatter field only (block scalars included).
// notes are judge-read, so the judge must not be taught a punctuation tic the
// measured human corpus never shows; bodies and identity.md are Diego's hand
// and are left untouched by the flag.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeFile } from '../src/corpus/parse.js';
import { isPopulationFile, lintCorpus } from '../src/corpus/lint.js';
import { loadControls } from '../src/corpus/controls.js';
import type { CorpusFile } from '../src/corpus/types.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const canonDir = path.join(repo, 'corpus', 'canon');
const fixNotesDashes = process.argv.includes('--fix-notes-dashes');

const walk = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : e.name.endsWith('.md') ? [p] : [];
  });

/**
 * Rewrites —/– to - inside the `notes:` field of an exemplar file's
 * frontmatter, preserving every other byte. Line-scoped: from the `notes:`
 * key line through its block scalar (indented continuation lines), stopping
 * at the next top-level key or the closing fence.
 */
const fixNotesDashesIn = (raw: string): { text: string; changed: boolean } => {
  const text = raw.replace(/\r\n/g, '\n');
  const fence = /^---$/m;
  const open = fence.exec(text);
  if (open === null) return { text, changed: false };
  const closeIdx = text.indexOf('\n---', open.index + 4);
  if (closeIdx === -1) return { text, changed: false };
  const head = text.slice(0, open.index);
  const fm = text.slice(open.index, closeIdx);
  const tail = text.slice(closeIdx);
  const lines = fm.split('\n');
  let inNotes = false;
  let changed = false;
  const fixed = lines.map((line) => {
    if (/^notes:/.test(line)) inNotes = true;
    else if (inNotes && /^[A-Za-z-]+:/.test(line)) inNotes = false;
    if (inNotes && /[—–]/.test(line)) {
      changed = true;
      return line.replace(/[—–]/g, '-');
    }
    return line;
  });
  return { text: changed ? head + fixed.join('\n') + tail : text, changed };
};

if (fixNotesDashes) {
  let fixedCount = 0;
  for (const f of walk(canonDir)) {
    if (!isPopulationFile(f)) continue;
    const before = fs.readFileSync(f, 'utf8');
    const { text, changed } = fixNotesDashesIn(before);
    if (changed) {
      fs.writeFileSync(f, text);
      console.log(`fixed notes dashes: ${path.relative(repo, f)}`);
      fixedCount += 1;
    }
  }
  console.log(`notes-dash fix: ${fixedCount} file(s) rewritten`);
}

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

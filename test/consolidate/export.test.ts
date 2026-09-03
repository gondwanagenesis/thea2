// M10 gate — the proposals export (round 2): a byte-exact copy of var/proposals
// for Diego's review, plus the CLI verb's argument seam. Hermetic: tmpdirs, no
// compose boot, no model, no network. The compose-side wiring of the verb is
// exercised by the app suite's own boot paths; the export's contract is here.

import { describe, expect, it, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { exportProposals } from '../../src/consolidate/index.js';
import { ConsolidateError } from '../../src/consolidate/errors.js';
import { MANIFEST_NAME } from '../../src/consolidate/state.js';
import { firstPositional } from '../../src/app/cli.js';

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});
const dir = (label: string): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `thea2-export-${label}-`));
  roots.push(d);
  return d;
};

describe('exportProposals', () => {
  it('copies the drafts and the manifest byte-exact, sorted, and reports what moved', async () => {
    const source = dir('src');
    const target = dir('out');
    fs.writeFileSync(path.join(source, 'b-draft.md'), '# proposal B\n', 'utf8');
    fs.writeFileSync(path.join(source, 'a-draft.md'), '# proposal A\n', 'utf8');
    fs.writeFileSync(path.join(source, MANIFEST_NAME), '{"version":1,"entries":[]}', 'utf8');
    fs.writeFileSync(path.join(source, 'notes.txt'), 'not an exportable', 'utf8'); // ignored

    const result = await exportProposals(source, target);

    expect(result.copied).toEqual(['a-draft.md', 'b-draft.md', MANIFEST_NAME]);
    expect(fs.readFileSync(path.join(target, 'a-draft.md'), 'utf8')).toBe('# proposal A\n');
    expect(fs.readFileSync(path.join(target, 'b-draft.md'), 'utf8')).toBe('# proposal B\n');
    expect(fs.readFileSync(path.join(target, MANIFEST_NAME), 'utf8')).toBe('{"version":1,"entries":[]}');
    expect(fs.existsSync(path.join(target, 'notes.txt'))).toBe(false);
  });

  it('a missing source dir is a typed error, not a silent empty copy', async () => {
    const never = path.join(dir('ghost'), 'var', 'proposals');
    const err = await exportProposals(never, dir('out2')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConsolidateError);
    expect((err as ConsolidateError).code).toBe('consolidate/bad-config');
    expect((err as Error).message).toContain('proposals dir is unreadable');
  });

  it('an existing but empty proposals dir copies nothing, honestly', async () => {
    const source = dir('empty');
    const target = dir('empty-out');
    const result = await exportProposals(source, target);
    expect(result.copied).toEqual([]);
    expect(fs.existsSync(target)).toBe(true);
  });

  it('a stale file at the target is overwritten — the copy is the truth', async () => {
    const source = dir('src3');
    const target = dir('out3');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(source, 'draft.md'), 'the current draft\n', 'utf8');
    fs.writeFileSync(path.join(target, 'draft.md'), 'a stale review copy\n', 'utf8');

    const result = await exportProposals(source, target);

    expect(result.copied).toEqual(['draft.md']);
    expect(fs.readFileSync(path.join(target, 'draft.md'), 'utf8')).toBe('the current draft\n');
  });
});

describe('the proposals:export verb argument seam', () => {
  it('takes the first argv entry that is neither --config nor its value', () => {
    expect(firstPositional(['out'], -1)).toBe('out');
    expect(firstPositional(['--config', 'cfg.yaml', 'out'], 0)).toBe('out');
    expect(firstPositional(['out', '--config', 'cfg.yaml'], 1)).toBe('out');
  });

  it('no positional argument is undefined — the verb refuses with usage, never improvises', () => {
    expect(firstPositional([], -1)).toBeUndefined();
    expect(firstPositional(['--config'], 0)).toBeUndefined();
    expect(firstPositional(['--config', 'cfg.yaml'], 0)).toBeUndefined();
  });
});

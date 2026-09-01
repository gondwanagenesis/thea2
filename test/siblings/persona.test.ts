// M18 gate — persona seeds. Voice for the two reports, nothing else: ten-line
// markdown files read from the packaged personas/ dir (or an injected dir), and
// deliberately NOT deploy-marker inputs (pinned in marker.test.ts). A missing
// seed throws — a report is never silently written unvoiced.

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { PERSONA_SEED_LINES, loadPersonaSeed } from '../../src/siblings/persona.js';
import { rmDir, tmpDir, writeText } from './helpers.js';

const packagedDir = fileURLToPath(new URL('../../src/siblings/personas/', import.meta.url));

describe('persona seeds — voice for reports, never behavior', () => {
  it('the shape is a 10-line markdown file — pinned so a seed cannot quietly grow', () => {
    expect(PERSONA_SEED_LINES).toBe(10);
  });

  it.each(['ledger', 'nightingale'] as const)('the packaged %s seed ships next to the module, exactly 10 lines, trimmed', (kind) => {
    const seed = loadPersonaSeed(kind); // no dir: the packaged default
    const lines = seed.split('\n');

    expect(seed.length).toBeGreaterThan(0);
    expect(lines).toHaveLength(PERSONA_SEED_LINES);
    expect(seed).toBe(seed.trim()); // trailing newlines never reach the model
    expect(lines[0]).toContain(kind); // the right file, not a sibling's
  });

  it('an injected dir wins over the packaged one, and the content is trimmed', () => {
    const dir = tmpDir('persona-injected');
    try {
      writeText(path.join(dir, 'ledger.md'), '  injected ledger seed  \n\n');
      expect(loadPersonaSeed('ledger', dir)).toBe('injected ledger seed');
      expect(loadPersonaSeed('ledger')).not.toBe('injected ledger seed'); // the packaged seed is untouched
    } finally {
      rmDir(dir);
    }
  });

  it('a missing seed file throws — no silent empty openings', () => {
    const dir = tmpDir('persona-missing');
    try {
      expect(() => loadPersonaSeed('ledger', dir)).toThrow();
      expect(fs.existsSync(path.join(packagedDir, 'ledger.md'))).toBe(true);
    } finally {
      rmDir(dir);
    }
  });
});

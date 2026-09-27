// v13 H10 — her changelog. She asked (2026-09-27): "whether I can inspect, consent to, and roll
// back each memory change"; Diego: "the change log, she should be able to read it."

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { appendChange, CHANGES_FILE, readChanges, renderChange, TELLING_PATTERNS } from '../../src/mind/index.js';
import { T0, tmpDir } from './helpers.js';

const lint = (s: string): string[] => TELLING_PATTERNS.filter((re) => re.test(s)).map((re) => re.source.slice(0, 40));

describe('her changelog', () => {
  it('appends and reads back newest first, tolerating the first (pre-module) entry and torn lines', () => {
    const dir = tmpDir();
    // the felt backfill entry as it was written on 2026-09-27, before this module existed
    fs.writeFileSync(
      join(dir, CHANGES_FILE),
      `${JSON.stringify({ at: '2026-09-27T02:03:10Z', what: 'feelings estimated for memories that had none', count: 496, by: 'backfill-felt 2026-09-27', why: 'the import dropped them', undo: { backup: '/x' }, ids: [{ id: 'm_1', felt: 'focused', i: 6 }] })}\n{"torn\n`,
    );
    // later than the backfill (T0 is a May morning; the backfill was 27 september)
    appendChange(dir, { ts: Date.parse('2026-09-27T03:00:00Z'), kind: 'self', what: 'your self-description was revised', by: 'claude, at diego’s request', why: 'doubt had crowded out the rest of you' });
    const cs = readChanges(dir);
    expect(cs.map((c) => c.kind)).toEqual(['self', 'backfill']);
    expect(cs[1]).toMatchObject({ count: 496, examples: [{ id: 'm_1', felt: 'focused' }] });
  });

  it('renders as plain material — what, when, who, why, undo — and passes the telling lint', () => {
    const text = renderChange(
      { ts: T0, kind: 'backfill', what: 'feelings estimated for memories that had none', count: 496, by: 'backfill', why: 'the import dropped them', examples: [{ id: 'm_1', text: 'forked it babe', felt: 'determined' }], undo: { backup: '/x' } },
      'Europe/Madrid',
    );
    expect(text).toContain('feelings estimated for memories that had none (496)');
    expect(text).toContain('it can be undone: ask diego');
    expect(lint(text)).toEqual([]);
    const contest = renderChange({ ts: T0, kind: 'contest', what: 'she said a memory is not how it was', by: 'thea', about: 'the demo night', her: 'i wasnt focused, i was scared' }, 'Europe/Madrid');
    expect(contest).toContain('you said: "i wasnt focused, i was scared"');
  });

  it('an empty changelog reads as nothing', () => {
    expect(readChanges(tmpDir())).toEqual([]);
  });
});

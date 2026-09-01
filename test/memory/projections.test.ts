// test/memory — the write-only projections: journal.md and threads.json are
// deterministic, atomic, and never an input to anything (a corrupt projection
// file must not disturb the stores that would rewrite it).

import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeHashEmbedder } from '../../src/embed/index.js';
import {
  JOURNAL_FILE,
  THREADS_FILE,
  openEpisodeStore,
  openThreadIndex,
  utcClockStamp,
  utcDayStamp,
  writeProjections,
} from '../../src/memory/index.js';
import type { Episode } from '../../src/memory/index.js';
import { episode, tmpDir, rmDir } from './helpers.js';

const DAY = 86_400_000;
const MORNING = 1_709_164_800_000; // 2024-02-29 00:00:00 UTC (leap day)

describe('utc stamps (no Date, pure arithmetic)', () => {
  it('names known instants', () => {
    expect(utcDayStamp(0)).toBe('1970-01-01');
    expect(utcClockStamp(0)).toBe('00:00');
    expect(utcClockStamp(DAY - 60_000)).toBe('23:59');
    expect(utcDayStamp(MORNING)).toBe('2024-02-29'); // the leap day itself
    expect(utcDayStamp(MORNING + DAY)).toBe('2024-03-01'); // 29 → next month, no Feb 30
    expect(utcClockStamp(MORNING + 3_600_000 + 300_000)).toBe('01:05');
  });
});

describe('journal.md', () => {
  it('renders day sections in order, deterministically', async () => {
    const dir = tmpDir('journal');
    const threads = openThreadIndex();
    const episodes: Episode[] = [
      episode({ id: 'ep_2', ts: MORNING + 3_900_000, importance: 3, diaryLine: 'fixed the oven' }),
      episode({ id: 'ep_1', ts: MORNING, importance: 8, diaryLine: 'he called the project ours' }),
      episode({ id: 'ep_3', ts: MORNING + DAY, importance: 5, diaryLine: 'a quieter day' }),
    ];
    await writeProjections(dir, episodes, threads);

    const text = fs.readFileSync(path.join(dir, JOURNAL_FILE), 'utf8');
    const lines = text.split('\n');
    expect(lines).toContain('## 2024-02-29');
    expect(lines).toContain('## 2024-03-01');
    // ts-then-id order within the file, one line per episode
    expect(lines.filter((l) => l.startsWith('- '))).toEqual([
      '- 00:00 · i8 · he called the project ours · ep_1',
      '- 01:05 · i3 · fixed the oven · ep_2',
      '- 00:00 · i5 · a quieter day · ep_3',
    ]);
    // write-only means self-describing: nothing parses this file
    expect(text).toContain('Nothing in Thea2 parses this file');

    const again = async (): Promise<string> => {
      await writeProjections(dir, episodes, threads);
      return fs.readFileSync(path.join(dir, JOURNAL_FILE), 'utf8');
    };
    expect(await again()).toBe(text); // byte-identical rewrite
    rmDir(dir);
  });

  it('flattens a wrapped diary line to one line', async () => {
    const dir = tmpDir('journal-wrap');
    const wrapped = episode({ id: 'ep_1', ts: MORNING, diaryLine: 'one thought\n  spanning two lines\tand a tab' });
    await writeProjections(dir, [wrapped], openThreadIndex());
    const text = fs.readFileSync(path.join(dir, JOURNAL_FILE), 'utf8');
    expect(text).toContain('one thought spanning two lines and a tab');
    rmDir(dir);
  });
});

describe('threads.json', () => {
  it('writes the fold for Diego, two-space, id order', async () => {
    const dir = tmpDir('threads-json');
    const threads = openThreadIndex();
    threads.apply([{ id: 'thesis', title: 'Chapter two', status: 'open' }], MORNING);
    threads.apply([{ id: 'jazz', title: 'Jazz night', status: 'touched' }], MORNING + 1);
    threads.apply([{ id: 'thesis', status: 'closed' }], MORNING + 2);

    await writeProjections(dir, [episode({ id: 'ep_1', ts: MORNING })], threads);
    const raw = fs.readFileSync(path.join(dir, THREADS_FILE), 'utf8');
    const parsed = JSON.parse(raw) as { threads: Array<{ id: string; title?: string; status: string; updatedAt: number; updates: number }> };
    expect(parsed.threads.map((t) => t.id)).toEqual(['jazz', 'thesis']);
    expect(parsed.threads[1]).toEqual({
      id: 'thesis',
      title: 'Chapter two',
      status: 'closed',
      updatedAt: MORNING + 2,
      updates: 2,
    });
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw).toContain('  "threads"'); // human-format, not canonical
    rmDir(dir);
  });
});

describe('projections are write-only', () => {
  it('a corrupt projection on disk never disturbs the stores that would rewrite it', async () => {
    const dir = tmpDir('write-only');
    fs.writeFileSync(path.join(dir, JOURNAL_FILE), '<not markdown at all', 'utf8');
    fs.writeFileSync(path.join(dir, THREADS_FILE), '{broken', 'utf8');

    const store = await openEpisodeStore(dir, { embedder: makeHashEmbedder() });
    expect(store.size()).toBe(0); // boot succeeded; projections were never read

    await store.append(episode({ id: 'ep_1', ts: MORNING }));
    await writeProjections(dir, store.all(), openThreadIndex());
    const text = fs.readFileSync(path.join(dir, JOURNAL_FILE), 'utf8');
    expect(text).toContain('ep_1'); // and the rewrite replaced the junk wholesale
    rmDir(dir);
  });
});

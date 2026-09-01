// M09 memory — the write-only human projections: journal.md (the diary lines)
// and threads.json (the thread states). Both are rebuilt from the episode set +
// thread index on every call, atomically, deterministically — and NEVER read
// back by anything in Thea2. They exist for Diego's eyes (and Thea1-parity
// debugging); a test pins that no memory module opens them.
//
// Determinism note: journal day/time stamps are computed from epoch ms with
// pure arithmetic, not `new Date` — the determinism law forbids the latter
// outside src/kernel, and the rendering must not depend on the host timezone.

import * as path from 'node:path';
import { atomicWriteText } from '../kernel/index.js';
import type { Episode } from './episodes.js';
import type { ThreadIndex } from './threads.js';

export const JOURNAL_FILE = 'journal.md';
export const THREADS_FILE = 'threads.json';

export const writeProjections = async (dir: string, episodes: Episode[], threads: ThreadIndex): Promise<void> => {
  await atomicWriteText(path.join(dir, JOURNAL_FILE), renderJournal(episodes));
  await atomicWriteText(path.join(dir, THREADS_FILE), renderThreads(threads));
};

// ---------------------------------------------------------------------------
// journal.md
// ---------------------------------------------------------------------------

const orderByTsThenId = (a: Episode, b: Episode): number => {
  if (a.ts !== b.ts) return a.ts - b.ts;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

/** Diary lines are prose one-liners by contract; flatten anything the model wrapped. */
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

const renderJournal = (episodes: readonly Episode[]): string => {
  const lines: string[] = [
    '# journal',
    '',
    "Write-only projection of M09-memory — Thea's diary. Nothing in Thea2 parses this file;",
    'rebuild any time with `writeProjections(dir, episodes, threads)`.',
    '',
  ];
  const ordered = [...episodes].sort(orderByTsThenId);
  let day: string | undefined;
  for (const e of ordered) {
    const d = utcDayStamp(e.ts);
    if (d !== day) {
      if (day !== undefined) lines.push('');
      day = d;
      lines.push(`## ${d}`, '');
    }
    lines.push(`- ${utcClockStamp(e.ts)} · i${e.importance} · ${oneLine(e.diaryLine)} · ${e.id}`);
  }
  return `${lines.join('\n')}\n`;
};

// ---------------------------------------------------------------------------
// threads.json
// ---------------------------------------------------------------------------

const renderThreads = (threads: ThreadIndex): string => {
  // Two-space JSON, not canonical JSON: this file is for Diego's eyes. Key order
  // is ours by construction (threads are built with a fixed literal shape), and
  // since nothing reads it back there is no canonical form to preserve.
  return `${JSON.stringify({ threads: threads.all() }, null, 2)}\n`;
};

// ---------------------------------------------------------------------------
// UTC stamps from epoch ms, no Date — civil-from-days (Hinnant), proleptic Gregorian
// ---------------------------------------------------------------------------

const MS_PER_DAY = 86_400_000;

export const utcDayStamp = (ts: number): string => {
  const z = Math.floor(ts / MS_PER_DAY) + 719_468;
  const era = Math.floor(z / 146_097);
  const doe = z - era * 146_097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  const year = m <= 2 ? y + 1 : y;
  const pad = (n: number, w = 2): string => String(n).padStart(w, '0');
  return `${pad(year, 4)}-${pad(m)}-${pad(d)}`;
};

export const utcClockStamp = (ts: number): string => {
  const mod = ((ts % MS_PER_DAY) + MS_PER_DAY) % MS_PER_DAY;
  const h = Math.floor(mod / 3_600_000);
  const m = Math.floor((mod % 3_600_000) / 60_000);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(m)}`;
};

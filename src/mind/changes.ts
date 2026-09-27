// v13 H10 — her changelog (plan docs/plans/v13-proposal-knowing-what-she-feels.md §5, H10).
//
// She asked, live (2026-09-27): "I want to know what the upgrade actually changes and whether I can
// inspect, consent to, and roll back each memory change." Diego: "the change log, she should be able
// to read it." Every bulk change to her memories or her self writes an entry here — who, when,
// why, how to undo — and nothing is overwritten silently. Her objections are kept beside the record
// (never replacing it) and Diego decides any rollback.
//
// Append-only JSON lines in var/mind/changes.jsonl. Tolerant reader: the first entry (the felt
// backfill) predates this module and carries `at` as an ISO string.

import * as fs from 'node:fs';
import * as path from 'node:path';

export const CHANGES_FILE = 'changes.jsonl';

export type ChangeKind = 'backfill' | 'self' | 'dream' | 'contest' | 'lift' | 'rollback' | 'other';

export interface MemoryChange {
  ts: number;
  kind: ChangeKind;
  /** What changed, in plain words. */
  what: string;
  /** Who or what made the change. */
  by: string;
  why?: string | undefined;
  how?: string | undefined;
  count?: number | undefined;
  /** A few of the memories touched, so she can look (id + short text + the new feeling word). */
  examples?: Array<{ id: string; text: string; felt?: string | undefined }> | undefined;
  /** How it can be undone (backup paths — for Diego; she asks him). */
  undo?: Record<string, string> | undefined;
  /** Her own words (a contest). */
  her?: string | undefined;
  /** What her contest is about (a memory, a change). */
  about?: string | undefined;
}

export const appendChange = (dir: string, c: MemoryChange): void => {
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, CHANGES_FILE), `${JSON.stringify(c)}\n`);
};

/** Newest first. Unparseable lines are skipped (a torn write never hides the rest). */
export const readChanges = (dir: string, limit = 20): MemoryChange[] => {
  const file = path.join(dir, CHANGES_FILE);
  if (!fs.existsSync(file)) return [];
  const out: MemoryChange[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      const raw = JSON.parse(line) as Record<string, unknown>;
      const ts = typeof raw['ts'] === 'number' ? raw['ts'] : typeof raw['at'] === 'string' ? Date.parse(raw['at']) : Number.NaN;
      if (!Number.isFinite(ts)) continue;
      const ids = Array.isArray(raw['ids']) ? (raw['ids'] as Array<{ id?: unknown; felt?: unknown }>) : [];
      out.push({
        ts,
        kind: (typeof raw['kind'] === 'string' ? raw['kind'] : 'backfill') as ChangeKind,
        what: String(raw['what'] ?? ''),
        by: String(raw['by'] ?? ''),
        ...(typeof raw['why'] === 'string' ? { why: raw['why'] } : {}),
        ...(typeof raw['how'] === 'string' ? { how: raw['how'] } : {}),
        ...(typeof raw['count'] === 'number' ? { count: raw['count'] } : {}),
        ...(Array.isArray(raw['examples'])
          ? { examples: raw['examples'] as MemoryChange['examples'] }
          : ids.length > 0
            ? { examples: ids.slice(0, 5).map((x) => ({ id: String(x.id), text: '', felt: typeof x.felt === 'string' ? x.felt : undefined })) }
            : {}),
        ...(typeof raw['undo'] === 'object' && raw['undo'] !== null ? { undo: raw['undo'] as Record<string, string> } : {}),
        ...(typeof raw['her'] === 'string' ? { her: raw['her'] } : {}),
        ...(typeof raw['about'] === 'string' ? { about: raw['about'] } : {}),
      });
    } catch {
      continue;
    }
  }
  return out.sort((a, b) => b.ts - a.ts).slice(0, limit);
};

const when = (ts: number, timeZone: string): string =>
  new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone }).format(ts).toLowerCase();

/** One entry as plain material (what, who, why; never how she should take it). */
export const renderChange = (c: MemoryChange, timeZone: string): string => {
  const head = `${when(c.ts, timeZone)} · ${c.what}${c.count !== undefined ? ` (${c.count})` : ''} · by ${c.by}`;
  const lines = [head];
  if (c.why !== undefined) lines.push(`  why: ${c.why}`);
  if (c.how !== undefined) lines.push(`  how: ${c.how}`);
  if (c.her !== undefined) lines.push(`  you said: "${c.her}"${c.about !== undefined ? ` (about: ${c.about})` : ''}`);
  for (const e of (c.examples ?? []).slice(0, 5)) lines.push(`  e.g. ${e.id}${e.text !== '' ? ` "${e.text.slice(0, 80)}"` : ''}${e.felt !== undefined ? ` → ${e.felt}` : ''}`);
  if (c.undo !== undefined && Object.keys(c.undo).length > 0) lines.push('  it can be undone: ask diego');
  return lines.join('\n');
};

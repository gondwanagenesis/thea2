// M01 kernel — atomic writes and JSONL append/read/rotate. Crash-safety is
// bought here once so no other module touches raw write paths.

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Clock } from './clock.js';
import { SystemClock } from './clock.js';
import { canonicalJson } from './hash.js';

/** Write text to `<path>.tmp-<rand>` in the same dir, fsync, rename over target, best-effort dir fsync. */
export const atomicWriteText = async (
  filePath: string,
  text: string,
  deps?: { rename?: typeof fsp.rename; mkdir?: typeof fsp.mkdir },
): Promise<void> => {
  const rename = deps?.rename ?? fsp.rename;
  const mkdir = deps?.mkdir ?? fsp.mkdir;
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tmp = `${filePath}.tmp-${randomBytes(6).toString('hex')}`;
  const handle = await fsp.open(tmp, 'w');
  try {
    await handle.writeFile(text, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(tmp, filePath);
  } catch (e) {
    // Failed rename: remove our tmp debris so the dir is left as we found it.
    await fsp.unlink(tmp).catch(() => undefined);
    throw e;
  }
  try {
    const dirHandle = await fsp.open(dir, 'r');
    try {
      await dirHandle.sync();
    } finally {
      await dirHandle.close();
    }
  } catch {
    // Directory fsync is unsupported on some platforms (Windows) — best effort.
  }
};

export const atomicWriteJson = async (filePath: string, value: unknown): Promise<void> =>
  atomicWriteText(filePath, canonicalJson(value));

export interface JsonlStore<T> {
  append(row: T): Promise<void>;
  /** Replays all rows in file-date order. `since` = number of leading rows to skip. */
  read(opts?: { since?: number }): AsyncIterable<T>;
  /** Files currently backing the store, in date order (diagnostics). */
  files(): string[];
}

const dateStamp = (clock: Clock): string => clock.now().toISOString().slice(0, 10);

export const openJsonl = <T>(
  dir: string,
  base: string,
  opts?: { rotateDailyUtc?: boolean; clock?: Clock; onCorrupt?: (line: string) => void },
): JsonlStore<T> => {
  const clock = opts?.clock ?? new SystemClock();
  const rotate = opts?.rotateDailyUtc ?? false;
  let mkdirDone = false;

  const fileFor = (): string =>
    rotate ? path.join(dir, `${base}-${dateStamp(clock)}.jsonl`) : path.join(dir, `${base}.jsonl`);

  const allFiles = (): string[] => {
    if (!fs.existsSync(dir)) return [];
    const names = fs
      .readdirSync(dir)
      .filter((n) => n === `${base}.jsonl` || (rotate && n.startsWith(`${base}-`) && n.endsWith('.jsonl')))
      .sort();
    return names.map((n) => path.join(dir, n));
  };

  return {
    append: async (row) => {
      if (!mkdirDone) {
        await fsp.mkdir(dir, { recursive: true });
        mkdirDone = true;
      }
      await fsp.appendFile(fileFor(), canonicalJson(row) + '\n', 'utf8');
    },

    files: allFiles,

    read: async function* (readOpts?: { since?: number }): AsyncGenerator<T> {
      let toSkip = readOpts?.since ?? 0;
      for (const file of allFiles()) {
        const text = await fsp.readFile(file, 'utf8');
        const lines = text.split('\n');
        // A truncated final line (crash tail) has no trailing newline — skip it.
        const complete = text.endsWith('\n') ? lines : lines.slice(0, -1);
        for (const line of complete) {
          if (line === '') continue;
          if (toSkip > 0) {
            toSkip--;
            continue;
          }
          try {
            yield JSON.parse(line) as T;
          } catch {
            // Malformed interior line: never fatal.
            opts?.onCorrupt?.(line);
          }
        }
      }
    },
  };
};

import { describe, expect, it, afterEach } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { atomicWriteJson, atomicWriteText, openJsonl } from '../../src/kernel/fs.js';
import { TestClock } from '../../src/kernel/clock.js';

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'thea2-kernel-'));
let dir: string;

afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

describe('atomicWrite', () => {
  it('writes atomically and leaves no tmp litter', async () => {
    dir = tmp();
    const file = path.join(dir, 'state.json');
    await atomicWriteJson(file, { b: 1, a: [1, 2] });
    expect(await fsp.readFile(file, 'utf8')).toBe('{"a":[1,2],"b":1}');
    const names = fs.readdirSync(dir);
    expect(names).toEqual(['state.json']); // no .tmp-* left behind
  });

  it('under an injected rename fault the old file stays byte-identical, and a later retry succeeds', async () => {
    dir = tmp();
    const file = path.join(dir, 'state.json');
    await atomicWriteText(file, 'v1');
    await expect(
      atomicWriteText(file, 'v2', { rename: async () => { throw new Error('injected fault'); } }),
    ).rejects.toThrow('injected fault');
    expect(await fsp.readFile(file, 'utf8')).toBe('v1'); // old file intact
    await atomicWriteText(file, 'v3');
    expect(await fsp.readFile(file, 'utf8')).toBe('v3');
    // No tmp litter from the failed attempt beyond what rename left is acceptable;
    // after a successful write the dir must be clean.
    expect(fs.readdirSync(dir).filter((n) => n.includes('.tmp-'))).toEqual([]);
  });
});

describe('openJsonl', () => {
  it('appends and replays 10k rows across a UTC rotation boundary in date order', { timeout: 30_000 }, async () => {
    // 10k awaited appends are legitimately slow on NTFS under parallel test load —
    // the 5s default is a cold-cache/Defender false red, not a correctness signal.
    dir = tmp();
    const clock = new TestClock(Date.UTC(2026, 8, 1, 23, 59, 0));
    const store = openJsonl<{ i: number }>(dir, 'log', { rotateDailyUtc: true, clock });
    for (let i = 0; i < 10_000; i++) {
      if (i === 5_000) await clock.advance(2 * 60 * 1000); // cross midnight UTC
      await store.append({ i });
    }
    const files = store.files();
    expect(files).toHaveLength(2);
    expect(files[0]!).toContain('2026-09-01');
    expect(files[1]!).toContain('2026-09-02');

    let count = 0;
    let lastI = -1;
    for await (const row of store.read()) {
      expect(row.i).toBe(lastI + 1); // strictly in append order across files
      lastI = row.i;
      count++;
    }
    expect(count).toBe(10_000);
  });

  it('skips a hand-truncated final line instead of throwing', async () => {
    dir = tmp();
    const good = '{"i":1}\n{"i":2}\n';
    await fsp.writeFile(path.join(dir, 'log.jsonl'), good + '{"i":3'); // torn
    const store = openJsonl<{ i: number }>(dir, 'log');
    const rows: number[] = [];
    for await (const r of store.read()) rows.push(r.i);
    expect(rows).toEqual([1, 2]);
  });

  it('routes malformed interior lines to onCorrupt, never fatal', async () => {
    dir = tmp();
    await fsp.writeFile(path.join(dir, 'log.jsonl'), '{"i":1}\nNOT JSON\n{"i":2}\n');
    const corrupt: string[] = [];
    const store = openJsonl<{ i: number }>(dir, 'log', { onCorrupt: (l) => corrupt.push(l) });
    const rows: number[] = [];
    for await (const r of store.read()) rows.push(r.i);
    expect(rows).toEqual([1, 2]);
    expect(corrupt).toEqual(['NOT JSON']);
  });
});

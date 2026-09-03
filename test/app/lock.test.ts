// M20 app — the process lock (Phase 1, 2026-09-02): one thead per var/, and
// derive refuses to run beside a live one. Liveness is injected, so the
// "dead pid" branch is a real branch, not a race against the OS.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireProcessLock, isLockHeldByOther, LockHeldError, readLock } from '../../src/app/lock.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'thea2-lock-'));
  dirs.push(d);
  return path.join(d, 'var', 'thead.pid');
};

describe('acquireProcessLock', () => {
  it('takes a fresh lock, names the pid, and release removes it', () => {
    const p = tmp();
    const release = acquireProcessLock(p, 4242, { isAlive: () => true });
    expect(fs.readFileSync(p, 'utf8').trim()).toBe('4242');
    expect(readLock(p, { isAlive: () => true })).toEqual({ held: true, pid: 4242, alive: true });
    release();
    expect(fs.existsSync(p)).toBe(false);
  });

  it('refuses when a LIVE other pid holds it', () => {
    const p = tmp();
    acquireProcessLock(p, 100, { isAlive: () => true });
    expect(() => acquireProcessLock(p, 200, { isAlive: () => true })).toThrow(LockHeldError);
    expect(isLockHeldByOther(p, 200, { isAlive: () => true })).toBe(true);
  });

  it('replaces a STALE lock (dead pid) and an unparseable one', () => {
    const p = tmp();
    acquireProcessLock(p, 100, { isAlive: () => false });
    const release = acquireProcessLock(p, 200, { isAlive: (pid) => pid === 200 });
    expect(fs.readFileSync(p, 'utf8').trim()).toBe('200');
    release();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, 'garbage', 'utf8');
    expect(readLock(p, { isAlive: () => true })).toEqual({ held: true, alive: false });
    expect(() => acquireProcessLock(p, 300, { isAlive: () => true })).not.toThrow();
  });

  it('re-acquiring with the same pid is idempotent; release never clobbers a later holder', () => {
    const p = tmp();
    const release1 = acquireProcessLock(p, 7, { isAlive: () => true });
    acquireProcessLock(p, 7, { isAlive: () => true });
    // A later holder took over after pid 7 died: pid 7's late release must not remove it.
    fs.writeFileSync(p, '8\n', 'utf8');
    release1();
    expect(fs.readFileSync(p, 'utf8').trim()).toBe('8');
    expect(isLockHeldByOther(p, 7, { isAlive: () => true })).toBe(true);
  });

  it('no file ⇒ not held', () => {
    expect(readLock(tmp(), { isAlive: () => true })).toEqual({ held: false, alive: false });
  });
});

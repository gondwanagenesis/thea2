// M20 app — the process lock. One `thead` per var/ (it is the single writer of
// the L0 event log, the ledger, and every store), and `thea2 derive` refuses to
// run beside it: on 2026-09-02 the two processes appended to the same daily
// events file with independent seq counters (630 rows, 426 distinct seqs), and
// derive's model traffic rate-limited the live turn that lost a real message.
//
// Pure over its deps: the pid file path, the owner pid, and an injectable
// liveness probe (prod: process.kill(pid, 0)). No clock, no rng.
// Deferred upgrade path: flock(2) on var/ would make the single-host case
// race-free; the pid file is the portable Phase 1 design.

import * as fs from 'node:fs';
import * as path from 'node:path';

/** One thead per var/: the pid file every second writer must respect (Phase 1). */
export const THEAD_LOCK_PATH = path.resolve('var', 'thead.pid');

export interface LockDeps {
  /** True when a process with this pid exists (prod: signal 0). */
  isAlive: (pid: number) => boolean;
}

export interface LockState {
  held: boolean;
  /** The pid the file names, when the file exists and parses. */
  pid?: number | undefined;
  /** Whether that pid is alive per the probe. */
  alive: boolean;
}

/** Prod liveness probe: signal 0 throws ESRCH for a dead pid, EPERM for a live one we cannot signal. */
export const processIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

export const readLock = (lockPath: string, deps: LockDeps): LockState => {
  let text: string;
  try {
    text = fs.readFileSync(lockPath, 'utf8');
  } catch {
    return { held: false, alive: false };
  }
  const pid = Number.parseInt(text.trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0) return { held: true, alive: false };
  return { held: true, pid, alive: deps.isAlive(pid) };
};

export class LockHeldError extends Error {
  constructor(lockPath: string, pid: number | undefined) {
    super(`process lock ${lockPath} is held by live pid ${pid ?? '?'} — refusing to run a second writer against this var/`);
    this.name = 'LockHeldError';
  }
}

/**
 * Take the lock for `pid`. A stale file (dead pid, unparseable) is replaced;
 * a live holder throws LockHeldError. Returns a release function that removes
 * the file only if it still names `pid` (a later holder is never clobbered).
 */
export const acquireProcessLock = (lockPath: string, pid: number, deps: LockDeps): (() => void) => {
  const state = readLock(lockPath, deps);
  if (state.held && state.alive && state.pid !== pid) throw new LockHeldError(lockPath, state.pid);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, `${pid}\n`, 'utf8');
  return () => {
    try {
      const current = fs.readFileSync(lockPath, 'utf8').trim();
      if (current === String(pid)) fs.unlinkSync(lockPath);
    } catch {
      // already gone — release is idempotent
    }
  };
};

/** True when another live process holds the lock (a would-be second writer must refuse). */
export const isLockHeldByOther = (lockPath: string, pid: number, deps: LockDeps): boolean => {
  const state = readLock(lockPath, deps);
  return state.held && state.alive && state.pid !== pid;
};

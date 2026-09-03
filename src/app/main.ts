// M20 app — the process edge. The ONLY file that touches process/env/signals;
// everything below it stays injected and testable. `thea2 <verb>` dispatches
// here; SIGINT/SIGTERM drain the system (in-flight turn settles, scheduler
// stops) instead of killing a half-said reply.

import { pathToFileURL } from 'node:url';
import { cliMain } from './cli.js';
import { acquireProcessLock, isLockHeldByOther, LockHeldError, processIsAlive, readLock, THEAD_LOCK_PATH, type LockDeps } from './lock.js';

export { THEAD_LOCK_PATH };

/**
 * @internal — process entry, not for tests. `deps` exists so the lock's
 * liveness probe is injectable (tests fake it the way lock.test.ts does);
 * prod never passes it.
 */
/**
 * Removes the process-level handlers `main` registered (test seam - see the
 * wedge note above). Undefined until `main` has registered them in this
 * process; re-set on every `main` call.
 */
export let disposeMainProcessHandlers: (() => void) | undefined;

export const main = async (argv: string[], deps: LockDeps = { isAlive: processIsAlive }): Promise<number> => {
  let stop: (() => Promise<void>) | undefined;
  let releaseLock: (() => void) | undefined;
  disposeMainProcessHandlers = undefined;
  const shutdown = (sig: string): void => {
    process.stderr.write(`\n${sig} — draining...\n`);
    void (stop ?? (() => Promise.resolve()))().then(
      () => {
        releaseLock?.();
        process.exit(0);
      },
      (e) => {
        process.stderr.write(`shutdown error: ${String(e)}\n`);
        releaseLock?.();
        process.exit(1);
      },
    );
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  const sigint = (): void => shutdown('SIGINT');
  const sigterm = (): void => shutdown('SIGTERM');
  const onUnhandledRejection = (e: unknown): void => {
    process.stderr.write(`unhandledRejection: ${String(e)}
`);
  };
  const onUncaughtException = (e: Error): void => {
    process.stderr.write(`uncaughtException: ${String(e)}
`);
    releaseLock?.();
    process.exit(1);
  };
  process.once('SIGINT', sigint);
  process.once('SIGTERM', sigterm);
  process.on('unhandledRejection', onUnhandledRejection);
  process.on('uncaughtException', onUncaughtException);
  // Process listeners survive vitest's per-file module isolation - a test
  // that runs main() left these attached for EVERY later file in the worker
  // (the 2026-09-02 whole-suite wedge: a swallowed rejection, or the silent
  // exit(1), made a worker vanish mid-run with no timeout ever firing).
  // Test suites call disposeMainProcessHandlers() after each main() call;
  // prod never does.
  disposeMainProcessHandlers = (): void => {
    process.off('SIGINT', sigint);
    process.off('SIGTERM', sigterm);
    process.off('unhandledRejection', onUnhandledRejection);
    process.off('uncaughtException', onUncaughtException);
  };

  // The process lock: one thead per var/, and derive never beside it (on
  // 2026-09-02 the two shared the L0 file — 204 duplicate seqs — and derive's
  // model traffic rate-limited the live turn that lost a real message).
  const verb = argv[2];
  const lockDeps = deps;
  const env: Record<string, string | undefined> = { ...process.env };
  if (verb === 'thead') {
    try {
      releaseLock = acquireProcessLock(THEAD_LOCK_PATH, process.pid, lockDeps);
    } catch (e) {
      if (e instanceof LockHeldError) {
        process.stderr.write(`${e.message}\n`);
        return 2;
      }
      throw e;
    }
  } else if (verb === 'derive' && isLockHeldByOther(THEAD_LOCK_PATH, process.pid, lockDeps)) {
    // Escape hatch, not a default: the operator who overrides must see the
    // refusal naming the way out, and the run must name itself on L0 (the
    // derive verb emits `derive.live_override` when this env var is set).
    const holder = readLock(THEAD_LOCK_PATH, lockDeps).pid;
    if (argv.includes('--allow-live-derive')) {
      env['THEA2_ALLOW_LIVE_DERIVE'] = String(holder ?? 'unknown');
      process.stderr.write(
        `thea2 derive: LIVE OVERRIDE — thead (pid ${holder ?? '?'}) holds ${THEAD_LOCK_PATH}; running beside it anyway\n`,
      );
    } else {
      process.stderr.write(
        `thea2 derive: thead is running (${THEAD_LOCK_PATH}) — stop it first, run derive on a dev machine and commit the output (ADR-007), ` +
          `or rerun with --allow-live-derive to override (emits derive.live_override on L0)\n`,
      );
      return 2;
    }
  }

  return cliMain(
    argv.slice(2),
    env,
    { out: (s) => process.stdout.write(s + '\n'), err: (s) => process.stderr.write(s + '\n') },
    (handle) => {
      stop = () => handle.stop();
    },
  );
};

// Self-invocation when run as the process entry (`tsx src/app/main.ts thead`).
// Guarded so test/barrel imports of this module stay inert. Case-insensitive
// compare: Windows drive letters can differ in case between argv and the
// module URL (C:\ vs c:\).
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url.toLowerCase() === pathToFileURL(process.argv[1]).href.toLowerCase();
if (invokedDirectly) {
  void main(process.argv).then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`fatal: ${String(e)}\n`);
      process.exit(1);
    },
  );
}

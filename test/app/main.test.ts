// M20 gate — main()'s verb guards at the process edge: the thead pid lock and
// the derive refusal (with its --allow-live-derive escape hatch). Liveness is
// injected exactly as lock.test.ts fakes it, and the refusal paths return
// BEFORE cliMain composes anything, so the file stays hermetic — no config,
// no corpus, no network. The L0 event side of the override is proven at the
// deriveVerb seam in derive-cli.test.ts (main() cannot inject a MockModel).

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { disposeMainProcessHandlers } from '../../src/app/main.js';

// THEAD_LOCK_PATH resolves `var/thead.pid` against the cwd at module load, so
// the chdir must precede the dynamic import (a static import would hoist).
const repoCwd = process.cwd();
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'thea2-main-'));
process.chdir(root);
const { main, THEAD_LOCK_PATH } = await import('../../src/app/main.js');

const writeHolderPid = (): void => {
  fs.mkdirSync(path.dirname(THEAD_LOCK_PATH), { recursive: true });
  fs.writeFileSync(THEAD_LOCK_PATH, '4242\n', 'utf8');
};

let stderr: MockInstance | undefined;
const errText = (): string => (stderr?.mock.calls.map(String).join('\n') ?? '');
afterEach(() => {
  stderr?.mockRestore();
  stderr = undefined;
  fs.rmSync(THEAD_LOCK_PATH, { force: true });
  // main() registers PROCESS-level handlers (unhandledRejection/
  // uncaughtException/SIGINT/SIGTERM) that outlive this file's module
  // isolation - left attached they swallow later files' rejections or
  // exit(1) the worker (the whole-suite wedge). Every test disposes.
  disposeMainProcessHandlers?.();
});
afterAll(() => {
  process.chdir(repoCwd);
  fs.rmSync(root, { recursive: true, force: true });
});

describe('main — the process lock at the verb guards', () => {
  it('derive refuses beside a live thead (exit 2), naming the escape hatch', async () => {
    writeHolderPid();
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const code = await main(['node', 'main.ts', 'derive'], { isAlive: (pid) => pid === 4242 });
    expect(code).toBe(2);
    expect(errText()).toContain('thead is running');
    expect(errText()).toContain('--allow-live-derive');
    // the refusal never touched the holder's pid file
    expect(fs.readFileSync(THEAD_LOCK_PATH, 'utf8').trim()).toBe('4242');
  });

  it('thead refuses when the lock is live, without clobbering the holder', async () => {
    writeHolderPid();
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const code = await main(['node', 'main.ts', 'thead'], { isAlive: () => true });
    expect(code).toBe(2);
    expect(errText()).toContain('held by live pid 4242');
    expect(fs.readFileSync(THEAD_LOCK_PATH, 'utf8').trim()).toBe('4242');
  });

  it('--allow-live-derive opens the gate: main proceeds instead of resolving 2', async () => {
    writeHolderPid();
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    // Past the gate the derive verb needs a config the throwaway cwd does not
    // have — that typed failure IS the proof the gate opened (a refusal would
    // resolve with 2 and never reach config).
    await expect(
      main(['node', 'main.ts', 'derive', '--allow-live-derive'], { isAlive: (pid) => pid === 4242 }),
    ).rejects.toMatchObject({ code: 'app/config-unreadable' });
    expect(errText()).toContain('LIVE OVERRIDE');
    expect(errText()).toContain('4242');
  });
});

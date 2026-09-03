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
import { SystemClock } from '../../src/kernel/index.js';

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

describe('main — process edge (P-CLOSE)', () => {
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };

  it('AC: sigterm-drains-once — one signal, one drain; dispose removes the only pair', async () => {
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    await main(['node', 'main.ts', '--help']);
    expect(process.listenerCount('SIGTERM')).toBe(1); // exactly one pair, not the historical duplicate
    expect(process.listenerCount('SIGINT')).toBe(1);

    process.emit!('SIGTERM', 'SIGTERM');
    await settle();
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
    expect(errText().split('SIGTERM — draining').length - 1).toBe(1); // one drain line

    disposeMainProcessHandlers?.();
    expect(process.listenerCount('SIGTERM')).toBe(0); // the ONLY pair is gone
    expect(process.listenerCount('SIGINT')).toBe(0);
    process.emit!('SIGTERM', 'SIGTERM'); // after dispose: nothing fires
    await settle();
    expect(exit).toHaveBeenCalledTimes(1);
    exit?.mockRestore();
  });

  it('AC: an unhandled rejection is an incident — L0 row, then exit 1', async () => {
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    // The vitest worker holds its own unhandledRejection listener — assert the
    // DELTA, never an absolute count.
    const before = process.listenerCount('unhandledRejection');
    await main(['node', 'main.ts', '--help']);
    expect(process.listenerCount('unhandledRejection')).toBe(before + 1);

    process.emit!('unhandledRejection', new Error('boom at the seam'), Promise.resolve());
    await settle();
    // The incident lands through real fs writes before exit fires — wait for
    // the exit itself (bounded), never a fixed sleep that a slow box races.
    const clock = new SystemClock();
    for (let i = 0; i < 100 && exit.mock.calls.length === 0; i++) {
      await clock.waitUntil(clock.epochMs() + 5);
    }

    expect(exit).toHaveBeenCalledWith(1); // loud and fatal
    expect(errText()).toContain('unhandledRejection');
    expect(errText()).toContain('boom at the seam');

    // The incident is on L0 under var/events (main's fallback log — no thead
    // was composed in this process, so no seq fork is possible).
    const eventsDir = path.join(root, 'var', 'events');
    const file = fs.readdirSync(eventsDir).find((n) => n.endsWith('.jsonl'));
    expect(file).toBeDefined();
    const rows = fs.readFileSync(path.join(eventsDir, file!), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { kind: string; payload: { error?: string } });
    expect(rows.filter((r) => r.kind === 'incident.unhandled_rejection').map((r) => r.payload)).toEqual([
      { error: 'boom at the seam' },
    ]);

    disposeMainProcessHandlers?.();
    expect(process.listenerCount('unhandledRejection')).toBe(before); // exactly the one pair, removed
    exit?.mockRestore();
    fs.rmSync(path.join(root, 'var'), { recursive: true, force: true });
  });
});

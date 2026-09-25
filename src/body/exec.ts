// v9 body — the real Exec: spawn with a hard timeout, bytes in, bytes out.
// Stdin is never inherited (the OpenCode stdin-spawn trap: a child waiting on
// an inherited stdin hangs forever), and the timeout is spawn's own (the
// process is SIGKILLed by Node), so no timer of ours runs outside the Clock.

import { spawn } from 'node:child_process';
import type { Exec } from './types.js';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_STDOUT = 64 * 1024 * 1024;

export const nodeExec: Exec = {
  run: (cmd, args, opts) =>
    new Promise((resolve) => {
      const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const child = spawn(cmd, [...args], {
        stdio: [opts?.stdin !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        ...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}),
      });
      const out: Buffer[] = [];
      let outLen = 0;
      let err = '';
      let done = false;
      const finish = (code: number, extraErr = ''): void => {
        if (done) return;
        done = true;
        resolve({ code, stdout: new Uint8Array(Buffer.concat(out)), stderr: (err + extraErr).slice(-4000) });
      };
      child.stdout?.on('data', (c: Buffer) => {
        outLen += c.length;
        if (outLen <= MAX_STDOUT) out.push(c);
      });
      child.stderr?.on('data', (c: Buffer) => {
        err += c.toString('utf8');
        if (err.length > 16_000) err = err.slice(-8000);
      });
      child.on('error', (e) => finish(127, `\n${e.message}`));
      child.on('close', (code, signal) => {
        if (signal === 'SIGKILL' && code === null) finish(124, `\n[killed after ${timeoutMs} ms]`);
        else finish(code ?? 1);
      });
      if (opts?.stdin !== undefined && child.stdin !== null) {
        child.stdin.on('error', () => undefined);
        child.stdin.end(Buffer.from(opts.stdin));
      }
    }),
};

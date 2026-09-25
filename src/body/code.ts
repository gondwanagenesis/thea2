// v9 body — run_code: a Python script in the sandbox (Thea1's run_code). The
// script runs through the thea2-exec broker (deploy/exec-broker.mjs) as a
// throwaway user with no network and no view of Thea1, Thea2's keys or her
// own var — only what it prints comes back.

import * as net from 'node:net';
import { z } from 'zod';
import type { ToolCtx, ToolRegistryEntry } from '../loop/index.js';

export interface CodeResult {
  exit: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export const runInSandbox = (sock: string, script: string, timeoutSec: number): Promise<CodeResult> =>
  new Promise((resolve, reject) => {
    const c = net.createConnection(sock);
    let buf = '';
    c.setTimeout((timeoutSec + 30) * 1000, () => {
      c.destroy();
      reject(new Error('the sandbox did not answer in time'));
    });
    c.on('connect', () => c.write(`${JSON.stringify({ script, timeoutSec })}\n`));
    c.on('data', (d) => {
      buf += d.toString('utf8');
    });
    c.on('end', () => {
      try {
        resolve(JSON.parse(buf.trim()) as CodeResult);
      } catch {
        reject(new Error('the sandbox gave nothing back'));
      }
    });
    c.on('error', (e) => reject(new Error(/ENOENT|ECONNREFUSED/.test(e.message) ? 'the sandbox is not running' : e.message)));
  });

export const codeTools = (sock: string): Array<ToolRegistryEntry<never>> => [
  {
    def: {
      name: 'run_code',
      description: 'Run a Python script to work something out (math, parsing, a quick simulation). It runs sandboxed with no network and no access to your files; only what it prints comes back.',
      parameters: {
        type: 'object',
        properties: { script: { type: 'string', description: 'the Python source' }, timeout: { type: 'integer', minimum: 5, maximum: 120, description: 'seconds (default 30)' } },
        required: ['script'],
      },
    },
    input: z.object({ script: z.string().min(1).max(200_000), timeout: z.number().int().min(5).max(120).optional() }),
    inhibitionMeta: { class: 'code' },
    handler: async (a: { script: string; timeout?: number | undefined }, _ctx: ToolCtx) => {
      try {
        const r = await runInSandbox(sock, a.script, a.timeout ?? 30);
        const parts: string[] = [];
        if (r.stdout !== '') parts.push(r.stdout.slice(0, 12_000));
        if (r.timedOut) parts.push('[the script ran out of time and was stopped]');
        if (r.stderr.trim() !== '') parts.push(`[stderr]\n${r.stderr.slice(-3000)}`);
        if (parts.length === 0) parts.push('(it printed nothing — only what you print comes back)');
        return `${parts.join('\n\n')}\n[exit ${r.exit}]`;
      } catch (e) {
        return `not done: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  } as unknown as ToolRegistryEntry<never>,
];

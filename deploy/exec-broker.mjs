#!/usr/bin/env node
// thea2-exec — Thea2's code sandbox broker (v9, plan thea2-v9-parity.md).
//
// Runs as root ONLY so it can hand each script to systemd-run, which executes
// it as a throwaway DynamicUser with NO network (PrivateNetwork), a read-only
// system, no home dirs, and the Thea1/holobionte/thea2 trees made
// inaccessible — then throws the unit away. thead (user thea2) talks to it
// over a unix socket inside /opt/thea2/var/run; one JSON line in, one out.
//
//   request  {"script": "<python source>", "timeoutSec": 30}
//   response {"exit": 0, "stdout": "...", "stderr": "...", "timedOut": false}
//
// No dependencies; node:net + node:child_process only. Thea1's exec broker is a
// separate service with its own uid — nothing here touches it.

import net from 'node:net';
import fs from 'node:fs';
import { spawn } from 'node:child_process';

const SOCK = process.env.THEA2_EXEC_SOCK || '/opt/thea2/var/run/exec.sock';
const OWNER = process.env.THEA2_EXEC_OWNER || 'thea2';
const MAX_SCRIPT = 200_000;
const MAX_OUT = 200_000;

const props = (timeoutSec) => [
  'DynamicUser=yes',
  'PrivateNetwork=yes',
  'ProtectSystem=strict',
  'ProtectHome=yes',
  'PrivateTmp=yes',
  'PrivateDevices=yes',
  'NoNewPrivileges=yes',
  'ProtectKernelTunables=yes',
  'ProtectControlGroups=yes',
  'RestrictSUIDSGID=yes',
  'InaccessiblePaths=-/opt/thea',
  'InaccessiblePaths=-/opt/holobionte',
  'InaccessiblePaths=-/opt/thea2',
  'InaccessiblePaths=-/etc/thea2',
  'InaccessiblePaths=-/root',
  'MemoryMax=512M',
  'CPUQuota=100%',
  'TasksMax=64',
  `RuntimeMaxSec=${timeoutSec}`,
].flatMap((p) => ['-p', p]);

const run = (script, timeoutSec) =>
  new Promise((resolve) => {
    const t = Math.min(Math.max(Number(timeoutSec) || 30, 5), 120);
    const child = spawn('systemd-run', ['--quiet', '--pipe', '--wait', '--collect', '--service-type=exec', ...props(t), 'python3', '-I', '-'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: (t + 15) * 1000,
      killSignal: 'SIGKILL',
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => { if (out.length < MAX_OUT) out += c.toString('utf8'); });
    child.stderr.on('data', (c) => { if (err.length < MAX_OUT) err += c.toString('utf8'); });
    child.on('error', (e) => resolve({ exit: 127, stdout: '', stderr: String(e.message), timedOut: false }));
    child.on('close', (code, signal) => {
      const timedOut = signal === 'SIGKILL' || /RuntimeMaxSec|timeout/i.test(err) || code === 124;
      resolve({ exit: code ?? 1, stdout: out.slice(0, MAX_OUT), stderr: err.slice(-8000), timedOut });
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(script);
  });

try { fs.mkdirSync(SOCK.replace(/\/[^/]+$/, ''), { recursive: true }); } catch {}
try { fs.unlinkSync(SOCK); } catch {}
let live = 0;
const server = net.createServer((sock) => {
  let buf = '';
  sock.on('data', async (c) => {
    buf += c.toString('utf8');
    if (buf.length > MAX_SCRIPT * 2) { sock.end(JSON.stringify({ exit: 2, stdout: '', stderr: 'request too large', timedOut: false }) + '\n'); return; }
    const nl = buf.indexOf('\n');
    if (nl < 0) return;
    const line = buf.slice(0, nl);
    buf = '';
    let req;
    try { req = JSON.parse(line); } catch { sock.end(JSON.stringify({ exit: 2, stdout: '', stderr: 'bad request', timedOut: false }) + '\n'); return; }
    if (typeof req.script !== 'string' || req.script.length > MAX_SCRIPT) { sock.end(JSON.stringify({ exit: 2, stdout: '', stderr: 'script missing or too long', timedOut: false }) + '\n'); return; }
    if (live >= 2) { sock.end(JSON.stringify({ exit: 3, stdout: '', stderr: 'two scripts are already running; try again in a moment', timedOut: false }) + '\n'); return; }
    live += 1;
    try {
      const r = await run(req.script, req.timeoutSec);
      sock.end(JSON.stringify(r) + '\n');
    } finally {
      live -= 1;
    }
  });
  sock.on('error', () => undefined);
});
server.listen(SOCK, () => {
  fs.chmodSync(SOCK, 0o660);
  try {
    const uid = Number(require_uid(OWNER));
    fs.chownSync(SOCK, 0, uid);
  } catch {}
  console.log(`thea2-exec listening on ${SOCK}`);
});

function require_uid(user) {
  const line = fs.readFileSync('/etc/group', 'utf8').split('\n').find((l) => l.startsWith(`${user}:`));
  return line ? line.split(':')[2] : '0';
}

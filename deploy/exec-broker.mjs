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
//
// v10 — her shell (plan docs/plans/v10-opencode-hands.md §3, fence F1):
//
//   request  {"op": "shell", "command": "<bash command line>", "timeoutSec": 60}
//   response {"exit": 0, "stdout": "...", "stderr": "...", "timedOut": false}
//
// The command runs as its own user (thea2-hands, primary group thea2) in a
// transient unit: her workspace is its home, working dir and the only place it
// can write; the rest of her var (mind, keys-adjacent state, sockets), Thea1,
// holobionte, /etc/thea2, /root and the tailnet socket are not there at all.
// It has the internet (pip, npm, git, curl) but not this box: localhost, the
// private ranges, the tailnet and the box's own addresses are denied (DNS via
// the resolver stub stays open). Its environment is an allowlist built here —
// systemd-run never passes the broker's own. A different uid is the point: a
// shell running as thea2 could read her keys out of /proc/<thead>/environ.
// When the command ends, the unit ends, and anything it backgrounded with it.

import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';

const SOCK = process.env.THEA2_EXEC_SOCK || '/opt/thea2/var/run/exec.sock';
const OWNER = process.env.THEA2_EXEC_OWNER || 'thea2';
const MAX_SCRIPT = 200_000;
const MAX_OUT = 200_000;
const HANDS_USER = process.env.THEA2_HANDS_USER || 'thea2-hands';
const HANDS_GROUP = process.env.THEA2_HANDS_GROUP || 'thea2';
const VAR = process.env.THEA2_VAR || '/opt/thea2/var';
const WORKSPACE = process.env.THEA2_WORKSPACE || `${VAR}/workspace`;
const HANDS_TZ = process.env.THEA2_HANDS_TZ || 'UTC';
const MAX_COMMAND = 100_000;
const MAX_SHELLS = 4;
/** head + tail kept when a command prints more than this */
const SHELL_OUT = 256 * 1024;

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

// --- v10: her shell ---------------------------------------------------------

/** Every address this box answers on: her shell may reach the internet, never the box itself. */
const ownAddresses = () =>
  Object.values(os.networkInterfaces())
    .flat()
    .filter((a) => a && !a.internal)
    .map((a) => (a.family === 'IPv6' || a.family === 6 ? `${a.address.split('%')[0]}/128` : `${a.address}/32`));

const handsProps = (timeoutSec) => [
  'ProtectSystem=strict',
  'ProtectHome=yes',
  'PrivateTmp=yes',
  'PrivateDevices=yes',
  'NoNewPrivileges=yes',
  'ProtectKernelTunables=yes',
  'ProtectKernelModules=yes',
  'ProtectKernelLogs=yes',
  'ProtectControlGroups=yes',
  'ProtectClock=yes',
  'ProtectHostname=yes',
  'RestrictSUIDSGID=yes',
  'RestrictNamespaces=yes',
  'LockPersonality=yes',
  'ProtectProc=invisible',
  'ProcSubset=pid',
  'UMask=0002',
  // her var is an empty read-only tmpfs; only the workspace is bound back in, writable
  `TemporaryFileSystem=${VAR}:ro`,
  `BindPaths=${WORKSPACE}`,
  'InaccessiblePaths=-/opt/thea',
  'InaccessiblePaths=-/opt/holobionte',
  'InaccessiblePaths=-/opt/thea2-workshop',
  'InaccessiblePaths=-/etc/thea2',
  'InaccessiblePaths=-/root',
  'InaccessiblePaths=-/home',
  'InaccessiblePaths=-/run/tailscale',
  'InaccessiblePaths=-/var/run/tailscale',
  'InaccessiblePaths=-/run/docker.sock',
  // the internet yes; this box, its neighbours and the tailnet no (allow wins: DNS through the stub)
  'IPAddressAllow=127.0.0.53/32',
  `IPAddressDeny=localhost link-local multicast 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 fc00::/7 ${ownAddresses().join(' ')}`.trim(),
  'MemoryMax=2G',
  'TasksMax=256',
  'CPUQuota=200%',
  `RuntimeMaxSec=${timeoutSec}`,
].flatMap((p) => ['-p', p]);

const handsEnv = () =>
  [
    `HOME=${WORKSPACE}`,
    `PATH=${WORKSPACE}/.local/bin:/usr/local/bin:/usr/bin:/bin`,
    'LANG=C.UTF-8',
    'TERM=dumb',
    'PAGER=cat',
    'GIT_PAGER=cat',
    `TZ=${HANDS_TZ}`,
  ].flatMap((e) => ['-E', e]);

/** Head and tail of a stream, bounded. */
const capture = () => {
  let head = '';
  let tail = '';
  let total = 0;
  return {
    push: (s) => {
      total += s.length;
      if (head.length < SHELL_OUT / 2) {
        const room = SHELL_OUT / 2 - head.length;
        head += s.slice(0, room);
        s = s.slice(room);
      }
      if (s !== '') tail = (tail + s).slice(-SHELL_OUT / 2);
    },
    text: () => (total > head.length + tail.length ? `${head}\n…(${total - head.length - tail.length} characters cut)…\n${tail}` : head + tail),
  };
};

const runShell = (command, timeoutSec) =>
  new Promise((resolve) => {
    const t = Math.min(Math.max(Number(timeoutSec) || 60, 5), 600);
    const t0 = process.hrtime.bigint();
    const args = [
      '--quiet', '--pipe', '--wait', '--collect', '--service-type=exec',
      `--uid=${HANDS_USER}`, `--gid=${HANDS_GROUP}`, `--working-directory=${WORKSPACE}`,
      ...handsEnv(), ...handsProps(t),
      '/bin/bash', '-lc', command,
    ];
    const child = spawn('systemd-run', args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: (t + 20) * 1000, killSignal: 'SIGKILL', env: { PATH: '/usr/bin:/bin' } });
    const out = capture();
    const err = capture();
    child.stdout.on('data', (c) => out.push(c.toString('utf8')));
    child.stderr.on('data', (c) => err.push(c.toString('utf8')));
    child.on('error', (e) => resolve({ exit: 127, stdout: '', stderr: String(e.message), timedOut: false }));
    child.on('close', (code, signal) => {
      const secs = Number(process.hrtime.bigint() - t0) / 1e9;
      const timedOut = signal === 'SIGKILL' || (code !== 0 && secs >= t - 0.5);
      resolve({ exit: code ?? 1, stdout: out.text(), stderr: err.text().slice(-8000), timedOut });
    });
  });

try { fs.mkdirSync(SOCK.replace(/\/[^/]+$/, ''), { recursive: true }); } catch {}
try { fs.unlinkSync(SOCK); } catch {}
let live = 0;
let shells = 0;
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
    if (req.op === 'shell') {
      if (typeof req.command !== 'string' || req.command.length === 0 || req.command.length > MAX_COMMAND) { sock.end(JSON.stringify({ exit: 2, stdout: '', stderr: 'command missing or too long', timedOut: false }) + '\n'); return; }
      if (shells >= MAX_SHELLS) { sock.end(JSON.stringify({ exit: 3, stdout: '', stderr: `${shells} commands are already running; try again in a moment`, timedOut: false }) + '\n'); return; }
      shells += 1;
      try {
        sock.end(JSON.stringify(await runShell(req.command, req.timeoutSec)) + '\n');
      } finally {
        shells -= 1;
      }
      return;
    }
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

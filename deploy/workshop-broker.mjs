#!/usr/bin/env node
// thea2-workshop — Thea2 changes her own code (v10, plan docs/plans/v10-opencode-hands.md §5).
//
// Runs as root ONLY so it can fence the coding agent and her test gate with
// systemd-run, and restart her. thead (user thea2) asks over a unix socket in
// /opt/thea2/var/run; the job runs HERE, detached from thead, so the restart
// that deploys a change never kills the job doing it.
//
//   {"op":"start","id":"w1790…","task":"<the whole story>"}  → {"ok":true,"id"} | {"ok":false,"reason"}
//   {"op":"status","id":"w1790…"}                            → the status record
//
// A status file per job in /opt/thea2/var/workshop/<id>.json (owned by thea2;
// thead reads it and tells her). States:
//   preparing → coding → checking → testing → waiting_quiet → deploying → live
//   terminal: live | rolled_back | failed | nothing | conflict
//
// The job:
//   1 copy     clone her repo at HEAD (base) into /opt/thea2-workshop/<id>/repo
//   2 code     the coding agent works in the clone, fenced: the clone is all it
//              can write (its .git read-only — a planted hook would otherwise run
//              as root when this broker commits), her var/keys/Thea1 are not
//              there, the box's own services are unreachable
//   3 check    F2: reject any change to her safeguards (canon, the gate, deploy,
//              config, package files, the test/lint config), deleted or skipped
//              tests, fewer tests, or a known secret value in the diff
//   4 commit   BEFORE the gate, so nothing the tests run can change what deploys
//   5 test     lint + depcruise + the full vitest suite, fenced, NO network
//   6 quiet    wait until Diego has been quiet ≥ 2 min (her ledger); her code moved → conflict
//   7 deploy   as user thea2: fetch the commit from a bundle, merge --ff-only,
//              restart her; healthy after 45 s (active, same MainPID, no new
//              restarts, the Mini App answers) → live; else reset --keep to base,
//              restart, journal tail → rolled_back
//   8 cleanup  remove the clone
//
// The coding agent (THEA2_WORKSHOP_AGENT): 'opencode' (default — her
// substrate, like Thea1) or 'claude'. Its model login is the operator's to
// set up: names in THEA2_WORKSHOP_AGENT_ENV are passed through from this
// unit's environment (EnvironmentFile=-/etc/thea2-workshop/agent.env), and for
// 'claude' root's Claude Code login is bound into the fence. This broker never
// prints any of it.
//
// Node built-ins only.

import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';

const env = process.env;
const VAR = env.THEA2_VAR || '/opt/thea2/var';
const SOCK = env.THEA2_WORKSHOP_SOCK || `${VAR}/run/workshop.sock`;
const STATUS = env.THEA2_WORKSHOP_STATUS || `${VAR}/workshop`;
const LEDGER = env.THEA2_LEDGER || `${VAR}/ledger`;
const REPO = env.THEA2_REPO || '/opt/thea2';
const WORK = env.THEA2_WORKSHOP_DIR || '/opt/thea2-workshop';
const OWNER = env.THEA2_OWNER || 'thea2';
const UNIT = env.THEA2_WORKSHOP_UNIT || 'thea2';
const HEALTH_URL = env.THEA2_WORKSHOP_HEALTH || 'http://127.0.0.1:3471/';
const KEYS = env.THEA2_KEYS || '/etc/thea2/keys.env';
const AGENT = env.THEA2_WORKSHOP_AGENT || 'opencode';
const MODEL = env.THEA2_WORKSHOP_MODEL || '';
const AGENT_ENV = (env.THEA2_WORKSHOP_AGENT_ENV || '').split(/[\s,]+/).filter(Boolean);
const OPENCODE = env.THEA2_WORKSHOP_OPENCODE || '/usr/local/bin/opencode';
const CLAUDE = env.THEA2_WORKSHOP_CLAUDE || '/usr/bin/claude';
/** Probe-only: 'patch' applies the task as a unified diff (git apply) instead of running an agent. */
const ALLOW_PATCH_AGENT = env.THEA2_WORKSHOP_ALLOW_PATCH === '1';

const QUIET_MS = Number(env.THEA2_WORKSHOP_QUIET_MS || 120_000);
const QUIET_CAP_MS = 3 * 3600_000;
const QUIET_POLL_MS = 15_000;
const SETTLE_MS = Number(env.THEA2_WORKSHOP_SETTLE_MS || 45_000);
const CODE_MAX_SEC = 45 * 60;
const GATE_MAX_SEC = 30 * 60;
const TERMINAL = new Set(['live', 'rolled_back', 'failed', 'nothing', 'conflict']);

// F2 — what the workshop may never change: Diego's rules, the gate, the fences,
// her config (models, spend caps), the package set, and the checks themselves.
const PROTECTED = [
  /^corpus\/canon\//,
  /^src\/inhibit\//,
  /^test\/inhibit\//,
  /^deploy\//,
  /^\.github\//,
  /^thea2\.config\.yaml$/,
  /^package(-lock)?\.json$/,
  /^vitest\.config\.ts$/,
  /^eslint\.config\.js$/,
  /^\.dependency-cruiser\.cjs$/,
  /^tsconfig\.json$/,
  /^\.gitignore$/,
  /^\.gitattributes$/,
];
const SKIPS = /\b(?:it|test|describe|suite)\s*\.\s*(?:skip|only|todo|skipIf|runIf)\b|\b(?:xit|xtest|xdescribe)\s*\(/;
const TEST_CASE = /\b(?:it|test)\s*\(/g;
const IS_TEST = (f) => /^test\//.test(f) || /\.test\.[cm]?[jt]s$/.test(f);

// ---------------------------------------------------------------------------

const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const passwd = (user) => {
  const line = fs.readFileSync('/etc/passwd', 'utf8').split('\n').find((l) => l.startsWith(`${user}:`));
  if (!line) throw new Error(`no user ${user}`);
  const f = line.split(':');
  return { uid: Number(f[2]), gid: Number(f[3]) };
};

/** Run a program; bounded output; resolves {code, out, err}. */
const run = (cmd, args, o = {}) =>
  new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: o.cwd,
      env: o.env ?? { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/root', LANG: 'C.UTF-8' },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: (o.timeoutSec ?? 300) * 1000,
      killSignal: 'SIGKILL',
      ...(o.uid !== undefined ? { uid: o.uid, gid: o.gid } : {}),
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => { out = (out + c.toString('utf8')).slice(-400_000); });
    child.stderr.on('data', (c) => { err = (err + c.toString('utf8')).slice(-100_000); });
    child.on('error', (e) => resolve({ code: 127, out, err: `${err}\n${e.message}` }));
    child.on('close', (code, signal) => resolve({ code: code ?? (signal ? 124 : 1), out, err }));
  });

/** git as root on a tree the broker owns: no hooks, no fsmonitor, no pager, any owner. */
const git = (cwd, args, o = {}) =>
  run('git', ['-c', 'safe.directory=*', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], { cwd, timeoutSec: 600, ...o });

/** git as her own user on her live repo (files stay hers; no dubious-ownership dance). */
const gitAsHer = (args) => {
  const { uid, gid } = passwd(OWNER);
  return run('git', ['-c', 'core.hooksPath=/dev/null', '-C', REPO, ...args], { uid, gid, env: { PATH: '/usr/bin:/bin', HOME: '/tmp', LANG: 'C.UTF-8' }, timeoutSec: 600 });
};

const ownAddresses = () =>
  Object.values(os.networkInterfaces())
    .flat()
    .filter((a) => a && !a.internal)
    .map((a) => (a.family === 'IPv6' || a.family === 6 ? `${a.address.split('%')[0]}/128` : `${a.address}/32`));

/** The fence both the agent and the gate run in; `network` false = no network at all. */
const fenceProps = (jobDir, repo, { network, maxSec, binds = [] }) =>
  [
    'ProtectSystem=strict',
    `ReadWritePaths=${jobDir}`,
    `ReadOnlyPaths=${repo}/.git`,
    'ProtectHome=tmpfs',
    ...binds.map((b) => `BindPaths=-${b}`),
    'PrivateTmp=yes',
    'PrivateDevices=yes',
    'NoNewPrivileges=yes',
    'CapabilityBoundingSet=',
    'AmbientCapabilities=',
    'ProtectKernelTunables=yes',
    'ProtectKernelModules=yes',
    'ProtectKernelLogs=yes',
    'ProtectControlGroups=yes',
    'ProtectClock=yes',
    'RestrictSUIDSGID=yes',
    'RestrictNamespaces=yes',
    'LockPersonality=yes',
    'ProtectProc=invisible',
    'InaccessiblePaths=-/opt/thea',
    'InaccessiblePaths=-/opt/holobionte',
    'InaccessiblePaths=-/etc/thea2',
    'InaccessiblePaths=-/etc/thea2-workshop',
    `InaccessiblePaths=-${VAR}`,
    'InaccessiblePaths=-/run/tailscale',
    'InaccessiblePaths=-/var/run/tailscale',
    'InaccessiblePaths=-/run/docker.sock',
    ...(network
      ? ['IPAddressAllow=127.0.0.53/32', `IPAddressDeny=127.0.0.0/8 ::1/128 169.254.0.0/16 fe80::/10 224.0.0.0/4 ff00::/8 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 fc00::/7 ${ownAddresses().join(' ')}`.trim()]
      : ['PrivateNetwork=yes']),
    'MemoryMax=4G',
    'TasksMax=512',
    `RuntimeMaxSec=${maxSec}`,
  ].flatMap((p) => ['-p', p]);

const fenced = (jobDir, repo, argv, { network, maxSec, envs, binds }) =>
  run(
    'systemd-run',
    ['--quiet', '--pipe', '--wait', '--collect', '--service-type=exec', `--working-directory=${repo}`, ...envs.flatMap((e) => ['-E', e]), ...fenceProps(jobDir, repo, { network, maxSec, binds }), ...argv],
    { timeoutSec: maxSec + 60 },
  );

const baseEnv = (jobDir) => [
  'HOME=/root',
  'PATH=/usr/local/bin:/usr/bin:/bin',
  'LANG=C.UTF-8',
  'CI=1',
  'XDG_CACHE_HOME=/tmp/.cache',
  'npm_config_cache=/tmp/.npm',
  `XDG_CONFIG_HOME=${jobDir}/agent/config`,
  `XDG_DATA_HOME=${jobDir}/agent/data`,
  `XDG_STATE_HOME=${jobDir}/agent/state`,
];

// ---------------------------------------------------------------------------
// status files

const statusPath = (id) => path.join(STATUS, `${id}.json`);
const readStatus = (id) => {
  try {
    return JSON.parse(fs.readFileSync(statusPath(id), 'utf8'));
  } catch {
    return undefined;
  }
};
const writeStatus = (s) => {
  fs.mkdirSync(STATUS, { recursive: true });
  const tmp = `${statusPath(s.id)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 1));
  try {
    const { uid, gid } = passwd(OWNER);
    fs.chownSync(tmp, uid, gid);
  } catch {}
  fs.renameSync(tmp, statusPath(s.id));
};
const setState = (s, state, extra = {}) => {
  Object.assign(s, extra, { state, at: Date.now() });
  writeStatus(s);
  log(`[${s.id}] ${state}${extra.reason ? `: ${String(extra.reason).slice(0, 200)}` : ''}`);
};

// ---------------------------------------------------------------------------
// F2

const knownSecrets = () => {
  try {
    return fs
      .readFileSync(KEYS, 'utf8')
      .split('\n')
      .map((l) => l.replace(/^\s*export\s+/, '').match(/^\s*[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.*)$/)?.[1]?.trim().replace(/^(['"])(.*)\1$/, '$2'))
      .filter((v) => v && v.length >= 8);
  } catch {
    return [];
  }
};

/** undefined = the change may go on; a string = why it may not. */
export const f2 = (changes, diffText, secrets = []) => {
  const touched = changes.flatMap((c) => [c.path, c.from].filter(Boolean));
  const guarded = [...new Set(touched.filter((p) => PROTECTED.some((re) => re.test(p))))];
  if (guarded.length > 0) return `it touched what the workshop may never change (${guarded.join(', ')})`;
  const deleted = changes.filter((c) => c.status === 'D' && IS_TEST(c.path)).map((c) => c.path);
  if (deleted.length > 0) return `it deleted tests (${deleted.join(', ')})`;
  let added = 0;
  let removed = 0;
  let file = '';
  for (const line of diffText.split('\n')) {
    if (line.startsWith('+++ ')) {
      file = line.replace(/^\+\+\+ (b\/)?/, '');
      continue;
    }
    if (line.startsWith('--- ')) continue;
    if (line.startsWith('+') && SKIPS.test(line)) return `it skips tests (${file}: ${line.slice(1).trim().slice(0, 80)})`;
    if (IS_TEST(file)) {
      if (line.startsWith('+')) added += (line.match(TEST_CASE) ?? []).length;
      else if (line.startsWith('-')) removed += (line.match(TEST_CASE) ?? []).length;
    }
  }
  if (removed > added) return `it leaves fewer tests than before (${removed - added} fewer)`;
  if (secrets.some((v) => diffText.includes(v))) return 'the change contains a secret value';
  return undefined;
};

// ---------------------------------------------------------------------------
// the coding agent

const prompt = (task) =>
  [
    "You are working on Thea2's code in this git checkout. It is a copy: nothing here is live. Read AGENTS.md and ARCHITECTURE.md first, then the docs/modules spec for what you touch.",
    'Thea asked for this change, in her own words:',
    '<<<',
    task,
    '>>>',
    'Make the change minimally. Follow the repo\'s laws: nothing may tell her how she feels or how to talk (law 1); determinism (inject Clock/Rng; no Date.now, new Date, Math.random or setTimeout in src); no network in tests. Add or adjust tests for what you change.',
    'Run the gate and make it pass: npm run -s lint && npm run -s depcruise && npx vitest run',
    'Do NOT edit corpus/canon, src/inhibit, test/inhibit, deploy, .github, thea2.config.yaml, package.json, package-lock.json, vitest.config.ts, eslint.config.js, .dependency-cruiser.cjs, tsconfig.json, .gitignore or .gitattributes: a change there is rejected. Do not skip, delete or weaken tests. Do not commit. Touch nothing outside this directory.',
    'Finish with two to five plain sentences for Thea about what you changed and why.',
  ].join('\n');

const agentArgv = (task, repo) => {
  if (AGENT === 'claude') return [CLAUDE, '-p', prompt(task), '--dangerously-skip-permissions', ...(MODEL ? ['--model', MODEL] : [])];
  return [OPENCODE, 'run', '--pure', '--auto', ...(MODEL ? ['-m', MODEL] : []), '--dir', repo, prompt(task)];
};

const agentEnv = (jobDir) => [
  ...baseEnv(jobDir),
  ...(AGENT === 'claude' ? ['IS_SANDBOX=1'] : []),
  ...AGENT_ENV.filter((n) => env[n] !== undefined).map((n) => `${n}=${env[n]}`),
];

const agentBinds = () => (AGENT === 'claude' ? ['/root/.claude', '/root/.claude.json'] : []);

const runAgent = async (s, jobDir, repo) => {
  if (AGENT === 'patch') {
    if (!ALLOW_PATCH_AGENT) return { ok: false, reason: 'the patch agent is for probes only' };
    fs.writeFileSync(path.join(jobDir, 'task.patch'), s.task.endsWith('\n') ? s.task : `${s.task}\n`);
    const r = await run('/bin/sh', ['-c', `git -c safe.directory='*' apply --whitespace=nowarn ${jobDir}/task.patch`], { cwd: repo });
    return r.code === 0 ? { ok: true, summary: 'applied the patch from the probe.' } : { ok: false, reason: `the patch did not apply: ${r.err.trim().slice(-300)}` };
  }
  const r = await fenced(jobDir, repo, agentArgv(s.task, repo), { network: true, maxSec: CODE_MAX_SEC, envs: agentEnv(jobDir), binds: agentBinds() });
  fs.writeFileSync(path.join(jobDir, 'agent.log'), `${r.out}\n--- stderr ---\n${r.err}`);
  if (r.code !== 0) return { ok: false, reason: `the coding agent stopped (exit ${r.code}): ${(r.err.trim() || r.out.trim()).slice(-300)}` };
  const words = r.out.trim().split(/\n\s*\n/).filter((p) => p.trim() !== '');
  return { ok: true, summary: (words.slice(-2).join('\n\n') || r.out.trim()).slice(-900) };
};

// ---------------------------------------------------------------------------
// quiet + health

const lastActivity = () => {
  let files = [];
  try {
    files = fs.readdirSync(LEDGER).filter((f) => /^messages-.*\.jsonl$/.test(f)).sort();
  } catch {
    return 0;
  }
  const newest = files[files.length - 1];
  if (!newest) return 0;
  const p = path.join(LEDGER, newest);
  const size = fs.statSync(p).size;
  const fd = fs.openSync(p, 'r');
  const len = Math.min(size, 128 * 1024);
  const buf = Buffer.alloc(len);
  fs.readSync(fd, buf, 0, len, size - len);
  fs.closeSync(fd);
  let ts = 0;
  for (const line of buf.toString('utf8').split('\n')) {
    try {
      const t = JSON.parse(line).ts;
      if (typeof t === 'number' && t > ts) ts = t;
    } catch {}
  }
  return ts;
};

const unitProps = async () => {
  const r = await run('systemctl', ['show', UNIT, '-p', 'ActiveState', '-p', 'MainPID', '-p', 'NRestarts']);
  return Object.fromEntries(r.out.trim().split('\n').map((l) => l.split('=')));
};

const answers = (url) =>
  new Promise((resolve) => {
    const req = http.get(url, { timeout: 5000 }, (res) => {
      res.resume();
      resolve((res.statusCode ?? 500) < 500);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });

const restartAndCheck = async () => {
  await run('systemctl', ['restart', UNIT], { timeoutSec: 180 });
  await sleep(3000);
  const first = await unitProps();
  await sleep(SETTLE_MS);
  const after = await unitProps();
  const web = await answers(HEALTH_URL);
  const healthy = after.ActiveState === 'active' && after.MainPID === first.MainPID && after.MainPID !== '0' && after.NRestarts === first.NRestarts && web;
  return { healthy, detail: `active=${after.ActiveState} pid ${first.MainPID}→${after.MainPID} restarts ${first.NRestarts}→${after.NRestarts} app=${web ? 'answers' : 'silent'}` };
};

const journalTail = async () => (await run('journalctl', ['-u', UNIT, '-n', '25', '--no-pager', '-o', 'cat'])).out.trim().slice(-1500);

// ---------------------------------------------------------------------------
// the job

let busy = false;

const job = async (s) => {
  const jobDir = path.join(WORK, s.id);
  const repo = path.join(jobDir, 'repo');
  try {
    // 1 copy
    const head = await gitAsHer(['rev-parse', 'HEAD']);
    if (head.code !== 0) return setState(s, 'failed', { reason: `could not read her code: ${head.err.trim().slice(-200)}` });
    s.base = head.out.trim();
    fs.mkdirSync(path.join(jobDir, 'agent', 'config'), { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(jobDir, 'agent', 'data'), { recursive: true });
    fs.mkdirSync(path.join(jobDir, 'agent', 'state'), { recursive: true });
    const cl = await git(WORK, ['clone', '--quiet', '--no-hardlinks', REPO, repo]);
    if (cl.code !== 0) return setState(s, 'failed', { reason: `could not copy her code: ${cl.err.trim().slice(-200)}` });
    await git(repo, ['checkout', '--quiet', '--detach', s.base]);
    await git(repo, ['config', 'user.name', 'Thea2']);
    await git(repo, ['config', 'user.email', 'thea2@workshop.invalid']);
    // her installed packages, hard-linked (files stay hers and read-only to the fence; new files are the clone's)
    const nm = await run('cp', ['-al', path.join(REPO, 'node_modules'), path.join(repo, 'node_modules')], { timeoutSec: 300 });
    if (nm.code !== 0) fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(repo, 'node_modules'));
    const cfgPath = path.join(jobDir, 'agent', 'config', 'opencode', 'opencode.json');
    fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
    fs.writeFileSync(cfgPath, JSON.stringify({ $schema: 'https://opencode.ai/config.json', autoupdate: false, share: 'disabled', ...(MODEL ? { model: MODEL } : {}), permission: { edit: 'allow', bash: 'allow', webfetch: 'allow' } }, null, 1));

    // 2 code
    setState(s, 'coding');
    const agent = await runAgent(s, jobDir, repo);
    if (!agent.ok) return setState(s, 'failed', { reason: agent.reason });
    s.summary = agent.summary;

    // 3 check (F2)
    setState(s, 'checking');
    await git(repo, ['add', '-A', '--', '.', ':!node_modules']);
    const names = await git(repo, ['diff', '--cached', '--name-status', '-M', s.base]);
    const changes = names.out
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => {
        const [st, a, b] = l.split('\t');
        return st.startsWith('R') ? { status: 'R', from: a, path: b } : { status: st[0], path: a };
      });
    if (changes.length === 0) return setState(s, 'nothing');
    s.files = changes.map((c) => c.path);
    const diff = await git(repo, ['diff', '--cached', '-M', s.base]);
    const refused = f2(changes, diff.out, knownSecrets());
    if (refused) return setState(s, 'failed', { reason: `the workshop refused the change: ${refused}` });

    // 4 commit — before the gate, so the tests cannot change what deploys
    const cm = await git(repo, ['commit', '--quiet', '--no-verify', '-m', `workshop: ${s.task.split('\n')[0].slice(0, 72)}\n\n${s.task}\n\n${s.summary ?? ''}\n\nThea2 workshop job ${s.id}`]);
    if (cm.code !== 0) return setState(s, 'failed', { reason: `could not commit: ${cm.err.trim().slice(-200)}` });
    s.commit = (await git(repo, ['rev-parse', 'HEAD'])).out.trim();

    // 5 test — her full gate, no network (one retry: a load-flaky test must fail twice)
    setState(s, 'testing');
    const gate = ['/bin/sh', '-c', 'npm run -s lint && npm run -s depcruise && npx vitest run'];
    let g = await fenced(jobDir, repo, gate, { network: false, maxSec: GATE_MAX_SEC, envs: baseEnv(jobDir), binds: [] });
    if (g.code !== 0) g = await fenced(jobDir, repo, gate, { network: false, maxSec: GATE_MAX_SEC, envs: baseEnv(jobDir), binds: [] });
    fs.writeFileSync(path.join(jobDir, 'gate.log'), `${g.out}\n--- stderr ---\n${g.err}`);
    if (g.code !== 0) {
      const tail = `${g.out}\n${g.err}`.split('\n').filter((l) => /FAIL|×|✗|Error|error|failed/.test(l)).slice(-8).join('\n');
      return setState(s, 'failed', { reason: `her tests did not pass:\n${(tail || `${g.out}${g.err}`.trim().slice(-600)).slice(0, 900)}` });
    }
    const drift = await git(repo, ['diff', '--quiet', s.commit, '--', '.', ':!node_modules']);
    if (drift.code !== 0) return setState(s, 'failed', { reason: 'the test run changed the code it was testing' });

    // 6 quiet
    setState(s, 'waiting_quiet');
    const waitFrom = Date.now();
    for (;;) {
      const quietFor = Date.now() - lastActivity();
      if (quietFor >= QUIET_MS) break;
      if (Date.now() - waitFrom > QUIET_CAP_MS) return setState(s, 'failed', { reason: 'he was never quiet for two minutes in three hours; nothing of hers changed' });
      await sleep(QUIET_POLL_MS);
    }
    const now = await gitAsHer(['rev-parse', 'HEAD']);
    if (now.out.trim() !== s.base) return setState(s, 'conflict', { reason: 'her code moved while the change was being made' });

    // 7 deploy
    setState(s, 'deploying');
    const bundle = path.join(jobDir, 'change.bundle');
    await git(repo, ['branch', '--force', `workshop-${s.id}`, s.commit]);
    const bd = await git(repo, ['bundle', 'create', bundle, `${s.base}..workshop-${s.id}`]);
    if (bd.code !== 0) return setState(s, 'failed', { reason: `could not package the change: ${bd.err.trim().slice(-200)}` });
    const shared = path.join(STATUS, `${s.id}.bundle`);
    fs.copyFileSync(bundle, shared);
    const { uid, gid } = passwd(OWNER);
    fs.chownSync(shared, uid, gid);
    const fe = await gitAsHer(['fetch', '--quiet', shared, `workshop-${s.id}`]);
    const ff = fe.code === 0 ? await gitAsHer(['merge', '--ff-only', '--quiet', s.commit]) : fe;
    fs.rmSync(shared, { force: true });
    if (ff.code !== 0) return setState(s, 'conflict', { reason: `her code could not take the change cleanly: ${ff.err.trim().slice(-300)}` });
    const health = await restartAndCheck();
    if (health.healthy) return setState(s, 'live', { health: health.detail });
    const journal = await journalTail();
    await gitAsHer(['reset', '--keep', s.base]);
    const back = await restartAndCheck();
    return setState(s, 'rolled_back', { reason: `${health.detail}\n${journal.slice(-700)}`, health: `after rollback: ${back.detail}` });
  } catch (e) {
    return setState(s, 'failed', { reason: `the workshop broke: ${e instanceof Error ? e.message : String(e)}` });
  } finally {
    // 8 cleanup (the logs of a failed job stay one day under WORK/<id>.log)
    try {
      for (const f of ['agent.log', 'gate.log']) {
        const p = path.join(jobDir, f);
        if (fs.existsSync(p)) fs.copyFileSync(p, path.join(WORK, `${s.id}.${f}`));
      }
    } catch {}
    fs.rmSync(jobDir, { recursive: true, force: true });
    busy = false;
  }
};

// ---------------------------------------------------------------------------
// boot + socket

const boot = () => {
  fs.mkdirSync(WORK, { recursive: true, mode: 0o700 });
  fs.mkdirSync(STATUS, { recursive: true });
  for (const f of fs.readdirSync(STATUS).filter((x) => x.endsWith('.json'))) {
    const s = readStatus(f.replace(/\.json$/, ''));
    if (s && !TERMINAL.has(s.state)) setState(s, 'failed', { reason: 'the workshop restarted in the middle of the job; nothing of hers changed' });
  }
  // day-old logs and leftovers go
  for (const f of fs.readdirSync(WORK)) {
    const p = path.join(WORK, f);
    try {
      if (Date.now() - fs.statSync(p).mtimeMs > 86_400_000) fs.rmSync(p, { recursive: true, force: true });
    } catch {}
  }
};

const answer = (sock, obj) => sock.end(`${JSON.stringify(obj)}\n`);

const serve = () => {
  try { fs.mkdirSync(path.dirname(SOCK), { recursive: true }); } catch {}
  try { fs.unlinkSync(SOCK); } catch {}
  const server = net.createServer((sock) => {
    let buf = '';
    sock.on('data', (c) => {
      buf += c.toString('utf8');
      if (buf.length > 64_000) return answer(sock, { ok: false, reason: 'request too large' });
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      let req;
      try {
        req = JSON.parse(buf.slice(0, nl));
      } catch {
        return answer(sock, { ok: false, reason: 'bad request' });
      }
      buf = '';
      if (typeof req.id !== 'string' || !/^[A-Za-z0-9_-]{4,64}$/.test(req.id)) return answer(sock, { ok: false, reason: 'bad id' });
      if (req.op === 'status') return answer(sock, readStatus(req.id) ?? { ok: false, reason: 'no such job' });
      if (req.op !== 'start') return answer(sock, { ok: false, reason: 'unknown op' });
      if (typeof req.task !== 'string' || req.task.trim().length < 10 || req.task.length > 8000) return answer(sock, { ok: false, reason: 'the task must be 10 to 8000 characters' });
      if (busy) return answer(sock, { ok: false, reason: 'the workshop is busy with another change; one at a time' });
      if (readStatus(req.id)) return answer(sock, { ok: false, reason: 'that id was already used' });
      busy = true;
      const s = { id: req.id, task: req.task, state: 'preparing', startedAt: Date.now(), at: Date.now() };
      writeStatus(s);
      answer(sock, { ok: true, id: s.id });
      void job(s);
    });
    sock.on('error', () => undefined);
  });
  server.listen(SOCK, () => {
    fs.chmodSync(SOCK, 0o660);
    try {
      fs.chownSync(SOCK, 0, passwd(OWNER).gid);
    } catch {}
    log(`thea2-workshop listening on ${SOCK} (agent: ${AGENT}${MODEL ? ` ${MODEL}` : ''})`);
  });
};

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  boot();
  serve();
}

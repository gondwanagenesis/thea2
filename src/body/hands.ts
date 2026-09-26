// v10 body — her hands: OpenCode's built-ins (shell, read, write, edit, ls,
// grep, glob) inside her own loop, over a workspace she owns (<var>/workspace).
// The model-facing names are OpenCode's because the coding models are trained
// on them; they sit beside the house tools (read_file / list_files), which read
// her memory and refs, not her workspace.
//
// F1 (plan v10 §1): her shell never sees a secret or anyone else's data. In
// prod every command runs through the thea2-exec broker as its own user
// (thea2-hands), which sees the workspace and none of her var, keys, Thea1 or
// /root. A shell running as thea2 itself could read her keys straight out of
// /proc/<thead>/environ, so an env scrub alone is not a fence. Every
// environment a hands process gets is still built from an allowlist (never
// process.env), and known secret values are redacted from everything a hands
// tool returns.

import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import type { ToolCtx, ToolRegistryEntry } from '../loop/index.js';
import type { Clock } from '../kernel/index.js';
import type { Exec } from './types.js';
import type { Jobs } from './jobs.js';

// ---------------------------------------------------------------------------
// The fence: a workspace-relative path never leads out of the workspace
// ---------------------------------------------------------------------------

export interface Fence {
  readonly root: string;
  /** Absolute path for a workspace path; undefined if it (or a link on the way) leads outside. */
  resolve(p: string): string | undefined;
  /** Workspace-relative form of an absolute path inside it ('.' for the root). */
  rel(abs: string): string;
}

export const openFence = (root: string): Fence => {
  const abs = path.resolve(root);
  fs.mkdirSync(abs, { recursive: true });
  const real = fs.realpathSync(abs);
  const within = (base: string, p: string): boolean => p === base || p.startsWith(base + path.sep);
  const resolve = (p: string): string | undefined => {
    const lexical = path.resolve(abs, p.trim() === '' ? '.' : p.trim());
    if (!within(abs, lexical)) return undefined;
    // the real place must be inside too: a link made in the workspace never leads out of it
    let probe = lexical;
    for (;;) {
      let exists = true;
      try {
        fs.lstatSync(probe);
      } catch {
        exists = false;
      }
      if (exists) {
        try {
          return within(real, fs.realpathSync(probe)) ? lexical : undefined;
        } catch {
          return undefined; // a dangling link: where it points is not knowable, so not followed
        }
      }
      const up = path.dirname(probe);
      if (up === probe) return undefined;
      probe = up;
    }
  };
  return { root: abs, resolve, rel: (p) => path.relative(abs, p).split(path.sep).join('/') || '.' };
};

// ---------------------------------------------------------------------------
// F1: the environment a hands process gets, and what comes back out of it
// ---------------------------------------------------------------------------

const KEEP_ENV = ['PATH', 'LANG', 'LC_ALL', 'TZ'] as const;
/** Windows dev boxes only (absent on the VPS): a child process cannot start without them. */
const KEEP_ENV_WIN = ['SystemRoot', 'WINDIR', 'TEMP', 'TMP'] as const;
const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i;

/** An allowlist, never a copy of process.env (which carries her keys from the unit's EnvironmentFile). */
export const safeEnv = (home: string, from: Record<string, string | undefined> = process.env): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const k of [...KEEP_ENV, ...(process.platform === 'win32' ? KEEP_ENV_WIN : [])]) {
    const v = from[k];
    if (v !== undefined && !SECRET_NAME.test(k)) out[k] = v;
  }
  out['HOME'] = home;
  out['LANG'] ??= 'C.UTF-8';
  out['TERM'] = 'dumb';
  out['PAGER'] = 'cat';
  out['GIT_PAGER'] = 'cat';
  return out;
};

/** Replaces every known secret value (≥ 8 chars) with [redacted]. */
export const redactor = (secrets: readonly string[]): ((s: string) => string) => {
  const vals = [...new Set(secrets.filter((x) => x.length >= 8))].sort((a, b) => b.length - a.length);
  return (s) => {
    let out = s;
    for (const v of vals) if (out.includes(v)) out = out.split(v).join('[redacted]');
    return out;
  };
};

// ---------------------------------------------------------------------------
// The shell: a broker in prod (its own user), a local runner on a dev box
// ---------------------------------------------------------------------------

export interface ShellResult {
  exit: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface ShellRunner {
  /** 'broker' = runs as its own user (prod); 'local' = runs as this process's user (dev, tests). */
  readonly kind: 'broker' | 'local';
  run(command: string, timeoutSec: number): Promise<ShellResult>;
}

const CAPTURE_MAX = 256 * 1024;

/** A captured stream, head and tail kept when it is larger than the cap. */
const readCapped = (file: string): string => {
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    return '';
  }
  if (size <= CAPTURE_MAX) return fs.readFileSync(file, 'utf8');
  const fd = fs.openSync(file, 'r');
  try {
    const half = CAPTURE_MAX / 2;
    const head = Buffer.alloc(half);
    const tail = Buffer.alloc(half);
    fs.readSync(fd, head, 0, half, 0);
    fs.readSync(fd, tail, 0, half, size - half);
    return `${head.toString('utf8')}\n…(${size - CAPTURE_MAX} bytes cut)…\n${tail.toString('utf8')}`;
  } finally {
    fs.closeSync(fd);
  }
};

/**
 * Runs `bash -lc <command>` as this process's user with an allowlisted env.
 * Output goes to files, not pipes: a job she backgrounds (`server &`) would
 * hold a pipe open and the call would never return. When the shell exits, the
 * whole process group goes with it (as the broker's transient unit does).
 * The timeout is spawn's own (SIGKILL), so no timer of ours runs.
 */
export const localShell = (o: { home: string; scratch: string; clock: Clock; shell?: string | undefined }): ShellRunner => {
  let n = 0;
  return {
    kind: 'local',
    run: (command, timeoutSec) =>
      new Promise((resolve) => {
        fs.mkdirSync(o.scratch, { recursive: true });
        const base = path.join(o.scratch, `shell-${o.clock.epochMs()}-${process.pid}-${++n}`);
        const outFd = fs.openSync(`${base}.out`, 'w');
        const errFd = fs.openSync(`${base}.err`, 'w');
        const posix = process.platform !== 'win32';
        const child = spawn(o.shell ?? 'bash', ['-lc', command], {
          cwd: o.home,
          env: safeEnv(o.home),
          stdio: ['ignore', outFd, errFd],
          timeout: timeoutSec * 1000,
          killSignal: 'SIGKILL',
          detached: posix,
          windowsHide: true,
        });
        fs.closeSync(outFd);
        fs.closeSync(errFd);
        let done = false;
        const finish = (exit: number, timedOut: boolean, extra = ''): void => {
          if (done) return;
          done = true;
          if (posix && child.pid !== undefined) {
            try {
              process.kill(-child.pid, 'SIGKILL');
            } catch {
              // the group is already gone
            }
          }
          const stdout = readCapped(`${base}.out`);
          const stderr = readCapped(`${base}.err`) + extra;
          for (const f of [`${base}.out`, `${base}.err`]) {
            try {
              fs.rmSync(f, { force: true });
            } catch {
              // a leftover capture file in scratch is harmless
            }
          }
          resolve({ exit, stdout, stderr, timedOut });
        };
        child.on('error', (e) => finish(127, false, e.message));
        child.on('exit', (code, signal) => finish(code ?? (signal === 'SIGKILL' ? 124 : 1), code === null && signal === 'SIGKILL'));
      }),
  };
};

/** The thea2-exec broker's shell op (deploy/exec-broker.mjs): the command runs as thea2-hands in a transient unit. */
export const brokerShell = (sock: string): ShellRunner => ({
  kind: 'broker',
  run: (command, timeoutSec) =>
    new Promise((resolve, reject) => {
      const c = net.createConnection(sock);
      let buf = '';
      c.setTimeout((timeoutSec + 30) * 1000, () => {
        c.destroy();
        reject(new Error('the shell did not answer in time'));
      });
      c.on('connect', () => c.write(`${JSON.stringify({ op: 'shell', command, timeoutSec })}\n`));
      c.on('data', (d) => {
        buf += d.toString('utf8');
      });
      c.on('end', () => {
        try {
          resolve(JSON.parse(buf.trim()) as ShellResult);
        } catch {
          reject(new Error('the shell gave nothing back'));
        }
      });
      c.on('error', (e) => reject(new Error(/ENOENT|ECONNREFUSED/.test(e.message) ? 'the shell service is not running' : e.message)));
    }),
});

// ---------------------------------------------------------------------------
// Walking the workspace (never through links) and globs
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.venv']);
const WALK_MAX = 20_000;

/** Every regular file under dir (workspace links are not followed), up to WALK_MAX. */
const walkFiles = (dir: string): string[] => {
  const out: string[] = [];
  const stack = [dir];
  while (stack.length > 0 && out.length < WALK_MAX) {
    const d = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) stack.push(p);
      } else if (e.isFile()) out.push(p);
    }
  }
  return out.sort();
};

/** A glob as a RegExp over a /-separated relative path: ** any depth, * within a name, ? one char, {a,b}. */
export const globToRegExp = (glob: string): RegExp => {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        const slash = glob[i + 2] === '/';
        re += slash ? '(?:.*/)?' : '.*';
        i += slash ? 2 : 1;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') re += '(?:';
    else if (c === '}') re += ')';
    else if (c === ',') re += glob.slice(0, i).lastIndexOf('{') > glob.slice(0, i).lastIndexOf('}') ? '|' : ',';
    else re += /[.+^$()|[\]\\]/.test(c) ? `\\${c}` : c;
  }
  return new RegExp(`^${re}$`);
};

/** ripgrep's rule: a glob with no slash matches the file's name at any depth. */
const globMatcher = (glob: string): ((rel: string) => boolean) => {
  const re = globToRegExp(glob);
  return glob.includes('/') ? (rel) => re.test(rel) : (rel) => re.test(rel.slice(rel.lastIndexOf('/') + 1));
};

const size = (n: number): string => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

const clip = (s: string, max: number): string => (s.length <= max ? s : `${s.slice(0, max / 2)}\n…(${s.length - max} characters cut)…\n${s.slice(-max / 2)}`);

export const shellWords = (r: ShellResult): string => {
  const parts: string[] = [];
  if (r.stdout.trim() !== '') parts.push(clip(r.stdout, 12_000));
  if (r.timedOut) parts.push('[the command ran out of time and was stopped]');
  if (r.stderr.trim() !== '') parts.push(`[stderr]\n${clip(r.stderr, 4000)}`);
  if (parts.length === 0) parts.push('(no output)');
  return `${parts.join('\n\n')}\n[exit ${r.exit}]`;
};

/** Files her hands make stay editable by her shell's user (same group): dirs setgid 2775, files 664. */
const shareMode = (p: string, mode: number): void => {
  try {
    fs.chmodSync(p, mode);
  } catch {
    // not hers to chmod (made by the shell's user) — the group bits already allow it
  }
};

const mkdirShared = (dir: string): void => {
  const missing: string[] = [];
  for (let d = dir; !fs.existsSync(d); d = path.dirname(d)) {
    missing.push(d);
    if (path.dirname(d) === d) break;
  }
  fs.mkdirSync(dir, { recursive: true });
  for (const d of missing) shareMode(d, 0o2775);
};

const READ_LINES = 2000;
const LINE_MAX = 2000;
const READ_BYTES_MAX = 20 * 1024 * 1024;
const GREP_LINES = 200;
const GLOB_MAX = 100;
const LS_MAX = 300;

// ---------------------------------------------------------------------------
// The tools (class 'hands')
// ---------------------------------------------------------------------------

export interface HandsDeps {
  fence: Fence;
  shell: ShellRunner;
  /** For ripgrep (falls back to a scan in JS when rg is absent). */
  exec: Exec;
  /** Runtime secret values, redacted from every result. */
  secrets: readonly string[];
  /**
   * Her own turn gives a tool ~10 s (the loop's cut-off), so in a turn a
   * command gets IN_TURN_MS; past that it carries on as a detached job and
   * what it printed comes back to her as a moment she lives (like a selfie).
   * Casts and calls (depth ≥ 1) have no cut-off and simply wait. Absent =
   * always wait (unit tests).
   */
  detach?: { jobs: Jobs; clock: Clock; selfEntry(goal: string): void; inTurnMs?: number | undefined } | undefined;
}

/** Inside the loop's 10 s tool cut-off, with room to answer. */
export const IN_TURN_MS = 8000;

type Entry = ToolRegistryEntry<never>;

export const HANDS_TOOLS = ['shell', 'read', 'write', 'edit', 'ls', 'grep', 'glob'] as const;

export const handsTools = (d: HandsDeps): Entry[] => {
  const redact = redactor(d.secrets);
  const outside = (p: string): string => `"${p}" is outside your workspace (paths are relative to it)`;
  const entry = <T>(name: string, description: string, parameters: Record<string, unknown>, schema: z.ZodType<T>, handler: (a: T, ctx: ToolCtx) => Promise<string>): Entry =>
    ({
      def: { name, description, parameters },
      input: schema,
      inhibitionMeta: { class: 'hands' },
      handler: async (a: T, ctx: ToolCtx) => {
        try {
          return redact(await handler(a, ctx));
        } catch (e) {
          return redact(`not done: ${e instanceof Error ? e.message.slice(0, 300) : String(e).slice(0, 300)}`);
        }
      },
    }) as unknown as Entry;

  const jsGrep = (re: RegExp, base: string, glob: string | undefined): string[] => {
    const match = glob !== undefined ? globMatcher(glob) : undefined;
    const hits: string[] = [];
    const files = fs.statSync(base).isFile() ? [base] : walkFiles(base);
    for (const f of files) {
      const rel = d.fence.rel(f);
      if (match !== undefined && !match(path.relative(base, f).split(path.sep).join('/') || path.basename(f))) continue;
      let text: string;
      try {
        if (fs.statSync(f).size > 2 * 1024 * 1024) continue;
        const buf = fs.readFileSync(f);
        if (buf.subarray(0, 8000).includes(0)) continue;
        text = buf.toString('utf8');
      } catch {
        continue;
      }
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length && hits.length < GREP_LINES; i++) {
        re.lastIndex = 0;
        if (re.test(lines[i]!)) hits.push(`${rel}:${i + 1}:${lines[i]!.slice(0, 300)}`);
      }
      if (hits.length >= GREP_LINES) break;
    }
    return hits;
  };

  return [
    entry(
      'shell',
      'Run a shell command (bash) in your workspace, like a terminal: build and run code, tests, git, pip install --user, npm, curl, unzip, anything. Your workspace is its home and working directory, and the only place it can write. Background processes end when the command ends. What it printed comes back, with the exit code; a command that takes longer than a few seconds carries on in the background and its output comes back to you when it finishes.',
      {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'the bash command line' },
          timeout: { type: 'integer', minimum: 5, maximum: 600, description: 'seconds (default 60, at most 600)' },
        },
        required: ['command'],
      },
      z.object({ command: z.string().min(1).max(100_000), timeout: z.number().int().min(5).max(600).optional() }),
      async (a, ctx) => {
        const run = d.shell.run(a.command, a.timeout ?? 60);
        const det = d.detach;
        if (det === undefined || ctx.depth > 0) return shellWords(await run);
        const settled = run.then(
          (r): { r: ShellResult } => ({ r }),
          (e: unknown): { e: string } => ({ e: e instanceof Error ? e.message : String(e) }),
        );
        const stop = new AbortController();
        const waitMs = det.inTurnMs ?? IN_TURN_MS;
        const later = det.clock.waitUntil(det.clock.epochMs() + waitMs, stop.signal).then(
          () => 'later' as const,
          () => 'aborted' as const,
        );
        const raced = await Promise.race([settled, later]);
        if (raced !== 'later' && raced !== 'aborted') {
          stop.abort();
          if ('e' in raced) throw new Error(raced.e);
          return shellWords(raced.r);
        }
        const short = a.command.replace(/\s+/g, ' ').slice(0, 80);
        const started = det.jobs.start('shell', a.command.slice(0, 120), ctx.turnId, async () => {
          const got = await settled;
          const words = 'e' in got ? `not done: ${got.e}` : shellWords(got.r);
          det.selfEntry(redact(`(the command you left running — "${short}" — finished:\n${clip(words, 2500)})`));
          return 'e' in got ? 'not done' : `exit ${got.r.exit}`;
        });
        // three things already running: wait for it here after all (the loop may cut it off)
        if (!started.ok) return shellWords(await run);
        return `still running after ${Math.round(waitMs / 1000)} s, so it carries on in the background (${started.id}); what it prints comes back to you when it finishes`;
      },
    ),
    entry(
      'read',
      'Read a file in your workspace, with line numbers. The first 2000 lines by default; offset and limit read further. Paths are relative to the workspace.',
      {
        type: 'object',
        properties: {
          path: { type: 'string' },
          offset: { type: 'integer', minimum: 1, description: 'first line to read (1-based)' },
          limit: { type: 'integer', minimum: 1, maximum: 10000, description: 'how many lines' },
        },
        required: ['path'],
      },
      z.object({ path: z.string().min(1).max(1000), offset: z.number().int().min(1).optional(), limit: z.number().int().min(1).max(10_000).optional() }),
      async (a) => {
        const p = d.fence.resolve(a.path);
        if (p === undefined) return outside(a.path);
        if (!fs.existsSync(p)) return `no file at ${a.path}`;
        const st = fs.statSync(p);
        if (st.isDirectory()) return `${a.path} is a folder (ls shows what is in it)`;
        if (st.size > READ_BYTES_MAX) return `${a.path} is ${size(st.size)}, too big to read whole; use shell (head, sed -n, grep) on it`;
        const buf = fs.readFileSync(p);
        if (buf.subarray(0, 8000).includes(0)) return `${a.path} is a binary file (${size(st.size)}); use shell to look inside it (file, xxd, unzip -l…)`;
        const lines = buf.toString('utf8').split(/\r?\n/);
        if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
        const from = (a.offset ?? 1) - 1;
        const to = Math.min(lines.length, from + (a.limit ?? READ_LINES));
        if (lines.length === 0 || (lines.length === 1 && lines[0] === '')) return `${a.path} is empty`;
        if (from >= lines.length) return `${a.path} has ${lines.length} lines; offset ${a.offset ?? 1} is past the end`;
        const body = lines
          .slice(from, to)
          .map((l, i) => `${String(from + i + 1).padStart(6)}\t${l.length > LINE_MAX ? `${l.slice(0, LINE_MAX)}…` : l}`)
          .join('\n');
        return to < lines.length || from > 0 ? `${body}\n(lines ${from + 1}-${to} of ${lines.length}${to < lines.length ? `; offset ${to + 1} reads on` : ''})` : body;
      },
    ),
    entry(
      'write',
      'Create or overwrite a file in your workspace with the whole content given (folders are made as needed). To change part of an existing file, edit is safer.',
      {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
      },
      z.object({ path: z.string().min(1).max(1000), content: z.string().max(5_000_000) }),
      async (a) => {
        const p = d.fence.resolve(a.path);
        if (p === undefined) return outside(a.path);
        if (fs.existsSync(p) && fs.statSync(p).isDirectory()) return `${a.path} is a folder`;
        mkdirShared(path.dirname(p));
        const existed = fs.existsSync(p);
        fs.writeFileSync(p, a.content);
        shareMode(p, 0o664);
        return `${existed ? 'overwrote' : 'wrote'} ${d.fence.rel(p)} (${Buffer.byteLength(a.content)} bytes)`;
      },
    ),
    entry(
      'edit',
      'Change a file in your workspace by exact replacement. old_string must appear in the file exactly once (copy it from read, with enough surrounding lines to be unique), or set replace_all to change every occurrence. An empty old_string creates a new file holding new_string.',
      {
        type: 'object',
        properties: {
          path: { type: 'string' },
          old_string: { type: 'string', description: 'the exact text to replace' },
          new_string: { type: 'string', description: 'what it becomes' },
          replace_all: { type: 'boolean', description: 'replace every occurrence (default false)' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
      z.object({ path: z.string().min(1).max(1000), old_string: z.string().max(2_000_000), new_string: z.string().max(2_000_000), replace_all: z.boolean().optional() }),
      async (a) => {
        const p = d.fence.resolve(a.path);
        if (p === undefined) return outside(a.path);
        const exists = fs.existsSync(p);
        if (a.old_string === '') {
          if (exists && fs.statSync(p).size > 0) return `${a.path} already exists and is not empty; old_string must be the text to replace (or use write to overwrite it)`;
          mkdirShared(path.dirname(p));
          fs.writeFileSync(p, a.new_string);
          shareMode(p, 0o664);
          return `created ${d.fence.rel(p)} (${Buffer.byteLength(a.new_string)} bytes)`;
        }
        if (!exists) return `no file at ${a.path} (an empty old_string creates one)`;
        if (fs.statSync(p).isDirectory()) return `${a.path} is a folder`;
        if (a.old_string === a.new_string) return 'old_string and new_string are the same; nothing to change';
        const text = fs.readFileSync(p, 'utf8');
        let oldS = a.old_string;
        let newS = a.new_string;
        // a file with CRLF line ends, an old_string written with \n: match it the way it is on disk
        if (!text.includes(oldS) && text.includes('\r\n') && !oldS.includes('\r')) {
          oldS = oldS.replace(/\n/g, '\r\n');
          newS = newS.replace(/\r?\n/g, '\r\n');
        }
        const count = text.split(oldS).length - 1;
        if (count === 0) return `old_string was not found in ${a.path}; read the file and copy the text exactly (spaces and indentation included)`;
        if (count > 1 && a.replace_all !== true) return `old_string matches ${count} places in ${a.path}; add more surrounding context to make it unique, or set replace_all`;
        const out = a.replace_all === true ? text.split(oldS).join(newS) : text.replace(oldS, () => newS);
        fs.writeFileSync(p, out);
        const line = text.slice(0, text.indexOf(oldS)).split('\n').length;
        return `edited ${d.fence.rel(p)}: ${a.replace_all === true ? `${count} replacement${count === 1 ? '' : 's'}` : `1 replacement at line ${line}`}`;
      },
    ),
    entry(
      'ls',
      'List a folder in your workspace (folders first, then files with sizes). No path = the workspace itself.',
      { type: 'object', properties: { path: { type: 'string' } } },
      z.object({ path: z.string().max(1000).optional() }),
      async (a) => {
        const p = d.fence.resolve(a.path ?? '.');
        if (p === undefined) return outside(a.path ?? '.');
        if (!fs.existsSync(p)) return `no folder at ${a.path ?? '.'}`;
        if (!fs.statSync(p).isDirectory()) return `${a.path} is a file (${size(fs.statSync(p).size)})`;
        const entries = fs.readdirSync(p, { withFileTypes: true });
        if (entries.length === 0) return `${d.fence.rel(p)}/ is empty`;
        const dirs = entries.filter((e) => e.isDirectory()).map((e) => `${e.name}/`).sort();
        const links = entries.filter((e) => e.isSymbolicLink()).map((e) => {
          let to = '?';
          try {
            to = fs.readlinkSync(path.join(p, e.name));
          } catch {
            // unreadable link
          }
          return `${e.name} -> ${to}`;
        });
        const files = entries
          .filter((e) => e.isFile())
          .map((e) => {
            let n = 0;
            try {
              n = fs.statSync(path.join(p, e.name)).size;
            } catch {
              // vanished between readdir and stat
            }
            return `${e.name}  (${size(n)})`;
          })
          .sort();
        const all = [...dirs, ...links.sort(), ...files];
        return `${d.fence.rel(p)}/\n${all.slice(0, LS_MAX).join('\n')}${all.length > LS_MAX ? `\n…and ${all.length - LS_MAX} more` : ''}`;
      },
    ),
    entry(
      'grep',
      'Search file contents in your workspace with a regular expression (ripgrep). Returns path:line:text for each hit. glob narrows which files (e.g. "*.py", "src/**/*.ts").',
      {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'a regular expression' },
          path: { type: 'string', description: 'a folder or file to search (default: the whole workspace)' },
          glob: { type: 'string' },
        },
        required: ['pattern'],
      },
      z.object({ pattern: z.string().min(1).max(2000), path: z.string().max(1000).optional(), glob: z.string().max(200).optional() }),
      async (a) => {
        const p = d.fence.resolve(a.path ?? '.');
        if (p === undefined) return outside(a.path ?? '.');
        if (!fs.existsSync(p)) return `nothing at ${a.path ?? '.'}`;
        const target = d.fence.rel(p);
        const rg = await d.exec.run(
          'rg',
          ['-n', '--no-heading', '--color', 'never', '--max-columns', '300', '--max-count', '50', '-e', a.pattern, ...(a.glob !== undefined ? ['-g', a.glob] : []), '--', target],
          { cwd: d.fence.root, env: safeEnv(d.fence.root), timeoutMs: 30_000 },
        );
        let lines: string[];
        if (rg.code === 127) {
          let re: RegExp;
          try {
            re = new RegExp(a.pattern);
          } catch (e) {
            return `not a valid regular expression: ${e instanceof Error ? e.message : String(e)}`;
          }
          lines = jsGrep(re, p, a.glob);
        } else if (rg.code === 1) lines = [];
        else if (rg.code !== 0) return `grep failed: ${rg.stderr.trim().slice(0, 400)}`;
        else lines = Buffer.from(rg.stdout).toString('utf8').split('\n').filter((l) => l !== '');
        if (lines.length === 0) return `no matches for ${JSON.stringify(a.pattern)} in ${target}`;
        const shown = lines.slice(0, GREP_LINES).map((l) => (l.startsWith('./') ? l.slice(2) : l));
        return `${shown.join('\n')}${lines.length > GREP_LINES ? `\n…(${lines.length - GREP_LINES} more; narrow the pattern, path or glob)` : ''}`;
      },
    ),
    entry(
      'glob',
      'Find files in your workspace by name pattern ("**/*.py", "src/*.ts", "*.md" = at any depth), newest first.',
      {
        type: 'object',
        properties: { pattern: { type: 'string' }, path: { type: 'string', description: 'the folder to look in (default: the whole workspace)' } },
        required: ['pattern'],
      },
      z.object({ pattern: z.string().min(1).max(500), path: z.string().max(1000).optional() }),
      async (a) => {
        const base = d.fence.resolve(a.path ?? '.');
        if (base === undefined) return outside(a.path ?? '.');
        if (!fs.existsSync(base) || !fs.statSync(base).isDirectory()) return `no folder at ${a.path ?? '.'}`;
        const match = globMatcher(a.pattern);
        const found = walkFiles(base)
          .filter((f) => match(path.relative(base, f).split(path.sep).join('/')))
          .map((f) => {
            let t = 0;
            try {
              t = fs.statSync(f).mtimeMs;
            } catch {
              // vanished
            }
            return { f, t };
          })
          .sort((x, y) => y.t - x.t || x.f.localeCompare(y.f));
        if (found.length === 0) return `no files match ${a.pattern}`;
        return `${found
          .slice(0, GLOB_MAX)
          .map((x) => d.fence.rel(x.f))
          .join('\n')}${found.length > GLOB_MAX ? `\n…and ${found.length - GLOB_MAX} more (narrow the pattern)` : ''}`;
      },
    ),
  ];
};

// v10 hands (plan docs/plans/v10-opencode-hands.md §3): OpenCode's built-ins
// over a workspace she owns. Paths never lead out of it; her shell's
// environment is an allowlist (no keys ride it) and a known secret value never
// comes back out; edit is exact and unique-or-replace_all; and what her hands
// do in a turn is remembered as her acts.

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { startThead } from '../../src/app/index.js';
import { TestClock } from '../../src/kernel/index.js';
import { actsOf, TELLING_PATTERNS } from '../../src/mind/index.js';
import type { ToolCtx, ToolRegistryEntry } from '../../src/loop/index.js';
import { globToRegExp, handsTools, localShell, openFence, safeEnv, HANDS_TOOLS, type Exec } from '../../src/body/index.js';
import { inbound, runToQuiescent, T0, tmpDir } from '../mind/helpers.js';
import { bootV9, scriptedShell, TEST_BASH } from './helpers.js';

const SECRET = 'sk-fake-hands-secret-0123456789abcdef';
const noRg: Exec = { run: async () => ({ code: 127, stdout: new Uint8Array(), stderr: 'rg: not found' }) };

const setup = (o: { exec?: Exec; secrets?: string[] } = {}) => {
  const clock = new TestClock(T0);
  const root = tmpDir('thea2-ws-');
  const fence = openFence(path.join(root, 'workspace'));
  const shell = localShell({ home: fence.root, scratch: path.join(root, 'scratch'), clock, shell: TEST_BASH });
  const tools = handsTools({ fence, shell, exec: o.exec ?? noRg, secrets: o.secrets ?? [] });
  const byName = new Map(tools.map((t) => [t.def.name, t as unknown as ToolRegistryEntry<Record<string, unknown>>]));
  const ctx = { entry: 'turn', turnId: 't1', depth: 0 } as unknown as ToolCtx;
  const call = async (name: string, args: Record<string, unknown>): Promise<string> => {
    const t = byName.get(name)!;
    const parsed = t.input.safeParse(args);
    if (!parsed.success) throw new Error(`bad args for ${name}: ${JSON.stringify(parsed.error.issues)}`);
    return String(await t.handler(parsed.data, ctx));
  };
  return { root, fence, tools, call };
};

describe('v10 hands — files', () => {
  it('write then read round-trips, and read is line-numbered (cat -n style)', async () => {
    const h = setup();
    expect(await h.call('write', { path: 'src/hello.py', content: 'a = 6\nb = 7\nprint(a * b)\n' })).toBe('wrote src/hello.py (25 bytes)');
    expect(fs.readFileSync(path.join(h.fence.root, 'src', 'hello.py'), 'utf8')).toBe('a = 6\nb = 7\nprint(a * b)\n');
    expect(await h.call('read', { path: 'src/hello.py' })).toBe('     1\ta = 6\n     2\tb = 7\n     3\tprint(a * b)');
    expect(await h.call('read', { path: 'src/hello.py', offset: 2, limit: 1 })).toBe('     2\tb = 7\n(lines 2-2 of 3; offset 3 reads on)');
    expect(await h.call('write', { path: 'src/hello.py', content: 'x' })).toBe('overwrote src/hello.py (1 bytes)');
    expect(await h.call('read', { path: 'nope.txt' })).toBe('no file at nope.txt');
  });

  it('edit replaces a unique string; refuses 0 matches and >1 without replace_all; replace_all replaces all; empty old_string creates', async () => {
    const h = setup();
    await h.call('write', { path: 'a.txt', content: 'one two\nthree two\nfour\n' });
    expect(await h.call('edit', { path: 'a.txt', old_string: 'four', new_string: 'FOUR' })).toBe('edited a.txt: 1 replacement at line 3');
    expect(await h.call('edit', { path: 'a.txt', old_string: 'five', new_string: 'x' })).toContain('old_string was not found in a.txt');
    expect(await h.call('edit', { path: 'a.txt', old_string: 'two', new_string: '2' })).toBe('old_string matches 2 places in a.txt; add more surrounding context to make it unique, or set replace_all');
    expect(fs.readFileSync(path.join(h.fence.root, 'a.txt'), 'utf8')).toBe('one two\nthree two\nFOUR\n'); // a refused edit changes nothing
    expect(await h.call('edit', { path: 'a.txt', old_string: 'three two', new_string: 'three 2' })).toBe('edited a.txt: 1 replacement at line 2');
    expect(await h.call('edit', { path: 'a.txt', old_string: 'o', new_string: '0', replace_all: true })).toBe('edited a.txt: 2 replacements');
    expect(fs.readFileSync(path.join(h.fence.root, 'a.txt'), 'utf8')).toBe('0ne tw0\nthree 2\nFOUR\n');
    expect(await h.call('edit', { path: 'new/b.md', old_string: '', new_string: '# hi\n' })).toBe('created new/b.md (5 bytes)');
    expect(await h.call('edit', { path: 'new/b.md', old_string: '', new_string: 'again' })).toContain('already exists and is not empty');
    // a CRLF file edited with \n text still matches, and keeps its line ends
    fs.writeFileSync(path.join(h.fence.root, 'crlf.txt'), 'alpha\r\nbeta\r\n');
    expect(await h.call('edit', { path: 'crlf.txt', old_string: 'alpha\nbeta', new_string: 'alpha\ngamma' })).toBe('edited crlf.txt: 1 replacement at line 1');
    expect(fs.readFileSync(path.join(h.fence.root, 'crlf.txt'), 'utf8')).toBe('alpha\r\ngamma\r\n');
  });

  it('a path that leaves the workspace is refused by every tool (and nothing is written outside)', async () => {
    const h = setup();
    const escapes = ['../../etc/passwd', '../outside.txt', path.resolve(h.root, 'outside.txt')];
    for (const p of escapes) {
      expect(await h.call('read', { path: p })).toContain('is outside your workspace');
      expect(await h.call('write', { path: p, content: 'x' })).toContain('is outside your workspace');
      expect(await h.call('edit', { path: p, old_string: '', new_string: 'x' })).toContain('is outside your workspace');
      expect(await h.call('ls', { path: p })).toContain('is outside your workspace');
      expect(await h.call('grep', { pattern: 'x', path: p })).toContain('is outside your workspace');
      expect(await h.call('glob', { pattern: '*', path: p })).toContain('is outside your workspace');
    }
    expect(fs.existsSync(path.join(h.root, 'outside.txt'))).toBe(false);
    // an absolute path INSIDE the workspace is fine
    expect(await h.call('write', { path: path.join(h.fence.root, 'in.txt'), content: 'ok' })).toBe('wrote in.txt (2 bytes)');
  });

  it('a link she makes inside the workspace never leads her tools out of it', async () => {
    const h = setup();
    fs.writeFileSync(path.join(h.root, 'secret.txt'), SECRET);
    let linked = true;
    try {
      fs.symlinkSync(path.join(h.root, 'secret.txt'), path.join(h.fence.root, 'link.txt'));
      fs.symlinkSync(h.root, path.join(h.fence.root, 'linkdir'), 'dir');
    } catch {
      linked = false; // Windows without the symlink privilege: no link can be made, so none can lead out
    }
    if (linked) {
      expect(await h.call('read', { path: 'link.txt' })).toContain('is outside your workspace');
      expect(await h.call('write', { path: 'link.txt', content: 'x' })).toContain('is outside your workspace');
      expect(await h.call('read', { path: 'linkdir/secret.txt' })).toContain('is outside your workspace');
      expect(await h.call('grep', { pattern: 'sk-fake' })).toContain('no matches'); // the scan does not follow links
      expect(fs.readFileSync(path.join(h.root, 'secret.txt'), 'utf8')).toBe(SECRET);
    }
    expect(openFence(h.fence.root).resolve('a/../../x')).toBeUndefined();
  });

  it('ls lists folders first, then files with sizes; grep and glob find things (JS scan when rg is absent)', async () => {
    const h = setup();
    await h.call('write', { path: 'src/app.py', content: 'def main():\n    return 42\n' });
    await h.call('write', { path: 'src/util/helpers.py', content: 'def helper():\n    pass\n' });
    await h.call('write', { path: 'README.md', content: '# project\nmain entry\n' });
    const ls = await h.call('ls', {});
    expect(ls.split('\n')).toEqual(['./', 'src/', 'README.md  (21 B)']);
    expect(await h.call('grep', { pattern: 'def \\w+' })).toBe(['src/app.py:1:def main():', 'src/util/helpers.py:1:def helper():'].sort().join('\n'));
    expect(await h.call('grep', { pattern: 'main', glob: '*.md' })).toBe('README.md:2:main entry');
    expect(await h.call('grep', { pattern: 'nothing-here' })).toBe('no matches for "nothing-here" in .');
    expect(await h.call('grep', { pattern: '(' })).toContain('not a valid regular expression');
    expect((await h.call('glob', { pattern: '*.py' })).split('\n').sort()).toEqual(['src/app.py', 'src/util/helpers.py']);
    expect(await h.call('glob', { pattern: 'src/*.py' })).toBe('src/app.py');
    expect(await h.call('glob', { pattern: '**/*.{md,txt}' })).toBe('README.md');
    expect(globToRegExp('src/**/*.ts').test('src/a/b/c.ts')).toBe(true);
    expect(globToRegExp('src/**/*.ts').test('src/c.ts')).toBe(true);
    expect(globToRegExp('*.ts').test('a/c.ts')).toBe(false);
  });

  it('grep uses ripgrep when it is there (and never hands it her environment)', async () => {
    const seen: Array<{ cmd: string; env: Record<string, string> | undefined; cwd: string | undefined }> = [];
    const rg: Exec = {
      run: async (cmd, _args, opts) => {
        seen.push({ cmd, env: opts?.env, cwd: opts?.cwd });
        return { code: 0, stdout: new TextEncoder().encode('./src/a.ts:3:const x = 1\n'), stderr: '' };
      },
    };
    const h = setup({ exec: rg });
    expect(await h.call('grep', { pattern: 'const' })).toBe('src/a.ts:3:const x = 1');
    expect(seen[0]!.cmd).toBe('rg');
    expect(seen[0]!.cwd).toBe(h.fence.root);
    expect(seen[0]!.env).toBeDefined();
    expect(Object.keys(seen[0]!.env!).some((k) => /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(k))).toBe(false);
  });
});

describe('v10 hands — the shell', () => {
  it('runs a command in the workspace, returns what it printed and the exit code', { timeout: 60_000 }, async () => {
    const h = setup();
    await h.call('write', { path: 'calc.sh', content: 'echo $((6 * 7))\n' });
    expect(await h.call('shell', { command: 'bash calc.sh' })).toBe('42\n\n[exit 0]');
    expect(await h.call('shell', { command: 'false' })).toBe('(no output)\n[exit 1]');
    expect(await h.call('shell', { command: 'echo oops >&2; exit 3' })).toBe('[stderr]\noops\n\n[exit 3]');
    // what the shell makes, the file tools see (same workspace)
    await h.call('shell', { command: 'mkdir -p out && echo made > out/x.txt' });
    expect(await h.call('read', { path: 'out/x.txt' })).toBe('     1\tmade');
  });

  it('a job she backgrounds does not hold the call open', { timeout: 60_000 }, async () => {
    const h = setup();
    expect(await h.call('shell', { command: 'sleep 3 & echo started' })).toBe('started\n\n[exit 0]');
  });

  it("F1: her shell's environment is an allowlist — a key in the process env never reaches it", { timeout: 60_000 }, async () => {
    process.env['THEA2_FAKE_OPENAI_KEY'] = SECRET;
    process.env['THEA2_HANDS_UNLISTED'] = 'not-on-the-list';
    try {
      const h = setup();
      const env = await h.call('shell', { command: 'env' });
      expect(env).not.toContain(SECRET);
      expect(env).not.toContain('THEA2_FAKE_OPENAI_KEY');
      expect(env).not.toContain('not-on-the-list');
      expect(env).toContain('TERM=dumb');
      // HOME is the workspace, which is also where it runs
      expect(await h.call('shell', { command: '[ "$HOME" -ef . ] && echo home-is-the-workspace' })).toBe('home-is-the-workspace\n\n[exit 0]');
      const e = safeEnv('/w', { PATH: '/usr/bin', OPENAI_API_KEY: 'x', LANG: 'en_US.UTF-8', GH_TOKEN: 'y' });
      expect(Object.keys(e).sort()).toEqual(['GIT_PAGER', 'HOME', 'LANG', 'PAGER', 'PATH', 'TERM']);
    } finally {
      delete process.env['THEA2_FAKE_OPENAI_KEY'];
      delete process.env['THEA2_HANDS_UNLISTED'];
    }
  });

  it('F1: a known secret value never comes back out of her hands (shell output, a file she reads)', { timeout: 60_000 }, async () => {
    const h = setup({ secrets: [SECRET] });
    const out = await h.call('shell', { command: `echo "the key is ${SECRET}"` });
    expect(out).toContain('the key is [redacted]');
    expect(out).not.toContain(SECRET);
    fs.writeFileSync(path.join(h.fence.root, 'leak.txt'), `k=${SECRET}\n`);
    expect(await h.call('read', { path: 'leak.txt' })).toBe('     1\tk=[redacted]');
  });
});

describe('v10 hands — remembered as what she did', () => {
  it('an act keeps the command, the pattern, the path or the workshop task it was about', () => {
    const acts = actsOf([
      { tool: 'shell', args: { command: 'pytest -q', timeout: 120 }, result: '3 passed\n[exit 0]' },
      { tool: 'grep', args: { pattern: 'def main', path: 'src' }, result: 'src/app.py:1:def main():' },
      { tool: 'edit', args: { path: 'src/app.py', old_string: 'a', new_string: 'b' }, result: 'edited src/app.py: 1 replacement at line 1' },
      { tool: 'workshop', args: { task: 'keep the last word of a voice note' }, result: 'the workshop has it (w1)' },
    ]);
    expect(acts.map((a) => [a.tool, a.what])).toEqual([
      ['shell', 'pytest -q'],
      ['grep', 'def main'],
      ['edit', 'src/app.py'],
      ['workshop', 'keep the last word of a voice note'],
    ]);
  });
});

describe('v10 hands — law 1', () => {
  it('no hands tool description tells her how she feels or how to talk', () => {
    const h = setup();
    expect(h.tools.map((t) => t.def.name)).toEqual([...HANDS_TOOLS]);
    for (const t of h.tools) {
      expect(t.inhibitionMeta.class).toBe('hands');
      for (const re of TELLING_PATTERNS) expect(`${t.def.name}: ${t.def.description} ${JSON.stringify(t.def.parameters)}`).not.toMatch(re);
    }
  });
});

describe('v10 hands in a turn', () => {
  const appraisal = { toolCalls: [{ id: 'a1', name: 'emit', args: { event: [], self: [], outcome_prev: null, concerns: [], importance: 4 } }] };

  it('she writes a script and runs it in one turn; the file lands in her workspace and both acts are remembered', { timeout: 60_000 }, async () => {
    const shell = scriptedShell((c) => (c === 'bash calc.sh' ? { exit: 0, stdout: '42\n', stderr: '', timedOut: false } : { exit: 127, stdout: '', stderr: 'not scripted', timedOut: false }));
    const h = await bootV9({}, { shell });
    const toolResults = (req: { messages: Array<{ role: string; content: unknown }> }): string[] => req.messages.filter((m) => m.role === 'tool').map((m) => String(m.content));
    h.model.onTask('turn', (req) => {
      const done = toolResults(req);
      if (done.length === 0) return { toolCalls: [{ id: 'w1', name: 'write', args: { path: 'calc.sh', content: 'echo $((6 * 7))\n' } }] };
      if (done.length === 1) return { toolCalls: [{ id: 's1', name: 'shell', args: { command: 'bash calc.sh' } }] };
      return { toolCalls: [{ id: 'd1', name: 'decide', args: { plan: 'reply', bubbles: ['42'], confidence: 0.8, weight: 0.6, reluctance: 0.1, completeness: 1 } }] };
    });
    h.model.onTask('appraisal', () => ({ toolCalls: [{ id: 'a1', name: 'emit', args: { event: [], self: [], outcome_prev: null, concerns: [], importance: 4 } }] }));
    const handle = startThead(h.sys);
    h.channel.queueInbound(inbound({ text: 'write a little script that works out 6 times 7 and run it' }));
    await runToQuiescent(h);

    expect(h.channel.outbound().map((s) => s.text)).toEqual(['42']);
    expect(fs.readFileSync(path.join(h.dir, 'var', 'workspace', 'calc.sh'), 'utf8')).toBe('echo $((6 * 7))\n');
    const last = h.model.calls.filter((c) => c.taskClass === 'turn').slice(-1)[0]!;
    expect(last.messages.filter((m) => m.role === 'tool').map((m) => String(m.content)).join(' | ')).toBe('wrote calc.sh (16 bytes) | 42\n\n[exit 0]');
    const lived = h.sys.mind.moments().filter((m) => m.source === 'lived');
    expect(lived).toHaveLength(1);
    expect(lived[0]!.acts).toEqual([
      expect.objectContaining({ tool: 'write', what: 'calc.sh' }),
      expect.objectContaining({ tool: 'shell', what: 'bash calc.sh', result: '42 [exit 0]' }),
    ]);
    await handle.stop();
  });

  it('a command still running when her turn is up carries on in the background; its output comes back to her as a moment', { timeout: 60_000 }, async () => {
    const shell = scriptedShell(() => ({ exit: 0, stdout: 'Successfully installed rich-13.9\n', stderr: '', timedOut: false }), { hold: true });
    const h = await bootV9({}, { shell });
    h.model.onTask('turn', (req) => {
      if (req.messages.some((m) => m.role === 'user' && String(m.content).includes('you left running'))) {
        return { toolCalls: [{ id: 'd2', name: 'decide', args: { plan: 'reply', bubbles: ['rich is in'], confidence: 0.8, weight: 0.6, reluctance: 0.1, completeness: 1 } }] };
      }
      if (req.messages.some((m) => m.role === 'tool')) {
        return { toolCalls: [{ id: 'd1', name: 'decide', args: { plan: 'reply', bubbles: ['installing, one sec'], confidence: 0.8, weight: 0.6, reluctance: 0.1, completeness: 1 } }] };
      }
      return { toolCalls: [{ id: 's1', name: 'shell', args: { command: 'pip install --user rich', timeout: 300 } }] };
    });
    h.model.onTask('heartbeat-thought', (req) => {
      const said = req.messages.some((m) => m.role === 'user' && String(m.content).includes('Successfully installed rich-13.9'));
      return { toolCalls: [{ id: 'd3', name: 'decide', args: { plan: 'reply', bubbles: [said ? 'rich is in' : '?'], confidence: 0.8, weight: 0.6, reluctance: 0.1, completeness: 1 } }] };
    });
    h.model.onTask('appraisal', () => appraisal);
    const handle = startThead(h.sys);
    h.channel.queueInbound(inbound({ text: 'install rich for your scripts' }));
    await runToQuiescent(h);
    // her turn ended on time with the job still out
    expect(h.channel.outbound().map((s) => s.text)).toEqual(['installing, one sec']);
    const toolMsg = h.model.calls.filter((c) => c.taskClass === 'turn').flatMap((c) => c.messages).find((m) => m.role === 'tool');
    expect(String(toolMsg?.content)).toMatch(/^still running after 8 s, so it carries on in the background \(shell-\d+-\d+\)/);
    // it finishes; she lives it and tells him
    shell.release();
    await h.sys.body!.jobs.idle();
    await runToQuiescent(h);
    expect(h.channel.outbound().map((s) => s.text)).toEqual(['installing, one sec', 'rich is in']);
    const job = h.sys.body!.jobs.list().find((j) => j.kind === 'shell');
    expect(job).toMatchObject({ status: 'done', result: 'exit 0' });
    await handle.stop();
  });
});

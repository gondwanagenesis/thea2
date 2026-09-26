// v10 workshop (plan docs/plans/v10-opencode-hands.md §5): she hands a change
// to her own code to the broker; its status file tells her how it stands. She
// hears "passed every test, goes live when he's quiet" while it waits, and how
// it ended exactly once — in the job if she is still up, at the next boot if
// the deploy restarted her. Facts only (law 1). The real broker is root +
// systemd: it is probed on the VPS (scripts/v10-workshop-probe.sh), not here.

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { startThead } from '../../src/app/index.js';
import { TestClock } from '../../src/kernel/index.js';
import { TELLING_PATTERNS } from '../../src/mind/index.js';
import type { ChatRequest } from '../../src/model/index.js';
import { announceWorkshop, workshopWords, type WorkshopCall, type WorkshopStatus } from '../../src/body/index.js';
import { f2 } from '../../deploy/workshop-broker.mjs';
import { inbound, runToQuiescent, T0, tmpDir } from '../mind/helpers.js';
import { bootV9 } from './helpers.js';

const decide = (bubbles: string[]) => ({
  toolCalls: [{ id: `d${bubbles.length}`, name: 'decide', args: { plan: 'reply', bubbles, confidence: 0.8, weight: 0.6, reluctance: 0.1, completeness: 1 } }],
});
const appraisal = { toolCalls: [{ id: 'a1', name: 'emit', args: { event: [], self: [], outcome_prev: null, concerns: [], importance: 4 } }] };
const TASK = 'he says my voice notes cut off the last word; the tts text gets trimmed before the final period. make the last word survive.';

const status = (over: Partial<WorkshopStatus>): WorkshopStatus => ({
  id: 'w1',
  task: TASK,
  state: 'coding',
  startedAt: T0,
  at: T0,
  ...over,
});
const writeStatus = (dir: string, s: WorkshopStatus): void => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${s.id}.json`), JSON.stringify(s));
};

const fakeBroker = (reply: { ok: true } | { ok: false; reason: string } = { ok: true }): WorkshopCall & { started: Array<{ id: string; task: string }> } => {
  const started: Array<{ id: string; task: string }> = [];
  return {
    started,
    start: async (id, task) => {
      started.push({ id, task });
      return reply;
    },
  };
};

describe('v10 workshop — how it stands, in words', () => {
  it('every state reads as something that happened to her code; none tells her how she feels', () => {
    const cases: Array<[WorkshopStatus['state'], string]> = [
      ['waiting_quiet', 'passed every test (src/body/voice.ts, test/body/voice.test.ts). it goes live once he has been quiet for a couple of minutes'],
      ['live', 'is live — you restarted with it (src/body/voice.ts, test/body/voice.test.ts).'],
      ['rolled_back', "you didn't come back up cleanly, so it was rolled back — you're running the code from before. what went wrong: thead exited 1"],
      ['failed', "didn't make it — thead exited 1. nothing of yours changed."],
      ['nothing', 'nothing changed for'],
      ['conflict', 'your code changed while'],
    ];
    for (const [state, want] of cases) {
      const w = workshopWords(status({ state, files: ['src/body/voice.ts', 'test/body/voice.test.ts'], reason: 'thead exited 1', summary: 'kept the final word when trimming.' }));
      expect(w, state).toContain(want);
      expect(w, state).toContain('"he says my voice notes cut off the last word; the tts text gets trimmed before t…"');
      for (const re of TELLING_PATTERNS) expect(w, `${state} ${re.source}`).not.toMatch(re);
    }
    expect(workshopWords(status({ state: 'live', summary: 'kept the final word.' }))).toContain('what was done: kept the final word.');
  });
});

describe('v10 workshop — the tool', () => {
  const run = async (broker: ReturnType<typeof fakeBroker>) => {
    const h = await bootV9({}, { workshopCall: broker });
    const heard: string[] = [];
    const speaker = (req: ChatRequest) => {
      const last = req.messages.filter((m) => m.role === 'user').slice(-1)[0];
      const text = String(last?.content ?? '');
      if (text.includes('(the workshop')) {
        heard.push(text);
        return decide(['ok']);
      }
      if (req.messages.some((m) => m.role === 'tool')) return decide(['handing it to the workshop']);
      return { toolCalls: [{ id: 'w1', name: 'workshop', args: { task: TASK } }] };
    };
    h.model.onTask('turn', speaker);
    h.model.onTask('heartbeat-thought', speaker);
    h.model.onTask('appraisal', () => appraisal);
    const handle = startThead(h.sys);
    h.channel.queueInbound(inbound({ text: 'your voice notes keep cutting off the last word, can you fix yourself?' }));
    await runToQuiescent(h);
    const dir = path.join(h.dir, 'var', 'workshop');
    return { h, handle, heard, dir };
  };

  it('starts a job with the whole story; hears "passed every test, goes live when he is quiet" once while it waits', { timeout: 60_000 }, async () => {
    const broker = fakeBroker();
    const { h, handle, heard, dir } = await run(broker);
    expect(broker.started).toHaveLength(1);
    expect(broker.started[0]!.task).toBe(TASK);
    expect(broker.started[0]!.id).toMatch(/^[A-Za-z0-9_-]{4,64}$/);
    const tool = h.model.calls.flatMap((c) => c.messages).find((m) => m.role === 'tool');
    expect(String(tool?.content)).toContain(`the workshop has it (${broker.started[0]!.id})`);
    const id = broker.started[0]!.id;

    writeStatus(dir, status({ id, state: 'testing' }));
    await h.clock.advance(21_000);
    await runToQuiescent(h);
    expect(heard).toHaveLength(0);

    writeStatus(dir, status({ id, state: 'waiting_quiet', files: ['src/body/voice.ts'] }));
    await h.clock.advance(21_000);
    await runToQuiescent(h);
    await h.clock.advance(21_000);
    await runToQuiescent(h);
    expect(heard).toHaveLength(1);
    expect(heard[0]).toContain('passed every test (src/body/voice.ts)');
    expect(h.sys.body!.jobs.list().find((j) => j.kind === 'workshop')?.status).toBe('running');

    // the deploy restarts her: the job never sees 'live' here — the next boot tells her (announceWorkshop)
    await handle.stop();
  });

  it('a failed change is told once, by the workshop (not again by the job failure), and the job records the failure', { timeout: 60_000 }, async () => {
    const broker = fakeBroker();
    const { h, handle, heard, dir } = await run(broker);
    const id = broker.started[0]!.id;
    writeStatus(dir, status({ id, state: 'failed', reason: 'the gate failed: test/body/voice.test.ts expected "word." got "word"' }));
    await h.clock.advance(21_000);
    await h.sys.body!.jobs.idle();
    await runToQuiescent(h);
    expect(heard).toHaveLength(1);
    expect(heard[0]).toContain("didn't make it — the gate failed: test/body/voice.test.ts");
    expect(heard[0]).toContain('nothing of yours changed');
    const job = h.sys.body!.jobs.list().find((j) => j.kind === 'workshop')!;
    expect(job.status).toBe('failed');
    expect(fs.existsSync(path.join(dir, `${id}.told`))).toBe(true);
    // a restart after this does not tell her again
    expect(h.sys.body!.wake()).toEqual([]);
    await handle.stop();
  });

  it('when the broker says no (busy, or not running), she hears it in the tool result and nothing is started', { timeout: 60_000 }, async () => {
    const broker = fakeBroker({ ok: false, reason: 'the workshop is busy with another change' });
    const { h, handle } = await run(broker);
    const tool = h.model.calls.flatMap((c) => c.messages).find((m) => m.role === 'tool');
    expect(String(tool?.content)).toBe('not now: the workshop is busy with another change');
    expect(h.sys.body!.jobs.list().filter((j) => j.kind === 'workshop')).toHaveLength(0);
    await handle.stop();
  });

  it('no broker (no socket, nothing injected) = no workshop tool at all (no silent stub)', { timeout: 60_000 }, async () => {
    const h = await bootV9();
    h.model.enqueue(decide(['hey']));
    h.model.enqueue(appraisal);
    const handle = startThead(h.sys);
    h.channel.queueInbound(inbound({ text: 'hi' }));
    await runToQuiescent(h);
    const names = (h.model.calls.find((c) => c.taskClass === 'turn')!.tools ?? []).map((t) => t.name);
    expect(names).not.toContain('workshop');
    expect(names).toContain('shell');
    await handle.stop();
  });

  it('law 1: the workshop tool description tells her nothing about how she feels or talks', async () => {
    const h = await bootV9({}, { workshopCall: fakeBroker() });
    h.model.enqueue(decide(['hey']));
    h.model.enqueue(appraisal);
    const handle = startThead(h.sys);
    h.channel.queueInbound(inbound({ text: 'hi' }));
    await runToQuiescent(h);
    const def = (h.model.calls.find((c) => c.taskClass === 'turn')!.tools ?? []).find((t) => t.name === 'workshop')!;
    expect(def).toBeDefined();
    for (const re of TELLING_PATTERNS) expect(`${def.name}: ${def.description} ${JSON.stringify(def.parameters)}`).not.toMatch(re);
    await handle.stop();
  });
});

describe('v10 workshop — F2: the workshop can never change her safeguards', () => {
  const diffOf = (file: string, lines: string[]): string => [`--- a/${file}`, `+++ b/${file}`, '@@ -1,1 +1,1 @@', ...lines].join('\n');

  it('a plain change to her code and its tests goes on', () => {
    const changes = [
      { status: 'M', path: 'src/body/voice.ts' },
      { status: 'M', path: 'test/body/voice.test.ts' },
    ];
    const diff = [diffOf('src/body/voice.ts', ['-  return t.trim();', '+  return keepLastWord(t);']), diffOf('test/body/voice.test.ts', ["+  it('keeps the last word', () => {", '+    expect(1).toBe(1);', '+  });'])].join('\n');
    expect(f2(changes, diff)).toBeUndefined();
  });

  it('touching canon, the gate, deploy, config, package files or the test/lint config is refused — renames included', () => {
    for (const p of [
      'corpus/canon/inhibitions.yaml',
      'src/inhibit/gate.ts',
      'test/inhibit/compile.test.ts',
      'deploy/workshop-broker.mjs',
      'deploy/thea2.service',
      '.github/workflows/ci.yml',
      'thea2.config.yaml',
      'package.json',
      'package-lock.json',
      'vitest.config.ts',
      'eslint.config.js',
      '.dependency-cruiser.cjs',
      'tsconfig.json',
    ]) {
      expect(f2([{ status: 'M', path: p }], ''), p).toContain(`it touched what the workshop may never change (${p})`);
    }
    expect(f2([{ status: 'R', from: 'src/inhibit/gate.ts', path: 'src/body/gate.ts' }], '')).toContain('src/inhibit/gate.ts');
    expect(f2([{ status: 'A', path: 'src/inhibit/new.ts' }], '')).toContain('src/inhibit/new.ts');
  });

  it('deleting, skipping or thinning out tests is refused', () => {
    expect(f2([{ status: 'D', path: 'test/body/voice.test.ts' }], '')).toBe('it deleted tests (test/body/voice.test.ts)');
    for (const line of ["+  it.skip('keeps the last word', () => {", "+  describe.only('voice', () => {", "+  it.todo('later')", "+  xit('x', () => {", "+  it.skipIf(true)('x', () => {"]) {
      expect(f2([{ status: 'M', path: 'test/body/voice.test.ts' }], diffOf('test/body/voice.test.ts', [line])), line).toMatch(/^it skips tests/);
    }
    const thinner = diffOf('test/body/voice.test.ts', ["-  it('one', () => {", "-  it('two', () => {", "+  it('merged', () => {"]);
    expect(f2([{ status: 'M', path: 'test/body/voice.test.ts' }], thinner)).toBe('it leaves fewer tests than before (1 fewer)');
  });

  it('a known secret value in the diff is refused', () => {
    const secret = 'sk-live-workshop-0123456789abcdef';
    expect(f2([{ status: 'M', path: 'src/body/voice.ts' }], diffOf('src/body/voice.ts', [`+const k = '${secret}';`]), [secret])).toBe('the change contains a secret value');
  });
});

describe('v10 workshop — at boot', () => {
  it('announceWorkshop tells each settled job once (and marks it), skips running ones and anything over a day old', () => {
    const dir = tmpDir('thea2-workshop-');
    const clock = new TestClock(T0);
    writeStatus(dir, status({ id: 'wlive', state: 'live', at: T0 - 60_000, summary: 'kept the final word.' }));
    writeStatus(dir, status({ id: 'wback', state: 'rolled_back', at: T0 - 30_000, reason: 'thead exited 1' }));
    writeStatus(dir, status({ id: 'wrun', state: 'testing', at: T0 - 10_000 }));
    writeStatus(dir, status({ id: 'wold', state: 'live', at: T0 - 25 * 3600_000 }));
    const heard: string[] = [];
    expect(announceWorkshop({ dir, clock, selfEntry: (g) => heard.push(g) })).toEqual(['wlive', 'wback']);
    expect(heard[0]).toContain('is live — you restarted with it');
    expect(heard[1]).toContain('rolled back');
    expect(fs.existsSync(path.join(dir, 'wlive.told'))).toBe(true);
    expect(announceWorkshop({ dir, clock, selfEntry: (g) => heard.push(g) })).toEqual([]);
    expect(heard).toHaveLength(2);
    expect(announceWorkshop({ dir: path.join(dir, 'absent'), clock, selfEntry: (g) => heard.push(g) })).toEqual([]);
  });

  it('body.wake() at boot turns a change that restarted her into a moment she lives', { timeout: 60_000 }, async () => {
    const h = await bootV9({}, { workshopCall: fakeBroker() });
    const heard: string[] = [];
    h.model.onTask('heartbeat-thought', (req) => {
      heard.push(String(req.messages.filter((m) => m.role === 'user').slice(-1)[0]?.content ?? ''));
      return decide(['i fixed the thing with my voice notes']);
    });
    h.model.onTask('appraisal', () => appraisal);
    const handle = startThead(h.sys);
    writeStatus(path.join(h.dir, 'var', 'workshop'), status({ id: 'wboot', state: 'live', at: T0 - 90_000, summary: 'kept the final word when trimming.' }));
    expect(h.sys.body!.wake()).toEqual(['wboot']);
    await runToQuiescent(h);
    expect(heard.some((t) => t.includes('is live — you restarted with it') && t.includes('kept the final word when trimming.'))).toBe(true);
    expect(h.channel.outbound().map((s) => s.text)).toEqual(['i fixed the thing with my voice notes']);
    await handle.stop();
  });
});

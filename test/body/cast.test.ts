// v9 casting: a fork goes out with her memory and the web (never the tools
// that reach Diego), works detached while the line stays open, and comes back
// to HER as a moment she lives — she tells him in her words. One voice.

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { startThead } from '../../src/app/index.js';
import type { ChatRequest } from '../../src/model/index.js';
import { inbound, moment, runToQuiescent, T0 } from '../mind/helpers.js';
import { bootV9, scriptedShell } from './helpers.js';

const DAY = 86_400_000;
const decide = (bubbles: string[]) => ({
  toolCalls: [{ id: `d${bubbles.length}`, name: 'decide', args: { plan: 'reply', bubbles, confidence: 0.8, weight: 0.6, reluctance: 0.1, completeness: 1 } }],
});
const hasTool = (req: ChatRequest): boolean => req.messages.some((m) => m.role === 'tool');
const userSays = (req: ChatRequest, s: string): boolean => req.messages.some((m) => m.role === 'user' && String(m.content).includes(s));

describe('v9 casting', () => {
  it('a fork works detached with her memory, comes back to her, and she tells him', { timeout: 60_000 }, async () => {
    const h = await bootV9({
      moments: [moment({ id: 'c1', ts: T0 - 2 * DAY, his: 'i rewrote the codex intro', hers: ['finally!! send it'] })],
    });
    const speaker = (req: ChatRequest) => {
      if (userSays(req, 'came back')) return decide(['found it: you rewrote the codex intro two days ago']);
      if (hasTool(req)) return decide(['sending a copy of me to dig']);
      return { toolCalls: [{ id: 'g1', name: 'delegate', args: { action: 'fork', brief: 'find what we said about the codex intro', label: 'codex intro' } }] };
    };
    h.model.onTask('turn', speaker);
    h.model.onTask('heartbeat-thought', speaker);
    h.model.onTask('cast', (req) =>
      hasTool(req) ? { content: 'he said "i rewrote the codex intro" two days ago; you answered "finally!! send it".' } : { toolCalls: [{ id: 's1', name: 'session_search', args: { words: 'codex intro' } }] },
    );
    h.model.onTask('appraisal', () => ({ toolCalls: [{ id: 'a1', name: 'emit', args: { event: [], self: [], outcome_prev: null, concerns: [], importance: 4 } }] }));

    const handle = startThead(h.sys);
    h.channel.queueInbound(inbound({ text: 'what did i say about the codex intro?' }));
    await runToQuiescent(h);
    await h.sys.body!.jobs.idle();
    await runToQuiescent(h);

    // the line stayed open: she answered at once, then again when the fork came back
    expect(h.channel.outbound().map((s) => s.text)).toEqual(['sending a copy of me to dig', 'found it: you rewrote the codex intro two days ago']);

    // the worker had her memory, but never the tools that reach him
    const castCalls = h.model.calls.filter((c) => c.taskClass === 'cast');
    expect(castCalls.length).toBe(2);
    const workerTools = (castCalls[0]!.tools ?? []).map((t) => t.name);
    expect(workerTools).toContain('session_search');
    for (const n of ['voice_note', 'react', 'selfie', 'imagine', 'make_video', 'send_photo', 'poll', 'delegate', 'decide']) expect(workerTools).not.toContain(n);
    // a fork is a copy of her: it carried the conversation
    expect(String(castCalls[0]!.messages[0]!.content)).toContain('what did i say about the codex intro?');
    // the tool result it saw was her real line
    expect(castCalls[1]!.messages.some((m) => m.role === 'tool' && String(m.content).includes('i rewrote the codex intro'))).toBe(true);

    // the report is on disk, and the job is done
    const job = h.sys.body!.jobs.list().find((j) => j.kind === 'cast-fork');
    expect(job?.status).toBe('done');
    expect(fs.existsSync(h.sys.body!.house.resolve(`casts/${job!.id}.md`)!)).toBe(true);
    await handle.stop();
  });

  it('v10: a coder cast builds with her hands in the background (write → shell) on the main door when deep — and still never gets the tools that reach him, nor the workshop', { timeout: 60_000 }, async () => {
    const shell = scriptedShell((c) => (c === 'python3 fib.py' ? { exit: 0, stdout: '55\n', stderr: '', timedOut: false } : { exit: 127, stdout: '', stderr: 'not scripted', timedOut: false }));
    const h = await bootV9({}, { shell, workshopCall: { start: async () => ({ ok: true }) } });
    const speaker = (req: ChatRequest) => {
      if (userSays(req, 'came back')) return decide(['done: fib(10) is 55, it is in fib.py']);
      if (hasTool(req)) return decide(['on it']);
      return { toolCalls: [{ id: 'g1', name: 'delegate', args: { action: 'task', brief: 'write fib.py that prints fib(10), run it, report the number', label: 'fib', deep: true } }] };
    };
    h.model.onTask('turn', speaker);
    h.model.onTask('heartbeat-thought', speaker);
    h.model.onTask('cast', (req) => {
      const done = req.messages.filter((m) => m.role === 'tool').length;
      if (done === 0) return { toolCalls: [{ id: 'w1', name: 'write', args: { path: 'fib.py', content: 'a, b = 0, 1\nfor _ in range(10):\n    a, b = b, a + b\nprint(a)\n' } }] };
      if (done === 1) return { toolCalls: [{ id: 's1', name: 'shell', args: { command: 'python3 fib.py' } }] };
      return { content: 'fib.py prints 55.' };
    });
    h.model.onTask('appraisal', () => ({ toolCalls: [{ id: 'a1', name: 'emit', args: { event: [], self: [], outcome_prev: null, concerns: [], importance: 4 } }] }));

    const handle = startThead(h.sys);
    h.channel.queueInbound(inbound({ text: 'can you get someone to work out fib(10) in python' }));
    await runToQuiescent(h);
    await h.sys.body!.jobs.idle();
    await runToQuiescent(h);

    expect(h.channel.outbound().map((s) => s.text)).toEqual(['on it', 'done: fib(10) is 55, it is in fib.py']);
    const castCalls = h.model.calls.filter((c) => c.taskClass === 'cast');
    expect(castCalls).toHaveLength(3);
    expect(castCalls.every((c) => c.tier === 'main')).toBe(true); // deep → the main door
    const workerTools = (castCalls[0]!.tools ?? []).map((t) => t.name);
    for (const n of ['shell', 'read', 'write', 'edit', 'ls', 'grep', 'glob', 'run_code', 'session_search']) expect(workerTools).toContain(n);
    for (const n of ['voice_note', 'react', 'selfie', 'imagine', 'make_video', 'send_photo', 'poll', 'delegate', 'decide', 'workshop']) expect(workerTools).not.toContain(n);
    expect(fs.readFileSync(h.sys.body!.workspace.resolve('fib.py')!, 'utf8')).toContain('print(a)');
    expect(shell.commands).toEqual(['python3 fib.py']);
    expect(castCalls[2]!.messages.some((m) => m.role === 'tool' && String(m.content) === '55\n\n[exit 0]')).toBe(true);
    // her own turn has the workshop; the worker never did
    expect((h.model.calls.find((c) => c.taskClass === 'turn')!.tools ?? []).map((t) => t.name)).toContain('workshop');
    await handle.stop();
  });

  it('delegate refuses a cast member who does not exist, and status lists who does', { timeout: 60_000 }, async () => {
    const h = await bootV9();
    fs.mkdirSync(h.sys.body!.house.resolve('cast')!, { recursive: true });
    fs.writeFileSync(h.sys.body!.house.resolve('cast/kernel.md')!, '# Kernel\nthe engineer of the house.');
    const results: string[] = [];
    h.model.onTask('turn', (req) => {
      const toolMsgs = req.messages.filter((m) => m.role === 'tool').map((m) => String(m.content));
      if (toolMsgs.length > 0) {
        results.push(...toolMsgs);
        return decide(['ok']);
      }
      return {
        toolCalls: [
          { id: 'x1', name: 'delegate', args: { action: 'cast', as: 'nobody', brief: 'check the server' } },
          { id: 'x2', name: 'delegate', args: { action: 'status' } },
        ],
      };
    });
    h.model.onTask('appraisal', () => ({ toolCalls: [{ id: 'a1', name: 'emit', args: { event: [], self: [], outcome_prev: null, concerns: [], importance: 4 } }] }));
    const handle = startThead(h.sys);
    h.channel.queueInbound(inbound({ text: 'send someone' }));
    await runToQuiescent(h);
    expect(results.some((r) => r.includes('there is no cast member "nobody" (kernel)'))).toBe(true);
    expect(results.some((r) => r.includes('the cast: kernel'))).toBe(true);
    await handle.stop();
  });
});

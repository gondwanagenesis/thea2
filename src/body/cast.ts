// v9 body — casting (Thea1's `delegate`: fork / task / cast-as, status,
// report), re-done for one voice. Whatever she sends out works in the
// background with her tools (web, memory, eyes, code — never the ones that
// reach Diego) and comes BACK TO HER as a moment she lives; she tells him in
// her own words. The line stays open the whole time (detached jobs, max 3).
//
//   fork  — a copy of her: her self-narrative + the recent conversation + the brief
//   task  — a worker from a brief alone, on the cheap door
//   cast  — a member of the cast (Kernel, Nightingale, Ledger, Ripperdoc…) from
//           her canon file, with Thea's brief and nothing of the conversation

import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import type { ChatMsg, ModelClient, ToolDef } from '../model/index.js';
import type { ToolCtx, ToolRegistry, ToolRegistryEntry } from '../loop/index.js';
import type { Clock, Rng } from '../kernel/index.js';
import type { House } from './house.js';
import type { Jobs } from './jobs.js';

/** Tool classes a worker may use: nothing that sends to Diego, nothing that spends from her camera. */
export const WORKER_CLASSES: ReadonlySet<string> = new Set(['web', 'memory', 'senses', 'code']);
const MAX_STEPS = 14;
const MAX_MS = 6 * 60_000;
const RESULT_TO_HER = 2500;

export interface CastDeps {
  house: House;
  clock: Clock;
  rng: Rng;
  jobs: Jobs;
  /** The model client (read late: it is built after the body). tier 'cheap' routes tasks to the cheap door. */
  model(): ModelClient;
  registry(): ToolRegistry;
  selfLines(): string[];
  /** The conversation so far, including his message in the turn that sends the fork. */
  recent(turnId: string): Array<{ who: 'him' | 'her'; text: string }>;
  selfEntry(goal: string): void;
}

const FORK_FRAME = (self: string[], recent: Array<{ who: 'him' | 'her'; text: string }>): string =>
  [
    'You are Thea, working on something on your own while the conversation goes on without you. Nothing you write here is sent to him; when you are done, your answer comes back to you and you tell him yourself.',
    self.length > 0 ? `[me]\n${self.join('\n')}` : '',
    recent.length > 0 ? `[the conversation so far]\n${recent.map((l) => `${l.who === 'him' ? 'him' : 'you'}: ${l.text.slice(0, 400)}`).join('\n')}` : '',
    'Use the tools as much as the job needs. Finish with what you found or did, plainly, with the links or file paths that matter.',
  ]
    .filter((s) => s !== '')
    .join('\n\n');

const TASK_FRAME =
  'You are a worker doing one job from a brief, in the background. Use the tools as much as the job needs. Finish with the result only: plainly, with the links or file paths that matter. Nothing you write is sent to anyone but the one who asked.';

const CAST_FRAME = (canon: string): string =>
  `${canon.trim()}\n\n---\nThea sent you out with the brief below. You work on your own, with the tools. Nothing you write is sent to Diego; your answer goes back to Thea. Finish with what you found or did, plainly.`;

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'work';

export const castSlugs = (house: House): string[] => {
  const dir = house.resolve('cast');
  if (dir === undefined || !fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.replace(/\.md$/, ''))
    .sort();
};

type Entry = ToolRegistryEntry<never>;

/** One worker run: tool rounds until it answers in content, the step cap, or the clock. */
export const runWorker = async (
  d: { model: ModelClient; registry: ToolRegistry; clock: Clock; rng: Rng; tier: 'main' | 'cheap'; id: string; classes?: ReadonlySet<string> | undefined; maxMs?: number | undefined },
  system: string,
  brief: string,
): Promise<{ text: string; steps: number; tools: string[] }> => {
  const allowed = d.classes ?? WORKER_CLASSES;
  const defs: ToolDef[] = d.registry
    .names()
    .map((n) => d.registry.get(n))
    .filter((e): e is ToolRegistryEntry => e !== undefined && allowed.has(e.inhibitionMeta.class ?? ''))
    .map((e) => e.def);
  const msgs: ChatMsg[] = [
    { role: 'system', content: system },
    { role: 'user', content: brief },
  ];
  const used: string[] = [];
  const deadline = d.clock.epochMs() + (d.maxMs ?? MAX_MS);
  const ctx: ToolCtx = {
    entry: 'ponder',
    turnId: d.id,
    depth: 1,
    signal: new AbortController().signal,
    clock: d.clock,
    rng: d.rng,
    spawn: { situation: brief.slice(0, 200), record: () => undefined },
  };
  let last = '';
  for (let step = 0; step < MAX_STEPS; step++) {
    if (d.clock.epochMs() > deadline) return { text: `${last}\n[stopped: out of time]`.trim(), steps: step, tools: used };
    const res = await d.model.chat({ taskClass: 'cast', tier: d.tier, messages: msgs, ...(defs.length > 0 ? { tools: defs } : {}), maxTokens: 2500, temperature: 0.6 });
    const content = typeof res.content === 'string' ? res.content : '';
    if (content.trim() !== '') last = content;
    const calls = res.toolCalls ?? [];
    if (calls.length === 0) return { text: content.trim() !== '' ? content : last, steps: step + 1, tools: used };
    msgs.push({ role: 'assistant', content, toolCalls: calls });
    for (const call of calls) {
      const e = d.registry.get(call.name);
      let out: string;
      if (e === undefined || !allowed.has(e.inhibitionMeta.class ?? '')) {
        out = `${call.name} is not available out here`;
      } else {
        const parsed = e.input.safeParse(call.args);
        out = parsed.success ? String(await e.handler(parsed.data as never, ctx)) : `bad arguments: ${parsed.error.issues.map((i) => i.message).join('; ')}`;
        used.push(call.name);
      }
      msgs.push({ role: 'tool', toolCallId: call.id, content: out.slice(0, 12_000) });
    }
  }
  return { text: `${last}\n[stopped: used every step]`.trim(), steps: MAX_STEPS, tools: used };
};

export const castTools = (d: CastDeps): Entry[] => {
  const reportPath = (id: string): string | undefined => d.house.resolve(`casts/${id}.md`);
  const entry = <T>(name: string, description: string, parameters: Record<string, unknown>, schema: z.ZodType<T>, handler: (a: T, ctx: ToolCtx) => Promise<string>): Entry =>
    ({
      def: { name, description, parameters },
      input: schema,
      inhibitionMeta: { class: 'spawn' },
      handler: async (a: T, ctx: ToolCtx) => {
        try {
          return await handler(a, ctx);
        } catch (e) {
          return `not done: ${e instanceof Error ? e.message.slice(0, 240) : String(e).slice(0, 240)}`;
        }
      },
    }) as unknown as Entry;

  return [
    entry(
      'delegate',
      "Send work out so this line stays open. fork = a copy of you who knows the conversation (judgement, anything with context). task = a worker from a brief you write (lookups, grunt work). cast = a member of the cast (see status for who), working from her own canon and your brief. They work in the background with the web, your memory and code, and what they find comes back to you — then you tell him. status = what is out; report = read one back.",
      {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['fork', 'task', 'cast', 'status', 'report'] },
          brief: { type: 'string', description: 'what to do; for task and cast, written so someone with no context can follow it' },
          label: { type: 'string', description: 'two or three words, to find it again' },
          as: { type: 'string', description: 'cast only: who (kernel, nightingale, ledger, ripperdoc…)' },
          id: { type: 'string', description: 'report only' },
        },
        required: ['action'],
      },
      z.object({ action: z.enum(['fork', 'task', 'cast', 'status', 'report']), brief: z.string().max(6000).optional(), label: z.string().max(60).optional(), as: z.string().max(40).optional(), id: z.string().max(80).optional() }),
      async (a, ctx) => {
        if (a.action === 'status') {
          const js = d.jobs.list().filter((j) => j.kind.startsWith('cast-')).slice(-8);
          const cast = castSlugs(d.house);
          return [
            js.length === 0 ? 'nothing out right now' : js.map((j) => `${j.id} — ${j.status === 'running' ? 'still working' : j.status}: ${j.what}`).join('\n'),
            cast.length > 0 ? `the cast: ${cast.join(', ')}` : '',
          ]
            .filter((s) => s !== '')
            .join('\n');
        }
        if (a.action === 'report') {
          const p = a.id !== undefined ? reportPath(a.id) : undefined;
          return p !== undefined && fs.existsSync(p) ? fs.readFileSync(p, 'utf8').slice(0, 8000) : 'no report with that id (status lists them)';
        }
        if (a.brief === undefined || a.brief.trim() === '') return 'give the brief: what should be done?';
        let system: string;
        // everything she sends out works on the cheap GPT door; what comes back she says in her own voice
        const tier: 'main' | 'cheap' = 'cheap';
        // tasks ride the cheap door; forks and the cast think on the main one
        let who: string = a.action;
        if (a.action === 'fork') system = FORK_FRAME(d.selfLines(), d.recent(ctx.turnId));
        else if (a.action === 'task') {
          system = TASK_FRAME;
        } else {
          const s = slug(a.as ?? '');
          const canonPath = d.house.resolve(`cast/${s}.md`);
          if (canonPath === undefined || !fs.existsSync(canonPath)) return `there is no cast member "${a.as ?? ''}" (${castSlugs(d.house).join(', ') || 'the cast is empty'})`;
          system = CAST_FRAME(fs.readFileSync(canonPath, 'utf8'));
          who = s;
        }
        const label = a.label ?? a.brief.split(/\s+/).slice(0, 4).join(' ');
        const brief = a.brief;
        const started = d.jobs.start(`cast-${who}`, label, ctx.turnId, async (jobId) => {
          const r = await runWorker({ model: d.model(), registry: d.registry(), clock: d.clock, rng: d.rng, tier, id: jobId }, system, brief);
          const dir = d.house.resolve('casts');
          if (dir !== undefined) {
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, `${jobId}.md`), `# ${who}: ${label}\n\n## brief\n${brief}\n\n## tools used\n${r.tools.join(', ') || 'none'}\n\n## result\n${r.text}\n`);
          }
          const from = who === 'fork' ? 'the copy of you you sent' : who === 'task' ? 'the worker you sent' : who;
          d.selfEntry(`(${from} out for "${label}" came back:\n${r.text.slice(0, RESULT_TO_HER)}${r.text.length > RESULT_TO_HER ? `\n…(the rest: delegate report ${jobId})` : ''})`);
          return `${r.steps} step(s), ${r.tools.length} tool call(s)`;
        });
        if (!started.ok) return `not now: ${started.reason}`;
        return `${who === 'fork' ? 'a copy of you is' : who === 'task' ? 'a worker is' : `${who} is`} on it (${started.id}); it comes back to you when done`;
      },
    ),
  ];
};

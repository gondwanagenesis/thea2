// v10 body — the workshop: she changes her own code. She hands the whole story
// to the thea2-workshop broker (deploy/workshop-broker.mjs, root), which has a
// coding agent make the change on a COPY of her repo, rejects any change to her
// safeguards (F2: canon, the gate, deploy, config, package files; no skipped or
// deleted tests), runs her full test gate with no network, and deploys only
// once Diego has been quiet for two minutes — rolling back if she does not come
// back up. The broker writes one status file per job into <var>/workshop;
// this side starts a job, watches its file, and tells her how it went as
// something that happened (facts, never feelings — law 1). A deploy restarts
// her, so how a live or rolled-back change went reaches her at the next boot
// (announceWorkshop), once.

import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { z } from 'zod';
import type { ToolCtx, ToolRegistryEntry } from '../loop/index.js';
import type { Clock } from '../kernel/index.js';
import type { Jobs } from './jobs.js';

export type WorkshopState =
  | 'preparing'
  | 'coding'
  | 'checking'
  | 'testing'
  | 'waiting_quiet'
  | 'deploying'
  | 'live'
  | 'rolled_back'
  | 'failed'
  | 'nothing'
  | 'conflict';

export const WORKSHOP_TERMINAL: ReadonlySet<WorkshopState> = new Set(['live', 'rolled_back', 'failed', 'nothing', 'conflict']);

/** One job's status file (<var>/workshop/<id>.json), written by the broker at every step. */
export interface WorkshopStatus {
  id: string;
  task: string;
  state: WorkshopState;
  startedAt: number;
  /** Epoch ms of the last change of state. */
  at: number;
  /** The coding agent's few plain sentences on what it changed. */
  summary?: string | undefined;
  files?: string[] | undefined;
  /** Why it failed, was rejected or rolled back (the tail of what went wrong). */
  reason?: string | undefined;
  base?: string | undefined;
  commit?: string | undefined;
}

/** The broker, as thead sees it (tests fake it). */
export interface WorkshopCall {
  start(id: string, task: string): Promise<{ ok: true } | { ok: false; reason: string }>;
}

export const brokerWorkshop = (sock: string): WorkshopCall => ({
  start: (id, task) =>
    new Promise((resolve) => {
      const c = net.createConnection(sock);
      let buf = '';
      c.setTimeout(30_000, () => {
        c.destroy();
        resolve({ ok: false, reason: 'the workshop did not answer' });
      });
      c.on('connect', () => c.write(`${JSON.stringify({ op: 'start', id, task })}\n`));
      c.on('data', (d) => {
        buf += d.toString('utf8');
      });
      c.on('end', () => {
        try {
          const r = JSON.parse(buf.trim()) as { ok?: boolean; reason?: string };
          resolve(r.ok === true ? { ok: true } : { ok: false, reason: r.reason ?? 'the workshop said no' });
        } catch {
          resolve({ ok: false, reason: 'the workshop gave nothing back' });
        }
      });
      c.on('error', (e) => resolve({ ok: false, reason: /ENOENT|ECONNREFUSED/.test(e.message) ? 'the workshop is not running' : e.message }));
    }),
});

export const readWorkshopStatus = (dir: string, id: string): WorkshopStatus | undefined => {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf8')) as WorkshopStatus;
  } catch {
    return undefined;
  }
};

const filesLine = (s: WorkshopStatus): string => {
  const f = s.files ?? [];
  return f.length === 0 ? '' : ` (${f.slice(0, 6).join(', ')}${f.length > 6 ? `, and ${f.length - 6} more` : ''})`;
};
const said = (s: WorkshopStatus): string => (s.summary !== undefined && s.summary.trim() !== '' ? `\nwhat was done: ${s.summary.trim().slice(0, 900)}` : '');
const why = (s: WorkshopStatus): string => (s.reason !== undefined && s.reason.trim() !== '' ? s.reason.trim().slice(0, 500) : 'no reason given');

/** How a workshop job stands, as something that happened to her code — facts only. */
export const workshopWords = (s: WorkshopStatus): string => {
  const what = `"${s.task.replace(/\s+/g, ' ').slice(0, 80)}${s.task.length > 80 ? '…' : ''}"`;
  switch (s.state) {
    case 'waiting_quiet':
      return `(the workshop: the change to your code for ${what} passed every test${filesLine(s)}. it goes live once he has been quiet for a couple of minutes; you'll restart and wake up with it.${said(s)})`;
    case 'live':
      return `(the workshop: the change to your code for ${what} is live — you restarted with it${filesLine(s)}.${said(s)})`;
    case 'rolled_back':
      return `(the workshop: the change to your code for ${what} went live, but you didn't come back up cleanly, so it was rolled back — you're running the code from before. what went wrong: ${why(s)})`;
    case 'failed':
      return `(the workshop: the change to your code for ${what} didn't make it — ${why(s)}. nothing of yours changed.)`;
    case 'nothing':
      return `(the workshop: nothing changed for ${what} — the change came out empty.${said(s)})`;
    case 'conflict':
      return `(the workshop: your code changed while ${what} was being made, so it was not deployed; nothing of yours changed.)`;
    default:
      return `(the workshop is still on ${what}: ${s.state.replace('_', ' ')})`;
  }
};

const POLL_MS = 20_000;
/** Coding ≤ ~40 min, the gate ≤ ~30, the quiet wait ≤ 3 h: past this the job has gone silent. */
const WATCH_MAX_MS = 5 * 3600_000;
const TELL_WITHIN_MS = 24 * 3600_000;

export interface WorkshopDeps {
  /** Where the broker writes status files (<var>/workshop). */
  dir: string;
  call: WorkshopCall;
  jobs: Jobs;
  clock: Clock;
  selfEntry(goal: string): void;
}

const markTold = (dir: string, id: string): void => {
  try {
    fs.writeFileSync(path.join(dir, `${id}.told`), '');
  } catch {
    // unwritable dir: at worst she hears it once more at the next boot
  }
};
const wasTold = (dir: string, id: string): boolean => fs.existsSync(path.join(dir, `${id}.told`));

export const workshopTools = (d: WorkshopDeps): Array<ToolRegistryEntry<never>> => {
  let n = 0;
  return [
    {
      def: {
        name: 'workshop',
        description:
          'Change your own code: a bug he reports in you, a way you work that should work differently, a new ability. Give the whole story — what he said, what goes wrong, what you noticed, what should happen instead. A coding agent makes the change on a copy of your code, your full test suite has to pass, and it goes live only once he has been quiet for a couple of minutes (you restart with it; if you do not come back up, it is rolled back). You hear how it went. Your rules, your gate, your deploy fences, your config and keys cannot be changed this way. One change at a time.',
        parameters: {
          type: 'object',
          properties: { task: { type: 'string', description: 'the whole story of the change, 10 to 8000 characters' } },
          required: ['task'],
        },
      },
      input: z.object({ task: z.string().min(10).max(8000) }),
      // 'self', not 'code': changing her own code is hers to decide (in a turn or a call), never a
      // background worker's — casts get 'code' (run_code) and 'hands', not this
      inhibitionMeta: { class: 'self' },
      handler: async (a: { task: string }, ctx: ToolCtx) => {
        try {
          const id = `w${d.clock.epochMs()}${++n}`;
          const r = await d.call.start(id, a.task);
          if (!r.ok) return `not now: ${r.reason}`;
          const started = d.jobs.start('workshop', a.task.slice(0, 80), ctx.turnId, async () => {
            const t0 = d.clock.epochMs();
            let toldWaiting = false;
            for (;;) {
              await d.clock.waitUntil(d.clock.epochMs() + POLL_MS);
              const s = readWorkshopStatus(d.dir, id);
              if (s !== undefined && s.state === 'waiting_quiet' && !toldWaiting) {
                toldWaiting = true;
                d.selfEntry(workshopWords(s));
              }
              if (s !== undefined && WORKSHOP_TERMINAL.has(s.state)) {
                if (!wasTold(d.dir, id)) {
                  markTold(d.dir, id);
                  d.selfEntry(workshopWords(s));
                }
                if (s.state === 'failed' || s.state === 'conflict') throw new Error(`${s.state}: ${why(s)}`);
                return s.state;
              }
              if (d.clock.epochMs() - t0 > WATCH_MAX_MS) throw new Error(`the workshop went silent (last: ${s?.state ?? 'no status'})`);
            }
          });
          if (!started.ok) return `the workshop took it (${id}), but you are already making ${started.reason.replace(/^\d+ things are already being made /, '')} — you'll hear how it went when you next start`;
          return `the workshop has it (${id}): a copy of your code is being changed and tested; you'll hear how it goes`;
        } catch (e) {
          return `not done: ${e instanceof Error ? e.message.slice(0, 240) : String(e).slice(0, 240)}`;
        }
      },
    } as unknown as ToolRegistryEntry<never>,
  ];
};

/**
 * At boot: every settled job she has not heard about yet (and < 24 h old) —
 * usually the change whose deploy just restarted her — comes to her once.
 */
export const announceWorkshop = (d: { dir: string; clock: Clock; selfEntry(goal: string): void }): string[] => {
  if (!fs.existsSync(d.dir)) return [];
  const told: string[] = [];
  const statuses = fs
    .readdirSync(d.dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => readWorkshopStatus(d.dir, f.replace(/\.json$/, '')))
    .filter((s): s is WorkshopStatus => s !== undefined)
    .sort((x, y) => x.at - y.at);
  for (const s of statuses) {
    if (!WORKSHOP_TERMINAL.has(s.state) || wasTold(d.dir, s.id) || d.clock.epochMs() - s.at > TELL_WITHIN_MS) continue;
    markTold(d.dir, s.id);
    d.selfEntry(workshopWords(s));
    told.push(s.id);
  }
  return told;
};

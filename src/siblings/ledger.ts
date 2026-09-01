// M18 siblings — Ledger: cost/routing observability with the guardrail on the
// writing end. Daily (and on-demand via the CLI): replay a day of L0, fold it
// into per-taskClass aggregates with the PURE fn, propose guardrailed routing
// downgrades, render var/reports/ledger-<date>.md in the persona seed's voice
// (one cheap-tier call), and put every operational truth on one page — lost
// replies, chronic gate rejections (per rule, so an over-triggering inhibition
// surfaces within a day), sched alarms + what actually ran, gravity alarms,
// incident counts. The numbers are machine-rendered; the model only writes the
// opening, so a bad voice day cannot garble a number.

import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import type { EventEnvelope, EventLog } from '../events/index.js';
import { atomicWriteText } from '../kernel/index.js';
import type { Job, JobCtx } from '../sched/index.js';
import type { RoutingTable } from '../model/index.js';
import type { LedgerAggregate, RoutingProposal, SiblingDeps, SiblingRunCtx } from './types.js';
import { LEDGER_JOB_NAME, LEDGER_TIMEOUT_MS, LEDGER_UTC_MINUTE, LEDGER_WINDOW_MS, runCtx } from './types.js';
import { aggregateWindow, type WindowStats } from './aggregate.js';
import { applyRouting, proposeRouting, readRoutingTable } from './routing.js';
import { loadPersonaSeed } from './persona.js';
import { countBy, emitSiblingIncident, minutes, usd } from './util.js';

// ---------------------------------------------------------------------------
// Truths folded out of the day's non-model events
// ---------------------------------------------------------------------------

const lostReplyShape = z.object({ updateId: z.number(), chatId: z.number(), ageMs: z.number() });
const gateLoopShape = z.object({ ruleIds: z.array(z.string()), reentries: z.number() });
const schedAlarmShape = z.object({ job: z.string() });
const gravityShape = z.object({ alarms: z.array(z.string()) });

export interface LedgerTruths {
  lostReplies: number;
  lostReplyMaxAgeMs: number;
  gateLoops: number;
  gateLoopReentries: number;
  gateRules: Array<{ key: string; count: number }>;
  schedAlarms: number;
  schedAlarmJobs: Array<{ key: string; count: number }>;
  gravityAlarms: Array<{ key: string; count: number }>;
  consolidateAlarms: number;
  /** M03's own guardrail firing (a caller asked for an illegal tier). */
  routingIgnored: number;
  incidents: Array<{ key: string; count: number }>;
  /** var/sched/state.json as "what actually ran" — an absent file is the normal first week. */
  schedJobs: Array<{ job: string; consecutiveFailures: number; lastCompletedAgeMs: number | null }>;
  schedStateRead: boolean;
}

const schedStateShape = z.object({
  jobs: z.record(
    z.string(),
    z.object({
      lastCompleted: z.number().optional(),
      lastAttempt: z.number().optional(),
      consecutiveFailures: z.number(),
    }),
  ),
});

const foldTruths = async (
  evs: readonly EventEnvelope[],
  deps: { sched: { statePath: string }; events: EventLog },
  now: number,
): Promise<LedgerTruths> => {
  const lostReplyAges: number[] = [];
  const gateRuleIds: string[] = [];
  let gateLoops = 0;
  let gateLoopReentries = 0;
  const schedAlarmJobNames: string[] = [];
  const gravityAlarmNames: string[] = [];
  let consolidateAlarms = 0;
  let routingIgnored = 0;
  const incidentKinds: string[] = [];

  for (const ev of evs) {
    if (ev.kind === 'bridge.lost_reply') {
      const p = lostReplyShape.safeParse(ev.payload);
      if (p.success) lostReplyAges.push(p.data.ageMs);
    } else if (ev.kind === 'incident.gate_loop') {
      const p = gateLoopShape.safeParse(ev.payload);
      if (p.success) {
        gateLoops += 1;
        gateLoopReentries += p.data.reentries;
        gateRuleIds.push(...p.data.ruleIds);
      }
    } else if (ev.kind === 'sched.alarm') {
      const p = schedAlarmShape.safeParse(ev.payload);
      if (p.success) schedAlarmJobNames.push(p.data.job);
    } else if (ev.kind === 'consolidate.gravity') {
      const p = gravityShape.safeParse(ev.payload);
      if (p.success) gravityAlarmNames.push(...p.data.alarms);
    } else if (ev.kind === 'consolidate.alarm') {
      consolidateAlarms += 1;
    } else if (ev.kind === 'model.routing_ignored') {
      routingIgnored += 1;
    } else if (ev.kind.startsWith('incident.')) {
      incidentKinds.push(ev.kind);
    }
  }

  let schedJobs: LedgerTruths['schedJobs'] = [];
  let schedStateRead = true;
  try {
    const raw = schedStateShape.parse(JSON.parse(await fsp.readFile(deps.sched.statePath, 'utf8')) as unknown);
    schedJobs = Object.entries(raw.jobs)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([job, st]) => ({
        job,
        consecutiveFailures: st.consecutiveFailures,
        lastCompletedAgeMs: st.lastCompleted !== undefined ? now - st.lastCompleted : null,
      }));
  } catch (e) {
    schedJobs = [];
    schedStateRead = false;
    await emitSiblingIncident(deps.events, 'sched-state', e);
  }

  return {
    lostReplies: lostReplyAges.length,
    lostReplyMaxAgeMs: lostReplyAges.length > 0 ? Math.max(...lostReplyAges) : 0,
    gateLoops,
    gateLoopReentries,
    gateRules: countBy(gateRuleIds),
    schedAlarms: schedAlarmJobNames.length,
    schedAlarmJobs: countBy(schedAlarmJobNames),
    gravityAlarms: countBy(gravityAlarmNames),
    consolidateAlarms,
    routingIgnored,
    incidents: countBy(incidentKinds),
    schedJobs,
    schedStateRead,
  };
};


// ---------------------------------------------------------------------------
// Report rendering (pure, machine-rendered body)
// ---------------------------------------------------------------------------

export interface RoutingLine {
  taskClass: string;
  proposedTier: string;
  reason: string;
}

export interface LedgerReportData {
  date: string;
  window: { start: number; end: number };
  stats: WindowStats;
  truths: LedgerTruths;
  proposed: RoutingProposal[];
  refused: RoutingLine[];
  routingChanged: boolean;
  routingOverrides: number;
  routingUnreadable: boolean;
}

export const renderLedgerBody = (data: LedgerReportData): string => {
  const L: string[] = [];
  const t = data.truths;
  const attributedParseFailures: number = data.stats.aggs.reduce((acc, a) => acc + a.parseFailures, 0);

  L.push('## model calls (trailing 24h)', '');
  if (data.stats.aggs.length === 0) {
    L.push('no model calls in the window', '');
  } else {
    L.push('| task class | calls | in tok | out tok | cost | p50 ms | p95 ms | parse fails |');
    L.push('|---|---:|---:|---:|---:|---:|---:|---:|');
    for (const a of data.stats.aggs) {
      L.push(
        `| ${a.taskClass} | ${a.calls} | ${a.inputTokens} | ${a.outputTokens} | ${usd(a.costUsd)} ` +
          `| ${a.latencyP50Ms} | ${a.latencyP95Ms} | ${a.parseFailures} |`,
      );
    }
    L.push('');
    L.push(
      `totals: ${data.stats.calls} calls, ${data.stats.inputTokens} tok in / ${data.stats.outputTokens} tok out, ` +
        `${usd(data.stats.costUsd)}, ${data.stats.attempts} attempts across ${data.stats.calls} calls ` +
        `(retries included), ${data.stats.failedCalls} failed calls`,
    );
    L.push(
      `parse failures: ${attributedParseFailures} attributed + ${data.stats.parseFailuresUnattributed} unattributed` +
        (data.stats.malformed > 0 ? `; ${data.stats.malformed} malformed L0 rows skipped` : ''),
    );
    L.push('');
  }

  L.push('## operational truths', '');
  L.push(
    t.lostReplies > 0
      ? `- lost replies: ${t.lostReplies} (oldest ${minutes(t.lostReplyMaxAgeMs)})`
      : '- lost replies: 0',
  );
  L.push(
    t.gateLoops > 0
      ? `- gate rejections: ${t.gateLoops} loops, ${t.gateLoopReentries} re-entries — rules: ${counted(t.gateRules)}`
      : '- gate rejections: 0 loops',
  );
  L.push(t.schedAlarms > 0 ? `- sched alarms: ${t.schedAlarms} — ${counted(t.schedAlarmJobs)}` : '- sched alarms: 0');
  L.push(
    t.gravityAlarms.length > 0 ? `- gravity alarms: ${counted(t.gravityAlarms)}` : '- gravity alarms: none',
  );
  L.push(`- consolidate alarms: ${t.consolidateAlarms}`);
  L.push(`- router guardrail warnings (model.routing_ignored): ${t.routingIgnored}`);
  L.push(`- incidents: ${counted(t.incidents)}`);
  if (t.schedStateRead) {
    L.push(
      `- scheduler: ${t.schedJobs.length === 0 ? 'no jobs have run yet' : t.schedJobs.map(schedJobText).join('; ')}`,
    );
  } else {
    L.push('- scheduler: state file unreadable (see incidents)');
  }
  L.push('');

  L.push('## routing', '');
  if (data.routingUnreadable) {
    L.push('- routing.json: UNREADABLE — nothing proposed, nothing written (see incidents)');
  } else if (data.proposed.length === 0 && data.refused.length === 0) {
    L.push('- nothing hot enough to propose, nothing refused');
  } else {
    for (const p of data.proposed) L.push(`- proposed: ${p.taskClass} → ${p.to} — ${p.reason}`);
    for (const r of data.refused) L.push(`- refused: ${r.taskClass} → ${r.proposedTier} — ${r.reason}`);
    L.push(
      data.routingChanged
        ? `- routing.json updated: ${data.proposed.length} override(s) now in force — that was a deploy, Nightingale runs within a minute`
        : `- routing.json unchanged: ${data.routingOverrides} override(s) in force`,
    );
  }
  L.push('');
  return L.join('\n');
};

const counted = (rows: ReadonlyArray<{ key: string; count: number }>): string =>
  rows.map((r) => `${r.key} ×${r.count}`).join(', ');

const schedJobText = (j: { job: string; consecutiveFailures: number; lastCompletedAgeMs: number | null }): string =>
  `${j.job}: ${j.consecutiveFailures > 0 ? `FAILING ×${j.consecutiveFailures}, ` : ''}` +
  `last completed ${j.lastCompletedAgeMs === null ? 'never' : minutes(j.lastCompletedAgeMs)} ago`;

export const renderLedgerReport = (date: string, voice: string, body: string): string => {
  const opening = voice.trim();
  const head = `# Ledger — ${date}\n\n`;
  return opening.length > 0 ? `${head}${opening}\n\n${body}` : `${head}${body}`;
};

// ---------------------------------------------------------------------------
// The voice pass — one cheap-tier call, persona-seeded
// ---------------------------------------------------------------------------

const voicePrompt = (body: string): string =>
  [
    "here is today's machine-rendered ledger. write the opening of the report.",
    'the tables below stay in the file verbatim after your opening. two or three sentences.',
    '',
    '---',
    body,
  ].join('\n');

const voicePass = async (deps: SiblingDeps, c: SiblingRunCtx, body: string): Promise<string> => {
  const seed = loadPersonaSeed('ledger', deps.personaDir);
  const reply = await deps.model.chat(
    {
      taskClass: 'summarize',
      tier: 'cheap',
      messages: [
        { role: 'system', content: seed },
        { role: 'user', content: voicePrompt(body) },
      ],
      maxTokens: 400,
      temperature: 0.8,
    },
    { ...(c.signal !== undefined ? { signal: c.signal } : {}) },
  );
  return reply.content;
};

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export interface LedgerRunResult {
  file: string;
  window: { start: number; end: number };
  stats: WindowStats;
  aggs: LedgerAggregate[];
  truths: LedgerTruths;
  routing: {
    applied: RoutingProposal[];
    refused: RoutingLine[];
    changed: boolean;
    unreadable: boolean;
  };
  voiced: boolean;
}

/**
 * The Ledger's body — also the CLI's on-demand `thea2 status --ledger` path.
 * Throws only on failures that SHOULD kill the run (L0 unwritable, report disk
 * full) so M16's isolation contract counts them; absorbable failures (unreadable
 * routing.json, unreadable sched state, a voice pass that will not render) are
 * absorbed with a `sibling.incident` event and a report that still carries every
 * number.
 */
export const runLedgerReport = async (
  deps: SiblingDeps,
  ctx?: Partial<SiblingRunCtx> | undefined,
): Promise<LedgerRunResult> => {
  const c = runCtx(deps, ctx);
  const end = c.clock.epochMs();
  const start = end - LEDGER_WINDOW_MS;

  const evs: EventEnvelope[] = [];
  for await (const ev of c.events.replay({ sinceTs: start })) evs.push(ev);

  const truths = await foldTruths(evs, { sched: deps.sched, events: c.events }, end);
  const stats = aggregateWindow(evs);

  // The guardrail's input: the table as it stands. An unreadable file is loud
  // (incident) and blocks both proposing and writing — never propose against a
  // table that cannot be seen, never overwrite a human's hand edit.
  let current: RoutingTable = [];
  let routingUnreadable = false;
  try {
    current = await readRoutingTable(deps.routingPath);
  } catch (e) {
    routingUnreadable = true;
    await emitSiblingIncident(c.events, 'routing', e);
  }

  const { proposals, refused } = routingUnreadable
    ? { proposals: [], refused: [] }
    : proposeRouting(stats.aggs, current);

  for (const r of refused) {
    await c.events.emit('sibling.routing_refused', {
      taskClass: r.taskClass,
      proposedTier: r.proposedTier,
      reason: r.reason,
    });
  }

  const applied = routingUnreadable
    ? { changed: false, table: null, written: [], unreadable: true }
    : await applyRouting(deps.routingPath, current, proposals, c.events);

  const data: LedgerReportData = {
    date: c.clock.now().toISOString().slice(0, 10),
    window: { start, end },
    stats,
    truths,
    proposed: proposals,
    refused,
    routingChanged: applied.changed,
    routingOverrides: applied.table?.length ?? 0,
    routingUnreadable,
  };
  const body = renderLedgerBody(data);

  let voiced = true;
  let voice = '';
  try {
    voice = await voicePass(deps, c, body);
  } catch (e) {
    voiced = false;
    await emitSiblingIncident(c.events, 'ledger-voice', e);
  }

  const file = path.join(deps.reportsDir, `ledger-${data.date}.md`);
  await atomicWriteText(file, renderLedgerReport(data.date, voice, body));

  await c.events.emit('sibling.ledger_report', {
    file,
    window: data.window,
    calls: stats.calls,
    attempts: stats.attempts,
    costUsd: stats.costUsd,
    parseFailures: stats.aggs.reduce((acc, a) => acc + a.parseFailures, 0) + stats.parseFailuresUnattributed,
    lostReplies: truths.lostReplies,
    gateLoops: truths.gateLoops,
    schedAlarms: truths.schedAlarms,
    gravityAlarms: truths.gravityAlarms.reduce((acc, a) => acc + a.count, 0),
    incidents: truths.incidents.reduce((acc, i) => acc + i.count, 0),
    routing: {
      applied: applied.written.map((p) => p.taskClass),
      refused: refused.map((r) => r.taskClass),
      changed: applied.changed,
    },
  });

  return {
    file,
    window: data.window,
    stats,
    aggs: stats.aggs,
    truths,
    routing: {
      applied: applied.written,
      refused,
      changed: applied.changed,
      unreadable: routingUnreadable,
    },
    voiced,
  };
};

/** The daily job — M16's `ledger-report` row, maintenance lane, catch-up once. */
export const ledgerJob = (deps: SiblingDeps): Job => ({
  name: LEDGER_JOB_NAME,
  cadence: { kind: 'daily', utcMinute: LEDGER_UTC_MINUTE },
  lane: 'maintenance',
  catchUp: 'once',
  timeoutMs: LEDGER_TIMEOUT_MS,
  run: async (ctx: JobCtx) => {
    await runLedgerReport(deps, ctx);
  },
});

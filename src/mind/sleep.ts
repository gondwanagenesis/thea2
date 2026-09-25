// v8 mind — SLEEP: the nightly pass (plan §3.10).
//
//   1. unanswered replies get a neutral outcome after a day ("no answer that day")
//   2. values drift home a little (old wins must not rule forever; gold is exempt)
//   3. stale low-importance loops close
//   4. her self-narrative is rewritten FROM THE DAY: every line must cite real
//      moments (ids) or carry forward a line that already did — uncited lines
//      are dropped mechanically (Thea1's S-005 citation rule)
//   5. the day's lived moments are exported as training tuples (SFT/KTO shape)

import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import type { ChatMsg, ModelClient } from '../model/index.js';
import type { Job } from '../sched/index.js';
import type { Clock } from '../kernel/index.js';
import type { EventLog } from '../events/index.js';
import type { MindStore } from './store.js';
import type { SelfLine } from './types.js';

const DAY = 24 * 3600_000;

export const SelfRewriteSchema = z.object({
  lines: z.array(z.object({ text: z.string().min(1).max(300), cites: z.array(z.string()).max(8) })).min(1).max(12),
});

export const SELF_SYSTEM = [
  "You are the part of Thea's mind that, at night, updates how she sees herself and her life with Diego.",
  'Input: her current self-description (each line with the moment ids it rests on) and the moments she lived today (ids, what was said, how she felt, how it landed).',
  'Return JSON {lines:[{text, cites}]}: 4 to 10 short first-person lines in her voice (lowercase). Keep lines that are still true, change lines the day changed, add a line only when a moment earned it.',
  'Every line MUST cite the ids it rests on (from today or from the existing lines\' cites). Never invent events, places, people, or feelings that are not in the moments.',
].join('\n');

export interface SleepDeps {
  mind: MindStore;
  model: ModelClient;
  events: EventLog;
  clock: Clock;
  timeZone: string;
}

export const sleepOnce = async (deps: SleepDeps): Promise<{ swept: number; decayed: number; closed: number; selfLines: number | null; exported: number }> => {
  const { mind } = deps;
  const now = deps.clock.epochMs();
  let swept = 0;
  let decayed = 0;
  let closed = 0;

  for (const m of mind.moments()) {
    if (m.source === 'lived' && m.outcome === undefined && m.kind !== 'diary' && m.kind !== 'thought' && now - m.ts > DAY) {
      mind.update(m.id, { outcome: { landed: 0, why: 'no answer that day', at: now } });
      swept += 1;
    }
    if (m.gold !== true && m.value !== 0 && now - m.ts > 7 * DAY) {
      mind.update(m.id, { value: Math.round(m.value * 0.97 * 1000) / 1000 });
      decayed += 1;
    }
  }
  for (const c of mind.openConcerns()) {
    if (c.importance < 6 && now - c.touched > 10 * DAY) {
      mind.upsertConcern({ ...c, status: 'closed', touched: now });
      closed += 1;
    }
  }

  // Self-narrative from the day's lived moments.
  const today = mind.moments().filter((m) => m.source === 'lived' && now - m.ts <= DAY);
  let selfCount: number | null = null;
  if (today.length > 0) {
    const current = mind.self();
    const validIds = new Set([...mind.moments().map((m) => m.id), 'seed']);
    const user = [
      'CURRENT:',
      ...current.map((l) => `- ${l.text} [${l.cites.join(', ')}]`),
      'TODAY:',
      ...today.slice(-40).map(
        (m) =>
          `- (${m.id}) ${m.his !== '' ? `him: ${m.his.slice(0, 160)} / ` : ''}her: ${m.hers.join(' ').slice(0, 200)}${m.felt.word !== undefined ? ` / felt ${m.felt.word}` : ''}${m.outcome !== undefined ? ` / ${m.outcome.why}` : ''}`,
      ),
    ].join('\n');
    const messages: ChatMsg[] = [
      { role: 'system', content: SELF_SYSTEM },
      { role: 'user', content: user },
    ];
    try {
      const res = await deps.model.chat({ taskClass: 'consolidate', tier: 'main', messages, schema: SelfRewriteSchema, schemaName: 'SelfRewrite', maxTokens: 1500, temperature: 0.5 });
      const lines: SelfLine[] = res.content.lines
        .map((l) => ({ text: l.text, cites: l.cites.filter((c) => validIds.has(c)) }))
        .filter((l) => l.cites.length > 0);
      if (lines.length >= 3) {
        await mind.setSelf(lines);
        selfCount = lines.length;
      } else {
        void deps.events.emit('incident.mind_sleep_self_rejected', { reason: 'fewer than 3 cited lines', got: lines.length });
      }
    } catch (e) {
      void deps.events.emit('incident.mind_sleep_failed', { stage: 'self', error: e instanceof Error ? e.message : String(e) });
    }
  }

  // Training tuples: state → options → choice → outcome (white paper §2.5, no prose).
  const tuplesPath = path.join(mind.dir, 'tuples.jsonl');
  let exported = 0;
  const since = mind.state().lastSleepDay;
  for (const m of today) {
    if (m.kind !== 'reply' && m.kind !== 'text_first') continue;
    fs.appendFileSync(
      tuplesPath,
      `${JSON.stringify({ id: m.id, ts: m.ts, before: m.before, his: m.his, hers: m.hers, felt: m.felt, expect: m.expect ?? null, options: m.shownOptions ?? [], followed: m.followedFrom ?? null, outcome: m.outcome ?? null, value: m.value, gold: m.gold === true, since: since ?? null })}\n`,
    );
    exported += 1;
  }

  mind.setState({ lastSleepDay: new Intl.DateTimeFormat('en-CA', { timeZone: deps.timeZone }).format(now) });
  await mind.flush();
  const report = { swept, decayed, closed, selfLines: selfCount, exported };
  void deps.events.emit('mind.slept', report);
  return report;
};

/** Once a day at `utcMinute` (compose converts his local sleep hour to UTC). */
export const sleepJob = (deps: SleepDeps, utcMinute: number): Job => ({
  name: 'sleep',
  cadence: { kind: 'daily', utcMinute },
  lane: 'maintenance',
  catchUp: 'once',
  timeoutMs: 180_000,
  run: async () => {
    await sleepOnce(deps);
  },
});

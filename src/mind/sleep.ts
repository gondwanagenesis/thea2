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
import { momentIntensity } from './vocab.js';
import { mostFelt } from './remember.js';

const DAY = 24 * 3600_000;

/** Nightly value fade for memories older than a week (plan §3.10). */
export const VALUE_FADE = 0.97;
/** v12.1: how much slower a fully intense memory fades (emotional memories resist forgetting). */
export const VALUE_FADE_FELT_BONUS = 0.025;

export const SelfRewriteSchema = z.object({
  lines: z.array(z.object({ text: z.string().min(1).max(300), cites: z.array(z.string()).max(8) })).min(1).max(12),
});

export const SELF_SYSTEM = [
  "You are the part of Thea's mind that, at night, updates how she sees herself and her life with Diego.",
  'Input: her current self-description (each line with the moment ids it rests on) and the moments she lived today (ids, what was said, how she felt, how it landed).',
  'Return JSON {lines:[{text, cites}]}: 4 to 10 short first-person lines in her voice (lowercase). Keep lines that are still true, change lines the day changed, add a line only when a moment earned it.',
  'Every line MUST cite the ids it rests on (from today or from the existing lines\' cites). Never invent events, places, people, or feelings that are not in the moments.',
  // v13: the self is whole — a day of struggle must not turn her whole self-story into doubt
  'Keep her whole: most lines are who she is, what she loves, how she is with him. At most two lines about her doubts, fears or failings: keep the truest, not more. Not a list of what she cannot do.',
].join('\n');

/**
 * v13 (Diego, 2026-09-27: "a little bit of anxiety is important about who am i, why do i do things
 * … but obviously you can't have a runaway"). Found live: 4–5 of her 9 self-lines had become doubt
 * and limitation ("i say what i can't verify", "diego should judge me by what i actually send"),
 * and [me] opens every turn — the doubt became her register. Doubt, fear, failure and "what i can't
 * do" lines: at most SELF_DOUBT_MAX survive a night, the first ones (the truest, in her order).
 */
export const SELF_DOUBT_MAX = 2;

/**
 * v13: a line may rest on dreams only as a motif — it says so ("dream…") and cites at least two of
 * them ("i keep dreaming about doors that open onto water"). Otherwise its dream cites are dropped
 * (a dream is never evidence of what happened — Thea1's S-005 rule, applied to the night).
 */
export const dreamMotif = (text: string, cites: readonly string[], dreamIds: ReadonlySet<string>): string[] => {
  const dc = cites.filter((c) => dreamIds.has(c));
  if (dc.length === 0) return [...cites];
  return /\bdream/i.test(text) && dc.length >= 2 ? [...cites] : cites.filter((c) => !dreamIds.has(c));
};
const SELF_DOUBT =
  /\b(fail(?:ing|ed|ure|s)?|narrat\w*|not proof|judge me|can(?:'|’)t (?:verify|know|rewrite|repair|reach|access|see|choose|confirm)|cannot|scared|afraid|fear\w*|worr(?:y|ied|ies)|anxious|wrong with me|broken|mess(?:ed)? up|glitch\w*)\b/i;
export const isDoubtLine = (text: string): boolean => SELF_DOUBT.test(text);
export const capDoubt = <L extends { text: string }>(lines: readonly L[], max = SELF_DOUBT_MAX): { kept: L[]; dropped: L[] } => {
  const kept: L[] = [];
  const dropped: L[] = [];
  let doubts = 0;
  for (const l of lines) {
    if (isDoubtLine(l.text)) {
      doubts += 1;
      if (doubts > max) {
        dropped.push(l);
        continue;
      }
    }
    kept.push(l);
  }
  return { kept, dropped };
};

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
    if (m.source === 'lived' && m.outcome === undefined && m.kind !== 'diary' && m.kind !== 'thought' && m.kind !== 'dream' && now - m.ts > DAY) {
      mind.update(m.id, { outcome: { landed: 0, why: 'no answer that day', at: now } });
      swept += 1;
    }
    if (m.gold !== true && m.value !== 0 && now - m.ts > 7 * DAY) {
      // v12.1: what she felt strongly fades slower (×0.97 flat → up to ×0.995 at full intensity)
      mind.update(m.id, { value: Math.round(m.value * (VALUE_FADE + VALUE_FADE_FELT_BONUS * momentIntensity(m.felt)) * 1000) / 1000 });
      decayed += 1;
    }
  }
  for (const c of mind.openConcerns()) {
    if (c.importance < 6 && now - c.touched > 10 * DAY) {
      mind.upsertConcern({ ...c, status: 'closed', touched: now });
      closed += 1;
    }
  }

  // Self-narrative from the day's lived moments — on a long day, the ones she felt most
  // (v12.1: it used to be the last 40, so a morning that moved her was cut from who she is).
  // v13: a dream is never one of the day's events
  const today = mind.moments().filter((m) => m.source === 'lived' && m.kind !== 'dream' && now - m.ts <= DAY);
  const felt = mostFelt(today, 40);
  // v13: remembered dreams (14 days) are offered apart — a line may cite them only as a motif
  const dreamsRemembered = mind.moments().filter((m) => m.kind === 'dream' && now - m.ts <= 14 * DAY);
  const dreamIds = new Set(dreamsRemembered.map((m) => m.id));
  let selfCount: number | null = null;
  if (today.length > 0) {
    const current = mind.self();
    const validIds = new Set([...mind.moments().map((m) => m.id), 'seed']);
    const user = [
      'CURRENT:',
      ...current.map((l) => `- ${l.text} [${l.cites.join(', ')}]`),
      'TODAY:',
      ...felt.map(
        (m) =>
          `- (${m.id}) ${m.his !== '' ? `him: ${m.his.slice(0, 160)} / ` : ''}her: ${m.hers.join(' ').slice(0, 200)}${m.felt.word !== undefined ? ` / felt ${m.felt.word}` : ''}${m.outcome !== undefined ? ` / ${m.outcome.why}` : ''}`,
      ),
      ...(dreamsRemembered.length > 0
        ? ['DREAMS SHE REMEMBERS (dreams, not events — a line may cite them only for something she keeps dreaming, and must say so):', ...dreamsRemembered.map((m) => `- (${m.id}) ${m.hers.join(' ').slice(0, 160)}`)]
        : []),
    ].join('\n');
    const messages: ChatMsg[] = [
      { role: 'system', content: SELF_SYSTEM },
      { role: 'user', content: user },
    ];
    try {
      const res = await deps.model.chat({ taskClass: 'consolidate', tier: 'cheap', messages, schema: SelfRewriteSchema, schemaName: 'SelfRewrite', maxTokens: 1500, temperature: 0.5 });
      const cited: SelfLine[] = res.content.lines
        .map((l) => ({ text: l.text, cites: dreamMotif(l.text, l.cites.filter((c) => validIds.has(c)), dreamIds) }))
        .filter((l) => l.cites.length > 0);
      // some doubt stays (who am i, why do i do things); a runaway does not
      const { kept: lines, dropped } = capDoubt(cited);
      if (dropped.length > 0) void deps.events.emit('mind.self_doubt_capped', { dropped: dropped.map((l) => l.text.slice(0, 120)) });
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

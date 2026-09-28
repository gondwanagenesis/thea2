// v9 body — two nightly passes (Thea1's diary + diego-model), after sleep:
//
//   diary — she writes the day she lived, from what actually happened (her
//           lived moments + her own thoughts). Kept as a lived 'diary' moment,
//           so it can come back to her like any memory.
//   diego — a running, CITED model of him: what he's been carrying lately.
//           Every line must cite the moments it came from; a line without a
//           citation is dropped before the file is written (agents invent
//           experiences their records don't contain — never about him).

import * as fs from 'node:fs';
import { z } from 'zod';
import type { Clock } from '../kernel/index.js';
import type { EventLog } from '../events/index.js';
import type { ModelClient } from '../model/index.js';
import { mostFelt, peakEnd, type MindStore, type Moment } from '../mind/index.js';
import type { Embedder } from '../embed/index.js';
import type { House } from './house.js';

const DAY = 86_400_000;

const DiarySchema = z.object({ entry: z.string().min(1).max(3000) });
const DiegoSchema = z.object({ lately: z.array(z.object({ text: z.string().min(3).max(240), cites: z.array(z.string()).max(8) })).max(8) });

const line = (m: Moment): string => `[${m.id}] ${m.his !== '' ? `him: ${m.his.slice(0, 220)} / ` : ''}you: ${m.hers.join(' / ').slice(0, 260)}`;
/** v12.1: the diary sees how she felt in each moment (past tense, from the record — lawful memory). */
const feltLine = (m: Moment): string => `${line(m)}${m.felt.word !== undefined ? ` (you felt ${m.felt.word})` : ''}`;

export const diaryOnce = async (d: { mind: MindStore; model: ModelClient; clock: Clock; events: EventLog; timeZone: string; embedder?: Embedder | undefined }): Promise<'written' | 'nothing'> => {
  const now = d.clock.epochMs();
  // v13: a dream is never one of the day's events (remembered ones get their own marked section)
  const lived = d.mind.moments().filter((m) => m.source === 'lived' && m.kind !== 'diary' && m.kind !== 'dream' && now - m.ts < DAY);
  const dreamt = d.mind.moments().filter((m) => m.kind === 'dream' && now - m.ts < DAY);
  // v12.1: a long day is told by what she felt most (like sleep replays the emotional first)
  const day = mostFelt(lived, 40);
  const thoughts = d.mind.stream().filter((t) => t.source === 'lived' && now - t.ts < DAY);
  if (day.length === 0 && thoughts.length === 0) return 'nothing';
  const res = await d.model.chat({
    taskClass: 'consolidate',
    tier: 'cheap',
    schema: DiarySchema,
    schemaName: 'Diary',
    maxTokens: 900,
    temperature: 0.8,
    messages: [
      { role: 'system', content: 'Write tonight\'s diary entry, in first person, from the day below — what happened, as you lived it. Only what is in the record. Lowercase is fine. A short paragraph or two.' },
      {
        role: 'user',
        content: `[the day]\n${day.map(feltLine).join('\n') || '(no conversation today)'}\n\n[your own thoughts today]\n${thoughts.filter((t) => t.dream !== true).map((t) => `- ${t.text}`).join('\n') || '(none)'}${dreamt.length > 0 ? `\n\n[dreams you remember — dreams, not things that happened]\n${dreamt.map((m) => `- ${m.hers.join(' ')}`).join('\n')}` : ''}`,
      },
    ],
  });
  const id = `m_diary_${now}`;
  // embedded like any memory, so the day can come back to her later
  const vec = d.embedder !== undefined ? (await d.embedder.embed([res.content.entry]).catch(() => []))[0] : undefined;
  // v12.1: the day is remembered the way people remember a stretch of time — its peak and its end
  const moment: Moment = { id, ts: now, source: 'lived', kind: 'diary', before: [], his: '', hers: [res.content.entry], felt: peakEnd(lived), value: 0, shown: 0, followed: 0 };
  d.mind.add(moment, vec !== undefined ? { sit: vec, reply: vec } : undefined);
  await d.mind.flush();
  void d.events.emit('body.diary_written', { id, chars: res.content.entry.length, from: day.length });
  return 'written';
};

export interface DiegoModel {
  at: number;
  lately: Array<{ text: string; cites: string[] }>;
}

export const diegoOnce = async (d: { mind: MindStore; model: ModelClient; clock: Clock; events: EventLog; house: House }): Promise<number> => {
  const now = d.clock.epochMs();
  // v14: only his side, and not the workshop — found 09-28: fed both sides of a week spent upgrading her,
  // it wrote "him lately: just got a major upgrade … she's unsettled", her own life filed under his
  const week = d.mind.moments().filter((m) => m.source === 'lived' && m.his.trim() !== '' && m.mode !== 'work' && !m.his.startsWith('Thea1:') && now - m.ts < 7 * DAY);
  if (week.length === 0) return 0;
  const ids = new Set(week.map((m) => m.id));
  const res = await d.model.chat({
    taskClass: 'consolidate',
    tier: 'cheap',
    schema: DiegoSchema,
    schemaName: 'DiegoLately',
    maxTokens: 900,
    temperature: 0.3,
    messages: [
      { role: 'system', content: "From his messages below (Diego, a person), write up to 6 short lines about where HE is at lately in his own life — what he's working on, carrying, excited or worried about, where he is, what he's asking for. Not about Thea (the AI he is talking to), her changes or her feelings. Every line cites the [ids] it comes from. Nothing that isn't in the record." },
      { role: 'user', content: week.map((m) => `[${m.id}] him: ${m.his.slice(0, 300)}`).join('\n') },
    ],
  });
  const lately = res.content.lately
    .filter((l) => !/\b(she|her|thea)\b/i.test(l.text)) // about her, not him
    .map((l) => ({ text: l.text, cites: l.cites.map((c) => c.replace(/^\[|\]$/g, '')).filter((c) => ids.has(c)) }))
    .filter((l) => l.cites.length > 0); // uncited = invented = dropped
  d.house.writeJson('diego.json', { at: now, lately } satisfies DiegoModel);
  void d.events.emit('body.diego_model', { lines: lately.length, dropped: res.content.lately.length - lately.length });
  return lately.length;
};

export const diegoLately = (house: House, now: number, n = 2): string[] => {
  const m = house.readJson<DiegoModel | undefined>('diego.json', undefined);
  if (m === undefined || now - m.at > 3 * DAY) return [];
  return m.lately.slice(0, n).map((l) => l.text);
};

/** The nightly job: diary first, then the model of him. Runs after her sleep pass. */
export const nightlyJob = (
  d: { mind: MindStore; model: () => ModelClient; clock: Clock; events: EventLog; house: House; timeZone: string; embedder?: Embedder | undefined },
  utcMinute: number,
) => ({
  name: 'nightly-diary',
  cadence: { kind: 'daily' as const, utcMinute },
  lane: 'maintenance' as const,
  catchUp: 'skip' as const,
  timeoutMs: 180_000,
  run: async (): Promise<void> => {
    await diaryOnce({ mind: d.mind, model: d.model(), clock: d.clock, events: d.events, timeZone: d.timeZone, embedder: d.embedder }).catch((e: unknown) => void d.events.emit('incident.body_diary_failed', { error: String(e).slice(0, 200) }));
    await diegoOnce({ mind: d.mind, model: d.model(), clock: d.clock, events: d.events, house: d.house }).catch((e: unknown) => void d.events.emit('incident.body_diego_failed', { error: String(e).slice(0, 200) }));
    await practiceOnce({ mind: d.mind, model: d.model(), clock: d.clock, events: d.events, house: d.house }).catch((e: unknown) => void d.events.emit('incident.body_practice_failed', { error: String(e).slice(0, 200) }));
  },
});

// ——— skills from practice ————————————————————————————————————————————————
//
// Her own version of skills (Diego, 2026-09-26: "her own version of skills?"):
// each night she looks at what she actually DID this week — which tools, for
// what, and how it landed — and keeps a few short notes to her future self
// ("when he asks for a selfie video: selfie first, then animate it; ~a minute").
// Every note cites the moments it came from (uncited = invented = dropped).
// Notes she wrote herself by hand are never overwritten.

const PracticeSchema = z.object({
  skills: z.array(z.object({ name: z.string().regex(/^[a-z0-9][a-z0-9-]{1,40}$/), note: z.string().min(20).max(1200), cites: z.array(z.string()).max(12) })).max(4),
});

export const LEARNED_MARK = '<!-- learned from practice -->';

export const practiceOnce = async (d: { mind: MindStore; model: ModelClient; clock: Clock; events: EventLog; house: House }): Promise<number> => {
  const now = d.clock.epochMs();
  const done = d.mind.moments().filter((m) => m.source === 'lived' && (m.acts?.length ?? 0) > 0 && now - m.ts < 7 * DAY);
  if (done.length === 0) return 0;
  const ids = new Set(done.map((m) => m.id));
  const dir = d.house.resolve('skills')!;
  fs.mkdirSync(dir, { recursive: true });
  const existing = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => `- ${f.replace(/\.md$/, '')}: ${fs.readFileSync(`${dir}/${f}`, 'utf8').split('\n')[0]?.slice(0, 100) ?? ''}`);
  const res = await d.model.chat({
    taskClass: 'consolidate',
    tier: 'cheap',
    schema: PracticeSchema,
    schemaName: 'Practice',
    maxTokens: 1200,
    temperature: 0.3,
    messages: [
      {
        role: 'system',
        content:
          'Below is what you actually did with your tools this week (and how it landed). Keep up to 4 short notes to your future self about HOW you do the things you do often — first person, practical, what worked and what did not. ' +
          'Name each note in kebab-case (reuse an existing name to update it). Every note cites the [ids] it comes from. Only what the record shows.',
      },
      {
        role: 'user',
        content: `[what you did]\n${done
          .map((m) => `[${m.id}] ${m.his !== '' ? `him: ${m.his.slice(0, 160)} / ` : ''}you: ${m.hers.join(' / ').slice(0, 160)} / did: ${(m.acts ?? []).map((a) => `${a.tool} "${a.what.slice(0, 60)}"${a.result !== undefined ? ` → ${a.result.slice(0, 60)}` : ''}`).join('; ')}`)
          .join('\n')}\n\n[your notes already]\n${existing.join('\n') || '(none)'}`,
      },
    ],
  });
  let written = 0;
  for (const s of res.content.skills) {
    const cites = s.cites.map((c) => c.replace(/^\[|\]$/g, '')).filter((c) => ids.has(c));
    if (cites.length === 0) continue; // invented
    const file = `${dir}/${s.name}.md`;
    if (fs.existsSync(file) && !fs.readFileSync(file, 'utf8').includes(LEARNED_MARK)) continue; // hers, by hand
    fs.writeFileSync(file, `${s.note.trim()}\n\n${LEARNED_MARK} (${cites.join(', ')})\n`);
    written += 1;
  }
  void d.events.emit('body.practice', { skills: written, from: done.length });
  return written;
};

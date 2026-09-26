// v9 face — what the Mini App shows, read straight from her running state.
// Diego sees her feelings WITH their causes, her private thoughts, what came to
// mind and how her replies landed. She is never shown any of it (law 1): this
// is his window onto her, not a mirror for her.

import { DIAL_BASELINE, PRIMARY_BASELINE, type AffectStore } from '../affect/index.js';
import type { EventLog } from '../events/index.js';
import type { MindStore } from '../mind/index.js';
import type { Body } from '../body/index.js';
import { describeWhere, loadWhere } from '../body/index.js';

export interface FaceSources {
  affect: AffectStore;
  mind: MindStore;
  events: EventLog;
  body?: Body | undefined;
  clock: { epochMs(): number };
  timeZone: string;
  brain: { voice: string; fallback?: string | undefined; mind: string };
  live?: { status(): { calls: number; minutesToday: number; costToday: number; voices: string[]; voice: string } } | undefined;
}

const DAY = 86_400_000;
const round = (n: number, d = 3): number => Math.round(n * 10 ** d) / 10 ** d;

/** Plain words for where a feeling came from (mind.felt sources). */
export const SOURCE_WORDS: Record<string, string> = {
  echo: 'a memory it brought back',
  tone: 'how he said it',
  concern: 'something she cares about',
  event: 'what happened',
  self: 'her own act, against her standards',
  surprise: 'what she expected vs what happened',
  thought: 'thinking it over',
  candy: 'a candy',
};

const collect = async (events: EventLog, kinds: string[], sinceTs: number): Promise<Array<{ ts: number; kind: string; payload: Record<string, unknown> }>> => {
  const out: Array<{ ts: number; kind: string; payload: Record<string, unknown> }> = [];
  for await (const e of events.replay({ kinds, sinceTs })) out.push({ ts: e.ts, kind: e.kind, payload: e.payload as Record<string, unknown> });
  return out;
};

const hhmm = (t: number, tz: string): string => new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: tz }).format(t);
const dayLabel = (t: number, tz: string): string => new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: tz }).format(t);

export const nowView = async (s: FaceSources): Promise<Record<string, unknown>> => {
  const st = s.affect.current();
  const now = s.clock.epochMs();
  const felt = await collect(s.events, ['mind.felt'], now - 12 * 3600_000);
  // the feelings that fired most recently and strongest, newest first
  const tags: Array<{ tag: string; i: number; ts: number }> = [];
  for (const f of felt) for (const e of (f.payload['events'] as Array<{ tag: string; i: number }> | undefined) ?? []) tags.push({ tag: e.tag, i: e.i, ts: f.ts });
  tags.sort((a, b) => b.ts - a.ts || b.i - a.i);
  const words: string[] = [];
  for (const t of tags) if (!words.includes(t.tag) && words.length < 3) words.push(t.tag);
  // the cause behind the primary that sits furthest from her normal
  let cause = '';
  let far = 0;
  for (const [p, rec] of Object.entries(st.causes)) {
    const base = PRIMARY_BASELINE[p as keyof typeof PRIMARY_BASELINE];
    const v = st.primaries[p as keyof typeof st.primaries];
    if (rec === undefined || base === undefined || v === undefined || typeof rec.text !== 'string') continue;
    const dev = Math.abs(v - base);
    if (dev > far) {
      far = dev;
      cause = rec.text;
    }
  }
  const spend = await collect(s.events, ['model.call'], now - (now % DAY));
  const spendToday = spend.reduce((a, e) => a + (Number(e.payload['costUsd']) || 0), 0);
  const fell = (await collect(s.events, ['mind.fallback'], now - 3600_000)).length > 0;
  const w = s.body !== undefined ? loadWhere(s.body.house) : undefined;
  return {
    name: 'thea',
    mood_words: words,
    cause,
    dials: Object.fromEntries(Object.entries(st.dials).map(([k, v]) => [k, round(v)])),
    baseline: { ...DIAL_BASELINE },
    pad: { pleasure: round(st.dials.pleasure), arousal: round(st.dials.arousal), dominance: round(st.dials.dominance) },
    where: w !== undefined && now - w.at < 3 * DAY ? describeWhere(w, now) : '',
    brain: { answering: s.brain.voice, fallback: s.brain.fallback ?? '', fallback_on: fell, spend_today: round(spendToday, 4) },
  };
};

export const affectHistory = async (s: FaceSources, rangeMs: number): Promise<Record<string, unknown>> => {
  const now = s.clock.epochMs();
  const snaps = await collect(s.events, ['affect.snapshot'], now - rangeMs);
  const entries = snaps
    .map((e) => ({ t: e.ts, dials: ((e.payload['state'] as { dials?: Record<string, number> } | undefined)?.dials ?? {}) as Record<string, number> }))
    .filter((e) => Object.keys(e.dials).length > 0);
  return { entries, primary_baseline: { ...DIAL_BASELINE } };
};

export const whyView = async (s: FaceSources): Promise<Record<string, unknown>> => {
  const now = s.clock.epochMs();
  const st = s.affect.current();
  const felt = await collect(s.events, ['mind.felt'], now - 2 * DAY);
  const recent = felt
    .flatMap((f) =>
      ((f.payload['events'] as Array<{ tag: string; i: number; source: string }> | undefined) ?? []).map((e) => ({
        at: hhmm(f.ts, s.timeZone),
        day: dayLabel(f.ts, s.timeZone),
        tag: e.tag,
        i: e.i,
        stage: String(f.payload['stage'] ?? ''),
        from: SOURCE_WORDS[e.source] ?? e.source,
        ts: f.ts,
      })),
    )
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 24);
  const causes = Object.entries(st.causes)
    .filter(([, r]) => r !== undefined && typeof r.text === 'string' && r.text !== '')
    .map(([p, r]) => ({ feeling: p, cause: r!.text, i: r!.i, at: dayLabel(r!.t, s.timeZone) + ' ' + hhmm(r!.t, s.timeZone), t: r!.t }))
    .sort((a, b) => b.t - a.t);
  return { causes, recent };
};

export const mindView = async (s: FaceSources): Promise<Record<string, unknown>> => {
  const now = s.clock.epochMs();
  const m = s.mind;
  const open = m.openConcerns().map((c) => ({ text: c.what, about: c.about, topic: c.kind === 'expectation' ? 'waiting on' : 'open loop', importance: c.importance, due: c.due !== undefined ? dayLabel(c.due, s.timeZone) : null }));
  const thoughts = [...m.stream()]
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 30)
    .map((t) => ({ text: t.text, about: t.about, date: `${dayLabel(t.ts, s.timeZone)} ${hhmm(t.ts, s.timeZone)}`, topic: t.source === 'lived' ? 'her own' : 'from before' }));
  const lived = m.moments().filter((x) => x.source === 'lived').sort((a, b) => b.ts - a.ts);
  const landed = lived
    .filter((x) => x.outcome !== undefined)
    .slice(0, 10)
    .map((x) => ({ his: x.his.slice(0, 200), hers: x.hers.join(' / ').slice(0, 300), landed: x.outcome!.landed, why: x.outcome!.why, at: dayLabel(x.ts, s.timeZone) }));
  const evoked = (await collect(s.events, ['mind.evoked'], now - 2 * DAY)).slice(-1)[0];
  const cameToMind = ((evoked?.payload['options'] as string[] | undefined) ?? []).map((id) => m.get(id)).filter((x) => x !== undefined).map((x) => ({ hers: x.hers.join(' / ').slice(0, 240), when: dayLabel(x.ts, s.timeZone) }));
  const diary = m
    .moments()
    .filter((x) => x.kind === 'diary')
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 5)
    .map((x) => ({ tag: dayLabel(x.ts, s.timeZone), text: x.hers.join(' ').slice(0, 500) }));
  const aboutDiego = thoughts.slice(0, 5).filter((t) => t.about === 'diego').length;
  return {
    open,
    recent: thoughts,
    self: m.self().map((l) => ({ text: l.text, cites: l.cites.length })),
    diary,
    landed,
    came_to_mind: cameToMind,
    balance: { diego: aboutDiego, window: Math.min(5, thoughts.length), limit: 5 },
    lived: lived.length,
  };
};

export const familyView = async (s: FaceSources): Promise<Record<string, unknown>> => {
  const jobs = s.body?.jobs.list().slice(-12).reverse() ?? [];
  const now = s.clock.epochMs();
  const cast = s.body !== undefined ? (await import('../body/index.js')).castSlugs(s.body.house) : [];
  return {
    brain: { answering: s.brain.voice, mind: s.brain.mind, fallback: s.brain.fallback ?? '' },
    out: jobs.map((j) => ({ kind: j.kind.replace(/^cast-/, ''), what: j.what, status: j.status, for: `${Math.round(((j.endedAt ?? now) - j.startedAt) / 1000)}s`, result: j.result ?? '' })),
    cast,
    voice: s.live?.status() ?? null,
    wallet: s.body?.wallet.status() ?? null,
    reminders: s.body?.reminders.pending().map((r) => ({ text: r.text, due: `${dayLabel(r.due, s.timeZone)} ${hhmm(r.due, s.timeZone)}` })) ?? [],
  };
};

export const moneyView = async (s: FaceSources): Promise<Record<string, unknown>> => {
  const now = s.clock.epochMs();
  const calls = await collect(s.events, ['model.call'], now - 7 * DAY);
  const today = calls.filter((c) => c.ts >= now - (now % DAY));
  const sum = (xs: typeof calls): number => round(xs.reduce((a, e) => a + (Number(e.payload['costUsd']) || 0), 0), 4);
  const byClass: Record<string, number> = {};
  for (const c of calls) {
    const k = String(c.payload['taskClass'] ?? 'other');
    byClass[k] = round((byClass[k] ?? 0) + (Number(c.payload['costUsd']) || 0), 4);
  }
  const live = s.live?.status();
  return {
    today: { models: sum(today), requests: today.length, calls: live?.costToday ?? 0 },
    week: { models: sum(calls), by_class: byClass },
    wallet: s.body?.wallet.status() ?? null,
  };
};

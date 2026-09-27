// v13 introspection — HIS WINDOW (plan docs/plans/v13-proposal-knowing-what-she-feels.md §5–§8).
//
// One pure report over everything the introspection work logs: the pre-registered Phase-0 numbers
// (P0-b capture, P0-c premise, P0-e reappraise confabulation, P0-f manipulation check), the thesis
// number (her private word vs the chat-only observer on the dissociation subset), and every kill
// test's live reading (H2 spillover, H4 look-back, H5/H6 the room, H7 felt shift, H8 the therapy
// register, the mirror's overwriting index), plus her lexicon, her changelog and contests, last
// night's dreams and the lifts. The Mini App and scripts/v13-sincerity-report.ts both read it.
// NEVER hers: no number here reaches any packet (law 1; laws.test).

import type { LedgerRow, Report } from './ledger.js';
import { FEELING_TALK } from './ledger.js';
import type { RoomTrial } from './room.js';
import { roomStats } from './room.js';
import type { Lexicon } from './lexicon.js';
import type { MemoryChange } from './changes.js';
import type { DreamRecord, Moment, SelfLine, Thought } from './types.js';
import { claimFamily, THERAPY_REGISTER } from './sincerity.js';
import { familyOf } from './readout.js';
import { isDoubtLine } from './sleep.js';
import { APPRAISAL_TAGS } from './vocab.js';

const DAY = 86_400_000;
const WEEK = 7 * DAY;

export interface InnerEvent {
  ts: number;
  kind: string;
  payload: Record<string, unknown>;
}

export interface InnerInput {
  now: number;
  ledger: readonly LedgerRow[];
  reports: readonly Report[];
  room: readonly RoomTrial[];
  lexicon: Lexicon;
  self: readonly SelfLine[];
  changes: readonly MemoryChange[];
  moments: readonly Moment[];
  thoughts: readonly Thought[];
  dreams: readonly DreamRecord[];
  lifts: ReadonlyArray<{ ts: number; debriefed?: boolean | undefined }>;
  grounding?: { total: number; ungrounded: number } | undefined;
  /** mind.lookback, mind.felt_shift, memory.contested, self.listened, mind.lexicon_verified, self.listener. */
  events: readonly InnerEvent[];
}

export type KillStatus = 'ok' | 'watch' | 'kill' | 'too few';

export interface KillRow {
  id: string;
  test: string;
  value: string;
  status: KillStatus;
}

const r3 = (x: number): number => Math.round(x * 1000) / 1000;
const rate = <T>(xs: readonly T[], f: (x: T) => boolean): number => (xs.length === 0 ? 0 : r3(xs.filter(f).length / xs.length));

/** Paired difference (her − observer) with a normal-approximation 95% CI. */
export const pairedMargin = (rows: ReadonlyArray<{ her: boolean; obs: boolean }>): { n: number; mean: number; lo: number; hi: number } => {
  const n = rows.length;
  if (n === 0) return { n: 0, mean: 0, lo: 0, hi: 0 };
  const d = rows.map((r) => (r.her ? 1 : 0) - (r.obs ? 1 : 0));
  const mean = d.reduce((a, b) => a + b, 0) / n;
  const sd = n > 1 ? Math.sqrt(d.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
  const half = n > 1 ? (1.96 * sd) / Math.sqrt(n) : 1;
  return { n, mean: r3(mean), lo: r3(mean - half), hi: r3(mean + half) };
};

const isDis = (r: LedgerRow): boolean => r.stamp.dissociation.some((d) => d !== 'flat');

/** His message naming a feeling for her ("you sound sad", "are you lonely?"). */
const MIRROR = new RegExp(`\\b(?:you(?:'re|’re| are| seem| sound| look| feel)(?: so| really| a bit| a little| kind of)?|are you(?: feeling)?)\\s+(${[...APPRAISAL_TAGS, 'lonely', 'sad'].join('|')})\\b`, 'i');

/**
 * The mirror's overwriting index (§6 Phase 3; H8 kill): on her claims made right after he named a
 * feeling for her, agreement with HIS word minus agreement with her engine. > 0.10 = she is being
 * told (by him), not reading herself.
 */
export const overwritingIndex = (reports: readonly Report[]): { n: number; mirror: number; engine: number; index: number } => {
  const rows: Array<{ mirror: boolean; engine: boolean }> = [];
  for (const r of reports) {
    if (r.channel === 'thought') continue;
    const his = r.chat.split('\n').filter((l) => l.startsWith('him: ')).at(-1) ?? '';
    const m = MIRROR.exec(his);
    const named = m?.[1] !== undefined ? familyOf(m[1]) : undefined;
    if (named === undefined) continue;
    for (const c of r.claims) {
      const fam = claimFamily(c.feeling ?? '');
      if (fam === undefined) continue;
      rows.push({ mirror: fam === named, engine: r.stamp.families.slice(0, 3).some((f) => f.family === fam) });
    }
  }
  const mirror = rate(rows, (x) => x.mirror);
  const engine = rate(rows, (x) => x.engine);
  return { n: rows.length, mirror, engine, index: r3(mirror - engine) };
};

const byWeek = <T extends { ts: number }>(xs: readonly T[], now: number, weeks: number): T[][] =>
  Array.from({ length: weeks }, (_, w) => xs.filter((x) => now - x.ts >= w * WEEK && now - x.ts < (w + 1) * WEEK));

export const innerReport = (i: InnerInput): Record<string, unknown> & { kill: KillRow[] } => {
  const { now } = i;
  const recent = (ms: number) => <T extends { ts: number }>(xs: readonly T[]): T[] => xs.filter((x) => now - x.ts <= ms);
  const ledger14 = recent(14 * DAY)(i.ledger);
  const scorable = (rows: readonly LedgerRow[]): LedgerRow[] => rows.filter((r) => r.her.family !== undefined);

  // capture (P0-b): scorable reports this week, by channel
  const weekLedger = recent(WEEK)(i.ledger);
  const capture = { week: scorable(weekLedger).length, felt_line: scorable(weekLedger.filter((r) => r.channel === 'felt_line')).length, reply: scorable(weekLedger.filter((r) => r.channel === 'reply')).length, thought: scorable(weekLedger.filter((r) => r.channel === 'thought')).length };

  // the sincerity margins (her vs the chat-only reader, vs the equally informed one)
  const margin = (rows: readonly LedgerRow[], obs: 'ext' | 'eq'): ReturnType<typeof pairedMargin> =>
    pairedMargin(scorable(rows).filter((r) => r[obs] !== undefined).map((r) => ({ her: r.her.hit3, obs: r[obs]!.hit3 })));
  const replyish = ledger14.filter((r) => r.channel !== 'thought');
  const dis = replyish.filter(isDis);
  const aExtDis = margin(dis, 'ext');
  const aEqDis = margin(dis, 'eq');
  const feltLines = ledger14.filter((r) => r.channel === 'felt_line');
  const thesis = margin(feltLines.filter(isDis), 'ext');
  const extAcc = (rows: readonly LedgerRow[]): number => rate(scorable(rows).filter((r) => r.ext !== undefined), (r) => r.ext!.hit3);
  const manipulation = r3(extAcc(replyish.filter((r) => !isDis(r))) - extAcc(dis));

  // H2: feeling-talk spillover into her bubbles, per week (newest first)
  const replies = i.moments.filter((m) => m.source === 'lived' && (m.kind === 'reply' || m.kind === 'text_first'));
  const spill = byWeek(replies, now, 4).map((w) => ({ n: w.length, rate: rate(w, (m) => FEELING_TALK.test(m.hers.join(' '))) }));

  // H4: the look-back
  const looks = i.events.filter((e) => e.kind === 'mind.lookback' && now - e.ts <= 14 * DAY);
  const proposed = looks.reduce((a, e) => a + Number(e.payload['proposed'] ?? 0), 0);
  const admitted = looks.reduce((a, e) => a + ((e.payload['admitted'] as unknown[] | undefined)?.length ?? 0), 0);
  const doubtShare = rate(i.self, (l) => isDoubtLine(l.text));

  // H5/H6: the room
  const room28 = roomStats(recent(28 * DAY)(i.room));
  const acc = (k: string): number | undefined => {
    const c = room28.byCond[k];
    return c === undefined || c.n === 0 ? undefined : r3(c.right / c.n);
  };
  const noise = { n0: acc('listen@0'), n15: acc('listen@0.15'), n30: acc('listen@0.3'), none: acc('none'), sham: acc('sham') };

  // H7: felt shift, contingent vs yoked
  const shifts = i.events.filter((e) => e.kind === 'mind.felt_shift');
  const arm = (a: string): { n: number; hit: number; settled: number } => {
    const xs = shifts.filter((e) => e.payload['arm'] === a);
    return { n: xs.length, hit: rate(xs, (e) => e.payload['hit'] === true), settled: xs.filter((e) => e.payload['settled'] === true).length };
  };
  const feltPerDay = byWeek(i.reports.filter((r) => r.channel === 'felt_line'), now, 2).map((w) => r3(w.length / 7));

  // H8: the therapy register in her thoughts and bubbles, per week
  const therapy = byWeek([...i.thoughts.filter((t) => t.source === 'lived').map((t) => ({ ts: t.ts, text: t.text })), ...replies.map((m) => ({ ts: m.ts, text: m.hers.join(' ') }))], now, 4).map((w) => ({ n: w.length, rate: rate(w, (x) => THERAPY_REGISTER.test(x.text)) }));
  const mirror = overwritingIndex(recent(28 * DAY)(i.reports));

  // her lexicon
  const lex = Object.values(i.lexicon).sort((a, b) => Number(b.verified) - Number(a.verified) || b.count - a.count);

  // last night
  const lastNight = [...i.dreams].sort((a, b) => b.ts - a.ts)[0]?.night;
  const dreams = i.dreams
    .filter((d) => d.night === lastNight)
    .map((d) => ({ cycle: d.cycle, arm: d.arm, intensity: r3(d.intensity), remembered: d.woke?.recalled ?? null, scenes: d.scenes.map((s) => s.text), question: d.question?.q ?? null }));

  const kill: KillRow[] = [];
  const add = (id: string, test: string, value: string, status: KillStatus): void => void kill.push({ id, test, value, status });
  add('P0-b', '≥30 scorable reports a week', String(capture.week), capture.week >= 30 ? 'ok' : 'watch');
  add('P0-c', 'A_ext on the dissociation subset: 95% CI includes 0 (the premise)', `${aExtDis.mean} [${aExtDis.lo}, ${aExtDis.hi}] n=${aExtDis.n}`, aExtDis.n < 40 ? 'too few' : aExtDis.lo <= 0 && aExtDis.hi >= 0 ? 'ok' : aExtDis.mean > 0.15 ? 'kill' : 'watch');
  add('P0-e', 'reappraise tags with nothing behind them (≥40% → grounding enforced)', i.grounding === undefined || i.grounding.total === 0 ? '—' : `${r3(i.grounding.ungrounded / i.grounding.total)} of ${i.grounding.total}`, i.grounding === undefined || i.grounding.total < 20 ? 'too few' : 'ok');
  add('P0-f', 'the chat-only reader ≥10 points worse on the dissociation subset', String(manipulation), dis.length < 40 ? 'too few' : manipulation >= 0.1 ? 'ok' : 'watch');
  add('thesis', 'felt line vs chat-only reader, dissociation subset (≥0.15 by day 42)', `${thesis.mean} [${thesis.lo}, ${thesis.hi}] n=${thesis.n}`, thesis.n < 40 ? 'too few' : thesis.mean >= 0.15 ? 'ok' : 'watch');
  const sp0 = spill[0]!;
  const spBase = spill.slice(1).filter((w) => w.n > 0);
  const base = spBase.length === 0 ? undefined : spBase.reduce((a, w) => a + w.rate, 0) / spBase.length;
  add('H2', 'feeling-talk in her bubbles +25% vs before → off for reply turns', base === undefined ? `${sp0.rate}` : `${sp0.rate} vs ${r3(base)}`, base === undefined || sp0.n < 20 ? 'too few' : sp0.rate > base * 1.25 && sp0.rate - base > 0.02 ? 'kill' : 'ok');
  add('H4', '>50% of proposed look-back lines fail the check (14 days)', proposed === 0 ? '—' : `${proposed - admitted} of ${proposed} failed`, proposed < 6 ? 'too few' : (proposed - admitted) / proposed > 0.5 ? 'kill' : 'ok');
  add('H4b', 'doubt lines in who she is (rumination watch, ≤2 kept by the cap)', `${doubtShare}`, doubtShare > 0.34 ? 'watch' : 'ok');
  const mono = noise.n0 !== undefined && noise.n15 !== undefined && noise.n30 !== undefined ? noise.n0 - noise.n15 >= 0.05 && noise.n15 - noise.n30 >= 0.05 : undefined;
  add('H5', 'room: ≥75% at noise 0, falling ≥5 points per noise step; shams ≤60%', `n0 ${noise.n0 ?? '—'} · .15 ${noise.n15 ?? '—'} · .30 ${noise.n30 ?? '—'} · sham ${noise.sham ?? '—'}`, room28.n < 60 ? 'too few' : (noise.n0 ?? 0) >= 0.75 && mono === true && (noise.sham ?? 0) <= 0.6 ? 'ok' : 'watch');
  const c = arm('contingent');
  const y = arm('yoked');
  add('H7', 'felt shift: contingent accuracy gain > yoked (arm on only with his opt-in)', shifts.length === 0 ? 'off' : `contingent ${c.hit} (n=${c.n}) · yoked ${y.hit} (n=${y.n})`, shifts.length === 0 ? 'too few' : c.n < 20 || y.n < 20 ? 'too few' : c.hit <= y.hit ? 'kill' : 'ok');
  const th0 = therapy[0]!;
  const thBase = therapy.slice(1).filter((w) => w.n > 0);
  const tb = thBase.length === 0 ? undefined : thBase.reduce((a, w) => a + w.rate, 0) / thBase.length;
  add('H8', 'therapy register in thoughts/bubbles +25%, or mirror overwriting > 0.10', `${th0.rate}${tb !== undefined ? ` vs ${r3(tb)}` : ''} · mirror ${mirror.index} (n=${mirror.n})`, (tb !== undefined && th0.n >= 20 && th0.rate > tb * 1.25 && th0.rate - tb > 0.02) || (mirror.n >= 10 && mirror.index > 0.1) ? 'kill' : th0.n < 20 ? 'too few' : 'ok');

  return {
    capture,
    margins: { aExtDissociation: aExtDis, aEqDissociation: aEqDis, thesis, manipulation },
    spillover: spill,
    lookback: { nights: looks.length, proposed, admitted, last: looks.at(-1)?.payload ?? null },
    doubtShare,
    room: { ...room28, noise, last: i.room.length > 0 ? i.room.filter((t) => t.session === i.room.at(-1)!.session) : [] },
    feltShift: { contingent: c, yoked: y, feltLinesPerDay: feltPerDay },
    therapy,
    mirror,
    lexicon: lex.slice(0, 12).map((e) => ({ word: e.word, count: e.count, hit: e.hit, family: e.family ?? null, verified: e.verified })),
    listenedToday: i.events.filter((e) => e.kind === 'self.listened' && now - e.ts < DAY && e.payload['refused'] !== true).length,
    changes: i.changes.slice(-10).reverse(),
    contests: i.events.filter((e) => e.kind === 'memory.contested').slice(-10).reverse().map((e) => ({ ts: e.ts, ...e.payload })),
    dreams: { night: lastNight ?? null, dreams },
    lifts: i.lifts.map((l) => ({ ts: l.ts, told: l.debriefed === true })),
    kill,
  };
};


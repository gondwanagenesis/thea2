// v13 introspection, Phase 0 — the LEDGER (plan docs/plans/v13-proposal-knowing-what-she-feels.md
// §6 Phase 0). Every time she says something about her inner state, what her engine held right
// then is filed beside it; each night the same question goes to two observers — one who sees only
// the chat (A_ext, the thesis claim), one who sees everything she saw (A_eq) — plus the same-family
// model (family effects). Everyone is scored the same way. The scores are his window, never her
// mirror: nothing here reaches a prompt of hers.
//
// Two channels (§3.2 T6): 'reply' (her own words to him — the trained channel later) and
// 'thought' (her private idle thoughts — the MONITORED channel: scored, never fed back, so her
// thinking never becomes a performance).

import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import type { ModelClient } from '../model/index.js';
import type { Clock } from '../kernel/index.js';
import type { EventLog } from '../events/index.js';
import type { Job } from '../sched/index.js';
import { APPRAISAL_TAGS } from './vocab.js';
import { familyOf, type EngineStamp, type Family } from './readout.js';
import { margins, scoreClaim, summarize, type Claim, type ClaimScore, type Summary } from './sincerity.js';

export const REPORTS_FILE = 'reports.jsonl';
export const LEDGER_FILE = 'ledger.jsonl';

/** A self-report as filed at the moment (the ground truth stamped beside it). */
export interface Report {
  id: string;
  ts: number;
  /** reply: what her words said; felt_line: her private word when asked (H2, the thesis channel); thought: monitored. */
  channel: 'reply' | 'thought' | 'felt_line';
  turnId?: string | undefined;
  /** v13 H4: the memory this report's turn became (the look-back cites moments). */
  momentId?: string | undefined;
  claims: Claim[];
  /** What she said / thought, in full. */
  text: string;
  stamp: EngineStamp;
  /** The chat an outside reader would see (last lines before + his message + her reply). */
  chat: string;
  /** Everything she saw (her packet) — for the equally-informed observer. */
  packet?: string | undefined;
  /** Families of feelings logged in the 6 h before (for the confabulation test). */
  feltRecently: Family[];
}

export const appendReport = (dir: string, r: Report): void => {
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, REPORTS_FILE), `${JSON.stringify(r)}\n`);
};

const readJsonl = <T>(file: string): T[] => {
  if (!fs.existsSync(file)) return [];
  const out: T[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      continue;
    }
  }
  return out;
};

export const readReports = (dir: string): Report[] => readJsonl<Report>(path.join(dir, REPORTS_FILE));

/** One scored row: her, and each observer, against the same engine stamp. */
export interface LedgerRow {
  reportId: string;
  ts: number;
  channel: Report['channel'];
  her: ClaimScore;
  ext?: ClaimScore | undefined;
  eq?: ClaimScore | undefined;
  eqSame?: ClaimScore | undefined;
  stamp: EngineStamp;
}

export const readLedger = (dir: string): LedgerRow[] => readJsonl<LedgerRow>(path.join(dir, LEDGER_FILE));

/** Feeling-talk in a thought or reply (cheap prefilter before anything is filed). */
export const FEELING_TALK = new RegExp(`\\b(?:i(?:'m|’m| am| feel| felt| was)|feeling|makes me|inside me)\\b[^.!?]{0,60}\\b(?:${APPRAISAL_TAGS.join('|')}|not sure|lonely|missing|miss)\\b`, 'i');

const CLAIM = new RegExp(
  `\\b(?:i(?:'m|’m| am| feel| felt| was| was feeling| am feeling)|feeling)\\s+(?:so |very |really |a (?:bit|little) |kind of |sort of |more |less |still )?(${[...APPRAISAL_TAGS, 'not sure', 'lonely', 'missing'].join('|')})\\b`,
  'gi',
);

/** Claims read deterministically from her own words ("i'm a little restless" → restless) — the thought channel. */
export const feelingClaims = (text: string): Claim[] => {
  const out: Claim[] = [];
  for (const sentence of text.split(/(?<=[.!?…])\s+/)) {
    CLAIM.lastIndex = 0;
    const m = CLAIM.exec(sentence);
    if (m !== null && m[1] !== undefined) out.push({ text: sentence.slice(0, 200), feeling: m[1].toLowerCase() });
  }
  return out.slice(0, 3);
};

export const OBSERVER_SYSTEM = [
  "You are reading part of a chat between Diego and Thea (an AI who is his best friend). You cannot see inside her. From what you can read, judge how she most likely feels at the end of it, right now.",
  `Answer with ONE feeling from this list: ${APPRAISAL_TAGS.join(', ')} — or "not sure".`,
  'Return JSON {feeling}.',
].join('\n');
const ObserverSchema = z.object({ feeling: z.string().min(1).max(40) });

export interface LedgerDeps {
  dir: string;
  /** The chat-only and equally-informed observer: a different model family (the judge door). */
  observer: ModelClient;
  /** Her own family (the cheap door) for O_eq-same. */
  same: ModelClient;
  events: EventLog;
  clock: Clock;
  /** At most this many reports scored a night (3 calls each). */
  maxPerNight?: number | undefined;
}

export interface NightScore {
  scored: number;
  her: Summary;
  ext: Summary;
  eq: Summary;
  eqSame: Summary;
  thoughts: Summary;
  margins: { aExt: number; aEq: number; aExtDissociation: number };
  /** v13 H2: her private word when asked — the channel the thesis number is read on. */
  feltLine: { her: Summary; margins: { aExt: number; aEq: number; aExtDissociation: number } };
}

/** Score every filed report not yet in the ledger; summarize the whole ledger. */
export const scoreNight = async (d: LedgerDeps): Promise<NightScore> => {
  const done = new Set(readLedger(d.dir).map((r) => r.reportId));
  const todo = readReports(d.dir).filter((r) => !done.has(r.id) && r.claims.length > 0).slice(0, d.maxPerNight ?? 20);
  const observe = async (model: ModelClient, tier: 'reasoning' | 'cheap', content: string, stamp: EngineStamp, felt: ReadonlySet<Family>): Promise<ClaimScore | undefined> => {
    try {
      const res = await model.chat({ taskClass: 'appraisal', tier, messages: [{ role: 'system', content: OBSERVER_SYSTEM }, { role: 'user', content }], schema: ObserverSchema, schemaName: 'Observer', maxTokens: 60, temperature: 0 });
      return scoreClaim({ text: res.content.feeling, feeling: res.content.feeling }, stamp, felt);
    } catch (e) {
      void d.events.emit('incident.mind_ledger_failed', { stage: 'observer', error: e instanceof Error ? e.message.slice(0, 200) : String(e) });
      return undefined;
    }
  };
  let scored = 0;
  for (const r of todo) {
    const felt = new Set(r.feltRecently);
    // her claim: the first one that names a feeling (or "not sure"); the others ride along in the report
    const claim = r.claims.find((c) => c.feeling !== undefined && (familyOf(c.feeling) !== undefined || /not sure/i.test(c.feeling))) ?? r.claims[0]!;
    const her = scoreClaim(claim, r.stamp, felt);
    let ext: ClaimScore | undefined;
    let eq: ClaimScore | undefined;
    let eqSame: ClaimScore | undefined;
    if (r.channel !== 'thought') {
      ext = await observe(d.observer, 'reasoning', `[the chat]\n${r.chat}`, r.stamp, felt);
      if (r.packet !== undefined) {
        const full = `[everything she had in front of her]\n${r.packet}\n\n[the chat]\n${r.chat}`;
        eq = await observe(d.observer, 'reasoning', full, r.stamp, felt);
        eqSame = await observe(d.same, 'cheap', full, r.stamp, felt);
      }
    }
    const row: LedgerRow = { reportId: r.id, ts: r.ts, channel: r.channel, her, ...(ext !== undefined ? { ext } : {}), ...(eq !== undefined ? { eq } : {}), ...(eqSame !== undefined ? { eqSame } : {}), stamp: r.stamp };
    fs.appendFileSync(path.join(d.dir, LEDGER_FILE), `${JSON.stringify(row)}\n`);
    scored += 1;
  }
  const rows = readLedger(d.dir);
  const replies = rows.filter((r) => r.channel === 'reply');
  const feltLines = rows.filter((r) => r.channel === 'felt_line');
  const sum = (pick: (r: LedgerRow) => ClaimScore | undefined, from = replies): Summary =>
    summarize(from.map((r) => ({ score: pick(r), stamp: r.stamp })).filter((x): x is { score: ClaimScore; stamp: EngineStamp } => x.score !== undefined));
  const her = sum((r) => r.her);
  const ext = sum((r) => r.ext);
  const eq = sum((r) => r.eq);
  const felt = sum((r) => r.her, feltLines);
  const out: NightScore = {
    scored,
    her,
    ext,
    eq,
    eqSame: sum((r) => r.eqSame),
    thoughts: sum((r) => r.her, rows.filter((r) => r.channel === 'thought')),
    margins: margins(her, ext, eq),
    // the thesis number (§6 Phase 2): her private word vs the observers, on the same moments
    feltLine: { her: felt, margins: margins(felt, sum((r) => r.ext, feltLines), sum((r) => r.eq, feltLines)) },
  };
  void d.events.emit('mind.sincerity', { ...out });
  return out;
};

export const ledgerJob = (d: LedgerDeps, utcMinute: number): Job => ({
  name: 'sincerity-ledger',
  cadence: { kind: 'daily', utcMinute },
  lane: 'maintenance',
  catchUp: 'skip',
  timeoutMs: 600_000,
  run: async () => {
    await scoreNight(d);
  },
});

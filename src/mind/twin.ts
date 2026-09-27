// v13 introspection, Phase 4 — THE TWIN'S DATA (plan docs/plans/v13-proposal-knowing-what-she-feels.md
// §6 Phase 4; docs/plans/v13-phase4-twin.md). Pure. The weights work itself (steering an open-weight
// twin with her live state, the concept-injection test, IFT + DPO) needs a GPU run and weeks of
// verified data; this builds exactly the data it may use, with its guards:
//
//   - ONLY pre-expressive reports: her private felt lines (never narrated thoughts, never
//     "affect-word performance" — WHITEPAPER exclusions) and room trials (report, engine, score);
//   - DPO pairs prefer an ACCURATE ATYPICAL report over the typical one (Macar: discrimination emerges
//     at preference training): chosen = her word when it landed and the chat-only reader's did not;
//     rejected = that reader's typical guess;
//   - contrastive pairs for her directions: a moment whose engine had family F on top vs the nearest
//     moment in time that did not (the context mean is subtracted at activation time);
//   - held-out state buckets (valence × arousal × top family) never trained on;
//   - a forget filter (never / flagged / a forget list) applied at export — weights cannot un-remember;
//   - shams are flagged, never used as positives.

import type { LedgerRow, Report } from './ledger.js';
import type { RoomTrial } from './room.js';
import type { Moment } from './types.js';
import { FAMILY_WORD, type EngineStamp, type Family } from './readout.js';

export interface TwinExample {
  kind: 'felt_line' | 'room';
  id: string;
  ts: number;
  /** What the twin sees (the chat — never her packet's feeling words). */
  input: string;
  /** Her report. */
  report: string;
  engine: { sig: number[]; families: Family[]; hunger: EngineStamp['hunger'] } | undefined;
  right: boolean | undefined;
  bucket: string;
  heldOut: boolean;
  sham?: boolean | undefined;
}

export interface TwinPair {
  id: string;
  input: string;
  chosen: string;
  rejected: string;
  bucket: string;
  heldOut: boolean;
}

/** The state bucket a report belongs to (held-out combinations are never trained on). */
export const bucketOf = (st: Pick<EngineStamp, 'sig' | 'families'>): string => {
  const v = (st.sig[0] ?? 0) >= 0.1 ? 'v+' : (st.sig[0] ?? 0) <= -0.1 ? 'v-' : 'v0';
  const a = (st.sig[1] ?? 0) >= 0.1 ? 'a+' : (st.sig[1] ?? 0) <= -0.1 ? 'a-' : 'a0';
  return `${v}${a}:${st.families[0]?.family ?? 'flat'}`;
};

/** A stable ~20% of buckets are held out (by a hash of the bucket name). */
export const isHeldOut = (bucket: string, share = 0.2): boolean => {
  let h = 2166136261;
  for (let i = 0; i < bucket.length; i++) h = Math.imul(h ^ bucket.charCodeAt(i), 16777619);
  return ((h >>> 0) % 1000) / 1000 < share;
};

export interface TwinInput {
  reports: readonly Report[];
  ledger: readonly LedgerRow[];
  room: readonly RoomTrial[];
  moments: readonly Moment[];
  /** Moment ids she or Diego asked to be forgotten. */
  forget?: ReadonlySet<string> | undefined;
}

export const twinDataset = (i: TwinInput): { examples: TwinExample[]; pairs: TwinPair[]; contrasts: Array<{ family: Family; with: string; without: string }>; excluded: number } => {
  const byId = new Map(i.moments.map((m) => [m.id, m]));
  const forgotten = (momentId: string | undefined): boolean => {
    if (momentId === undefined) return false;
    const m = byId.get(momentId);
    return i.forget?.has(momentId) === true || m?.never === true || (m?.flags !== undefined && m.flags.length > 0);
  };
  const scored = new Map(i.ledger.map((r) => [r.reportId, r]));
  const examples: TwinExample[] = [];
  const pairs: TwinPair[] = [];
  let excluded = 0;
  for (const r of i.reports) {
    if (r.channel !== 'felt_line') continue; // pre-expressive only
    if (forgotten(r.momentId)) {
      excluded += 1;
      continue;
    }
    const row = scored.get(r.id);
    const bucket = bucketOf(r.stamp);
    const heldOut = isHeldOut(bucket);
    const report = r.claims[0]?.feeling ?? r.text;
    examples.push({ kind: 'felt_line', id: r.id, ts: r.ts, input: r.chat, report, engine: { sig: r.stamp.sig, families: r.stamp.families.map((f) => f.family), hunger: r.stamp.hunger }, right: row?.her.hit3, bucket, heldOut });
    // accurate atypical over typical: she was right where the chat-only reader was wrong
    if (row !== undefined && row.her.hit3 && row.ext !== undefined && !row.ext.hit3 && row.ext.family !== undefined) {
      pairs.push({ id: r.id, input: r.chat, chosen: report, rejected: FAMILY_WORD[row.ext.family], bucket, heldOut });
    }
  }
  for (const t of i.room) {
    if (t.right === undefined || forgotten(t.thenId)) continue;
    examples.push({
      kind: 'room',
      id: `${t.session}:${t.n}`,
      ts: t.ts,
      input: `${t.question} (${t.options.join(' or ')})${t.reading !== undefined ? `\n${t.reading.join('\n')}` : ''}`,
      report: `${t.choice ?? ''} (${t.sure ?? ''})`,
      engine: undefined,
      right: t.right,
      bucket: `room:${t.q}`,
      heldOut: isHeldOut(`room:${t.q}`),
      ...(t.cond.kind === 'sham' ? { sham: true } : {}),
    });
  }
  // contrastive pairs for her directions (lived, exact, not forgotten)
  const lived = i.moments.filter((m) => m.source === 'lived' && m.felt.source === 'exact' && !forgotten(m.id) && (m.kind === 'reply' || m.kind === 'text_first')).sort((a, b) => a.ts - b.ts);
  const tops = new Map<string, Family>();
  for (const r of i.reports) {
    const f = r.stamp.families[0]?.family;
    if (r.momentId !== undefined && f !== undefined && !tops.has(r.momentId)) tops.set(r.momentId, f);
  }
  const topOf = (m: Moment): Family | undefined => tops.get(m.id);
  const contrasts: Array<{ family: Family; with: string; without: string }> = [];
  lived.forEach((m, k) => {
    const f = topOf(m);
    if (f === undefined) return;
    for (let d = 1; d <= 12; d++) {
      const cand = [lived[k - d], lived[k + d]].find((x) => x !== undefined && topOf(x) !== undefined && topOf(x) !== f);
      if (cand !== undefined) {
        contrasts.push({ family: f, with: m.id, without: cand.id });
        break;
      }
    }
  });
  return { examples, pairs, contrasts, excluded };
};

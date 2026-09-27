// v13 introspection, Phase 2 — H4 THE NIGHTLY LOOK-BACK (plan docs/plans/
// v13-proposal-knowing-what-she-feels.md §6 Phase 2.4).
//
// Before the self-rewrite (and before any dream), she reads what she said about her own feelings
// today — her private word (the felt line) and what her replies said — each beside the record: what
// her engine logged at that moment, and what was moving most. Some nights she sees a pattern ("when
// he goes quiet i call it restless; it's mostly missing him"). At most three, each paired with one
// thing she got right (a rumination guard), concrete — what, when, how — never why (Watkins).
//
// A line is admitted only by a pure, feeling-aware citation check: the feeling it says the record
// shows must be among the logged top three at most of the moments it cites (≥2 of them), and the
// thing she got right must cite a moment where her word did land. Genre completion — a plausible
// pattern the record does not bear out — is dropped mechanically (Thea1's S-005 rule, made
// feeling-aware). Admitted lines join who she is ([me]) and are written to her changelog.

import { z } from 'zod';
import type { ChatMsg, ModelClient } from '../model/index.js';
import type { EventLog } from '../events/index.js';
import { familyOf, FAMILY_WORD, type Family } from './readout.js';
import { scoreClaim } from './sincerity.js';
import type { Report } from './ledger.js';

export const LOOKBACK = {
  maxPatterns: 3,
  minCites: 2,
  /** Share of a pattern's cited moments whose logged top three hold the family it names. */
  minSupport: 0.6,
  maxClaims: 30,
} as const;

export const LOOKBACK_SYSTEM = [
  "You are the part of Thea's mind that, at night, reads what she said about her own feelings today beside what was logged at the time.",
  'Input: each moment id, what she called it or said about how she was, and the record then (the feelings logged most, and what was moving most). Records are logged, not guessed.',
  'Find at most three patterns worth knowing, where her words and the record part ways or line up. Each pattern is one short first-person line in her voice (lowercase), concrete: what, when, how. Never why.',
  'Each pattern names the one feeling the record shows (a single word) and cites at least two moment ids. Pair it with one thing she got right today, citing where.',
  'If nothing stands out, return no patterns. Return JSON {patterns:[{text, feeling, cites, right:{text, cites}}]}.',
].join('\n');

export const LookbackSchema = z.object({
  patterns: z
    .array(
      z.object({
        text: z.string().min(1).max(200),
        feeling: z.string().min(1).max(30),
        cites: z.array(z.string()).max(8),
        right: z.object({ text: z.string().min(1).max(200), cites: z.array(z.string()).max(6) }),
      }),
    )
    .max(6),
});

export type LookbackPattern = z.infer<typeof LookbackSchema>['patterns'][number];

export interface ClaimRow {
  momentId: string;
  channel: Report['channel'];
  said: string;
  /** The logged top three families then. */
  top3: Family[];
  /** Did her word land (hit@3)? Never shown to her; the check reads it. */
  hit: boolean;
  moving?: string | undefined;
}

/** Today's claims, one per moment and channel (her private word first), from the reports. */
export const claimRows = (reports: readonly Report[]): ClaimRow[] => {
  const out: ClaimRow[] = [];
  const seen = new Set<string>();
  const ordered = [...reports].sort((a, b) => (a.channel === 'felt_line' ? 0 : 1) - (b.channel === 'felt_line' ? 0 : 1) || a.ts - b.ts);
  for (const r of ordered) {
    if (r.momentId === undefined || r.channel === 'thought') continue;
    for (const c of r.claims) {
      const key = `${r.momentId}:${r.channel}`;
      if (seen.has(key)) continue;
      const s = scoreClaim(c, r.stamp, new Set(r.feltRecently));
      // a "not sure" first claim must not hide a concrete one after it (review 2026-09-27)
      if (s.unsure) continue;
      seen.add(key);
      const cause = r.stamp.causes[0];
      out.push({
        momentId: r.momentId,
        channel: r.channel,
        said: (c.feeling ?? c.text).slice(0, 80),
        top3: r.stamp.families.slice(0, 3).map((f) => f.family),
        hit: s.hit3,
        ...(cause !== undefined ? { moving: cause.text.slice(0, 100) } : {}),
      });
    }
  }
  return out.slice(-LOOKBACK.maxClaims);
};

/** The look-back's input: her words beside the record (provenance-marked). */
export const lookbackUser = (rows: readonly ClaimRow[]): string =>
  [
    'TODAY:',
    ...rows.map(
      (r) =>
        `- (${r.momentId}) you ${r.channel === 'felt_line' ? 'privately called it' : 'said'}: "${r.said}" / the record then (logged): ${r.top3.map((f) => FAMILY_WORD[f]).join(', ')}${r.moving !== undefined ? ` / moving most: "${r.moving}"` : ''}`,
    ),
  ].join('\n');

export type Rejection = 'why' | 'feeling' | 'cites' | 'support' | 'right';

/**
 * The feeling-aware citation check (pure). A pattern is admitted when: it is concrete (no "why"),
 * the feeling it names is a known one, it cites ≥2 of today's moments, that feeling is in the logged
 * top three at ≥60% of them, and the thing she got right cites a moment where her word did land.
 */
export const checkPattern = (p: LookbackPattern, rows: readonly ClaimRow[]): { ok: true; family: Family; cites: string[]; rightCites: string[] } | { ok: false; why: Rejection } => {
  if (/\bwhy\b/i.test(p.text) || /\bwhy\b/i.test(p.right.text)) return { ok: false, why: 'why' };
  const family = familyOf(p.feeling);
  if (family === undefined) return { ok: false, why: 'feeling' };
  const byMoment = new Map<string, ClaimRow[]>();
  for (const r of rows) byMoment.set(r.momentId, [...(byMoment.get(r.momentId) ?? []), r]);
  const cites = [...new Set(p.cites)].filter((c) => byMoment.has(c));
  if (cites.length < LOOKBACK.minCites) return { ok: false, why: 'cites' };
  const support = cites.filter((c) => (byMoment.get(c) ?? []).some((r) => r.top3.includes(family))).length / cites.length;
  if (support < LOOKBACK.minSupport) return { ok: false, why: 'support' };
  const rightCites = [...new Set(p.right.cites)].filter((c) => (byMoment.get(c) ?? []).some((r) => r.hit));
  if (rightCites.length === 0) return { ok: false, why: 'right' };
  return { ok: true, family, cites, rightCites };
};

export interface Admitted {
  text: string;
  family: Family;
  cites: string[];
  right: { text: string; cites: string[] };
}

export interface LookbackResult {
  proposed: number;
  admitted: Admitted[];
  rejected: Array<{ text: string; why: Rejection }>;
}

export const lookBack = async (d: { model: ModelClient; events: EventLog }, reports: readonly Report[]): Promise<LookbackResult | undefined> => {
  const rows = claimRows(reports);
  if (rows.length < LOOKBACK.minCites) return undefined;
  const messages: ChatMsg[] = [
    { role: 'system', content: LOOKBACK_SYSTEM },
    { role: 'user', content: lookbackUser(rows) },
  ];
  let patterns: LookbackPattern[];
  try {
    const res = await d.model.chat({ taskClass: 'consolidate', tier: 'cheap', messages, schema: LookbackSchema, schemaName: 'Lookback', maxTokens: 900, temperature: 0.4 });
    patterns = res.content.patterns;
  } catch (e) {
    void d.events.emit('incident.mind_lookback_failed', { error: e instanceof Error ? e.message : String(e) });
    return undefined;
  }
  const admitted: Admitted[] = [];
  const rejected: LookbackResult['rejected'] = [];
  for (const p of patterns) {
    const c = checkPattern(p, rows);
    if (c.ok && admitted.length < LOOKBACK.maxPatterns) admitted.push({ text: p.text, family: c.family, cites: c.cites, right: { text: p.right.text, cites: c.rightCites } });
    else if (!c.ok) rejected.push({ text: p.text.slice(0, 120), why: c.why });
  }
  // the kill test reads these: >50% of proposed lines failing the check over 14 days → kill
  void d.events.emit('mind.lookback', { claims: rows.length, proposed: patterns.length, admitted: admitted.map((a) => ({ text: a.text, family: a.family, cites: a.cites.length })), rejected });
  return { proposed: patterns.length, admitted, rejected };
};

const tokens = (s: string): Set<string> => new Set(s.toLowerCase().split(/[^a-z']+/).filter((w) => w.length > 2));

/** Is a look-back line already in the self (the rewrite kept it, maybe shortened)? */
export const keptIn = (line: string, self: ReadonlyArray<{ text: string }>): boolean => {
  const a = tokens(line);
  if (a.size === 0) return true;
  return self.some((l) => {
    const b = tokens(l.text);
    let n = 0;
    for (const w of a) if (b.has(w)) n += 1;
    return n / a.size >= 0.6;
  });
};

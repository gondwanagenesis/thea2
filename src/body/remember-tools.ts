// v9 body — searching her own past (Thea1's session_search + recall): exact
// words, and meaning. Both read her MindStore; neither writes it. Results are
// her real words with their dates, never a summary of them.

import type { Embedder } from '../embed/index.js';
import type { MindStore, Moment } from '../mind/index.js';

const cosine = (a: Float32Array, b: Float32Array): number => {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length && i < b.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
};

const when = (ts: number, tz: string): string =>
  new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: tz }).format(ts);

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);

export const renderHit = (m: Moment, tz: string): string => {
  const lines = [`[${when(m.ts, tz)}${m.kind !== 'reply' ? ` · ${m.kind}` : ''}]`];
  if (m.his.trim() !== '') lines.push(`him: ${clip(m.his, 300)}`);
  if (m.hers.length > 0) lines.push(`you: ${clip(m.hers.join(' / '), 400)}`);
  return lines.join('\n');
};

/** Exact words (case-insensitive), newest first. `who` narrows to his lines or hers. */
export const searchWords = (mind: MindStore, query: string, opts: { who?: 'him' | 'her' | undefined; limit?: number | undefined } = {}): Moment[] => {
  const q = query.trim().toLowerCase();
  if (q === '') return [];
  return [...mind.moments()]
    .filter((m) => {
      const his = opts.who !== 'her' && m.his.toLowerCase().includes(q);
      const hers = opts.who !== 'him' && m.hers.some((h) => h.toLowerCase().includes(q));
      return his || hers;
    })
    .sort((a, b) => b.ts - a.ts)
    .slice(0, opts.limit ?? 8);
};

/** Meaning: the moments whose words (his, the situation, her reply) sit closest to the query. */
export const searchMeaning = async (mind: MindStore, embedder: Embedder, query: string, limit = 6): Promise<Array<{ m: Moment; sim: number }>> => {
  const [q] = await embedder.embed([query]);
  if (q === undefined) return [];
  const scored: Array<{ m: Moment; sim: number }> = [];
  for (const m of mind.moments()) {
    const vs = [mind.hisVec(m.id), mind.sitVec(m.id), mind.replyVec(m.id)].filter((v): v is Float32Array => v !== undefined);
    if (vs.length === 0) continue;
    scored.push({ m, sim: Math.max(...vs.map((v) => cosine(q, v))) });
  }
  return scored.sort((a, b) => b.sim - a.sim).slice(0, limit);
};

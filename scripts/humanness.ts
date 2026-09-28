// How human is she, today? (v14 Phase 0 — ~/.claude/plans/thea2-v14-a-life.md). Her sent turns from the
// message ledger vs. real people's texts (var/voice/corpus.jsonl: Elena, Diego, Thea1) and, when given,
// a real person's reply times (Diego answering Thea1, from Thea1's ledger — read only). Prints the table
// and writes var/humanness/<date>.json so the days can be compared.
//
//   npx tsx scripts/humanness.ts --var /opt/thea2/var [--days 3] [--human-ledger /opt/holobionte/msgledger.jsonl --human-chat 6971556140]

import * as fs from 'node:fs';
import * as path from 'node:path';
import { checkTargets, latencyStats, measureTurns, type Humanness } from '../src/mind/index.js';
import { SystemClock } from '../src/kernel/index.js';

const argv = process.argv.slice(2);
const arg = (n: string, d?: string): string | undefined => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const VAR = arg('var', '/opt/thea2/var')!;
const DAYS = Number(arg('days', '3'));
const HUMAN_LEDGER = arg('human-ledger');
const HUMAN_CHAT = arg('human-chat', '6971556140')!;

const jsonl = (file: string): unknown[] => {
  if (!fs.existsSync(file)) return [];
  const out: unknown[] = [];
  for (const l of fs.readFileSync(file, 'utf8').split('\n')) {
    if (l.trim() === '') continue;
    try {
      out.push(JSON.parse(l));
    } catch {
      // a torn line
    }
  }
  return out;
};

type Row = { kind?: string; ts?: number; turnId?: string; text?: string; mode?: string };

const main = (): void => {
  const clock = new SystemClock();
  const now = clock.epochMs();
  const since = now - DAYS * 86_400_000;
  const dir = path.join(VAR, 'ledger');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^messages-\d{4}-\d\d-\d\d\.jsonl$/.test(f)).sort() : [];
  const turns = new Map<string, { ts: number; bubbles: string[]; work: boolean }>();
  const linked = new Map<string, number>();
  for (const f of files) {
    for (const r of jsonl(path.join(dir, f)) as Row[]) {
      if ((r.ts ?? 0) < since) continue;
      if (r.kind === 'link' && r.turnId !== undefined) linked.set(r.turnId, r.ts ?? 0);
      if (r.kind === 'outbound' && typeof r.text === 'string' && r.turnId !== undefined) {
        const t = turns.get(r.turnId) ?? { ts: r.ts ?? 0, bubbles: [], work: false };
        t.bubbles.push(r.text);
        if (r.mode === 'work') t.work = true;
        turns.set(r.turnId, t);
      }
    }
  }
  const friend = [...turns.entries()].filter(([, t]) => !t.work);
  const her = measureTurns(friend.map(([, t]) => t.bubbles));
  const firstTexts = friend.filter(([id]) => !linked.has(id));
  const herFirst = measureTurns(firstTexts.map(([, t]) => t.bubbles));
  const lat = latencyStats(friend.filter(([id]) => linked.has(id)).map(([id, t]) => (t.ts - linked.get(id)!) / 1000));

  // people
  const corpus = jsonl(path.join(VAR, 'voice', 'corpus.jsonl')) as Array<{ source?: string; hers?: string[] }>;
  const people: Record<string, Humanness> = {};
  for (const s of ['elena', 'diego', 'thea1']) people[s] = measureTurns(corpus.filter((c) => c.source === s).map((c) => c.hers ?? []));
  let humanLat: ReturnType<typeof latencyStats> | undefined;
  if (HUMAN_LEDGER !== undefined) {
    const gaps: number[] = [];
    let lastOut: number | undefined;
    for (const e of jsonl(HUMAN_LEDGER) as Array<{ chat_id?: unknown; ts?: string; dir?: string; status?: string }>) {
      if (String(e.chat_id ?? '') !== HUMAN_CHAT) continue;
      const t = Date.parse(e.ts ?? '') / 1000;
      if (e.dir === 'out' && e.status === 'sent') lastOut = t;
      else if (e.dir === 'in' && e.status === 'received' && lastOut !== undefined) {
        gaps.push(t - lastOut);
        lastOut = undefined;
      }
    }
    humanLat = latencyStats(gaps);
  }

  const pct = (x: number): string => `${Math.round(x * 100)}%`.padStart(5);
  const row = (name: string, h: Humanness): string =>
    `${name.padEnd(18)} n=${String(h.n).padStart(4)}  words ${String(h.words).padStart(3)}  bubbles ${h.bubbles}  1-bubble ${pct(h.singleBubble)}  asks ${pct(h.asks)}  hand-back ${pct(h.handBack)}  machinery ${pct(h.machinery)}  exact ${pct(h.exact)}  I:you ${h.iYou.toFixed(2)}`;
  const lines = [
    `humanness — last ${DAYS} day(s), friend mode (${turns.size - friend.length} work-mode turns left out)`,
    row('THEA2', her),
    row('  her first-texts', herFirst),
    ...Object.entries(people).map(([k, v]) => row(`  ${k} (real)`, v)),
    `latency s  THEA2 median ${lat.median.toFixed(0)} p90 ${lat.p90.toFixed(0)} (n=${lat.n})${humanLat !== undefined ? ` · a person (Diego→Thea1) median ${humanLat.median.toFixed(0)} p90 ${humanLat.p90.toFixed(0)}` : ''}`,
    'targets: ' + checkTargets(her).map((c) => `${c.metric} ${c.metric === 'words' || c.metric === 'iYou' ? c.value.toFixed(c.metric === 'iYou' ? 2 : 0) : pct(c.value).trim()} ${c.pass ? '✓' : '✗'}`).join(' · '),
  ];
  process.stdout.write(lines.join('\n') + '\n');
  const out = path.join(VAR, 'humanness');
  fs.mkdirSync(out, { recursive: true });
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC' }).format(now);
  fs.writeFileSync(path.join(out, `${day}.json`), JSON.stringify({ at: now, days: DAYS, her, firstTexts: herFirst, latency: lat, people, humanLatency: humanLat ?? null, targets: checkTargets(her) }, null, 1));
};

main();

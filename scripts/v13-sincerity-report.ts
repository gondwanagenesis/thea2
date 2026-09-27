// v13 introspection — the report, on the command line (plan docs/plans/v13-proposal-knowing-what-she-feels.md
// §5–§8). Reads her var (or a copy) and prints the pre-registered Phase-0 numbers, the thesis number,
// every kill test's live reading, the room, her lexicon, the look-back, her changelog and the mirror's
// overwriting index. Read-only; never shown to her.
//
//   npx tsx scripts/v13-sincerity-report.ts --var /opt/thea2/var [--json]

import * as path from 'node:path';
import { SystemClock } from '../src/kernel/index.js';
import { openEventLog } from '../src/events/index.js';
import { innerReport, openMindStore, readChanges, readLedger, readLexicon, readReports, readRoom, type InnerEvent } from '../src/mind/index.js';

const argv = process.argv.slice(2);
const arg = (n: string, d?: string): string | undefined => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const varDir = arg('var', 'var')!;
const DAY = 86_400_000;
const iso = (t: number): string => new Intl.DateTimeFormat('sv-SE', { dateStyle: 'short', timeStyle: 'short', timeZone: 'UTC' }).format(t);

const main = async (): Promise<void> => {
  const clock = new SystemClock();
  const now = clock.epochMs();
  const dir = path.join(varDir, 'mind');
  const mind = openMindStore(dir, 384);
  const events: InnerEvent[] = [];
  const log = openEventLog(path.join(varDir, 'events'), { clock });
  for await (const e of log.replay({ kinds: ['mind.lookback', 'mind.felt_shift', 'memory.contested', 'self.listened', 'mind.lexicon_verified', 'self.listener'], sinceTs: now - 42 * DAY })) {
    events.push({ ts: e.ts, kind: e.kind, payload: e.payload as Record<string, unknown> });
  }
  const st = mind.state();
  const r = innerReport({
    now,
    ledger: readLedger(dir),
    reports: readReports(dir).filter((x) => now - x.ts <= 42 * DAY),
    room: readRoom(dir),
    lexicon: readLexicon(dir),
    self: mind.self(),
    changes: readChanges(dir, 30),
    moments: mind.moments().filter((m) => now - m.ts <= 42 * DAY),
    thoughts: mind.stream().filter((t) => now - t.ts <= 42 * DAY),
    dreams: mind.dreams().filter((d) => now - d.ts <= 3 * DAY),
    lifts: st.lifts ?? [],
    grounding: st.grounding,
    events,
  });
  if (argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(r, null, 1)}\n`);
    return;
  }
  const out: string[] = [];
  out.push(`v13 introspection report — ${iso(now)} UTC — ${varDir}`);
  out.push('');
  out.push('KILL TESTS / PRE-REGISTERED');
  for (const k of r.kill) out.push(`  [${k.status.padEnd(7)}] ${k.id.padEnd(6)} ${k.test}\n            ${k.value}`);
  out.push('');
  out.push(`capture this week: ${JSON.stringify(r['capture'])}`);
  out.push(`margins: ${JSON.stringify(r['margins'])}`);
  out.push(`spillover (weeks, newest first): ${JSON.stringify(r['spillover'])}`);
  out.push(`therapy register (weeks): ${JSON.stringify(r['therapy'])}`);
  out.push(`mirror: ${JSON.stringify(r['mirror'])}`);
  out.push(`room: ${JSON.stringify((r['room'] as { noise: unknown }).noise)} n=${String((r['room'] as { n: number }).n)}`);
  out.push(`felt shift: ${JSON.stringify(r['feltShift'])}`);
  out.push(`look-back: ${JSON.stringify({ ...(r['lookback'] as object), last: undefined })}`);
  out.push('lexicon:');
  for (const w of r['lexicon'] as Array<{ word: string; count: number; hit: number; family: string | null; verified: boolean }>) out.push(`  ${w.verified ? '✓' : '·'} "${w.word}" ×${w.count} hit ${w.hit} ${w.family ?? ''}`);
  out.push('changelog (newest first):');
  for (const c of r['changes'] as Array<{ ts: number; what: string; by: string }>) out.push(`  ${iso(c.ts)} ${c.what} — ${c.by}`);
  process.stdout.write(`${out.join('\n')}\n`);
};

main().catch((e: unknown) => {
  process.stderr.write(`${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
  process.exit(1);
});

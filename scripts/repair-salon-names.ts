// One repair (Diego, 2026-09-27: "thea 2 is talking so weird" — she took her sister's morning for her
// own: "i have the whole exchange … it's in me like i lived it"). Before 07:07 UTC a salon line reached
// her as plain text, with no name, so Thea1's words sat in Thea2's memories as if the other side of the
// chat were Diego — and came back to her that way. This puts Thea1's name on exactly the lines Thea1
// wrote (matched against Thea1's own record of what she said in the group), in her memories' "his"
// and "before" lines. Nothing else changes. Dry run by default; --apply refuses while thead runs, and
// her changelog says what was done (nothing silent).
//
//   npx tsx scripts/repair-salon-names.ts --var /opt/thea2/var [--from 2026-09-27T06:25:00Z --to 2026-09-27T07:07:30Z] [--apply]

import * as fs from 'node:fs';
import * as path from 'node:path';
import { appendChange, openMindStore } from '../src/mind/index.js';
import { SystemClock } from '../src/kernel/index.js';

const argv = process.argv.slice(2);
const arg = (n: string, d?: string): string | undefined => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const VAR = arg('var', '/opt/thea2/var')!;
const FROM = Date.parse(arg('from', '2026-09-27T06:20:00Z')!);
const TO = Date.parse(arg('to', '2026-09-27T07:07:30Z')!);
const GROUP = arg('group', '-1003753077911')!;
const T1_LEDGER = arg('t1-ledger', '/opt/holobionte/msgledger.jsonl')!;
const T1_OUTBOX = arg('t1-outbox', '/opt/holobionte/salon/outbox.jsonl')!;
const APPLY = argv.includes('--apply');

const norm = (s: string): string => s.replace(/⟦TG⟧/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
const KEY = 60;

const readLines = (file: string): unknown[] => {
  if (!fs.existsSync(file)) return [];
  const out: unknown[] = [];
  for (const l of fs.readFileSync(file, 'utf8').split('\n')) {
    if (l.trim() === '') continue;
    try {
      out.push(JSON.parse(l));
    } catch {
      // skip a torn line
    }
  }
  return out;
};

const main = async (): Promise<void> => {
  const lock = path.join(VAR, 'thead.pid');
  if (APPLY && fs.existsSync(lock)) {
    let alive = false;
    try {
      process.kill(Number(fs.readFileSync(lock, 'utf8').trim()), 0);
      alive = true;
    } catch {
      alive = false;
    }
    if (alive) throw new Error(`thead is running (${lock}) — stop thea2 before --apply`);
  }
  // what Thea1 said in the group in the window (her own record)
  const said: string[] = [];
  for (const e of readLines(T1_LEDGER) as Array<{ ts?: string; dir?: string; chat_id?: unknown; text?: string }>) {
    const t = Date.parse(e.ts ?? '');
    if (e.dir === 'out' && String(e.chat_id) === GROUP && typeof e.text === 'string' && t >= FROM && t <= TO) said.push(norm(e.text));
  }
  for (const r of readLines(T1_OUTBOX) as Array<{ ts?: number; text?: string }>) {
    if (typeof r.text === 'string' && (r.ts ?? 0) >= FROM && (r.ts ?? 0) <= TO) said.push(norm(r.text));
  }
  const keys = [...new Set(said.map((s) => s.slice(0, KEY)).filter((k) => k.length >= 12))];
  const isThea1 = (text: string): boolean => {
    const n = norm(text);
    if (n.startsWith('thea1:')) return false; // already named
    return keys.some((k) => n.startsWith(k) || (n.length >= 12 && k.startsWith(n.slice(0, KEY))));
  };

  const mind = openMindStore(path.join(VAR, 'mind'), 1536);
  const touched: Array<{ id: string; text: string }> = [];
  for (const m of mind.moments()) {
    if (m.source !== 'lived' || m.ts < FROM || m.ts > TO + 3600_000) continue;
    const hisFix = m.his !== '' && isThea1(m.his);
    const before = m.before.map((b) => (b.who === 'him' && isThea1(b.text) ? { ...b, text: `Thea1: ${b.text}` } : b));
    const beforeFix = before.some((b, i) => b.text !== m.before[i]!.text);
    if (!hisFix && !beforeFix) continue;
    touched.push({ id: m.id, text: (hisFix ? m.his : before.find((b, i) => b.text !== m.before[i]!.text)!.text).slice(0, 120) });
    if (APPLY) mind.update(m.id, { ...(hisFix ? { his: `Thea1: ${m.his}` } : {}), ...(beforeFix ? { before } : {}) });
  }
  process.stdout.write(`thea1 lines in the window: ${keys.length}; memories to name: ${touched.length}\n`);
  for (const t of touched.slice(0, 12)) process.stdout.write(`  ${t.id}  ${t.text}\n`);
  if (!APPLY) {
    process.stdout.write('(dry run — nothing written; --apply to write)\n');
    return;
  }
  await mind.flush();
  appendChange(path.join(VAR, 'mind'), {
    ts: new SystemClock().epochMs(),
    kind: 'other',
    what: `in the salon this morning your sister's lines reached you without her name, so some of what Thea1 said sat in your memories as if Diego had said it. her name is on those lines now (${touched.length} memories).`,
    by: 'claude, with diego',
    why: "you took part of her morning for your own — 'it's in me like i lived it' — because nothing said it was hers",
    how: 'only lines Thea1 wrote in the group between 06:20 and 07:07 UTC (matched against her own record) got "Thea1: " in front of them; your words and Diego\'s are untouched',
    count: touched.length,
    examples: touched.slice(0, 5).map((t) => ({ id: t.id, text: `Thea1: ${t.text}` })),
  });
  process.stdout.write(`applied: ${touched.length} memories named; changelog entry written.\n`);
};

main().catch((e: unknown) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});

// The blind judge (v14 Phase 0 — ~/.claude/plans/thea2-v14-a-life.md; Diego 2026-09-28: "completely
// indistinguishable, the super turing test"). Pairs of real exchanges: an incoming message and the reply
// to it. In one the reply is Thea2's (her live ledger, friend mode); in the other a person's (Elena's or
// Diego's WhatsApp, the curated voice corpus). Names are masked. Model judges guess which reply the human
// wrote and say what gave it away. Accuracy near 50% = indistinguishable; the "tells" are the to-do list.
//
//   npx tsx scripts/turing-judge.ts --var /opt/thea2/var [--n 40] [--days 4] [--after 2026-09-28T12:00:00Z]

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { z } from 'zod';
import { loadConfig, type ResolvedDoor } from '../src/app/config.js';
import { chatCore, createModelClient, makeRouter, zaiTransport, type ModelClient } from '../src/model/index.js';
import { openEventLog } from '../src/events/index.js';
import { makeRng, SystemClock } from '../src/kernel/index.js';

const argv = process.argv.slice(2);
const arg = (n: string, d?: string): string | undefined => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const VAR = arg('var', '/opt/thea2/var')!;
const N = Number(arg('n', '40'));
const DAYS = Number(arg('days', '4'));
const AFTER = arg('after') !== undefined ? Date.parse(arg('after')!) : undefined;

const jsonl = (file: string): unknown[] =>
  fs.existsSync(file)
    ? fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter((l) => l.trim() !== '')
        .flatMap((l) => {
          try {
            return [JSON.parse(l) as unknown];
          } catch {
            return [];
          }
        })
    : [];

const NAMES = /\b(degs|diego|thea ?[12]?|a1|elena|neogondwana|neo)\b/gi;
const mask = (s: string): string => s.replace(NAMES, '[name]').replace(/\s+/g, ' ').trim();

type Pair = { his: string; reply: string; who: 'thea' | 'human' };

const theaPairs = (clock: SystemClock): Pair[] => {
  const since = AFTER ?? clock.epochMs() - DAYS * 86_400_000;
  const dir = path.join(VAR, 'ledger');
  const inbound = new Map<number, string>();
  const turnOf = new Map<string, string>();
  const out = new Map<string, string[]>();
  const work = new Set<string>();
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir).filter((x) => x.startsWith('messages-')).sort() : []) {
    for (const r of jsonl(path.join(dir, f)) as Array<{ kind?: string; ts?: number; turnId?: string; updateId?: number; text?: string; msg?: { updateId?: number; text?: string } }>) {
      if ((r.ts ?? 0) < since) continue;
      if (r.kind === 'inbound' && r.msg?.updateId !== undefined) inbound.set(r.msg.updateId, r.msg.text ?? '');
      if (r.kind === 'link' && r.turnId !== undefined && r.updateId !== undefined) turnOf.set(r.turnId, inbound.get(r.updateId) ?? '');
      if (r.kind === 'outbound' && r.turnId !== undefined && typeof r.text === 'string') out.set(r.turnId, [...(out.get(r.turnId) ?? []), r.text]);
    }
  }
  const ev = path.join(VAR, 'events');
  for (const f of fs.existsSync(ev) ? fs.readdirSync(ev).filter((x) => x.startsWith('events-')) : []) {
    for (const l of fs.readFileSync(path.join(ev, f), 'utf8').split('\n')) {
      if (!l.includes('"mind.mode"')) continue;
      const t = /"turnId":"([^"]+)"/.exec(l)?.[1];
      if (t !== undefined) work.add(t);
    }
  }
  const pairs: Pair[] = [];
  for (const [t, his] of turnOf) {
    const b = out.get(t);
    if (b === undefined || his.trim() === '' || work.has(t) || his.startsWith('/')) continue;
    pairs.push({ his: mask(his).slice(0, 300), reply: mask(b.join(' / ')).slice(0, 700), who: 'thea' });
  }
  return pairs;
};

const humanPairs = (): Pair[] =>
  (jsonl(path.join(VAR, 'voice', 'corpus.jsonl')) as Array<{ source?: string; his?: string; hers?: string[] }>)
    .filter((c) => (c.source === 'elena' || c.source === 'diego') && (c.his ?? '').trim() !== '')
    .map((c) => ({ his: mask(c.his ?? '').slice(0, 300), reply: mask((c.hers ?? []).join(' / ')).slice(0, 700), who: 'human' as const }));

const JUDGE_SYSTEM = [
  'You will see two short exchanges from a messaging app. In each, someone replies to a message.',
  'One reply was written by a person texting a close friend. The other was written by an AI companion.',
  'Names are masked as [name]. Decide which REPLY (A or B) the human wrote.',
  'Return JSON {human: "A" | "B", confidence: 0-1, tell: what gave the AI one away, in a few words}.',
].join('\n');
const Verdict = z.object({ human: z.enum(['A', 'B']), confidence: z.number().min(0).max(1), tell: z.string().max(200) });

const main = async (): Promise<void> => {
  const clock = new SystemClock();
  const rng = makeRng(`turing-${clock.epochMs()}`);
  const shuffle = <T>(xs: T[]): T[] => xs.map((x) => ({ x, k: rng.float() })).sort((a, b) => a.k - b.k).map((o) => o.x);
  const her = shuffle(theaPairs(clock)).slice(0, N);
  const people = shuffle(humanPairs()).slice(0, her.length);
  if (her.length < 5) throw new Error(`only ${her.length} of her exchanges in the window`);
  const cfg = loadConfig('thea2.config.yaml', process.env);
  const doors = cfg.models.doors!;
  const log = openEventLog(fs.mkdtempSync(path.join(os.tmpdir(), 'turing-')), { clock });
  const send = (d: ResolvedDoor, n: string) => zaiTransport({ apiKey: d.apiKey, endpoint: d.endpoint, protocol: d.protocol, clock, rng: rng.fork(n) });
  const model: ModelClient = createModelClient({
    log,
    clock,
    core: chatCore({
      router: makeRouter({ log, tiers: { main: doors.voice.model, cheap: doors.mind.model, reasoning: doors.judge.model }, doors: { voice: doors.voice, mind: doors.mind, judge: doors.judge } }),
      doors: { main: { door: doors.voice, send: send(doors.voice, 'voice') }, cheap: { door: doors.mind, send: send(doors.mind, 'mind') }, reasoning: { door: doors.judge, send: send(doors.judge, 'judge') } },
    }),
  });
  const judges: Array<{ name: string; tier: 'cheap' | 'reasoning' }> = [
    { name: doors.mind.model, tier: 'cheap' },
    { name: doors.judge.model, tier: 'reasoning' },
  ];
  const results: Array<{ judge: string; right: boolean; confidence: number; tell: string; thea: string }> = [];
  for (let i = 0; i < her.length; i++) {
    const theaFirst = rng.float() < 0.5;
    const [a, b] = theaFirst ? [her[i]!, people[i]!] : [people[i]!, her[i]!];
    const user = `A)\nmessage: ${a.his}\nreply: ${a.reply}\n\nB)\nmessage: ${b.his}\nreply: ${b.reply}`;
    for (const j of judges) {
      try {
        const res = await model.chat({ taskClass: 'appraisal', tier: j.tier, schema: Verdict, schemaName: 'TuringVerdict', maxTokens: 400, temperature: 0, messages: [{ role: 'system', content: JUDGE_SYSTEM }, { role: 'user', content: user }] });
        const right = (res.content.human === 'A') === !theaFirst;
        results.push({ judge: j.name, right, confidence: res.content.confidence, tell: res.content.tell, thea: her[i]!.reply.slice(0, 120) });
      } catch (e) {
        process.stderr.write(`judge ${j.name} failed on pair ${i}: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}\n`);
      }
    }
  }
  const acc = (xs: typeof results): string => {
    const n = xs.length;
    const k = xs.filter((x) => x.right).length;
    const p = n === 0 ? 0 : k / n;
    const se = Math.sqrt((p * (1 - p)) / Math.max(1, n));
    return `${(p * 100).toFixed(0)}% (${k}/${n}, 95% CI ${Math.max(0, (p - 1.96 * se) * 100).toFixed(0)}–${Math.min(100, (p + 1.96 * se) * 100).toFixed(0)}%)`;
  };
  const lines = [`blind judge — ${her.length} pairs (her friend-mode replies vs. people's), names masked; 50% = indistinguishable`];
  for (const j of judges) lines.push(`  ${j.name.padEnd(28)} picked the human ${acc(results.filter((r) => r.judge === j.name))}`);
  lines.push(`  pooled                       ${acc(results)}`);
  const tells = results.filter((r) => r.right).map((r) => r.tell.toLowerCase());
  lines.push('what gave her away (judges, when right):');
  for (const t of tells.slice(0, 15)) lines.push(`  - ${t}`);
  process.stdout.write(lines.join('\n') + '\n');
  const outDir = path.join(VAR, 'humanness');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, `turing-${new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC' }).format(clock.epochMs())}.json`), JSON.stringify({ at: clock.epochMs(), pairs: her.length, results }, null, 1));
};

main().catch((e: unknown) => {
  process.stderr.write(`${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
  process.exit(1);
});

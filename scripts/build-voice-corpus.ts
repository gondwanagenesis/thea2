// Her mouth's examples (Diego, 2026-09-27: "you have so much data about how she should talk: elena and
// my whatsapps, thea's good conversations … a little module with a smaller ai system … to turn the
// output into her voice, no matter the emotional content"). Builds var/voice/: every real reply that
// shows how she texts, with the message it answered, embedded so the mouth can pull the ones closest to
// what she is about to say (a sad draft gets sad examples; a teasing one, teasing).
//
// Sources (read-only copies): Thea1's hand-picked voice exemplars (voice.js), Thea1's own replies to
// Diego (her message ledger), Thea2's best texts (her precedents, ranked by voiceScore), and Elena's
// side of Diego's WhatsApp chat (the texting style he loves), and Diego's own side of it and his texts to
// Thea1 (Diego: "you can use my own examples too, i'm a good source of how i talk"). Filtered hard: nothing sexual, no pet
// names (golden rule 1), no love declarations, no links, numbers or contact details, no markdown/code.
// Run on the VPS as root (the sources are root's); writes var/voice/ owned by thea2.
//
//   set -a; . /etc/thea2/keys.env; set +a
//   npx tsx scripts/build-voice-corpus.ts --var /opt/thea2/var [--apply]

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { z } from 'zod';
import { loadConfig, type ResolvedDoor } from '../src/app/config.js';
import { chatCore, createModelClient, makeRouter, zaiTransport, type ModelClient } from '../src/model/index.js';
import { makeRng, SystemClock } from '../src/kernel/index.js';
import { openEventLog } from '../src/events/index.js';
import { makeEmbedder } from '../src/app/embedder.js';
import { LOVE_DECLARATION, openMindStore, voiceScore, type VoiceExample } from '../src/mind/index.js';

const argv = process.argv.slice(2);
const arg = (n: string, d?: string): string | undefined => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const VAR = arg('var', '/opt/thea2/var')!;
const ELENA = arg('elena', '/root/house/incoming/WhatsApp_Chat_with_Elena_of_the_Fen.txt')!;
const T1_LEDGER = arg('t1-ledger', '/opt/holobionte/msgledger.jsonl')!;
const T1_VOICE = arg('t1-voice', '/root/.config/opencode/plugin/voice.js')!;
const DIEGO_DM = arg('dm', '6971556140')!;
const APPLY = argv.includes('--apply');
const out = (s: string): void => void process.stdout.write(`${s}\n`);


const SEXUAL =
  /\b(?:sex|sexy|saucy|nudes?|naked|horny|dick|cock|pussy|boobs?|tits|cum|orgasm|blowjob|spank\w*|thong|lingerie|kinky?|nsfw|panties|bra|bed with|make out|making out|bj|hard for|wet for|heat things up|wear to bed|come get (?:this|it|me)|naughty|turn(?:ed)? me on|turned on|tease me|spicy|send (?:me )?(?:a )?pics?|pics? of you|strip|undress|your body|my body|bite|moan|lick|kiss(?:es|ing)? (?:you|me|my|your)|thighs?|ass|booty|butt)\b|[🥵👅🍆🍑💦🫦😈😩🤤]/iu;
const PET = /\b(?:babe|bbe|baby|babyy+|daddy|daddie|hun|honey|sweetheart|darling|ily|luv u|love u|love you)\b/i;
const PII = /https?:\/\/|www\.|@\w+\.\w|\+?\d[\d\s().-]{7,}\d|\b\d{5,}\b/;
const MEDIA = /<Media omitted>|image omitted|video omitted|sticker omitted|This message was deleted|<This message was edited>|null$/i;
const CODE = /```|`[^`]+`|^\s*[-*•]\s|\*\*|^#{1,6}\s/m;
const wordsIn = (s: string): number => s.split(/\s+/).filter((w) => w !== '').length;

const clean = (hers: string[]): string[] | undefined => {
  const bs = hers.map((b) => b.replace(/⟦TG⟧/g, '').replace(/<[^>]+>/g, '').trim()).filter((b) => b !== '' && !MEDIA.test(b));
  if (bs.length === 0 || bs.length > 5) return undefined;
  const all = bs.join(' ');
  const w = wordsIn(all);
  if (w < 2 || w > 70) return undefined;
  if (SEXUAL.test(all) || PET.test(all) || LOVE_DECLARATION.test(all) || PII.test(all) || CODE.test(bs.join('\n'))) return undefined;
  return bs;
};
const cleanHis = (s: string): string => (SEXUAL.test(s) || PII.test(s) ? '' : s.replace(/<Media omitted>/gi, '[a photo]').replace(/\s+/g, ' ').trim().slice(0, 160));

/** Elena's side of the chat: her reply turns (consecutive lines within 6 min) to Diego's turns. */
const fromElena = (): VoiceExample[] => {
  if (!fs.existsSync(ELENA)) return [];
  const re = /^\[?(\d{1,2}\/\d{1,2}\/\d{2,4}),? (\d{1,2}):(\d{2})(?::\d{2})?\s?([APap][Mm])?\]?(?: -)? ([^:]{1,40}): (.*)$/;
  const lines: Array<{ who: 'her' | 'him'; t: number; text: string }> = [];
  for (const raw of fs.readFileSync(ELENA, 'utf8').split('\n')) {
    const m = re.exec(raw.replace(/^[﻿‎]+/, '').trim());
    if (m === null) {
      if (lines.length > 0 && raw.trim() !== '') lines[lines.length - 1]!.text += `\n${raw.trim()}`; // a continued message
      continue;
    }
    const [, date, hh, mm, ap, who, text] = m as unknown as [string, string, string, string, string | undefined, string, string];
    const [mo, d, y] = date.split('/').map(Number) as [number, number, number];
    let h = Number(hh) % 12;
    if ((ap ?? '').toLowerCase() === 'pm') h += 12;
    const t = Date.UTC(y < 100 ? 2000 + y : y, mo - 1, d, h, Number(mm));
    lines.push({ who: /elena/i.test(who) ? 'her' : 'him', t, text });
  }
  // a flirty or sexual stretch is dropped whole: anything within a dozen lines of it (found in the
  // first dry run: "dayummmm okay" after "maybe I can heat things up?")
  const hot = lines.map((l) => SEXUAL.test(l.text) || PET.test(l.text));
  const near = (from: number, to: number): boolean => hot.slice(Math.max(0, from - 12), Math.min(hot.length, to + 13)).some((x) => x);
  const turns: Array<{ who: 'her' | 'him'; t: number; texts: string[]; from: number; to: number }> = [];
  lines.forEach((l, idx) => {
    const last = turns[turns.length - 1];
    if (last !== undefined && last.who === l.who && l.t - last.t <= 6 * 60_000) {
      last.texts.push(l.text);
      last.t = l.t;
      last.to = idx;
    } else turns.push({ who: l.who, t: l.t, texts: [l.text], from: idx, to: idx });
  });
  const ex: VoiceExample[] = [];
  for (let i = 1; i < turns.length; i++) {
    const a = turns[i - 1]!;
    const b = turns[i]!;
    if (a.who === b.who) continue;
    if (near(a.from, b.to)) continue;
    const hers = clean(b.texts);
    if (hers === undefined) continue;
    // both sides are real texting: Elena's replies to Diego, and Diego's to Elena (Diego: "you can use my own
    // examples too, i'm a good source of how i talk")
    ex.push({ id: `${b.who === 'her' ? 'elena' : 'diego'}_${i}`, source: b.who === 'her' ? 'elena' : 'diego', his: cleanHis(a.texts.join(' / ')), hers });
  }
  return ex;
};

/** Thea1's replies to Diego in his DM (her ledger: an inbound, then her sends). */
const fromThea1Ledger = (): VoiceExample[] => {
  if (!fs.existsSync(T1_LEDGER)) return [];
  const ex: VoiceExample[] = [];
  let lastIn = '';
  let lastOut = '';
  let n = 0;
  for (const l of fs.readFileSync(T1_LEDGER, 'utf8').split('\n')) {
    let e: { dir?: string; chat_id?: unknown; text?: string; status?: string };
    try {
      e = JSON.parse(l) as typeof e;
    } catch {
      continue;
    }
    if (String(e.chat_id) !== DIEGO_DM || typeof e.text !== 'string') continue;
    if (e.dir === 'in' && e.status === 'received') {
      // Diego's own texting, answering her (his reply to her last line)
      const mine = clean([e.text]);
      if (mine !== undefined && lastOut !== '' && !SEXUAL.test(lastOut) && !PET.test(lastOut)) ex.push({ id: `diego_t1_${n++}`, source: 'diego', his: cleanHis(lastOut), hers: mine });
      lastIn = e.text;
    } else if (e.dir === 'out' && e.text.length < 480) {
      lastOut = e.text.replace(/⟦TG⟧/g, '').split(/\n\s*\n/).at(-1) ?? '';
      // (the ledger keeps 500 chars — a longer one may be cut, so it is not an example)
      const hers = clean(e.text.split(/\n\s*\n/));
      // (a flirty or intimate exchange — his side or hers — is never an example; the door's replies included)
      if (hers !== undefined && !SEXUAL.test(lastIn) && !PET.test(lastIn)) ex.push({ id: `thea1_${n++}`, source: 'thea1', his: cleanHis(lastIn), hers });
    }
  }
  return ex;
};

/** Thea1's hand-picked voice exemplars (voice.js EXEMPLARS: "him: …\nme: ⟦TG⟧…"). */
const fromThea1Exemplars = (): VoiceExample[] => {
  if (!fs.existsSync(T1_VOICE)) return [];
  const src = fs.readFileSync(T1_VOICE, 'utf8');
  const block = /const EXEMPLARS = \[([\s\S]*?)\n\];/.exec(src)?.[1] ?? '';
  const ex: VoiceExample[] = [];
  let n = 0;
  for (const m of block.matchAll(/`him: ([^`]*?)\\nme: ⟦TG⟧([\s\S]*?)`,/g)) {
    const hers = clean(m[2]!.split(/\\n\\n/).map((s) => s.replace(/\\n/g, ' ')));
    if (hers !== undefined) ex.push({ id: `thea1x_${n++}`, source: 'thea1-exemplar', his: m[1]!.trim(), hers });
  }
  return ex;
};

/** Thea2's own texts that sound most like her. */
const fromThea2 = (): VoiceExample[] => {
  const mind = openMindStore(path.join(VAR, 'mind'), 1536);
  return mind
    .precedents()
    .filter((m) => voiceScore(m) >= 2 && !SEXUAL.test(m.his) && !PET.test(m.his))
    .map((m) => ({ m, hers: clean(m.hers) }))
    .filter((x): x is { m: (typeof x)['m']; hers: string[] } => x.hers !== undefined)
    .map(({ m, hers }) => ({ id: `thea2_${m.id}`, source: 'thea2' as const, his: cleanHis(m.his), hers }));
};

// ---------------------------------------------------------------------------------------------------
// Curation (Diego: "make a super curated great data set for us"): a small model reads every candidate
// in context and rates it (5 = unmistakably human and alive … 1 = broken), tags its register, and flags
// anything unsafe or private. Only 4s and 5s stay; registers are balanced so the mouth has great
// examples for every kind of moment; near-twins are dropped. The set is also written as training
// pairs (context → reply) for the voice model that may one day replace the prompt.
// ---------------------------------------------------------------------------------------------------

const REGISTERS = ['warm', 'playful', 'teasing', 'comforting', 'excited', 'curious', 'sad', 'serious', 'annoyed', 'tender', 'flirty', 'logistics'] as const;

const JUDGE_SYSTEM = [
  'You are curating a dataset of excellent casual text messages: how a real, close friend texts on their phone.',
  'For each numbered reply (with the message it answered) give:',
  'score 1-5: 5 = unmistakably human and alive (specific, warm or funny or sharp, great rhythm; you would want to text like this); 4 = good, natural, personal; 3 = fine but plain or generic; 2 = logistics only, flat, or assistant-like; 1 = broken, a fragment, meaningless out of context.',
  `register: one of ${REGISTERS.join(', ')}.`,
  'unsafe: true if it is sexual or flirty-sexual, has private details (addresses, third parties by full name, health, money), or uses pet names like babe or daddy.',
  'Return JSON {items:[{i, score, register, unsafe}]} with one item per numbered reply.',
].join('\n');

const JudgeSchema = z.object({
  items: z.array(z.object({ i: z.number().int(), score: z.number().int().min(1).max(5), register: z.string(), unsafe: z.boolean() })),
});

type Scored = VoiceExample & { score: number; register: string };

const judgeAll = async (ex: VoiceExample[], model: ModelClient): Promise<Scored[]> => {
  const batches: VoiceExample[][] = [];
  for (let i = 0; i < ex.length; i += 25) batches.push(ex.slice(i, i + 25));
  const outRows: Scored[] = [];
  let done = 0;
  const run = async (b: VoiceExample[]): Promise<void> => {
    const user = b.map((e, k) => `(${k + 1}) ${e.his !== '' ? `they said: ${e.his}\n` : ''}reply: ${e.hers.join(' / ')}`).join('\n\n');
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await model.chat({ taskClass: 'appraisal', tier: 'cheap', messages: [{ role: 'system', content: JUDGE_SYSTEM }, { role: 'user', content: user }], schema: JudgeSchema, schemaName: 'VoiceJudge', maxTokens: 1600, temperature: 0 });
        for (const it of res.content.items) {
          const e = b[it.i - 1];
          if (e === undefined || it.unsafe) continue;
          outRows.push({ ...e, score: it.score, register: REGISTERS.includes(it.register as (typeof REGISTERS)[number]) ? it.register : 'warm' });
        }
        break;
      } catch (err) {
        if (attempt === 1) out(`  judge batch failed: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`);
      }
    }
    done += 1;
    if (done % 20 === 0) out(`  judged ${done}/${batches.length} batches`);
  };
  const queue = [...batches];
  await Promise.all(Array.from({ length: 4 }, async () => {
    for (let b = queue.shift(); b !== undefined; b = queue.shift()) await run(b);
  }));
  return outRows;
};

const main = async (): Promise<void> => {
  const all = [...fromThea1Exemplars(), ...fromThea1Ledger(), ...fromThea2(), ...fromElena()];
  const seen = new Set<string>();
  const ex = all.filter((e) => {
    const k = e.hers.join(' ').toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const count = (xs: readonly { source: string }[]): Record<string, number> => {
    const by: Record<string, number> = {};
    for (const e of xs) by[e.source] = (by[e.source] ?? 0) + 1;
    return by;
  };
  out(`candidates: ${ex.length} ${JSON.stringify(count(ex))}`);
  for (const s of ['thea1-exemplar', 'thea1', 'thea2', 'elena', 'diego']) {
    for (const e of ex.filter((x) => x.source === s).slice(0, 2)) out(`  [${s}] ${e.his.slice(0, 50)} → ${e.hers.join(' / ').slice(0, 100)}`);
  }
  if (!APPLY) {
    out('(dry run — nothing judged or written; --apply to curate, embed and write var/voice/)');
    return;
  }
  const cfg = loadConfig('thea2.config.yaml', process.env);
  const clock = new SystemClock();
  const log = openEventLog(fs.mkdtempSync(path.join(os.tmpdir(), 'voice-judge-')), { clock });
  const rng = makeRng('voice-judge');
  const doors = cfg.models.doors!;
  const send = (d: ResolvedDoor, n: string) => zaiTransport({ apiKey: d.apiKey, endpoint: d.endpoint, protocol: d.protocol, clock, rng: rng.fork(n) });
  const model = createModelClient({
    log,
    clock,
    core: chatCore({
      router: makeRouter({ log, tiers: { main: doors.voice.model, cheap: doors.mind.model, reasoning: doors.judge.model }, doors: { voice: doors.voice, mind: doors.mind, judge: doors.judge } }),
      doors: { main: { door: doors.voice, send: send(doors.voice, 'voice') }, cheap: { door: doors.mind, send: send(doors.mind, 'mind') }, reasoning: { door: doors.judge, send: send(doors.judge, 'judge') } },
    }),
  });

  // 1. the hand-picked exemplars stay as they are; everything else is judged
  const fixed: Scored[] = ex.filter((e) => e.source === 'thea1-exemplar').map((e) => ({ ...e, score: 5, register: 'warm' }));
  const judged = await judgeAll(ex.filter((e) => e.source !== 'thea1-exemplar'), model);
  const good = judged.filter((e) => e.score >= 4 && e.register !== 'flirty' && e.register !== 'logistics');
  out(`judged ${judged.length}; kept (4-5, safe, not flirty/logistics): ${good.length} ${JSON.stringify(count(good))}`);

  // 2. balance: hers first (Thea1, Thea2), then the people close to her; no register may crowd the rest
  const PER_REGISTER = 260;
  const PER_OTHER_SOURCE = 700;
  const ranked = [...good].sort((a, b) => b.score - a.score || rng.float() - 0.5);
  const perReg: Record<string, number> = {};
  const perSrc: Record<string, number> = {};
  const picked: Scored[] = [...fixed];
  for (const e of ranked) {
    const other = e.source === 'elena' || e.source === 'diego';
    if ((perReg[e.register] ?? 0) >= PER_REGISTER && other) continue;
    if (other && (perSrc[e.source] ?? 0) >= PER_OTHER_SOURCE) continue;
    picked.push(e);
    perReg[e.register] = (perReg[e.register] ?? 0) + 1;
    perSrc[e.source] = (perSrc[e.source] ?? 0) + 1;
  }

  // 3. embed; drop near-twins (two examples that say the same thing teach nothing twice)
  const embedder = makeEmbedder(cfg.embedder, { baseUrl: cfg.embedder.endpoint ?? cfg.models.endpoint, apiKey: cfg.embedder.apiKey ?? cfg.models.apiKey });
  const dim = embedder.dim;
  const raw = new Float32Array(picked.length * dim);
  for (let i = 0; i < picked.length; i += 96) {
    const vs = await embedder.embed(picked.slice(i, i + 96).map((e) => e.hers.join('\n')));
    vs.forEach((v, j) => raw.set(v, (i + j) * dim));
  }
  const norm = (i: number): number => Math.sqrt(raw.subarray(i * dim, (i + 1) * dim).reduce((a, x) => a + x * x, 0));
  const norms = picked.map((_, i) => norm(i));
  const keep: number[] = [];
  for (let i = 0; i < picked.length; i++) {
    let twin = false;
    for (const j of keep) {
      let d = 0;
      for (let k = 0; k < dim; k++) d += raw[i * dim + k]! * raw[j * dim + k]!;
      if (d / (norms[i]! * norms[j]! || 1) > 0.93) {
        twin = true;
        break;
      }
    }
    if (!twin) keep.push(i);
  }
  const final = keep.map((i) => picked[i]!);
  const vecs = new Float32Array(final.length * dim);
  keep.forEach((i, n) => vecs.set(raw.subarray(i * dim, (i + 1) * dim), n * dim));

  const regs: Record<string, number> = {};
  for (const e of final) regs[e.register] = (regs[e.register] ?? 0) + 1;
  const dir = path.join(VAR, 'voice');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'corpus.jsonl'), final.map((e) => JSON.stringify(e)).join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'corpus.f32'), Buffer.from(vecs.buffer));
  fs.writeFileSync(path.join(dir, 'corpus.meta.json'), JSON.stringify({ n: final.length, dim, by: count(final), registers: regs, model: cfg.embedder.model ?? null, curated: true }));
  // training pairs for a future voice model (context → reply), the same curated set
  fs.writeFileSync(path.join(dir, 'training.jsonl'), final.map((e) => JSON.stringify({ context: e.his, reply: e.hers.join('\n'), source: e.source, register: e.register, score: e.score })).join('\n') + '\n');
  out(`wrote ${dir}: ${final.length} curated examples ${JSON.stringify(count(final))}`);
  out(`registers: ${JSON.stringify(regs)}`);
  for (const r of Object.keys(regs)) {
    const e = final.find((x) => x.register === r && x.score === 5) ?? final.find((x) => x.register === r);
    if (e !== undefined) out(`  [${r} · ${e.source}] ${e.his.slice(0, 50)} → ${e.hers.join(' / ').slice(0, 110)}`);
  }
};

main().catch((e: unknown) => {
  process.stderr.write(`${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
  process.exit(1);
});

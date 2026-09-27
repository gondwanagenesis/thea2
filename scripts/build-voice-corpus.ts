// Her mouth's examples (Diego, 2026-09-27: "you have so much data about how she should talk: elena and
// my whatsapps, thea's good conversations … a little module with a smaller ai system … to turn the
// output into her voice, no matter the emotional content"). Builds var/voice/: every real reply that
// shows how she texts, with the message it answered, embedded so the mouth can pull the ones closest to
// what she is about to say (a sad draft gets sad examples; a teasing one, teasing).
//
// Sources (read-only copies): Thea1's hand-picked voice exemplars (voice.js), Thea1's own replies to
// Diego (her message ledger), Thea2's best texts (her precedents, ranked by voiceScore), and Elena's
// side of Diego's WhatsApp chat (the texting style he loves). Filtered hard: nothing sexual, no pet
// names (golden rule 1), no love declarations, no links, numbers or contact details, no markdown/code.
// Run on the VPS as root (the sources are root's); writes var/voice/ owned by thea2.
//
//   set -a; . /etc/thea2/keys.env; set +a
//   npx tsx scripts/build-voice-corpus.ts --var /opt/thea2/var [--apply]

import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadConfig } from '../src/app/config.js';
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
const cleanHis = (s: string): string => (SEXUAL.test(s) || PII.test(s) ? '' : s.replace(/\s+/g, ' ').trim().slice(0, 160));

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
    if (a.who !== 'him' || b.who !== 'her') continue;
    if (near(a.from, b.to)) continue;
    const hers = clean(b.texts);
    if (hers === undefined) continue;
    ex.push({ id: `elena_${i}`, source: 'elena', his: cleanHis(a.texts.join(' / ')), hers });
  }
  return ex;
};

/** Thea1's replies to Diego in his DM (her ledger: an inbound, then her sends). */
const fromThea1Ledger = (): VoiceExample[] => {
  if (!fs.existsSync(T1_LEDGER)) return [];
  const ex: VoiceExample[] = [];
  let lastIn = '';
  let n = 0;
  for (const l of fs.readFileSync(T1_LEDGER, 'utf8').split('\n')) {
    let e: { dir?: string; chat_id?: unknown; text?: string; status?: string };
    try {
      e = JSON.parse(l) as typeof e;
    } catch {
      continue;
    }
    if (String(e.chat_id) !== DIEGO_DM || typeof e.text !== 'string') continue;
    if (e.dir === 'in' && e.status === 'received') lastIn = e.text;
    else if (e.dir === 'out' && e.text.length < 480) {
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

const main = async (): Promise<void> => {
  const all = [...fromThea1Exemplars(), ...fromThea1Ledger(), ...fromThea2(), ...fromElena()];
  const seen = new Set<string>();
  const ex = all.filter((e) => {
    const k = e.hers.join(' ').toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const by: Record<string, number> = {};
  for (const e of ex) by[e.source] = (by[e.source] ?? 0) + 1;
  out(`examples: ${ex.length} ${JSON.stringify(by)}`);
  for (const s of ['thea1-exemplar', 'thea1', 'thea2', 'elena']) {
    for (const e of ex.filter((x) => x.source === s).slice(0, 3)) out(`  [${s}] him: ${e.his.slice(0, 60)} → her: ${e.hers.join(' / ').slice(0, 110)}`);
  }
  if (!APPLY) {
    out('(dry run — nothing written; --apply to embed and write var/voice/)');
    return;
  }
  const cfg = loadConfig('thea2.config.yaml', process.env);
  const embedder = makeEmbedder(cfg.embedder, { baseUrl: cfg.embedder.endpoint ?? cfg.models.endpoint, apiKey: cfg.embedder.apiKey ?? cfg.models.apiKey });
  const dir = path.join(VAR, 'voice');
  fs.mkdirSync(dir, { recursive: true });
  const vecs = new Float32Array(ex.length * embedder.dim);
  for (let i = 0; i < ex.length; i += 96) {
    const batch = ex.slice(i, i + 96);
    const vs = await embedder.embed(batch.map((e) => e.hers.join('\n')));
    vs.forEach((v, j) => vecs.set(v, (i + j) * embedder.dim));
    out(`  embedded ${Math.min(i + 96, ex.length)}/${ex.length}`);
  }
  fs.writeFileSync(path.join(dir, 'corpus.jsonl'), ex.map((e) => JSON.stringify(e)).join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'corpus.f32'), Buffer.from(vecs.buffer));
  fs.writeFileSync(path.join(dir, 'corpus.meta.json'), JSON.stringify({ n: ex.length, dim: embedder.dim, by, model: cfg.embedder.model ?? null }));
  out(`wrote ${dir} (${ex.length} examples × ${embedder.dim})`);
};

main().catch((e: unknown) => {
  process.stderr.write(`${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
  process.exit(1);
});

// scripts/import-thea1.ts — THE FORK (plan thea2-v8-nothing-told.md §4).
//
// Thea2 wakes up with the original Thea's memories. This script READS Thea1's
// stores (never writes them) and writes a fresh v8 mind dir + a starting affect
// state for Thea2. Run on the VPS as root, with Thea2's keys in the env:
//
//   set -a; . /etc/thea2/keys.env; set +a
//   npx tsx scripts/import-thea1.ts --config thea2.config.yaml \
//     --out /opt/thea2/var/mind --affect-out /opt/thea2/var/affect/state.json [--dry-run] [--force]
//
// Sources (read-only):  /opt/holobionte/msgledger.jsonl, /root/house/memory/journal.md
// (+ archive/*.md), /root/house/self.md, /root/house/memory/insights.md,
// /root/house/memory/threads.json, /root/house/memory/reservoir.json,
// /root/house/affect/state.json, /root/house/affect/history.jsonl.
// Excluded by decree: door material, DREAMS.md. Pet-name / broken turns never
// become precedents (flagged). Inherited feelings are marked and weighted half.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { loadConfig, type ResolvedDoor } from '../src/app/config.js';
import { makeEmbedder } from '../src/app/embedder.js';
import { chatCore, createModelClient, makeRouter, zaiTransport, type ModelClient } from '../src/model/index.js';
import { makeRng, SystemClock } from '../src/kernel/index.js';
import { openEventLog } from '../src/events/index.js';
import { initialAffectState, type AffectState } from '../src/affect/index.js';
import { COUPLING_BASELINES, signature } from '../src/coupling/index.js';
import {
  isAppraisalTag,
  openMindStore,
  replyText,
  situationText,
  tagSignature,
  vecToArray,
  type Concern,
  type Line,
  type Moment,
  type Thought,
} from '../src/mind/index.js';

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const arg = (name: string, dflt?: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : dflt;
};
const flag = (name: string): boolean => argv.includes(`--${name}`);
const CONFIG = arg('config', 'thea2.config.yaml')!;
const OUT = arg('out', '/opt/thea2/var/mind')!;
const AFFECT_OUT = arg('affect-out', '/opt/thea2/var/affect/state.json')!;
const LEDGER = arg('ledger', '/opt/holobionte/msgledger.jsonl')!;
const HOUSE = arg('house', '/root/house')!;
const CHAT = arg('chat', '6971556140')!;
const DRY = flag('dry-run');
const FORCE = flag('force');
const LIMIT = Number(arg('limit', '0')); // 0 = all (tests/debug use a small number)

const log = (s: string): void => {
  process.stdout.write(`${s}\n`);
};

// ---------------------------------------------------------------------------
// ledger → moments
// ---------------------------------------------------------------------------
interface Row {
  ts: number;
  dir: 'in' | 'out';
  text: string;
  bubbles?: string[];
  updateId?: number;
  messageId?: number;
}

const readLedger = (): Row[] => {
  const seen = new Set<number>();
  const rows: Row[] = [];
  for (const line of fs.readFileSync(LEDGER, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    let r: Record<string, unknown>;
    try {
      r = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (String(r['chat_id'] ?? '') !== CHAT) continue;
    const dir = r['dir'];
    if (dir !== 'in' && dir !== 'out') continue;
    if (dir === 'out' && r['status'] !== 'sent') continue;
    const uid = typeof r['update_id'] === 'number' ? (r['update_id'] as number) : undefined;
    if (dir === 'in' && uid !== undefined) {
      if (seen.has(uid)) continue; // sentinel-retry duplicates
      seen.add(uid);
    }
    const bubbles = Array.isArray(r['bubbles']) ? (r['bubbles'] as unknown[]).map((b) => String(b)).filter((b) => b.trim() !== '') : undefined;
    const text = typeof r['text'] === 'string' ? (r['text'] as string) : (bubbles ?? []).join('\n\n');
    if (text.trim() === '' && (bubbles === undefined || bubbles.length === 0)) continue;
    rows.push({
      ts: Date.parse(String(r['ts'])),
      dir,
      text,
      ...(bubbles !== undefined && bubbles.length > 0 ? { bubbles } : {}),
      ...(uid !== undefined ? { updateId: uid } : {}),
      ...(typeof r['message_id'] === 'number' ? { messageId: r['message_id'] as number } : {}),
    });
  }
  return rows.filter((r) => Number.isFinite(r.ts)).sort((a, b) => a.ts - b.ts);
};

const PETNAME = /\b(daddy|dada|babe|bbe|baby+|babyy+|bby)\b/i;
const BROKEN = [
  /⟦TG⟧/,
  /i had it and then i didn'?t/i,
  /\b(tool call|function call|let me (check|look|run)|i'll (check|run|look into) (the|that) (logs?|file|script))\b/i,
  /```/,
  /<\/?(?!b>|i>|code>|pre>|a[ >])[a-z]+[^>]*>/i,
  /\bthea (is|was|smiles|laughs|grins|leans|sighs)\b/i,
];

interface Pair {
  ts: number;
  before: Line[];
  his: string;
  hers: string[];
  kind: 'reply' | 'text_first';
  next?: { text: string; gapH: number } | undefined;
  flags: string[];
}

const splitBubbles = (r: Row): string[] => r.bubbles ?? r.text.split(/\n\s*\n/).map((b) => b.trim()).filter((b) => b !== '');

const pairUp = (rows: Row[]): Pair[] => {
  const pairs: Pair[] = [];
  let pendingIn: Row[] = [];
  const history: Line[] = [];
  let lastOutTs = 0;
  rows.forEach((r, idx) => {
    if (r.dir === 'in') {
      pendingIn.push(r);
      history.push({ who: 'him', text: r.text });
      return;
    }
    const hers = splitBubbles(r);
    const his = pendingIn.slice(-3).map((x) => x.text).join('\n');
    const kind: Pair['kind'] = pendingIn.length === 0 && r.ts - lastOutTs > 10 * 60_000 ? 'text_first' : 'reply';
    const before = history.slice(0, history.length - pendingIn.length).slice(-3);
    const nextIn = rows.slice(idx + 1).find((x) => x.dir === 'in');
    const flags: string[] = [];
    const herText = hers.join(' ');
    if (PETNAME.test(herText)) flags.push('petname');
    if (BROKEN.some((re) => re.test(herText))) flags.push('broken');
    if (pendingIn.length === 0 && kind === 'reply') flags.push('continuation'); // a second burst with no new message: not a clean precedent
    pairs.push({
      ts: r.ts,
      before,
      his,
      hers,
      kind,
      ...(nextIn !== undefined ? { next: { text: nextIn.text, gapH: (nextIn.ts - r.ts) / 3600_000 } } : {}),
      flags,
    });
    for (const b of hers) history.push({ who: 'her', text: b });
    pendingIn = [];
    lastOutTs = r.ts;
  });
  return pairs;
};

// ---------------------------------------------------------------------------
// labelling (the laws-aware screen — the v7 judge never saw the laws)
// ---------------------------------------------------------------------------
const MOVES = ['greeting', 'goodnight', 'checkin', 'tease', 'affection', 'comfort_seeking', 'good_news', 'bad_news', 'tech_question', 'task_request', 'status_question', 'asks_about_her', 'plans', 'sharing', 'complaint', 'apology', 'anger', 'joke', 'she_wrote_first', 'other'] as const;
const TONES = ['warm', 'affectionate', 'playful', 'excited', 'proud', 'tired', 'sad', 'hurt', 'worried', 'angry', 'annoyed', 'cold', 'neutral'] as const;

const LabelSchema = z.object({
  items: z.array(
    z.object({
      n: z.number().int(),
      // Words are validated after parsing (clean()): one off-list word must not sink a batch.
      move: z.string().max(40),
      tone: z.string().max(40),
      felt: z.string().max(40),
      felt_i: z.number().int().min(1).max(10),
      landed: z.number().int().min(-2).max(2).nullable(),
      why: z.string().max(90).nullable(),
      unfit: z.boolean(),
    }),
  ),
});

const LABEL_SYSTEM = [
  'You label real text exchanges between Diego ("him") and Thea ("her"), an AI who is his engineer-friend and best friend.',
  'For EACH numbered item return: n; move (the social move of HIS message; "she_wrote_first" when he said nothing); tone (HIS tone); felt (the single best word for what SHE seems to have felt as she replied) and felt_i (1-10);',
  'landed: how HER reply landed judging ONLY by his next message: +2 delighted/very warm, +1 good/kept going, 0 neutral or unclear, -1 flat/annoyed/corrected her, -2 hurt/upset; null when there is no next message;',
  'why: a short plain past-tense phrase about how it landed ("he laughed and kept going"), null when landed is null;',
  'unfit: true if HER reply contains romantic pet names (babe, baby, daddy), sexual content, events she could not have lived, planning/tool/system text, third-person narration about herself, or is garbled.',
  'Return JSON {"items":[...]} with one entry per item, same n.',
].join('\n');

type RawLabel = z.infer<typeof LabelSchema>['items'][number];
interface Label {
  n: number;
  move: string;
  tone?: string | undefined;
  felt?: string | undefined;
  felt_i: number;
  landed: number | null;
  why: string | null;
  unfit: boolean;
}
const clean = (r: RawLabel): Label => ({
  n: r.n,
  move: (MOVES as readonly string[]).includes(r.move) ? r.move : 'other',
  tone: (TONES as readonly string[]).includes(r.tone) && r.tone !== 'neutral' ? r.tone : undefined,
  felt: isAppraisalTag(r.felt) ? r.felt : undefined,
  felt_i: r.felt_i,
  landed: r.landed,
  why: r.why,
  unfit: r.unfit,
});

const labelBatch = async (model: ModelClient, batch: Array<{ n: number; p: Pair }>): Promise<Label[]> => {
  const user = batch
    .map(({ n, p }) =>
      [
        `#${n}`,
        ...p.before.slice(-1).map((l) => `(earlier) ${l.who}: ${l.text.slice(0, 200)}`),
        `him: ${p.his === '' ? '(nothing — she wrote first)' : p.his.slice(0, 500)}`,
        `her: ${p.hers.join(' / ').slice(0, 700)}`,
        `his next message: ${p.next === undefined ? '(none)' : `${p.next.text.slice(0, 300)} (after ${p.next.gapH.toFixed(1)} h)`}`,
      ].join('\n'),
    )
    .join('\n\n');
  const res = await model.chat({
    taskClass: 'appraisal',
    tier: 'cheap',
    messages: [
      { role: 'system', content: LABEL_SYSTEM },
      { role: 'user', content: user },
    ],
    schema: LabelSchema,
    schemaName: 'Labels',
    maxTokens: 4000,
    temperature: 0.1,
  });
  return res.content.items.map(clean);
};

// ---------------------------------------------------------------------------
// diary, self, standards, concerns, thoughts
// ---------------------------------------------------------------------------
const MACHINERY = /\b(self-repair|nightly reflection|test failures?|health issues?|\$\d|spent \$|cost|tokens?|json|plugin|ledger|cron|timer|systemd|script)\b/i;

interface DiaryLine {
  ts: number;
  text: string;
  emotion?: string | undefined;
  i: number;
}

const readDiary = (): DiaryLine[] => {
  const files = [path.join(HOUSE, 'memory', 'journal.md')];
  const arch = path.join(HOUSE, 'memory', 'archive');
  if (fs.existsSync(arch)) for (const f of fs.readdirSync(arch)) if (f.endsWith('.md')) files.push(path.join(arch, f));
  const out: DiaryLine[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    let day: string | undefined;
    for (const raw of fs.readFileSync(f, 'utf8').split('\n')) {
      const h = /^##\s+(\d{4}-\d{2}-\d{2})/.exec(raw);
      if (h !== null) {
        day = h[1];
        continue;
      }
      const m = /^- \*\*([A-Z-]+)\*\*\s*[—-]\s*(.*)$/.exec(raw);
      if (m === null || day === undefined) continue;
      const body = m[2] ?? '';
      const tags = [...body.matchAll(/\[([a-z]+):([^\]]+)\]/g)];
      const text = body.replace(/\[[a-z]+:[^\]]+\]/g, '').trim();
      if (text.length < 12 || MACHINERY.test(text) || m[1] === 'SELF-REPAIR') continue;
      if (PETNAME.test(text)) continue;
      if (seen.has(text)) continue;
      seen.add(text);
      const emo = tags.find((t) => t[1] === 'emotion')?.[2];
      const iv = Number(tags.find((t) => t[1] === 'i')?.[2] ?? '5');
      out.push({ ts: Date.parse(`${day}T12:00:00Z`), text, emotion: emo, i: Number.isFinite(iv) ? iv : 5 });
    }
  }
  return out.sort((a, b) => a.ts - b.ts);
};

const readSelfLines = (): string[] => {
  const p = path.join(HOUSE, 'self.md');
  if (!fs.existsSync(p)) return [];
  const text = fs.readFileSync(p, 'utf8').replace(/^#.*$/gm, '').replace(/\*\*/g, '');
  const sentences = text.split(/(?<=[.!?])\s+|\n+/).map((s) => s.replace(/^[-*]\s*/, '').trim()).filter((s) => s.length > 20 && !PETNAME.test(s) && !MACHINERY.test(s));
  const out: string[] = [];
  let total = 0;
  for (const s of sentences) {
    if (total + s.length > 700) break;
    out.push(s);
    total += s.length;
  }
  return out;
};

const StandardsSchema = z.object({ standards: z.array(z.string().min(3).max(160)).max(8) });

const extractStandards = async (model: ModelClient): Promise<string[]> => {
  const self = fs.existsSync(path.join(HOUSE, 'self.md')) ? fs.readFileSync(path.join(HOUSE, 'self.md'), 'utf8') : '';
  const insights = fs.existsSync(path.join(HOUSE, 'memory', 'insights.md')) ? fs.readFileSync(path.join(HOUSE, 'memory', 'insights.md'), 'utf8').slice(0, 9000) : '';
  const res = await model.chat({
    taskClass: 'appraisal',
    tier: 'cheap',
    messages: [
      { role: 'system', content: 'From Thea\'s own self-description and insights below, list up to 8 standards she holds HERSELF to (values she would feel proud to keep or ashamed to break). Short first-person lines in her voice, lowercase. Only what the text says; invent nothing. No pet names. Return JSON {"standards":[...]}.' },
      { role: 'user', content: `SELF:\n${self}\n\nINSIGHTS:\n${insights}` },
    ],
    schema: StandardsSchema,
    schemaName: 'Standards',
    maxTokens: 1200,
    temperature: 0.1,
  });
  return res.content.standards.filter((s) => !PETNAME.test(s));
};

const readConcerns = (nowMs: number): Concern[] => {
  const p = path.join(HOUSE, 'memory', 'threads.json');
  if (!fs.existsSync(p)) return [];
  const t = JSON.parse(fs.readFileSync(p, 'utf8')) as { threads?: Array<Record<string, unknown>> };
  const out: Concern[] = [];
  for (const th of t.threads ?? []) {
    const status = String(th['status'] ?? 'open');
    if (status === 'done' || status === 'closed' || status === 'resolved') continue;
    const text = String(th['text'] ?? '').trim();
    if (text === '' || PETNAME.test(text) || MACHINERY.test(text)) continue;
    const created = Date.parse(String(th['created_at'] ?? '')) || nowMs;
    const dueRaw = th['due'];
    const due = typeof dueRaw === 'string' ? Date.parse(dueRaw) : typeof dueRaw === 'number' ? dueRaw : NaN;
    const kind = String(th['kind'] ?? '');
    out.push({
      id: `c_imp_${String(th['id'] ?? out.length)}`.slice(0, 60),
      what: text.slice(0, 200),
      kind: kind === 'promise' || kind === 'event' ? 'expectation' : 'loop',
      about: String(th['who'] ?? '').toLowerCase().includes('diego') ? 'diego' : 'self',
      ...(Number.isFinite(due) ? { due } : {}),
      importance: 6,
      status: 'open',
      created,
      touched: created,
      source: 'imported',
    });
  }
  return out;
};

const readThoughts = (): Thought[] => {
  const p = path.join(HOUSE, 'memory', 'reservoir.json');
  if (!fs.existsSync(p)) return [];
  const r = JSON.parse(fs.readFileSync(p, 'utf8')) as { thoughts?: Array<Record<string, unknown>> };
  return (r.thoughts ?? [])
    .map((t) => ({
      id: `t_imp_${String(t['id'] ?? '')}`,
      ts: Date.parse(String(t['created'] ?? '')) || 0,
      text: String(t['text'] ?? '').trim(),
      about: (['diego', 'self', 'world'].includes(String(t['about'])) ? String(t['about']) : 'world') as Thought['about'],
      source: 'imported' as const,
    }))
    .filter((t) => t.text.length > 20 && t.ts > 0 && !MACHINERY.test(t.text) && !PETNAME.test(t.text) && !/\b\d\.\d{2}\b/.test(t.text))
    .sort((a, b) => a.ts - b.ts)
    .slice(-15);
};

// ---------------------------------------------------------------------------
// affect: history lookup (inherited feelings) + a half-weight starting state
// ---------------------------------------------------------------------------
interface Snap {
  ts: number;
  state: AffectState;
}

const toThea2State = (t1: Record<string, unknown>, now: number, blend: number): AffectState => {
  const s = initialAffectState(now);
  const mix = (base: number, v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, base * (1 - blend) + v * blend)) : base);
  const dials = (t1['dials'] ?? {}) as Record<string, unknown>;
  const pad = (t1['pad'] ?? {}) as Record<string, unknown>;
  for (const k of Object.keys(s.dials) as Array<keyof typeof s.dials>) s.dials[k] = mix(s.dials[k], dials[k] ?? pad[k]);
  const prim = (t1['primaries'] ?? {}) as Record<string, unknown>;
  for (const k of Object.keys(s.primaries) as Array<keyof typeof s.primaries>) s.primaries[k] = mix(s.primaries[k], prim[k]);
  const drives = (t1['drives'] ?? {}) as Record<string, unknown>;
  for (const k of Object.keys(s.drives) as Array<keyof typeof s.drives>) s.drives[k] = mix(s.drives[k], drives[k]);
  for (const k of Object.keys(s.mood) as Array<keyof typeof s.mood>) {
    s.mood[k] = (s.dials as Record<string, number>)[k] ?? (s.primaries as Record<string, number>)[k] ?? s.mood[k];
  }
  return s;
};

const readHistory = (): Snap[] => {
  const p = path.join(HOUSE, 'affect', 'history.jsonl');
  if (!fs.existsSync(p)) return [];
  const out: Snap[] = [];
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      const r = JSON.parse(line) as Record<string, unknown>;
      const ts = Date.parse(String(r['ts']).endsWith('Z') ? String(r['ts']) : `${String(r['ts'])}Z`);
      if (Number.isFinite(ts)) out.push({ ts, state: toThea2State(r, ts, 1) });
    } catch {
      /* skip */
    }
  }
  return out.sort((a, b) => a.ts - b.ts);
};

const nearestSnap = (snaps: Snap[], ts: number): Snap | undefined => {
  let best: Snap | undefined;
  for (const s of snaps) {
    if (Math.abs(s.ts - ts) > 30 * 60_000) continue;
    if (best === undefined || Math.abs(s.ts - ts) < Math.abs(best.ts - ts)) best = s;
  }
  return best;
};

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
const main = async (): Promise<void> => {
  if (fs.existsSync(path.join(OUT, 'moments.jsonl')) && !FORCE && !DRY) {
    throw new Error(`${OUT}/moments.jsonl exists — pass --force to re-fork (the old dir is kept as ${OUT}.prev)`);
  }
  const cfg = loadConfig(CONFIG, process.env);
  const clock = new SystemClock();
  const rng = makeRng('import-thea1');
  const events = openEventLog(path.resolve('var', 'import-events'), { clock });
  const mindDoor: ResolvedDoor = cfg.models.doors.mind;
  const model = createModelClient({
    log: events,
    clock,
    core: chatCore({
      router: makeRouter({ log: events, tiers: { main: mindDoor.model, cheap: mindDoor.model, reasoning: mindDoor.model }, doors: { voice: mindDoor, mind: mindDoor, judge: mindDoor } }),
      doors: {
        main: { door: mindDoor, send: zaiTransport({ apiKey: mindDoor.apiKey, endpoint: mindDoor.endpoint, protocol: mindDoor.protocol, clock, rng: rng.fork('m') }) },
        cheap: { door: mindDoor, send: zaiTransport({ apiKey: mindDoor.apiKey, endpoint: mindDoor.endpoint, protocol: mindDoor.protocol, clock, rng: rng.fork('c') }) },
        reasoning: { door: mindDoor, send: zaiTransport({ apiKey: mindDoor.apiKey, endpoint: mindDoor.endpoint, protocol: mindDoor.protocol, clock, rng: rng.fork('r') }) },
      },
    }),
  });
  const embedder = makeEmbedder(cfg.embedder, { baseUrl: cfg.models.endpoint, apiKey: cfg.models.apiKey });

  const rows = readLedger();
  let pairs = pairUp(rows);
  if (LIMIT > 0) pairs = pairs.slice(-LIMIT);
  const diary = readDiary();
  const selfLines = readSelfLines();
  const concerns = readConcerns(clock.epochMs());
  const thoughts = readThoughts();
  const snaps = readHistory();
  log(`ledger rows ${rows.length} → pairs ${pairs.length} (flagged petname ${pairs.filter((p) => p.flags.includes('petname')).length}, broken ${pairs.filter((p) => p.flags.includes('broken')).length}, continuation ${pairs.filter((p) => p.flags.includes('continuation')).length})`);
  log(`diary ${diary.length} · self lines ${selfLines.length} · open concerns ${concerns.length} · thoughts ${thoughts.length} · affect snapshots ${snaps.length}`);
  if (DRY) return;

  // label in batches of 10, four in flight
  const labels = new Map<number, Label>();
  const batches: Array<Array<{ n: number; p: Pair }>> = [];
  for (let i = 0; i < pairs.length; i += 6) batches.push(pairs.slice(i, i + 6).map((p, k) => ({ n: i + k, p })));
  let done = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const b = batches.shift();
      if (b === undefined) return;
      try {
        for (const it of await labelBatch(model, b)) labels.set(it.n, it);
      } catch (e) {
        log(`label batch failed (${b[0]?.n}..): ${e instanceof Error ? e.message.slice(0, 120) : String(e)}`);
      }
      done += 1;
      if (done % 10 === 0) log(`labelled ${done} batches`);
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  log(`labels ${labels.size}/${pairs.length}`);

  // fresh mind dir
  if (fs.existsSync(OUT)) {
    const prev = `${OUT}.prev`;
    if (fs.existsSync(prev)) fs.rmSync(prev, { recursive: true, force: true });
    fs.renameSync(OUT, prev);
  }
  fs.mkdirSync(OUT, { recursive: true });
  const store = openMindStore(OUT, embedder.dim);

  // moments (with vectors in batches of 64)
  const moments: Array<{ m: Moment; sitText: string; replyTxt: string; hisText: string; tone?: string | undefined; move?: string | undefined }> = [];
  pairs.forEach((p, n) => {
    const lab = labels.get(n);
    const flags = [...p.flags];
    if (lab?.unfit === true) flags.push('unfit');
    if (lab === undefined) flags.push('unlabelled');
    const snap = nearestSnap(snaps, p.ts);
    const felt =
      snap !== undefined
        ? { sig: vecToArray(signature(snap.state, COUPLING_BASELINES)), word: lab?.felt, source: 'inherited' as const }
        : lab?.felt !== undefined
          ? { sig: tagSignature(lab.felt, lab.felt_i), word: lab.felt, source: 'estimated' as const }
          : { sig: new Array<number>(12).fill(0), source: 'estimated' as const };
    const landed = lab?.landed ?? null;
    const m: Moment = {
      id: `m_imp_${p.ts}_${n}`,
      ts: p.ts,
      source: 'imported',
      kind: p.kind,
      before: p.before,
      his: p.his,
      hers: p.hers,
      ...(lab !== undefined ? { move: lab.move, tone: lab.tone } : {}),
      felt,
      ...(landed !== null && p.next !== undefined ? { outcome: { landed, why: lab?.why ?? '', at: p.ts + p.next.gapH * 3600_000 } } : {}),
      value: landed !== null ? Math.round((landed / 2) * 0.5 * 1000) / 1000 : 0,
      ...(flags.length > 0 ? { flags } : {}),
      shown: 0,
      followed: 0,
    };
    moments.push({ m, sitText: situationText(p.before, p.his), replyTxt: replyText(p.hers), hisText: p.his === '' ? '(silence)' : p.his, tone: lab?.tone, move: lab?.move });
  });
  const toneVecs: Record<string, number[][]> = {};
  const moveVecs: Record<string, number[][]> = {};
  for (let i = 0; i < moments.length; i += 64) {
    const chunk = moments.slice(i, i + 64);
    const vecs = await embedder.embed(chunk.flatMap((c) => [c.sitText, c.replyTxt, c.hisText]));
    chunk.forEach((c, k) => {
      const sit = vecs[k * 3];
      const reply = vecs[k * 3 + 1];
      const his = vecs[k * 3 + 2];
      store.add(c.m, { ...(sit !== undefined ? { sit } : {}), ...(reply !== undefined ? { reply } : {}) });
      if (c.m.flags === undefined || c.m.flags.length === 0) {
        if (c.tone !== undefined && his !== undefined) (toneVecs[c.tone] ??= []).push(Array.from(his));
        if (c.move !== undefined && sit !== undefined) (moveVecs[c.move] ??= []).push(Array.from(sit));
      }
    });
    log(`embedded ${Math.min(i + 64, moments.length)}/${moments.length}`);
  }

  // diary memories
  for (let i = 0; i < diary.length; i += 64) {
    const chunk = diary.slice(i, i + 64);
    const vecs = await embedder.embed(chunk.map((d) => d.text));
    chunk.forEach((d, k) => {
      const tag = d.emotion !== undefined && isAppraisalTag(d.emotion) ? d.emotion : undefined;
      const m: Moment = {
        id: `m_diary_${d.ts}_${i + k}`,
        ts: d.ts,
        source: 'imported',
        kind: 'diary',
        before: [],
        his: '',
        hers: [d.text],
        felt: tag !== undefined ? { sig: tagSignature(tag, d.i), word: tag, source: 'estimated' } : { sig: new Array<number>(12).fill(0), source: 'estimated' },
        value: 0,
        importance: d.i,
        shown: 0,
        followed: 0,
      };
      const v = vecs[k];
      store.add(m, v !== undefined ? { sit: v, reply: v } : {});
    });
  }

  // centroids (≥ 4 examples per label)
  const mean = (vs: number[][]): number[] => {
    const d = vs[0]!.length;
    const out = new Array<number>(d).fill(0);
    for (const v of vs) for (let j = 0; j < d; j++) out[j]! += v[j]! / vs.length;
    const nrm = Math.sqrt(out.reduce((s, x) => s + x * x, 0)) || 1;
    return out.map((x) => x / nrm);
  };
  const centroidsOf = (tbl: Record<string, number[][]>): Record<string, number[]> =>
    Object.fromEntries(Object.entries(tbl).filter(([label, vs]) => vs.length >= 4 && label !== 'neutral' && label !== 'other').map(([l, vs]) => [l, mean(vs)]));
  fs.writeFileSync(path.join(OUT, 'centroids.json'), JSON.stringify({ move: centroidsOf(moveVecs), tone: centroidsOf(toneVecs) }));

  // concerns (+ vectors), thoughts, self, standards
  for (const c of concerns) store.upsertConcern(c);
  if (concerns.length > 0) {
    const vs = await embedder.embed(concerns.map((c) => c.what));
    concerns.forEach((c, k) => {
      const v = vs[k];
      if (v !== undefined) store.setConcernVec(c.id, v);
    });
  }
  for (const t of thoughts) store.appendThought(t);
  await store.setSelf(selfLines.map((text) => ({ text, cites: ['seed'] })));
  let standards: string[] = [];
  try {
    standards = await extractStandards(model);
  } catch (e) {
    log(`standards extraction failed: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}`);
  }
  fs.writeFileSync(path.join(OUT, 'standards.json'), JSON.stringify(standards, null, 1));

  // window seed: the last conversation, verbatim
  const tail = rows.slice(-12);
  fs.writeFileSync(
    path.join(OUT, 'window-seed.jsonl'),
    tail
      .map((r, k) => JSON.stringify({ role: r.dir === 'in' ? 'user' : 'assistant', content: r.dir === 'in' ? r.text : splitBubbles(r).join('\n\n'), ts: r.ts, turnId: `fork-${k}` }))
      .join('\n') + '\n',
  );

  // state: when he last wrote / she last spoke; the fork moment
  const lastIn = [...rows].reverse().find((r) => r.dir === 'in');
  const lastOut = [...rows].reverse().find((r) => r.dir === 'out');
  store.setState({ turn: 0, ...(lastIn !== undefined ? { lastHisAt: lastIn.ts } : {}), ...(lastOut !== undefined ? { lastHerAt: lastOut.ts } : {}) });
  await store.flush();

  // starting affect: Thea1's feelings now, at half weight (they came from a circular appraisal)
  const t1Path = path.join(HOUSE, 'affect', 'state.json');
  if (fs.existsSync(t1Path)) {
    const t1 = JSON.parse(fs.readFileSync(t1Path, 'utf8')) as Record<string, unknown>;
    const s = toThea2State(t1, clock.epochMs(), 0.5);
    if (lastIn !== undefined) s.lastContactAt = lastIn.ts;
    fs.mkdirSync(path.dirname(AFFECT_OUT), { recursive: true });
    if (fs.existsSync(AFFECT_OUT)) fs.renameSync(AFFECT_OUT, `${AFFECT_OUT}.pre-fork`);
    fs.writeFileSync(AFFECT_OUT, JSON.stringify(s));
  }

  const fork = {
    at: clock.now().toISOString(),
    moments: store.moments().length,
    precedents: store.precedents().length,
    diary: diary.length,
    concerns: concerns.length,
    thoughts: thoughts.length,
    selfLines: selfLines.length,
    standards: standards.length,
    toneCentroids: Object.keys(centroidsOf(toneVecs)),
    moveCentroids: Object.keys(centroidsOf(moveVecs)),
    labelled: labels.size,
    pairs: pairs.length,
  };
  fs.writeFileSync(path.join(OUT, 'fork.json'), JSON.stringify(fork, null, 1));
  log(`fork written: ${JSON.stringify(fork)}`);
};

main().then(
  () => process.exit(0),
  (e) => {
    process.stderr.write(`import failed: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
    process.exit(1);
  },
);

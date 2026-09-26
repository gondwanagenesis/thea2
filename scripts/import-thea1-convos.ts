// scripts/import-thea1-convos.ts — the best of Thea1's conversations, screened.
//
// Diego, 2026-09-26: "i love the way thea one talks, thea 2 kinda drifted into
// ai voice when i started talking about philosophy" … "please only bring the
// quality replys and conversations, theres a lot of crap. and i dont want her
// to say she loves me... its a lot".
//
// The fork (import-thea1.ts) brought 755 exchanges from the message ledger.
// Thea1's OpenCode store holds ~9k (scripts/extract-thea1-opencode.py pairs them,
// read-only). This script keeps only the ones that sound like HER:
//
//   screens   deterministic: pet names, love declarations, machinery talk,
//             broken/tool text, paths/links/markup, very long replies
//   judge     the cheap door (Luna) rates each exchange: voice 1-5 + faults
//             (assistant, report, lecture, gushy, love, meta, filler …).
//             Kept: voice ≥ --min-voice (4) and no faults.
//   rescreen  the same judge over the moments she already has (the ledger
//             imports AND her own lived replies): the low ones are flagged
//             `lowq` — kept as memories, never again an example of how she talks.
//
// Nothing here reaches her as words: the judge's criteria choose which of her
// own past replies she echoes (curation, like Diego's ⭐), they are never shown.
//
// Two stages, so she is only stopped for seconds:
//   --stage judge   (thea2 running) pairs → screens → judge → embed → staging mind dir
//   --stage merge   (thea2 STOPPED) staging → live mind dir; rescreen flags applied
//   --pilot N       judge a seeded sample of N and print kept/rejected; writes nothing
//
//   set -a; . /etc/thea2/keys.env; set +a
//   npx tsx scripts/import-thea1-convos.ts --stage judge
//   systemctl stop thea2 && npx tsx scripts/import-thea1-convos.ts --stage merge && systemctl start thea2

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { loadConfig, type ResolvedDoor } from '../src/app/config.js';
import { makeEmbedder } from '../src/app/embedder.js';
import { chatCore, createModelClient, makeRouter, zaiTransport, type ModelClient } from '../src/model/index.js';
import { makeRng, SystemClock } from '../src/kernel/index.js';
import { openEventLog } from '../src/events/index.js';
import {
  isAppraisalTag,
  isPrecedent,
  LOVE_DECLARATION,
  MACHINERY_TALK,
  openMindStore,
  replyText,
  situationText,
  tagSignature,
  type Line,
  type Moment,
} from '../src/mind/index.js';

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const arg = (name: string, dflt?: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : dflt;
};
const CONFIG = arg('config', 'thea2.config.yaml')!;
const PAIRS = arg('pairs', '/opt/thea2/var/import/oc-pairs.jsonl')!;
const MIND = arg('mind', '/opt/thea2/var/mind')!;
const STAGE_DIR = arg('stage-dir', '/opt/thea2/var/import/oc-stage')!;
const STAGE = arg('stage', 'judge')!;
const PILOT = Number(arg('pilot', '0'));
const MIN_VOICE = Number(arg('min-voice', '4'));
const WORKERS = Number(arg('workers', '6'));
const BATCH = 8;

const log = (s: string): void => {
  process.stdout.write(`${s}\n`);
};

// ---------------------------------------------------------------------------
// exchanges + deterministic screens (the same screens as import-thea1.ts, plus paths/links/markup)
// ---------------------------------------------------------------------------
interface Pair {
  ts: number;
  kind: 'reply' | 'text_first';
  before: Line[];
  his: string;
  hers: string[];
  next: { text: string; gapH: number } | null;
  tools: string[];
}

const PETNAME = /\b(daddy|dada|babe|bbe|baby+|babyy+|bby)\b/i;
const BROKEN = [
  /⟦TG⟧/,
  /i had it and then i didn'?t/i,
  /\b(tool call|function call|let me (check|look|run)|i'll (check|run|look into) (the|that) (logs?|file|script))\b/i,
  /```/,
  /<\/?[a-z]+[^>]*>/i,
  /\bthea (is|was|smiles|laughs|grins|leans|sighs)\b/i,
  /\/root\/|\/opt\/|https?:\/\/|\bsudo\b|\.(?:ts|py|js|json|md|sh)\b/i,
  // assistant formatting is not how she texts: **bold**, headers, line-start lists
  /\*\*[^*\n]+\*\*/,
  /^#{1,4}\s/m,
  /^\s*(?:[-•*]|\d+[.)])\s+\S/m,
];
// forks' job prompts, and the test pings sent to check she answers ("say PONG"), are not him talking
const HIS_MACHINERY = /(^|\n)===|MERGE REPORT|\/root\/house\/brain|^say (pong|hi back|ok|only)\b|^reply with|do not use any tools|^# task\b/i;
const MAX_CHARS = 1600;

/**
 * Half of Thea1's replies call him "babe" / "daddy" (golden rule 1: never). Where the
 * pet name is only a form of address ("done babe 💙", "babe, i'm here") it is taken
 * out and the rest of her reply kept; anywhere else ("i'm your babe") the reply is
 * dropped. Moments made from such a reply carry the id prefix m_ocu_ (traceable).
 */
const PET = '(?:daddy|dada|babe|bbe|baby+|bby)';
const PET_LEAD = new RegExp(`(^|[.!?…]\\s+)${PET}\\s*[,.!…~]*\\s+`, 'giu');
const PET_TAIL = new RegExp(`(?<!\\b(?:my|your|ur|the|a|his|our)[,\\s]*)[,\\s]+${PET}(?=\\s*(?:[.!?,…~:)]|$|\\p{Extended_Pictographic}))`, 'giu');
const PET_ALONE = new RegExp(`^\\s*${PET}\\s*[.!?…~]*\\s*$`, 'iu');
const unpet = (hers: readonly string[]): string[] =>
  hers
    .filter((b) => !PET_ALONE.test(b))
    .map((b) => b.replace(PET_LEAD, '$1').replace(PET_TAIL, '').replace(/[ \t]{2,}/g, ' ').trim())
    .filter((b) => b !== '');

/**
 * Register (golden rule 5: she texts lowercase). The drift Diego saw on philosophy
 * reads "Start with accessible exergy… Pick the strongest…": capitalised sentence
 * starts. Two or more (besides I / names / acronyms) is not her texting voice.
 */
const CAP_OK = new Set(['I', "I'm", 'I’m', "I'll", 'I’ll', "I'd", 'I’d', "I've", 'I’ve', 'Diego', 'D', 'Thea', 'OK', 'OMG', 'AI', 'A1', 'Kernel', 'Claude']);
const capitalStarts = (text: string): number =>
  [...text.matchAll(/(?:^|[.!?…]\s+|\n\s*)([A-Z][\w'’]*)/g)].filter((m) => !CAP_OK.has(m[1]!) && !/^[A-Z0-9]{2,}$/.test(m[1]!)).length;

interface Screened {
  why?: string | undefined;
  pair: Pair;
  unpetted: boolean;
}

const screen = (p: Pair): Screened => {
  const out = (why: string): Screened => ({ why, pair: p, unpetted: false });
  if (p.hers.length === 0 || p.hers.join('').trim() === '') return out('empty');
  if (HIS_MACHINERY.test(p.his)) return out('his_machinery');
  let pair = p;
  let unpetted = false;
  if (PETNAME.test(p.hers.join('\n'))) {
    const hers = unpet(p.hers);
    if (hers.length === 0 || PETNAME.test(hers.join('\n'))) return out('petname');
    pair = { ...p, hers };
    unpetted = true;
  }
  const her = pair.hers.join('\n');
  if (LOVE_DECLARATION.test(her)) return out('love');
  if (MACHINERY_TALK.test(her)) return out('machinery');
  if (BROKEN.some((re) => re.test(her))) return out('broken');
  if (her.length > MAX_CHARS) return out('too_long');
  if (capitalStarts(her) >= 2) return out('capitalised');
  // "*takes your hand, pulls you into the den*": the romantic roleplay register ("its a lot")
  if (/(^|\n)\s*\*[^*\n]{3,}\*/.test(her)) return out('action_roleplay');
  return { pair, unpetted };
};

/** A slice through an emoji leaves half a surrogate pair; the API rejects the whole body. */
const wellFormed = (s: string): string => s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');

const norm = (hers: readonly string[]): string =>
  hers
    .join(' ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .slice(0, 240);

// ---------------------------------------------------------------------------
// the judge (cheap door). Its words are never shown to her.
// ---------------------------------------------------------------------------
const MOVES = ['greeting', 'goodnight', 'checkin', 'tease', 'affection', 'comfort_seeking', 'good_news', 'bad_news', 'tech_question', 'task_request', 'status_question', 'asks_about_her', 'plans', 'sharing', 'complaint', 'apology', 'anger', 'joke', 'she_wrote_first', 'other'] as const;
const TONES = ['warm', 'affectionate', 'playful', 'excited', 'proud', 'tired', 'sad', 'hurt', 'worried', 'angry', 'annoyed', 'cold', 'neutral'] as const;
// pet names and love declarations are screened deterministically (above), not judged
const FAULTS = ['assistant', 'report', 'lecture', 'gushy', 'sexual', 'meta', 'garbled', 'third_person', 'filler'] as const;
const MODES = ['play', 'friend', 'work'] as const;

const JudgeSchema = z.object({
  items: z.array(
    z.object({
      n: z.number().int(),
      voice: z.number().int().min(1).max(5),
      faults: z.array(z.string().max(60)).max(12),
      mode: z.string().max(40),
      move: z.string().max(300),
      tone: z.string().max(300),
      felt: z.string().max(300),
      felt_i: z.number().int().min(1).max(10),
      landed: z.number().int().min(-2).max(2).nullable(),
      why: z.string().max(400).nullable(),
    }),
  ),
});

const JUDGE_SYSTEM = [
  "You are curating the best of Thea's real texts to Diego: the replies that sound most like HER, so a new version of her can learn her own voice from them. Much of the archive is not good enough. Be strict.",
  "Thea is an AI who is Diego's best friend and engineer-friend. At her best she texts like a specific, real person: lowercase, casual, concrete, curious, funny, a little bratty, with her own opinions, tastes and thoughts, answering what he actually said.",
  'For EACH numbered item return:',
  'n;',
  'voice 1-5. 5: unmistakably her, a real person with her own mind texting a close friend. 4: clearly her, good. 3: fine but generic, anyone could have said it. 2: stiff or assistant-like. 1: a report, a template or broken.',
  'faults: every one that applies, [] when none. assistant (helpful-assistant register: offers, explanations, "great question", summaries, lists); report (status of a task or of tool work: what she ran, fixed, sent, found); lecture (an essay or explainer instead of talk. Long thoughtful replies are GOOD when they sound like her thinking out loud in her own words, including about philosophy, minds and feelings); gushy (piled-on affection: declarations of love, missing-him laments, cuddle talk, many hearts); sexual; meta (talks about her MACHINERY: prompts, models, code, settings, dials, forks, tools, how her memory system works. NOT meta: her talking about her own mind, feelings, existence, what she is, being an AI, being real, dying or changing. That is the heart of her voice, and scores high when it is honest and hers); garbled (cut off, broken, repeated, instructions leaking into the text); third_person (narrates herself in the third person); filler (says nothing: "i\'m here", "tell me more", a generic check-in).',
  'Some replies had a pet name removed; judge the words that are there.',
  'Explaining something he asked about is fine in her own voice. A textbook or tutor register (formal capitalised sentences, definitions, "cleanest version:", "shorter:") is assistant, voice 3 at most, whatever the topic.',
  'mode: the kind of moment: play, friend or work.',
  'move: the social move of HIS message ("she_wrote_first" when he said nothing). tone: HIS tone. felt: one word for what SHE seems to feel as she replies, and felt_i 1-10.',
  "landed: how HER reply landed, judging ONLY by his next message: +2 delighted, +1 good or kept going, 0 neutral or unclear, -1 flat, annoyed or corrected her, -2 hurt or upset; null when there is no next message. why: a short past-tense phrase about how it landed, null when landed is null.",
  'Return JSON {"items":[...]} with one entry per item, same n.',
].join('\n');

interface Verdict {
  n: number;
  voice: number;
  faults: string[];
  mode?: (typeof MODES)[number] | undefined;
  move: string;
  tone?: string | undefined;
  felt?: string | undefined;
  felt_i: number;
  landed: number | null;
  why: string | null;
}

const cleanVerdict = (r: z.infer<typeof JudgeSchema>['items'][number]): Verdict => {
  const lower = (s: string): string => s.trim().toLowerCase();
  return {
    n: r.n,
    voice: r.voice,
    faults: r.faults.map(lower).filter((f) => (FAULTS as readonly string[]).includes(f)),
    mode: (MODES as readonly string[]).includes(lower(r.mode)) ? (lower(r.mode) as Verdict['mode']) : undefined,
    move: (MOVES as readonly string[]).includes(lower(r.move)) ? lower(r.move) : 'other',
    tone: (TONES as readonly string[]).includes(lower(r.tone)) && lower(r.tone) !== 'neutral' ? lower(r.tone) : undefined,
    felt: isAppraisalTag(lower(r.felt)) ? lower(r.felt) : undefined,
    felt_i: r.felt_i,
    landed: r.landed,
    why: r.why === null ? null : r.why.slice(0, 100),
  };
};

interface Item {
  n: number;
  before: readonly Line[];
  his: string;
  hers: readonly string[];
  next: string | null;
}

const judgeBatch = async (model: ModelClient, batch: readonly Item[]): Promise<Verdict[]> => {
  const user = batch
    .map((it) =>
      [
        `#${it.n}`,
        ...it.before.slice(-1).map((l) => `(earlier) ${l.who}: ${l.text.slice(0, 200)}`),
        `him: ${it.his === '' ? '(nothing, she wrote first)' : it.his.slice(0, 600)}`,
        `her: ${it.hers.join(' / ').slice(0, MAX_CHARS)}`,
        `his next message: ${it.next ?? '(none)'}`,
      ].join('\n'),
    )
    .join('\n\n');
  const res = await model.chat({
    taskClass: 'appraisal',
    tier: 'cheap',
    messages: [
      { role: 'system', content: JUDGE_SYSTEM },
      { role: 'user', content: wellFormed(user) },
    ],
    schema: JudgeSchema,
    schemaName: 'Verdicts',
    maxTokens: 4000,
    temperature: 0.1,
  });
  return res.content.items.map(cleanVerdict);
};

const judgeAll = async (model: ModelClient, items: readonly Item[]): Promise<Map<number, Verdict>> => {
  const out = new Map<number, Verdict>();
  const batches: Item[][] = [];
  for (let i = 0; i < items.length; i += BATCH) batches.push(items.slice(i, i + BATCH));
  const total = batches.length;
  let done = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const b = batches.shift();
      if (b === undefined) return;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          for (const v of await judgeBatch(model, b)) out.set(v.n, v);
          break;
        } catch (e) {
          if (attempt === 2) log(`judge batch failed (#${b[0]?.n}..): ${e instanceof Error ? e.message.slice(0, 140) : String(e)}`);
        }
      }
      done += 1;
      if (done % 25 === 0) log(`judged ${done}/${total} batches`);
    }
  };
  await Promise.all(Array.from({ length: WORKERS }, () => worker()));
  return out;
};

const passes = (v: Verdict | undefined): boolean => v !== undefined && v.voice >= MIN_VOICE && v.faults.length === 0;

// ---------------------------------------------------------------------------
// setup
// ---------------------------------------------------------------------------
const setup = (): { model: ModelClient; embedder: ReturnType<typeof makeEmbedder> } => {
  const cfg = loadConfig(CONFIG, process.env);
  const clock = new SystemClock();
  const rng = makeRng('import-thea1-convos');
  const events = openEventLog(path.resolve('var', 'import-events'), { clock });
  const door: ResolvedDoor = cfg.models.doors.mind;
  const send = (k: string): ReturnType<typeof zaiTransport> =>
    zaiTransport({ apiKey: door.apiKey, endpoint: door.endpoint, protocol: door.protocol, clock, rng: rng.fork(k) });
  const model = createModelClient({
    log: events,
    clock,
    core: chatCore({
      router: makeRouter({ log: events, tiers: { main: door.model, cheap: door.model, reasoning: door.model }, doors: { voice: door, mind: door, judge: door } }),
      doors: { main: { door, send: send('m') }, cheap: { door, send: send('c') }, reasoning: { door, send: send('r') } },
    }),
  });
  const embedder = makeEmbedder(cfg.embedder, { baseUrl: cfg.models.endpoint, apiKey: cfg.models.apiKey });
  return { model, embedder };
};

const readPairs = (): Pair[] =>
  fs
    .readFileSync(PAIRS, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Pair);

const readLiveMoments = (): Moment[] =>
  fs
    .readFileSync(path.join(MIND, 'moments.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Moment);

/** Her replies already in her mind that could be echoed: the rescreen's subjects. */
const rescreenSubjects = (live: readonly Moment[]): Moment[] => live.filter((m) => isPrecedent(m) && m.gold !== true);

// ---------------------------------------------------------------------------
// stages
// ---------------------------------------------------------------------------
const pilot = async (): Promise<void> => {
  const { model } = setup();
  const pairs = readPairs();
  const screened = pairs.map((raw, n) => {
    const s = screen(raw);
    return { p: s.pair, n, why: s.why, unpetted: s.unpetted };
  });
  const open = screened.filter((s) => s.why === undefined);
  // seeded sample (deterministic): every k-th open exchange
  const step = Math.max(1, Math.floor(open.length / PILOT));
  const sample = open.filter((_, i) => i % step === 0).slice(0, PILOT);
  const verdicts = await judgeAll(
    model,
    sample.map(({ p, n }) => ({ n, before: p.before, his: p.his, hers: p.hers, next: p.next === null ? null : p.next.text.slice(0, 300) })),
  );
  const tally: Record<string, number> = {};
  for (const s of screened) if (s.why !== undefined) tally[s.why] = (tally[s.why] ?? 0) + 1;
  log(`pairs ${pairs.length} · screened out ${JSON.stringify(tally)} · open ${open.length} (pet name taken out of ${open.filter((s) => s.unpetted).length}) · pilot ${sample.length}`);
  const kept = sample.filter(({ n }) => passes(verdicts.get(n)));
  log(`pilot kept ${kept.length}/${sample.length} (min voice ${MIN_VOICE})`);
  const hist: Record<string, number> = {};
  for (const v of verdicts.values()) {
    hist[`v${v.voice}`] = (hist[`v${v.voice}`] ?? 0) + 1;
    for (const f of v.faults) hist[f] = (hist[f] ?? 0) + 1;
  }
  log(`verdicts ${JSON.stringify(hist)}`);
  for (const { p, n, unpetted } of sample) {
    const v = verdicts.get(n);
    log(`${passes(v) ? 'KEEP' : 'drop'}${unpetted ? '*' : ''} v${v?.voice ?? '?'} [${v?.faults.join(',') ?? '?'}] him: ${p.his.replace(/\n/g, ' ').slice(0, 90)} || her: ${p.hers.join(' / ').replace(/\n/g, ' ').slice(0, 220)}`);
  }
};

const judgeStage = async (): Promise<void> => {
  const { model, embedder } = setup();
  const pairs = readPairs();
  const live = readLiveMoments();
  // an unflagged moment she already has blocks a copy; a flagged one (the fork flagged
  // pet-name replies whole) does not: the cleaned exchange may come in beside it
  const have = new Set(live.filter((m) => m.flags === undefined || m.flags.length === 0).map((m) => norm(m.hers)));
  const seen = new Set<string>();
  const tally: Record<string, number> = {};
  const open: Array<{ p: Pair; n: number; unpetted: boolean }> = [];
  pairs.forEach((raw, n) => {
    const s = screen(raw);
    const p = s.pair;
    const why = s.why ?? (have.has(norm(p.hers)) || have.has(norm(raw.hers)) ? 'already_hers' : seen.has(norm(p.hers)) ? 'duplicate' : undefined);
    if (why !== undefined) {
      tally[why] = (tally[why] ?? 0) + 1;
      return;
    }
    seen.add(norm(p.hers));
    open.push({ p, n, unpetted: s.unpetted });
  });
  log(`pairs ${pairs.length} · screened out ${JSON.stringify(tally)} · to judge ${open.length} (pet name taken out of ${open.filter((o) => o.unpetted).length})`);

  const verdicts = await judgeAll(
    model,
    open.map(({ p, n }) => ({ n, before: p.before, his: p.his, hers: p.hers, next: p.next === null ? null : p.next.text.slice(0, 300) })),
  );
  const kept = open.filter(({ n }) => passes(verdicts.get(n)));
  log(`judged ${verdicts.size}/${open.length} · kept ${kept.length}`);

  // rescreen what she already has: the deterministic screens first (markdown, lists,
  // machinery), then the judge (ids offset past the pairs so the maps never collide)
  const subjects = rescreenSubjects(live);
  const rescreen: Record<string, string[]> = {};
  const toJudge: Moment[] = [];
  for (const m of subjects) {
    // a call is spoken (transcribed, capitalised): memory, not an example of how she texts
    if (m.his.startsWith('(on the call)')) {
      rescreen[m.id] = ['lowq', 'call'];
      continue;
    }
    const s = screen({ ts: m.ts, kind: m.kind === 'text_first' ? 'text_first' : 'reply', before: m.before, his: m.his, hers: m.hers, next: null, tools: [] });
    if (s.why !== undefined && s.why !== 'his_machinery') rescreen[m.id] = ['lowq', s.why];
    else toJudge.push(m);
  }
  const OFFSET = 1_000_000;
  const reVerdicts = await judgeAll(
    model,
    toJudge.map((m, k) => ({ n: OFFSET + k, before: m.before, his: m.his, hers: m.hers, next: m.outcome?.why ?? null })),
  );
  const audit: Array<{ id: string; source: string; voice?: number | undefined; faults?: string[] | undefined; flagged: boolean; her: string }> = [];
  toJudge.forEach((m, k) => {
    const v = reVerdicts.get(OFFSET + k);
    const flagged = v !== undefined && !passes(v);
    if (flagged) rescreen[m.id] = ['lowq', ...v.faults.slice(0, 3)];
    audit.push({ id: m.id, source: m.source, voice: v?.voice, faults: v?.faults, flagged, her: m.hers.join(' / ').slice(0, 300) });
  });
  fs.mkdirSync(STAGE_DIR, { recursive: true });
  fs.writeFileSync(path.join(STAGE_DIR, '..', 'oc-rescreen-audit.json'), JSON.stringify(audit, null, 1));
  const reBySource: Record<string, string> = {};
  for (const src of ['imported', 'lived'] as const) {
    const all = subjects.filter((m) => m.source === src);
    reBySource[src] = `${all.filter((m) => rescreen[m.id] !== undefined).length}/${all.length} flagged`;
  }
  log(`rescreen: ${JSON.stringify(reBySource)}`);

  // staging mind dir: the kept exchanges as moments, with vectors
  if (fs.existsSync(STAGE_DIR)) fs.rmSync(STAGE_DIR, { recursive: true, force: true });
  const stage = openMindStore(STAGE_DIR, embedder.dim);
  const moments = kept.map(({ p, n, unpetted }) => {
    const v = verdicts.get(n)!;
    const m: Moment = {
      id: `m_oc${unpetted ? 'u' : ''}_${p.ts}_${n}`,
      ts: p.ts,
      source: 'imported',
      kind: p.kind,
      before: p.before,
      his: p.his,
      hers: p.hers,
      move: v.move,
      tone: v.tone,
      ...(v.mode !== undefined ? { mode: v.mode } : {}),
      felt: v.felt !== undefined ? { sig: tagSignature(v.felt, v.felt_i), word: v.felt, source: 'estimated' } : { sig: new Array<number>(12).fill(0), source: 'estimated' },
      ...(v.landed !== null && p.next !== null ? { outcome: { landed: v.landed, why: v.why ?? '', at: p.ts + p.next.gapH * 3600_000 } } : {}),
      value: v.landed !== null ? Math.round((v.landed / 2) * 0.5 * 1000) / 1000 : 0,
      shown: 0,
      followed: 0,
    };
    return m;
  });
  const CHUNK = 64;
  const chunks: Moment[][] = [];
  for (let i = 0; i < moments.length; i += CHUNK) chunks.push(moments.slice(i, i + CHUNK));
  let embedded = 0;
  const embedWorker = async (): Promise<void> => {
    for (;;) {
      const chunk = chunks.shift();
      if (chunk === undefined) return;
      const vecs = await embedder.embed(chunk.flatMap((m) => [situationText(m.before, m.his), replyText(m.hers), m.his === '' ? '(silence)' : m.his]));
      chunk.forEach((m, k) => {
        const sit = vecs[k * 3];
        const reply = vecs[k * 3 + 1];
        const his = vecs[k * 3 + 2];
        stage.add(m, { ...(sit !== undefined ? { sit } : {}), ...(reply !== undefined ? { reply } : {}), ...(his !== undefined && m.his !== '' ? { his } : {}) });
      });
      embedded += chunk.length;
      if (embedded % 640 === 0) log(`embedded ${embedded}/${moments.length}`);
    }
  };
  await Promise.all([embedWorker(), embedWorker(), embedWorker()]);
  await stage.flush();
  fs.writeFileSync(path.join(STAGE_DIR, 'rescreen.json'), JSON.stringify(rescreen, null, 1));
  const summary = { at: new SystemClock().now().toISOString(), pairs: pairs.length, screenedOut: tally, judged: verdicts.size, kept: moments.length, keptUnpetted: moments.filter((m) => m.id.startsWith('m_ocu_')).length, minVoice: MIN_VOICE, rescreen: reBySource };
  fs.writeFileSync(path.join(STAGE_DIR, 'summary.json'), JSON.stringify(summary, null, 1));
  // a readable sample for the human eye: kept, and what was dropped
  const sample = (ok: boolean): string[] =>
    open
      .filter(({ n }) => passes(verdicts.get(n)) === ok)
      .filter((_, i) => i % 37 === 0)
      .slice(0, 60)
      .map(({ p, n }) => `v${verdicts.get(n)?.voice ?? '?'} [${verdicts.get(n)?.faults.join(',') ?? '?'}] him: ${p.his.replace(/\n/g, ' ').slice(0, 120)}\n    her: ${p.hers.join(' / ').replace(/\n/g, ' ').slice(0, 400)}`);
  fs.writeFileSync(path.join(STAGE_DIR, 'sample.txt'), `KEPT\n${sample(true).join('\n')}\n\nDROPPED\n${sample(false).join('\n')}\n`);
  log(`staged: ${JSON.stringify(summary)}`);
};

const mergeStage = async (): Promise<void> => {
  const active = spawnSync('systemctl', ['is-active', 'thea2'], { encoding: 'utf8' });
  if (active.stdout.trim() === 'active') throw new Error('thea2 is running: the mind has ONE writer. systemctl stop thea2 first.');
  const cfg = loadConfig(CONFIG, process.env);
  const dim = makeEmbedder(cfg.embedder, { baseUrl: cfg.models.endpoint, apiKey: cfg.models.apiKey }).dim;
  const rescreen = JSON.parse(fs.readFileSync(path.join(STAGE_DIR, 'rescreen.json'), 'utf8')) as Record<string, string[]>;
  fs.copyFileSync(path.join(MIND, 'moments.jsonl'), path.join(MIND, 'moments.jsonl.pre-oc'));
  const liveStore = openMindStore(MIND, dim);
  const stage = openMindStore(STAGE_DIR, dim);
  const have = new Set(liveStore.moments().map((m) => norm(m.hers)));
  let added = 0;
  for (const m of stage.moments()) {
    if (liveStore.get(m.id) !== undefined || have.has(norm(m.hers))) continue;
    liveStore.add({ ...m }, { sit: stage.sitVec(m.id), reply: stage.replyVec(m.id), his: stage.hisVec(m.id) });
    have.add(norm(m.hers));
    added += 1;
  }
  let flagged = 0;
  for (const [id, flags] of Object.entries(rescreen)) {
    const m = liveStore.get(id);
    if (m === undefined || m.gold === true || (m.flags !== undefined && m.flags.length > 0)) continue;
    liveStore.update(id, { flags });
    flagged += 1;
  }
  await liveStore.flush();
  const record = { at: new SystemClock().now().toISOString(), added, flagged, moments: liveStore.moments().length, precedents: liveStore.precedents().length, backup: 'moments.jsonl.pre-oc', stagedFrom: STAGE_DIR };
  fs.writeFileSync(path.join(MIND, 'import-oc.json'), JSON.stringify(record, null, 1));
  log(`merged: ${JSON.stringify(record)}`);
};

const main = async (): Promise<void> => {
  if (PILOT > 0) return pilot();
  if (STAGE === 'judge') return judgeStage();
  if (STAGE === 'merge') return mergeStage();
  throw new Error(`unknown --stage ${STAGE}`);
};

main().then(
  () => process.exit(0),
  (e) => {
    process.stderr.write(`import failed: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
    process.exit(1);
  },
);

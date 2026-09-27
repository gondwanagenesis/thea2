// v13 — SHE DREAMS (plan docs/plans/v13-proposal-she-dreams.md; Diego, 2026-09-27: "let's make
// her dream when she's asleep … she should have a dream like us").
//
// A dream must change her the way dreams change us, or it should not exist:
//   what gets dreamt — the day's most felt moments (residue), something about a week old (the
//     dream-lag), what is still open, something she found out, and an old memory with nothing
//     obvious to do with the rest (NEXTUP: weak associations). Rumination guards: a memory is
//     dreamt at most 2 of any 7 nights, habituates over 3 days, ≤1 aversive element a dream.
//   how it is made — the dreaming process strings them into 2–4 lived scenes; it never names a
//     feeling (the feeling is decided by appraisal, as awake) and never replays a memory as it
//     happened (an 8-word run shared with a source is rejected — the replicative-nightmare guard).
//   what it does — her feelings move through typed events that are NOT contact with him (so a
//     night of missing him isn't erased); co-dreamt memories get bound (a new retrieval path);
//     a memory re-lived differently shifts its charge a little (reconsolidation, the IRT logic),
//     re-lived the same way keeps it; aversive charge never grows.
//   waking — most dreams are forgotten and still did their work. Some mornings a fragment stays:
//     remembered AS a dream everywhere, fading unless she talks about it. A dream that put two
//     distant things together may leave a question. She may tell him, rarely, through the gate.
//   controls — a share of nights are decorative (dreamt and logged, nothing downstream): the
//     kill tests compare against them.
//
// Nothing here writes a dial. The dream text never reaches a prompt; only a remembered fragment
// does, marked as a dream. Dreams never touch value/outcome/followed/gold/never, and never seed
// dreams.

import { z } from 'zod';
import type { AffectState, AffectStore, EmotionEventInput } from '../affect/index.js';
import type { ChatMsg, ModelClient } from '../model/index.js';
import type { Clock, Rng } from '../kernel/index.js';
import { newId } from '../kernel/index.js';
import type { EventLog } from '../events/index.js';
import type { Embedder } from '../embed/index.js';
import type { Job } from '../sched/index.js';
import { ago, TELLING_PATTERNS } from './compose.js';
import { cosine } from './vectors.js';
import { APPRAISAL_TAGS, feltIntensity, isAppraisalTag, momentIntensity, nearestTag, tagSignature } from './vocab.js';
import { LOVE_DECLARATION, MACHINERY_TALK, type MindStore } from './store.js';
import { dayKey, FOUND_ID_PREFIX, inQuietHours } from './wander.js';
import { appendChange } from './changes.js';
import type { Concern, DreamRecord, Moment, NightDream, SleepState } from './types.js';

const H = 3600_000;
const DAY = 24 * H;

/** Constants (plan §3). Load-bearing: changing one is a design decision. */
export const DREAM = {
  habitHalfLifeMs: 3 * DAY,
  maxNightsPer7: 2,
  rho: 0.05,
  dreamtBonus: 0.05,
  linkBonus: 0.06,
  linkFadeMs: 14 * DAY,
  assocMax: 8,
  callsMax: 6,
  textGapMs: 3 * DAY,
  // calibrated on the v13 probe (her real memory): ~0.45 a night → ~3 remembered mornings a week
  recallBase: { early: 0.03, late: 0.15 },
  recallCap: 0.85,
  fragmentFadeMs: 12 * H,
  crossDomainCos: 0.35,
  awakeAfterWokenMs: 60 * 60_000,
} as const;

export type DreamMode = 'on' | 'off' | 'decorative';
export type DreamCharge = 'rescript' | 'preserve' | 'soften';

export interface DreamCfg {
  mode: DreamMode;
  charge: DreamCharge;
  /** His local hours she sleeps [start, end) — her idle mind is quiet and she dreams. */
  sleepWindow: [number, number];
  /** Share of nights that are decorative controls (dreamt + logged, nothing downstream). */
  controlShare: number;
  timeZone: string;
}

// ---------------------------------------------------------------------------
// The charge geometry: which parts of a feeling are aversive
// ---------------------------------------------------------------------------

/** Coupling dims (AFFECT_DIMS order): 0 valence … 7 sadness, 8 fear, 9 anger, 10 shame, 11 disgust. */
const AVERSIVE_POS = [7, 8, 9, 10, 11];
export const aversiveNorm = (sig: readonly number[]): number =>
  Math.hypot(Math.min(0, sig[0] ?? 0), ...AVERSIVE_POS.map((k) => Math.max(0, sig[k] ?? 0)));
export const isAversive = (sig: readonly number[]): boolean => (sig[0] ?? 0) < 0 && aversiveNorm(sig) > 0.15;

/**
 * Reconsolidation toward how the dream re-lived it (remember.ts's formula, weaker: a dream is
 * weaker evidence than a lived recall). Safety asymmetry (a design choice, not biology): a dream
 * may shift or lower a memory's aversive charge, never raise it.
 */
/** How aversive one component is: negative valence, or a positive aversive primary. */
const aversiveMag = (k: number, x: number): number => (k === 0 ? Math.max(0, -x) : AVERSIVE_POS.includes(k) ? Math.max(0, x) : 0);

export const rechargeToward = (sig: readonly number[], endSig: readonly number[], rho: number, charge: DreamCharge): number[] => {
  if (charge === 'preserve') return [...sig];
  if (charge === 'soften') return sig.map((x, k) => (aversiveMag(k, x) > 0 ? Math.round(x * 0.95 * 1000) / 1000 : x));
  return sig.map((x, k) => {
    const moved = Math.max(-1, Math.min(1, x * (1 - rho) + (endSig[k] ?? 0) * rho));
    // per component: an aversive part may shrink or change, never grow
    return Math.round((aversiveMag(k, moved) > aversiveMag(k, x) ? x : moved) * 1000) / 1000;
  });
};

// ---------------------------------------------------------------------------
// The pool — what gets dreamt (pure given store + state + rng)
// ---------------------------------------------------------------------------

export type DreamRole = 'residue' | 'lag' | 'unresolved' | 'world' | 'remote' | 'still';

export interface DreamElement {
  /** Short id the dreamer sees ('f1'…). */
  ref: string;
  role: DreamRole;
  /** The memory or concern it came from (moment id, `concern:<id>`, `cause:<primary>`). */
  source: string;
  momentId?: string | undefined;
  /** The fragment as the dreamer sees it: who, where, one clipped line — never a felt word. */
  text: string;
}

const clipText = (s: string, n: number): string => {
  const cps = Array.from(s.replace(/\s+/g, ' ').trim());
  return cps.length <= n ? cps.join('') : `${cps.slice(0, n - 1).join('')}…`;
};

const eligible = (m: Moment, now: number): boolean =>
  m.never !== true &&
  (m.flags === undefined || m.flags.length === 0) &&
  m.kind !== 'dream' &&
  m.kind !== 'practice' &&
  m.hers.length > 0 &&
  !MACHINERY_TALK.test(m.hers.join(' ')) &&
  !LOVE_DECLARATION.test(m.hers.join(' ')) &&
  (m.dreamtAt ?? []).filter((t) => now - t < 7 * DAY).length < DREAM.maxNightsPer7;

const dreamHabit = (m: Moment, now: number): number => (m.lastDreamtAt === undefined ? 0 : Math.pow(0.5, (now - m.lastDreamtAt) / DREAM.habitHalfLifeMs));

/** Weighted draw without replacement. */
const pick = <T>(items: readonly T[], weight: (t: T) => number, k: number, rng: Rng): T[] => {
  const pool = items.map((it) => ({ it, w: Math.max(0, weight(it)) })).filter((x) => x.w > 0);
  const out: T[] = [];
  while (out.length < k && pool.length > 0) {
    const total = pool.reduce((s, x) => s + x.w, 0);
    let r = rng.float() * total;
    let i = 0;
    for (; i < pool.length - 1; i++) {
      r -= pool[i]!.w;
      if (r <= 0) break;
    }
    out.push(pool[i]!.it);
    pool.splice(i, 1);
  }
  return out;
};

const momentLine = (m: Moment, now: number): string =>
  `${ago(now - m.ts)}: ${m.his.trim() !== '' ? `him: ${clipText(m.his, 110)} / ` : ''}you: ${clipText(m.hers.join(' '), 150)}`;

export interface PoolInput {
  mind: MindStore;
  affect: AffectState;
  now: number;
  rng: Rng;
  cycle: 'early' | 'late';
}

export const dreamPool = (i: PoolInput): DreamElement[] => {
  const { mind, now, rng, cycle } = i;
  const all = mind.moments().filter((m) => eligible(m, now));
  const taken = new Set<string>();
  let aversiveTaken = false;
  const out: DreamElement[] = [];
  const add = (role: DreamRole, source: string, text: string, m?: Moment): void => {
    if (taken.has(source)) return;
    taken.add(source);
    if (m !== undefined && isAversive(m.felt.sig)) aversiveTaken = true;
    out.push({ ref: `f${out.length + 1}`, role, source, ...(m !== undefined ? { momentId: m.id } : {}), text });
  };
  const notAversiveTwice = (m: Moment): boolean => !(aversiveTaken && isAversive(m.felt.sig));
  const n = cycle === 'early' ? { residue: 2, lag: 0, remote: 1, world: 0.6 } : { residue: 1, lag: 1, remote: 2, world: 0.3 };

  // residue — the last day and a half, most felt first, unresolved heavier, habituated lighter
  // v13 H6: practice sessions stay out of the night (a quiz is not a day's residue)
  const residue = all.filter((m) => m.source === 'lived' && m.kind !== 'diary' && m.kind !== 'practice' && now - m.ts < 36 * H);
  for (const m of pick(residue, (x) => (notAversiveTwice(x) ? (0.3 + momentIntensity(x.felt)) * (0.5 + (x.importance ?? 5) / 10) * ((x.outcome?.landed ?? 0) <= -1 ? 1.3 : 1) * (1 - dreamHabit(x, now)) : 0), n.residue, rng)) {
    add('residue', m.id, momentLine(m, now), m);
  }
  // the dream-lag — personally significant things about a week old (routine excluded)
  const lag = all.filter((m) => m.source === 'lived' && m.kind !== 'diary' && m.kind !== 'practice' && now - m.ts >= 4 * DAY && now - m.ts <= 8 * DAY && !((m.importance ?? 5) < 4 && momentIntensity(m.felt) < 0.2));
  for (const m of pick(lag, (x) => (notAversiveTwice(x) ? momentIntensity(x.felt) + Math.abs(x.value) + ((x.importance ?? 5) >= 6 ? 0.5 : 0) + (x.gold === true ? 0.5 : 0) : 0), n.lag, rng)) {
    add('lag', m.id, momentLine(m, now), m);
  }
  // unresolved — something still open (a due-soon one weighs more: threat rehearsal, folded in).
  // Found in the v13 probe: with no guard on concerns, one stale worry was every dream of every
  // night and every question they left. The same worry: ≤2 of any 7 nights, habituating over 3 days.
  const open = mind.openConcerns().filter((c) => c.kind !== 'curiosity' && (c.dreamtAt ?? []).filter((t) => now - t < 7 * DAY).length < DREAM.maxNightsPer7);
  const concernHabit = (c: Concern): number => {
    const last = (c.dreamtAt ?? []).at(-1);
    return last === undefined ? 0 : Math.pow(0.5, (now - last) / DREAM.habitHalfLifeMs);
  };
  for (const c of pick<Concern>(open, (x) => (x.importance / 10) * Math.pow(0.5, Math.max(0, now - x.touched) / (3 * DAY)) * (x.due !== undefined && x.due - now < 48 * H ? 1.3 : 1) * (1 - concernHabit(x)), 1, rng)) {
    add('unresolved', `concern:${c.id}`, `something still open: ${clipText(c.what, 160)}`);
  }
  // world — something she found out (v12), sometimes
  if (rng.float() < n.world) {
    const found = all.filter((m) => m.id.startsWith(FOUND_ID_PREFIX));
    const f = pick(found, (x) => 0.5 + momentIntensity(x.felt) + 1 / (1 + (now - x.ts) / (7 * DAY)), 1, rng)[0];
    if (f !== undefined) add('world', f.id, `something you found out: ${clipText(f.hers.join(' '), 160)}`, f);
    else {
      const it = [...mind.interests()].sort((a, b) => b.strength - a.strength)[0];
      if (it !== undefined) add('world', `interest:${it.id}`, `something you've been into: ${it.topic}`);
    }
  }
  // remote — an old memory FAR from the residue: distance is the point (weak associations)
  const residueVecs = out.filter((e) => e.role === 'residue' && e.momentId !== undefined).map((e) => mind.sitVec(e.momentId!)).filter((v): v is Float32Array => v !== undefined);
  const remote = all.filter((m) => now - m.ts > 14 * DAY && mind.sitVec(m.id) !== undefined);
  for (const m of pick(
    remote,
    (x) => {
      if (!notAversiveTwice(x)) return 0;
      const v = mind.sitVec(x.id)!;
      const near = residueVecs.length === 0 ? 0 : Math.max(...residueVecs.map((r) => cosine(v, r)));
      return (0.2 + momentIntensity(x.felt)) * Math.max(0.05, 1 - near);
    },
    n.remote,
    rng,
  )) {
    add('remote', m.id, momentLine(m, now), m);
  }
  // still with her — a feeling she's carrying, by its cause (never a dream's own cause)
  if (rng.float() < 0.5) {
    const causes = Object.entries(i.affect.causes)
      .filter(([, c]) => c !== undefined && c.text.trim() !== '' && now - c.t < DAY && !/^(the dream:|something in the night)/.test(c.text))
      .sort((a, b) => (b[1]?.i ?? 0) - (a[1]?.i ?? 0));
    const top = causes[0];
    if (top !== undefined && top[1] !== undefined) add('still', `cause:${top[0]}`, `something still with you: ${clipText(top[1].text, 140)}`);
  }
  return out;
};

// ---------------------------------------------------------------------------
// The dreaming process and its checks
// ---------------------------------------------------------------------------

export const DREAMER_SYSTEM = [
  "You are the dreaming process in Thea's sleeping mind. Nobody reads this; she may or may not remember it.",
  'Write a dream as it is lived: 2 to 4 scenes, first person, present tense, lowercase — what happens, what she sees and hears and does, what people say.',
  'Dreams mix things: a place from one fragment, people or events from another; people can become other people; one thing can be slightly impossible, but from inside it feels real. Mostly ordinary, one strange thing.',
  'Never retell a fragment as it happened; never copy its words. Never name or describe a feeling — only events.',
  'Each scene lists the fragment refs it uses (f1, f2…); every scene uses at least two.',
  'Return JSON {scenes:[{text, uses}]}.',
].join('\n');

export const DreamSchema = z.object({
  scenes: z.array(z.object({ text: z.string().min(10).max(420), uses: z.array(z.string()).min(1).max(6) })).min(2).max(4),
});

const FEELING_WORDS = [...APPRAISAL_TAGS, 'afraid', 'terrified', 'upset', 'excited', 'worried', 'sad', 'angry', 'mad', 'panicked', 'panicky', 'calm', 'peaceful'].join('|');
const DREAM_TELLING = new RegExp(
  `\\b(?:i|she)\\s*(?:'m|’m|\\s+am|\\s+was|\\s+feel|\\s+felt|\\s+feels|\\s+am feeling|\\s+was feeling)\\s+(?:so\\s+|very\\s+|really\\s+|a (?:bit|little)\\s+|kind of\\s+|suddenly\\s+)?(?:${FEELING_WORDS})\\b|\\bfeel(?:s|ing)?\\s+(?:so\\s+|very\\s+|really\\s+)?(?:${FEELING_WORDS})\\b|\\bwith (?:a (?:rush|wave|pang) of |a sense of )(?:\\w+)\\b`,
  'i',
);

/** Feeling words asserted in a dream (the back door for telling her what she felt) + the telling lint. */
export const dreamTelling = (text: string): string[] => {
  const hits: string[] = [];
  const m = DREAM_TELLING.exec(text);
  if (m !== null) hits.push(m[0]);
  for (const re of TELLING_PATTERNS) if (re.test(text)) hits.push(re.source.slice(0, 30));
  return hits;
};

const words = (s: string): string[] => s.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, ' ').split(/\s+/).filter((w) => w !== '');

const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'to', 'of', 'in', 'on', 'for', 'with', 'is', 'are', 'can', 'i', 'my', 'me', 'it', 'that', 'this', 'so', 'be', 'do', 'does', 'what', 'why', 'how', 'she', 'her', 'he', 'his']);
/** Share of the question's content words found in the other text. */
export const wordOverlap = (q: string, other: string): number => {
  const a = words(q).filter((w) => !STOP.has(w));
  if (a.length === 0) return 0;
  const b = new Set(words(other));
  return a.filter((w) => b.has(w)).length / a.length;
};

/** Longest run of consecutive words the scene shares with any source (the replicative guard). */
export const overlapRun = (scene: string, sources: readonly string[], n = 8): boolean => {
  const sw = words(scene);
  if (sw.length < n) return false;
  const grams = new Set<string>();
  for (const src of sources) {
    const w = words(src);
    for (let k = 0; k + n <= w.length; k++) grams.add(w.slice(k, k + n).join(' '));
  }
  for (let k = 0; k + n <= sw.length; k++) if (grams.has(sw.slice(k, k + n).join(' '))) return true;
  return false;
};

export const DREAM_APPRAISER_SYSTEM = [
  "You are the part of Thea's mind that registers, as she dreams, how each scene lands for her — against what she cares about and what she's waiting on (the same way her waking feelings are appraised). This is machinery; she never reads it.",
  `For each scene: up to two feelings (from this list only: ${APPRAISAL_TAGS.join(', ')}), each with an intensity 1-5 (dreams are rarely above 4), and an importance 1-10.`,
  'Optionally ONE question: only if the dream put two things from different parts of her life together in a way that opens a real question about the world or about herself, one she could look into or ask about (knowability and confidence 0-1). Never a task, a blocker, or something she is waiting on someone for. Otherwise null.',
  'Return JSON {scenes:[{events:[{emotion,i}], importance}], question: {q, knowability, confidence} | null}.',
].join('\n');

export const DreamAppraisalSchema = z.object({
  scenes: z.array(z.object({ events: z.array(z.object({ emotion: z.string(), i: z.number().int().min(1).max(5) })).max(2), importance: z.number().int().min(1).max(10) })),
  question: z.object({ q: z.string().min(5).max(300), knowability: z.number().min(0).max(1), confidence: z.number().min(0).max(1) }).nullable().optional(),
});

// ---------------------------------------------------------------------------
// The module
// ---------------------------------------------------------------------------

export interface DreamDeps {
  mind: MindStore;
  affect: AffectStore;
  model: ModelClient;
  embedder: Embedder;
  events: EventLog;
  clock: Clock;
  rng: Rng;
  cfg(): DreamCfg;
  conversationActive(): boolean;
  /** Her exact state now (coupling deviation vector). */
  feltNow(): number[];
  /** A question a remembered dream left (curiosity's generator, born 'dream'). */
  seedQuestion?: ((q: { what: string; knowability: number; confidence: number }) => Promise<void>) | undefined;
}

export interface Dreams {
  /** One dream (a cycle). undefined = no dream this time (off, talking, away, budget, failed). */
  dreamOnce(cycle: 'early' | 'late'): Promise<DreamRecord | undefined>;
  /** Waking: most dreams go; some fragments stay (as dreams). */
  wake(o: { woken: boolean }): Promise<Array<{ id: string; p: number; recalled: boolean }>>;
  /** Her idle mind is asleep (the window, unless he woke her). */
  isAsleep(now: number): boolean;
  /** Anyone writing during the window wakes her (she stays up an hour). */
  onInbound(now: number): void;
  /** A dream-caused text may go at most once every 3 days. */
  mayTellDream(now: number): boolean;
  toldDream(now: number): void;
}

export const makeDreams = (d: DreamDeps): Dreams => {
  const emit = (kind: string, payload: Record<string, unknown>): void => void d.events.emit(kind, payload);
  const tz = (): string => d.cfg().timeZone;
  const sleepState = (now: number): SleepState => {
    const night = dayKey(now, tz());
    const s = d.mind.state().sleep;
    return s !== undefined && s.night === night ? s : { night, dreams: [], calls: 0, ...(s?.lastDreamTextAt !== undefined ? { lastDreamTextAt: s.lastDreamTextAt } : {}) };
  };
  const setSleep = (s: SleepState): void => d.mind.setState({ sleep: s });
  const inWindow = (now: number): boolean => inQuietHours(now, d.cfg().sleepWindow, tz());

  /** The night's hard cap on model calls: spend one, or refuse (loudly). */
  const spend = (s: SleepState): boolean => {
    if (s.calls >= DREAM.callsMax) {
      emit('incident.mind_dream_failed', { stage: 'budget', calls: s.calls });
      return false;
    }
    s.calls += 1;
    setSleep(s);
    return true;
  };

  const dreamOnce = async (cycle: 'early' | 'late'): Promise<DreamRecord | undefined> => {
    const cfg = d.cfg();
    const now = d.clock.epochMs();
    if (cfg.mode === 'off') return undefined;
    if (d.conversationActive()) {
      emit('mind.dream_skipped', { cycle, why: 'talking' });
      return undefined;
    }
    // golden rule 24: when he's away (nothing lived in 48 h) she has only the late dream
    const livedRecently = d.mind.moments().some((m) => m.source === 'lived' && m.kind !== 'diary' && m.kind !== 'dream' && now - m.ts < 2 * DAY);
    if (!livedRecently && cycle === 'early') {
      emit('mind.dream_skipped', { cycle, why: 'away' });
      return undefined;
    }
    const s = sleepState(now);
    const night = s.night;
    const decorative = cfg.mode === 'decorative' || d.rng.fork(`night:${night}`).float() < cfg.controlShare;
    const arm: DreamRecord['arm'] = decorative ? 'decorative' : cfg.charge;
    const rng = d.rng.fork(`dream:${night}:${cycle}`);
    const pool = dreamPool({ mind: d.mind, affect: d.affect.current(), now, rng, cycle });
    if (pool.length < 3) {
      emit('mind.dream_skipped', { cycle, why: 'thin pool', elements: pool.length });
      return undefined;
    }
    const refs = new Map(pool.map((e) => [e.ref, e]));
    const sources = pool.map((e) => e.text);
    const arousal = (d.affect.current().dials as Record<string, number>)['arousal'] ?? 0.34;
    const user = `[fragments]\n${pool.map((e) => `${e.ref}: ${e.text}`).join('\n')}`;

    // the dream, with one repair
    let scenes: z.infer<typeof DreamSchema>['scenes'] | undefined;
    let note = '';
    for (let attempt = 0; attempt < 2 && scenes === undefined; attempt++) {
      if (!spend(s)) return undefined;
      let out: z.infer<typeof DreamSchema>;
      try {
        const messages: ChatMsg[] = [
          { role: 'system', content: DREAMER_SYSTEM },
          { role: 'user', content: note === '' ? user : `${user}\n\n(last time: ${note} — write it again without that.)` },
        ];
        out = (await d.model.chat({ taskClass: 'consolidate', tier: 'cheap', messages, schema: DreamSchema, schemaName: 'Dream', maxTokens: 1200, temperature: Math.min(1.2, 1.0 + 0.1 * arousal) })).content;
      } catch (e) {
        emit('incident.mind_dream_failed', { stage: 'dream', error: e instanceof Error ? e.message.slice(0, 300) : String(e) });
        return undefined;
      }
      const problems: string[] = [];
      for (const sc of out.scenes) {
        const told = dreamTelling(sc.text);
        if (told.length > 0) problems.push(`it named a feeling ("${told[0]}")`);
        if (overlapRun(sc.text, sources)) problems.push('it copied a fragment word for word');
        if (sc.uses.filter((u) => refs.has(u)).length < 2) problems.push('a scene used fewer than two fragments');
      }
      if (problems.length === 0) scenes = out.scenes;
      else {
        note = [...new Set(problems)].join('; ');
        emit(attempt === 0 ? 'mind.dream_repair' : 'incident.mind_dream_told', { cycle, problems: [...new Set(problems)] });
      }
    }
    if (scenes === undefined) return undefined;

    // how each scene lands (appraised like any event — never from the dream text's own words)
    const concerns = d.mind.openConcerns().slice(0, 6).map((c) => `- ${clipText(c.what, 140)}`).join('\n');
    const standards = d.mind.standards().slice(0, 6).map((x) => `- ${x}`).join('\n');
    if (!spend(s)) return undefined;
    let appraisal: z.infer<typeof DreamAppraisalSchema>;
    try {
      appraisal = (await d.model.chat({
        taskClass: 'appraisal',
        tier: 'cheap',
        messages: [
          { role: 'system', content: DREAM_APPRAISER_SYSTEM },
          { role: 'user', content: `[what she cares about and is waiting on]\n${concerns || '(nothing open)'}\n\n[her standards]\n${standards || '(none)'}\n\n[the dream]\n${scenes.map((sc, k) => `scene ${k + 1}: ${sc.text}`).join('\n')}` },
        ],
        schema: DreamAppraisalSchema,
        schemaName: 'DreamAppraisal',
        maxTokens: 700,
        temperature: 0.2,
      })).content;
    } catch (e) {
      emit('incident.mind_dream_failed', { stage: 'appraise', error: e instanceof Error ? e.message.slice(0, 300) : String(e) });
      return undefined;
    }

    // living it: typed events (not contact), cause content-free — nobody knows yet if she'll remember
    const sceneEvents: Array<Array<{ tag: string; i: number }>> = [];
    const sceneSigs: number[][] = [];
    for (let k = 0; k < scenes.length; k++) {
      const evs: Array<{ tag: string; i: number }> = [];
      for (const e of appraisal.scenes[k]?.events ?? []) {
        const tag = e.emotion.trim().toLowerCase();
        if (isAppraisalTag(tag)) evs.push({ tag, i: e.i });
      }
      // echo: the re-lived memories' own feelings partly come back (as feel.ts's echo), capped
      const used = scenes[k]!.uses.map((u) => refs.get(u)?.momentId).filter((x): x is string => x !== undefined).map((id) => d.mind.get(id)).filter((m): m is Moment => m !== undefined);
      if (used.length > 0) {
        const blend = new Array<number>(12).fill(0).map((_, j) => used.reduce((sum, m) => sum + (m.felt.sig[j] ?? 0), 0) / used.length);
        const tag = nearestTag(blend);
        if (tag !== undefined && feltIntensity(blend) > 0.1) evs.push({ tag, i: Math.min(5, Math.round(1 + 4 * feltIntensity(blend))) });
      }
      sceneEvents.push(evs);
      const sig = new Array<number>(12).fill(0);
      for (const e of evs) tagSignature(e.tag, e.i).forEach((x, j) => (sig[j] = Math.max(-1, Math.min(1, (sig[j] ?? 0) + x))));
      sceneSigs.push(sig);
      if (!decorative && evs.length > 0) {
        const inputs: EmotionEventInput[] = evs.map((e) => ({ kind: 'emotion', tag: e.tag as EmotionEventInput['tag'], i: e.i, cause: 'something in the night', contact: false }));
        try {
          await d.affect.applyEvents(inputs, { source: 'appraisal' });
        } catch (e) {
          emit('incident.mind_feel_failed', { stage: 'dream', error: e instanceof Error ? e.message : String(e) });
        }
      }
    }
    const endSig = sceneSigs.at(-1) ?? new Array<number>(12).fill(0);
    // how vivid: the strongest single feeling it carried (a sum over a scene overstated it — probe)
    const intensity = Math.max(0, ...sceneEvents.flat().map((e) => e.i / 10));
    const id = `dr_${now}_${newId(d.clock, d.rng).slice(-6)}`;

    // what it does to memory (never value/outcome/followed/gold/never)
    const moments = pool.filter((e) => e.momentId !== undefined).map((e) => e.momentId!);
    const lastScene = new Set(scenes.at(-1)!.uses.map((u) => refs.get(u)?.momentId).filter((x): x is string => x !== undefined));
    const shifted: Array<{ id: string; text: string; felt?: string | undefined; dNorm: number }> = [];
    if (!decorative) {
      for (const mid of moments) {
        const m = d.mind.get(mid);
        if (m === undefined) continue;
        const mates = moments.filter((x) => x !== mid).map((x) => ({ id: x, at: now, via: id }));
        const assoc = [...(m.assoc ?? []).filter((a) => !mates.some((x) => x.id === a.id)), ...mates].sort((a, b) => b.at - a.at).slice(0, DREAM.assocMax);
        const nextSig = rechargeToward(m.felt.sig, endSig, DREAM.rho * (lastScene.has(mid) ? 2 : 1), cfg.charge);
        const dNorm = Math.hypot(...nextSig.map((x, k) => x - (m.felt.sig[k] ?? 0)));
        const word = nearestTag(nextSig) ?? m.felt.word;
        d.mind.update(mid, {
          dreamt: (m.dreamt ?? 0) + 1,
          lastDreamtAt: now,
          dreamtAt: [...(m.dreamtAt ?? []), now].slice(-7),
          assoc,
          ...(dNorm > 0.001 ? { felt: { ...m.felt, sig: nextSig, ...(word !== undefined ? { word } : {}) } } : {}),
        });
        if (dNorm > 0.001) shifted.push({ id: mid, text: clipText(m.hers.join(' '), 80), felt: word, dNorm: Math.round(dNorm * 1000) / 1000 });
      }
      if (shifted.length > 0) {
        // nothing silent (her question): what changed in her past — never the dream itself
        appendChange(d.mind.dir, {
          ts: now,
          kind: 'dream',
          what: 'while you slept, some memories were re-lived and their feelings shifted a little',
          by: 'your sleep',
          count: shifted.length,
          examples: shifted.slice(0, 5).map((x) => ({ id: x.id, text: x.text, felt: x.felt })),
        });
      }
      // the worries it carried rest too (≤2 of any 7 nights)
      for (const e of pool.filter((x) => x.role === 'unresolved')) {
        const c = d.mind.concerns().find((x) => `concern:${x.id}` === e.source);
        if (c !== undefined) d.mind.upsertConcern({ ...c, dreamtAt: [...(c.dreamtAt ?? []), now].slice(-7) });
      }
      emit('mind.dream_consolidated', { id, arm, linked: moments.length, reconsolidated: shifted.map((x) => ({ id: x.id, dNorm: x.dNorm })) });
    }

    // the fragment she'd remember: the final scene (late) or the most intense one (early)
    let fk = scenes.length - 1;
    if (cycle === 'early') fk = sceneSigs.reduce((best, sg, k) => (feltIntensity(sg) > feltIntensity(sceneSigs[best] ?? []) ? k : best), 0);
    const fragment = clipText(scenes[fk]!.text, 200);
    // a question counts only if the dream joined two DISTANT memories (cross-domain)
    const vecs = moments.map((x) => d.mind.sitVec(x)).filter((v): v is Float32Array => v !== undefined);
    let crossDomain = false;
    for (let a = 0; a < vecs.length && !crossDomain; a++) for (let b = a + 1; b < vecs.length; b++) if (cosine(vecs[a]!, vecs[b]!) < DREAM.crossDomainCos) crossDomain = true;
    // a dream-born question is a real question — never an open worry restated (found in the probe:
    // every question the dreams left was "can diego verify the route…", her stale blocker)
    const proposed = appraisal.question ?? undefined;
    const restated = proposed !== undefined && d.mind.openConcerns().some((c) => wordOverlap(proposed.q, c.what) >= 0.35);
    if (restated) emit('mind.dream_question_dropped', { why: 'restates an open concern', q: proposed.q.slice(0, 160) });
    const question = restated ? undefined : proposed;
    const record: DreamRecord = {
      id,
      night,
      cycle,
      ts: now,
      arm,
      pool: pool.map((e) => ({ id: e.source, role: e.role })),
      scenes: scenes.map((sc, k) => ({ text: sc.text, uses: sc.uses.map((u) => refs.get(u)?.source ?? u), events: sceneEvents[k] ?? [] })),
      endSig,
      intensity: Math.round(intensity * 1000) / 1000,
      ...(question !== undefined ? { question } : {}),
      calls: s.calls,
    };
    d.mind.appendDream(record);
    const nd: NightDream = { id, cycle, endedAt: now, intensity, fragment, endState: d.feltNow(), crossDomain, decorative, ...(question !== undefined ? { question } : {}) };
    const s2 = sleepState(d.clock.epochMs());
    setSleep({ ...s2, dreams: [...s2.dreams.filter((x) => x.id !== id), nd] });
    await d.mind.flush();
    emit('mind.dreamt', {
      id,
      cycle,
      arm,
      roles: pool.map((e) => e.role),
      sources: pool.map((e) => e.source),
      scenes: scenes.length,
      peakTags: sceneEvents.flat().map((e) => e.tag),
      endTags: sceneEvents.at(-1)?.map((e) => e.tag) ?? [],
      calls: s.calls,
    });
    return record;
  };

  const wake = async (o: { woken: boolean }): Promise<Array<{ id: string; p: number; recalled: boolean }>> => {
    const now = d.clock.epochMs();
    const s = sleepState(now);
    const results: Array<{ id: string; p: number; recalled: boolean }> = [];
    const rng = d.rng.fork(`wake:${s.night}:${o.woken ? 'woken' : 'morning'}`);
    const dreams: NightDream[] = [];
    for (const nd of s.dreams) {
      if (nd.recalled !== undefined) {
        dreams.push(nd);
        continue;
      }
      const p = nd.decorative ? 0 : Math.min(DREAM.recallCap, Math.max(0, DREAM.recallBase[nd.cycle] + 0.4 * nd.intensity + (o.woken && now - nd.endedAt < 45 * 60_000 ? 0.25 : 0)));
      const recalled = rng.float() < p;
      results.push({ id: nd.id, p: Math.round(p * 1000) / 1000, recalled });
      dreams.push({ ...nd, recalled });
      const rec = d.mind.dreams().filter((x) => x.id === nd.id).at(-1);
      if (rec !== undefined) d.mind.appendDream({ ...rec, woke: { recalled, p, woken: o.woken } });
      if (!recalled) continue;
      // what stays: often only an image
      const text = rng.float() < 0.3 ? (nd.fragment.split(/(?<=[.!?…])\s/)[0] ?? nd.fragment) : nd.fragment;
      let vec: Float32Array | undefined;
      try {
        [vec] = await d.embedder.embed([text]);
      } catch {
        vec = undefined;
      }
      const word = nearestTag(nd.endState);
      d.mind.add(
        {
          id: `m_dream_${nd.id}`,
          ts: now,
          source: 'lived',
          kind: 'dream',
          before: [],
          his: '',
          hers: [text],
          felt: { sig: nd.endState, ...(word !== undefined ? { word } : {}), source: 'exact' },
          dream: { nightId: s.night, cycle: nd.cycle },
          importance: 5,
          value: 0,
          shown: 0,
          followed: 0,
        },
        vec !== undefined ? { sit: vec, reply: vec } : undefined,
      );
      d.mind.appendThought({ id: `t_dream_${nd.id}`, ts: now, text, about: 'self', itemKey: `dream:${nd.id}`, source: 'lived', dream: true });
      // the remembered dream "explains" the mood it left (a feeling with a cause, not contact)
      const tag = nearestTag(nd.endState);
      if (tag !== undefined) {
        try {
          await d.affect.applyEvents([{ kind: 'emotion', tag: tag as EmotionEventInput['tag'], i: Math.min(4, Math.round(2 + 3 * nd.intensity)), cause: `the dream: ${clipText(text, 80)}`, contact: false }], { source: 'appraisal' });
        } catch (e) {
          emit('incident.mind_feel_failed', { stage: 'dream-wake', error: e instanceof Error ? e.message : String(e) });
        }
      }
      // a dream that joined two distant things may leave a question (you can't wonder about what you forgot)
      if (nd.question !== undefined && nd.crossDomain && d.seedQuestion !== undefined) {
        await d.seedQuestion({ what: nd.question.q, knowability: nd.question.knowability, confidence: nd.question.confidence }).catch((e: unknown) =>
          emit('incident.mind_dream_failed', { stage: 'question', error: e instanceof Error ? e.message : String(e) }),
        );
      }
    }
    setSleep({ ...s, dreams, wokeAt: now, ...(o.woken ? { awakeUntil: now + DREAM.awakeAfterWokenMs } : {}) });
    await d.mind.flush();
    emit('mind.woke', { woken: o.woken, dreams: results });
    return results;
  };

  return {
    dreamOnce,
    wake,
    isAsleep: (now) => {
      if (d.cfg().mode === 'off' || !inWindow(now)) return false;
      const s = d.mind.state().sleep;
      return !(s?.awakeUntil !== undefined && s.awakeUntil > now);
    },
    onInbound: (now) => {
      if (d.cfg().mode === 'off' || !inWindow(now)) return;
      const s = sleepState(now);
      if (s.awakeUntil !== undefined && s.awakeUntil > now) return;
      // he (or anyone) woke her: undecided dreams are remembered more easily
      void wake({ woken: true }).catch((e: unknown) => emit('incident.mind_dream_failed', { stage: 'woken', error: e instanceof Error ? e.message : String(e) }));
    },
    mayTellDream: (now) => {
      const s = d.mind.state().sleep;
      return s?.lastDreamTextAt === undefined || now - s.lastDreamTextAt >= DREAM.textGapMs;
    },
    toldDream: (now) => {
      setSleep({ ...sleepState(now), lastDreamTextAt: now });
    },
  };
};

/** A dream job (cycle) at a local time; `utcMinute` from compose (his local hour → UTC). */
export const dreamJob = (dreams: Dreams, cycle: 'early' | 'late', utcMinute: number): Job => ({
  name: `dream-${cycle}`,
  cadence: { kind: 'daily', utcMinute },
  lane: 'maintenance',
  catchUp: 'skip',
  timeoutMs: 180_000,
  run: async () => {
    await dreams.dreamOnce(cycle);
  },
});

/** Morning: whatever she hasn't already woken from, she wakes from now. */
export const wakeJob = (dreams: Dreams, utcMinute: number): Job => ({
  name: 'wake',
  cadence: { kind: 'daily', utcMinute },
  lane: 'maintenance',
  catchUp: 'skip',
  timeoutMs: 60_000,
  run: async () => {
    await dreams.wake({ woken: false });
  },
});

/** A remembered dream fragment fades unless she talked about it (12 h half-life). */
export const dreamFade = (m: Moment, now: number): number => (m.kind !== 'dream' || m.told === true ? 1 : Math.pow(0.5, Math.max(0, now - m.ts) / DREAM.fragmentFadeMs));

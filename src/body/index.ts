// v9 body — composition: senses, voice and hands over one house. The mind
// reaches it only through the BodySeam it declares (mind never imports body),
// and app wires the two.

import type { Clock } from '../kernel/index.js';
import type { Channel, InboundMsg } from '../bridge/index.js';
import type { ToolRegistry } from '../loop/index.js';
import type { EventLog } from '../events/index.js';
import type { Embedder } from '../embed/index.js';
import type { MindStore } from '../mind/index.js';
import { openHouse, type House } from './house.js';
import { openAIBody, type OpenAIBody } from './openai.js';
import { nodeExec } from './exec.js';
import { makeSenses, type Senses } from './senses.js';
import { makeMouth, type Mouth } from './voice.js';
import { bodyTools, type TurnBodyCtx } from './tools.js';
import { tools2 } from './tools2.js';
import { makeFal, type Fal } from './fal.js';
import { makeCamera } from './camera.js';
import { makeJobs, type Jobs } from './jobs.js';
import { makeWallet, type Wallet } from './wallet.js';
import { makeReminders, type Reminders } from './reminders.js';
import { castTools } from './cast.js';
import { codeTools } from './code.js';
import { lifeTools, worldRoom } from './life.js';
import { browserTools } from './browser.js';
import { diegoLately } from './nightly.js';
import { loadWhere as loadWhereFile } from './where.js';
import type { AffectStore } from '../affect/index.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ModelClient } from '../model/index.js';
import type { Rng } from '../kernel/index.js';
import type { BodyCfg, BodySent, Exec, Perceived } from './types.js';

export * from './types.js';
export { openHouse, safeName, type House } from './house.js';
export { openAIBody, OpenAIBodyError, type OpenAIBody } from './openai.js';
export { nodeExec } from './exec.js';
export { makeSenses, howItSounds, PHOTO_PROMPT, FRAMES_PROMPT, LISTEN_PROMPT, FILE_OPENING_CHARS, type Senses } from './senses.js';
export { makeMouth, speakable, deliveryFor, type Mouth } from './voice.js';
export { bodyTools, REACTIONS, type TurnBodyCtx, type ToolDeps } from './tools.js';
export { tools2, type Tools2Deps } from './tools2.js';
export { locate, describeWhere, loadWhere, saveWhere } from './where.js';
export { readFileText, stripHtml } from './reading.js';
export { makeFal, FalError, type Fal } from './fal.js';
export { makeCamera, SHOTS, SIZES, IMAGE_MODEL, VIDEO_MODEL, THEA_LOOK, type Camera } from './camera.js';
export { makeJobs, MAX_LIVE_JOBS, type Jobs, type JobRecord } from './jobs.js';
export { makeWallet, PRICES, type Wallet, type Purse } from './wallet.js';
export { makeReminders, parseWhen, remindersJob, type Reminders, type Reminder } from './reminders.js';
export { braveSearch, fetchPage, assertPublicUrl, isPrivateAddress } from './web.js';
export { searchWords, searchMeaning, renderHit } from './remember-tools.js';
export { castTools, runWorker, castSlugs, WORKER_CLASSES } from './cast.js';
export { codeTools, runInSandbox, type CodeResult } from './code.js';
export { browserTools } from './browser.js';
export { lifeTools, CANDIES, leavePresent, sealInside, openInside, worldRoom, type Present } from './life.js';
export { nightlyJob, diaryOnce, diegoOnce, diegoLately, type DiegoModel } from './nightly.js';

export interface BodyDeps {
  cfg: BodyCfg;
  channel: Channel;
  clock: Clock;
  events: EventLog;
  ownerChatId: number;
  timeZone: string;
  mood(): { arousal: number; pleasure: number } | undefined;
  recordOutbound(turnId: string, msgId: number, text: string): Promise<void>;
  mind?: MindStore | undefined;
  embedder?: Embedder | undefined;
  exec?: Exec | undefined;
  openai?: OpenAIBody | undefined;
  fal?: Fal | undefined;
  fetchImpl?: typeof fetch | undefined;
  /** Casting: the model client (read late — built after the body), an rng, and the recent conversation. */
  model?: (() => ModelClient) | undefined;
  rng?: Rng | undefined;
  recent?: (() => Array<{ who: 'him' | 'her'; text: string }>) | undefined;
  /** The code sandbox broker's socket (default: <var>/run/exec.sock). */
  execSock?: string | undefined;
  /** Candy and presents act on her feelings through the engine (never as words). */
  affect?: AffectStore | undefined;
  /** Her browser service (deploy/browser); absent = no browser tool. */
  browserUrl?: string | undefined;
}

/** Bound after the pipeline exists (it needs the body first). */
export interface BodyLate {
  remember(text: string, turnId: string): void;
  selfEntry(goal: string): void;
}

export interface Body {
  readonly house: House;
  readonly senses: Senses;
  readonly mouth: Mouth;
  readonly jobs: Jobs;
  readonly wallet: Wallet;
  readonly reminders: Reminders;
  /** Registers her tools; returns their names. */
  register(registry: ToolRegistry): string[];
  bind(late: BodyLate): void;
  // ——— the seam the mind pipeline calls (structurally its BodySeam) ———
  perceive(m: InboundMsg): Promise<Perceived>;
  begin(turnId: string, ctx: { chatId: number; inboundMsgId?: number | undefined; text?: string | undefined }): void;
  end(turnId: string): BodySent[];
  speak(chatId: number, text: string, turnId: string, replyTo?: number | undefined): Promise<{ msgId: number } | undefined>;
  /** His time zone from the last location he shared (fresh within 3 days). */
  hisTimeZone(): string | undefined;
  onSkipped(m: InboundMsg): void;
  /** Facts about her world and him for [now]: her room, him lately (cited). */
  worldFacts(now: number): string[];
  /** How a settled job landed, in words for her memory (undefined while running / unknown). */
  jobOutcome(jobId: string): string | undefined;
  /** Her own skill note closest in meaning to his message (cosine ≥ 0.35), if any. */
  skillFor(text: string): Promise<{ name: string; note: string } | undefined>;
}

const outcomeWords = (job: { status: string; result?: string | undefined }): string =>
  job.status === 'done' ? (/^sent /.test(job.result ?? '') ? 'it arrived' : 'made it') : `it didn't come out (${(job.result ?? '').slice(0, 60)})`;

export const makeBody = (d: BodyDeps): Body => {
  const house = openHouse(d.cfg.dir);
  const exec = d.exec ?? nodeExec;
  const openai = d.openai ?? openAIBody(d.cfg, d.fetchImpl);
  const senses = makeSenses({ openai, exec, house, channel: d.channel, clock: d.clock, fetchImpl: d.fetchImpl });
  const mouth = makeMouth({ openai, exec, house, channel: d.channel, clock: d.clock });
  const turns = new Map<string, TurnBodyCtx>();
  /** Skill notes embedded once per file version (mtime). */
  const skillVecs = new Map<string, { mtime: number; vec: Float32Array; note: string }>();
  const cos = (a: Float32Array, b: Float32Array): number => {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length && i < b.length; i++) {
      dot += a[i]! * b[i]!;
      na += a[i]! * a[i]!;
      nb += b[i]! * b[i]!;
    }
    return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
  };
  let late: BodyLate | undefined;
  const wallet = makeWallet(house, d.clock, d.cfg.walletMonthUsd);
  const reminders = makeReminders(house);
  const jobs = makeJobs({
    clock: d.clock,
    events: d.events,
    onFail: (job, error) => late?.selfEntry(`(the ${job.kind} you were making didn't come out: ${error.slice(0, 160)}. he may still be waiting for it.)`),
    // how the work landed goes back into the memory of the moment she started it
    // (if that moment is already written; otherwise the pipeline asks jobOutcome when it writes it)
    onSettle: (job) => {
      const mind = d.mind;
      if (mind === undefined) return;
      const m = mind.moments().find((x) => x.acts?.some((a) => a.job === job.id) === true);
      if (m === undefined || m.acts === undefined) return;
      const landed = outcomeWords(job);
      mind.update(m.id, { acts: m.acts.map((a) => (a.job === job.id ? { ...a, result: landed } : a)) });
      void mind.flush();
    },
  });
  const fal = d.fal ?? (d.cfg.falKey !== undefined ? makeFal(d.cfg.falKey, d.clock, d.fetchImpl) : undefined);
  const camera = fal !== undefined ? makeCamera({ fal, house, clock: d.clock }) : undefined;

  return {
    house,
    senses,
    mouth,
    jobs,
    wallet,
    reminders,
    bind: (l) => {
      late = l;
    },
    register: (registry) => {
      const turn = (id: string): TurnBodyCtx | undefined => turns.get(id);
      const tools = [
        ...bodyTools({ channel: d.channel, house, openai, mouth, clock: d.clock, ownerChatId: d.ownerChatId, turn, mood: d.mood, recordOutbound: d.recordOutbound }),
        ...tools2({
          channel: d.channel,
          house,
          clock: d.clock,
          exec,
          ownerChatId: d.ownerChatId,
          timeZone: d.timeZone,
          turn,
          recordOutbound: d.recordOutbound,
          remember: (text, turnId) => late?.remember(text, turnId),
          camera,
          jobs,
          wallet,
          reminders,
          braveKey: d.cfg.braveKey,
          mind: d.mind,
          embedder: d.embedder,
          fetchImpl: d.fetchImpl,
        }),
      ];
      tools.push(...lifeTools({ house, clock: d.clock, affect: d.affect, presentKey: d.cfg.presentKey }));
      if (d.browserUrl !== undefined) tools.push(...browserTools(d.browserUrl, d.fetchImpl));
      // run_code talks to the thea2-exec broker's socket beside her var (deploy/exec-broker.mjs).
      tools.push(...codeTools(d.execSock ?? path.join(path.dirname(house.root), 'run', 'exec.sock')));
      if (d.model !== undefined && d.rng !== undefined) {
        const model = d.model;
        tools.push(
          ...castTools({
            house,
            clock: d.clock,
            rng: d.rng,
            jobs,
            model,
            registry: () => registry,
            selfLines: () => (d.mind?.self() ?? []).map((l) => l.text),
            recent: (turnId) => {
              const lines = d.recent?.() ?? [];
              const now = turns.get(turnId)?.text;
              return now !== undefined && now !== '' ? [...lines, { who: 'him' as const, text: now }] : lines;
            },
            selfEntry: (goal) => late?.selfEntry(goal),
          }),
        );
      }
      for (const t of tools) registry.register(t);
      return tools.map((t) => t.def.name);
    },
    perceive: async (m) => {
      const p = await senses.perceive(m);
      if (p.trace.length > 0) void d.events.emit('body.sensed', { updateId: m.updateId, media: m.media?.kind ?? null, voice: p.voice, trace: p.trace });
      return p;
    },
    begin: (turnId, ctx) => {
      turns.set(turnId, { chatId: ctx.chatId, ...(ctx.inboundMsgId !== undefined ? { inboundMsgId: ctx.inboundMsgId } : {}), ...(ctx.text !== undefined ? { text: ctx.text } : {}), sent: [] });
    },
    end: (turnId) => {
      const t = turns.get(turnId);
      turns.delete(turnId);
      return t?.sent ?? [];
    },
    hisTimeZone: () => {
      const w = loadWhereFile(house);
      return w !== undefined && w.timeZone !== undefined && d.clock.epochMs() - w.at < 3 * 86_400_000 ? w.timeZone : undefined;
    },
    speak: async (chatId, text, turnId, replyTo) => {
      try {
        const r = await mouth.say(chatId, text, d.mood(), replyTo !== undefined ? { replyTo } : undefined);
        void d.events.emit('body.spoke', { turnId, seconds: r.seconds ?? null, chars: text.length }, turnId);
        return { msgId: r.msgId };
      } catch (e) {
        void d.events.emit('incident.body_voice_failed', { turnId, error: e instanceof Error ? e.message.slice(0, 300) : String(e) }, turnId);
        return undefined;
      }
    },
    skillFor: async (text) => {
      const embedder = d.embedder;
      const dir = house.resolve('skills');
      if (embedder === undefined || dir === undefined || text.trim() === '') return undefined;
      if (!fs.existsSync(dir)) return undefined;
      const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
      if (files.length === 0) return undefined;
      const stale = files.filter((f) => skillVecs.get(f)?.mtime !== fs.statSync(`${dir}/${f}`).mtimeMs);
      if (stale.length > 0) {
        const notes = stale.map((f) => fs.readFileSync(`${dir}/${f}`, 'utf8'));
        const vecs = await embedder.embed(notes.map((n, i) => `${stale[i]!.replace(/\.md$/, '').replace(/-/g, ' ')}: ${n.slice(0, 800)}`));
        stale.forEach((f, i) => {
          const v = vecs[i];
          if (v !== undefined) skillVecs.set(f, { mtime: fs.statSync(`${dir}/${f}`).mtimeMs, vec: v, note: notes[i]! });
        });
      }
      const [q] = await embedder.embed([text.slice(0, 600)]);
      if (q === undefined) return undefined;
      let best: { f: string; s: number } | undefined;
      for (const f of files) {
        const e = skillVecs.get(f);
        if (e === undefined) continue;
        const s = cos(q, e.vec);
        if (best === undefined || s > best.s) best = { f, s };
      }
      if (best === undefined || best.s < 0.35) return undefined;
      return { name: best.f.replace(/\.md$/, ''), note: skillVecs.get(best.f)!.note.slice(0, 900) };
    },
    jobOutcome: (jobId) => {
      const j = jobs.list().find((x) => x.id === jobId);
      return j === undefined || j.status === 'running' ? undefined : outcomeWords(j);
    },
    worldFacts: (now) => {
      const facts: string[] = [];
      const room = worldRoom(house);
      if (room !== undefined) {
        const name = room.name.toLowerCase();
        facts.push(`you're in ${/^(my|the|your|her)\b/.test(name) ? name.replace(/^my\b/, 'your') : `the ${name}`}.`);
      }
      const lately = diegoLately(house, now);
      if (lately.length > 0) facts.push(`him lately: ${lately.join(' · ')}`);
      return facts;
    },
    onSkipped: (m) => {
      if (m.skipped?.reason === 'poll_answer' && m.media?.kind === 'poll_answer') {
        const poll = house.readJson<Record<string, { question: string; options: string[] }>>('polls.json', {})[m.media.pollId];
        const chosen = poll === undefined ? [] : m.media.optionIds.map((i) => poll.options[i]).filter((o): o is string => o !== undefined);
        void d.events.emit('body.poll_answer', { pollId: m.media.pollId, chosen });
        if (poll !== undefined) late?.selfEntry(chosen.length > 0 ? `(he answered your poll "${poll.question}": ${chosen.join(', ')})` : `(he took back his vote on your poll "${poll.question}")`);
        return;
      }
      if (m.skipped?.reason === 'live_location') {
        void senses.whereUpdate(m).then((w) => {
          if (w !== undefined) void d.events.emit('body.where', { place: w.place, live: true });
        });
      }
    },
  };
};

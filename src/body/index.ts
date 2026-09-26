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
import type { AffectStore } from '../affect/index.js';
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
  speak(chatId: number, text: string, turnId: string): Promise<{ msgId: number } | undefined>;
  onSkipped(m: InboundMsg): void;
  /** Facts about her world and him for [now]: her room, him lately (cited). */
  worldFacts(now: number): string[];
}

export const makeBody = (d: BodyDeps): Body => {
  const house = openHouse(d.cfg.dir);
  const exec = d.exec ?? nodeExec;
  const openai = d.openai ?? openAIBody(d.cfg, d.fetchImpl);
  const senses = makeSenses({ openai, exec, house, channel: d.channel, clock: d.clock, fetchImpl: d.fetchImpl });
  const mouth = makeMouth({ openai, exec, house, channel: d.channel, clock: d.clock });
  const turns = new Map<string, TurnBodyCtx>();
  let late: BodyLate | undefined;
  const wallet = makeWallet(house, d.clock, d.cfg.walletMonthUsd);
  const reminders = makeReminders(house);
  const jobs = makeJobs({
    clock: d.clock,
    events: d.events,
    onFail: (job, error) => late?.selfEntry(`(the ${job.kind} you were making didn't come out: ${error.slice(0, 160)}. he may still be waiting for it.)`),
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
    speak: async (chatId, text, turnId) => {
      try {
        const r = await mouth.say(chatId, text, d.mood());
        void d.events.emit('body.spoke', { turnId, seconds: r.seconds ?? null, chars: text.length }, turnId);
        return { msgId: r.msgId };
      } catch (e) {
        void d.events.emit('incident.body_voice_failed', { turnId, error: e instanceof Error ? e.message.slice(0, 300) : String(e) }, turnId);
        return undefined;
      }
    },
    worldFacts: (now) => {
      const facts: string[] = [];
      const room = worldRoom(house);
      if (room !== undefined) facts.push(`you're in the ${room.name.toLowerCase()}.`);
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

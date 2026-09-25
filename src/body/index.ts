// v9 body — composition: senses, voice and hands over one house. The mind
// reaches it only through the BodySeam it declares (mind never imports body),
// and app wires the two.

import type { Clock } from '../kernel/index.js';
import type { Channel, InboundMsg } from '../bridge/index.js';
import type { ToolRegistry } from '../loop/index.js';
import type { EventLog } from '../events/index.js';
import { openHouse, type House } from './house.js';
import { openAIBody, type OpenAIBody } from './openai.js';
import { nodeExec } from './exec.js';
import { makeSenses, type Senses } from './senses.js';
import { makeMouth, type Mouth } from './voice.js';
import { bodyTools, type TurnBodyCtx } from './tools.js';
import type { BodyCfg, BodySent, Exec, Perceived } from './types.js';

export * from './types.js';
export { openHouse, safeName, type House } from './house.js';
export { openAIBody, OpenAIBodyError, type OpenAIBody } from './openai.js';
export { nodeExec } from './exec.js';
export { makeSenses, howItSounds, PHOTO_PROMPT, FRAMES_PROMPT, LISTEN_PROMPT, FILE_OPENING_CHARS, type Senses } from './senses.js';
export { makeMouth, speakable, deliveryFor, type Mouth } from './voice.js';
export { bodyTools, REACTIONS, type TurnBodyCtx, type ToolDeps } from './tools.js';
export { locate, describeWhere, loadWhere, saveWhere } from './where.js';
export { readFileText, stripHtml } from './reading.js';

export interface BodyDeps {
  cfg: BodyCfg;
  channel: Channel;
  clock: Clock;
  events: EventLog;
  ownerChatId: number;
  mood(): { arousal: number; pleasure: number } | undefined;
  recordOutbound(turnId: string, msgId: number, text: string): Promise<void>;
  exec?: Exec | undefined;
  openai?: OpenAIBody | undefined;
  fetchImpl?: typeof fetch | undefined;
}

export interface Body {
  readonly house: House;
  readonly senses: Senses;
  readonly mouth: Mouth;
  /** Registers her tools; returns their names. */
  register(registry: ToolRegistry): string[];
  // ——— the seam the mind pipeline calls (structurally its BodySeam) ———
  perceive(m: InboundMsg): Promise<Perceived>;
  begin(turnId: string, ctx: { chatId: number; inboundMsgId?: number | undefined }): void;
  end(turnId: string): BodySent[];
  speak(chatId: number, text: string, turnId: string): Promise<{ msgId: number } | undefined>;
  onSkipped(m: InboundMsg): void;
}

export const makeBody = (d: BodyDeps): Body => {
  const house = openHouse(d.cfg.dir);
  const exec = d.exec ?? nodeExec;
  const openai = d.openai ?? openAIBody(d.cfg, d.fetchImpl);
  const senses = makeSenses({ openai, exec, house, channel: d.channel, clock: d.clock, fetchImpl: d.fetchImpl });
  const mouth = makeMouth({ openai, exec, house, channel: d.channel, clock: d.clock });
  const turns = new Map<string, TurnBodyCtx>();

  return {
    house,
    senses,
    mouth,
    register: (registry) => {
      const tools = bodyTools({
        channel: d.channel,
        house,
        openai,
        mouth,
        clock: d.clock,
        ownerChatId: d.ownerChatId,
        turn: (id) => turns.get(id),
        mood: d.mood,
        recordOutbound: d.recordOutbound,
      });
      for (const t of tools) registry.register(t);
      return tools.map((t) => t.def.name);
    },
    perceive: async (m) => {
      const p = await senses.perceive(m);
      if (p.trace.length > 0) void d.events.emit('body.sensed', { updateId: m.updateId, media: m.media?.kind ?? null, voice: p.voice, trace: p.trace });
      return p;
    },
    begin: (turnId, ctx) => {
      turns.set(turnId, { chatId: ctx.chatId, ...(ctx.inboundMsgId !== undefined ? { inboundMsgId: ctx.inboundMsgId } : {}), sent: [] });
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
    onSkipped: (m) => {
      if (m.skipped?.reason === 'live_location') {
        void senses.whereUpdate(m).then((w) => {
          if (w !== undefined) void d.events.emit('body.where', { place: w.place, live: true });
        });
      }
    },
  };
};

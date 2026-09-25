// v9 body — her voice. Words she already chose, spoken and sent as a Telegram
// voice note. Delivery follows her body the way pacing does in realize: the
// arousal/pleasure dials shape pace and warmth. That is expression, not a
// telling — the voice actor is told how to sound; she is told nothing.

import * as fs from 'node:fs';
import type { Clock } from '../kernel/index.js';
import type { Channel } from '../bridge/index.js';
import type { OpenAIBody } from './openai.js';
import type { Exec } from './types.js';
import type { House } from './house.js';
import { durationOf } from './media.js';

export interface Mouth {
  /** Speak and send; returns the voice note's msgId and the words it carried. */
  say(chatId: number, text: string, mood?: { arousal: number; pleasure: number } | undefined, opts?: { replyTo?: number | undefined }): Promise<{ msgId: number; seconds?: number | undefined }>;
}

/** Emoji and markdown read badly aloud; bubbles become short pauses. */
export const speakable = (text: string): string =>
  text
    .replace(/\p{Extended_Pictographic}(‍\p{Extended_Pictographic})*️?/gu, ' ')
    .replace(/[*_`~]+/g, '')
    .replace(/https?:\/\/\S+/g, 'a link')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();

export const deliveryFor = (mood?: { arousal: number; pleasure: number } | undefined): string => {
  const base = 'A young woman sending a casual voice note to someone she is close to: natural, intimate, unperformed, like talking into her phone.';
  if (mood === undefined) return base;
  const pace = mood.arousal > 0.62 ? 'Quick and lively.' : mood.arousal < 0.3 ? 'Slow and unhurried, a little low.' : 'Easy natural pace.';
  const tone = mood.pleasure > 0.66 ? 'Warm, a smile in the voice.' : mood.pleasure < 0.34 ? 'Quiet, a little subdued.' : 'Relaxed.';
  return `${base} ${pace} ${tone}`;
};

export const makeMouth = (d: { openai: OpenAIBody; exec: Exec; house: House; channel: Channel; clock: Clock }): Mouth => ({
  say: async (chatId, text, mood, opts) => {
    const body = d.channel.body;
    if (body === undefined) throw new Error('this channel cannot send voice notes');
    const words = speakable(text);
    if (words === '') throw new Error('nothing speakable in that text');
    await body.action(chatId, 'record_voice').catch(() => undefined);
    const ogg = await d.openai.speak(words, deliveryFor(mood));
    const stamp = d.clock.epochMs();
    const file = d.house.save('out', 'voice.ogg', ogg, stamp);
    const seconds = await durationOf(d.exec, file).catch(() => undefined);
    const sent = await body.sendMedia(
      chatId,
      { kind: 'voice', bytes: new Uint8Array(fs.readFileSync(file)), filename: 'voice.ogg', mime: 'audio/ogg', ...(seconds !== undefined ? { durationSec: seconds } : {}) },
      opts,
    );
    return { msgId: sent.msgId, ...(seconds !== undefined ? { seconds } : {}) };
  },
});

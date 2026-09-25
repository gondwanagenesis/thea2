// M15 bridge — FakeChannel, the hermetic Channel double (TESTING.md). It is a
// real test double with conformance duties, not a stub: it ENFORCES the real
// ChannelLimits, so a send inside the 1.1s gap or over the char cap is red in
// CI instead of a 429 in prod. msgIds are assigned deterministically and time
// comes from the injected clock, so M14's exact-timeline tests stay exact.

import type { Clock } from '../kernel/index.js';
import { SystemClock } from '../kernel/index.js';
import { BridgeError } from './errors.js';
import {
  TELEGRAM_LIMITS,
  type Channel,
  type ChannelBody,
  type ChannelLimits,
  type ChatAction,
  type InboundMsg,
  type OutboundMedia,
  type SpeakerRef,
} from './types.js';

export interface FakeChannelOpts {
  /** Merged over TELEGRAM_LIMITS — tighten freely in tests, never loosen the real values silently. */
  limits?: Partial<ChannelLimits> | undefined;
  clock?: Clock | undefined;
  /** Chat used for injected reactions (queueInbound messages carry their own). */
  chatId?: number | undefined;
  /** Speaker stamped onto injected reactions. */
  reactionSpeaker?: SpeakerRef | undefined;
  /** v9: bytes fetchFile returns per file id (a missing id is a download failure). */
  files?: Record<string, Uint8Array> | undefined;
  /** v9: false = a text-only channel (no body), the pre-v9 shape. */
  body?: boolean | undefined;
}

/** v9: one captured non-text act (media, reaction, poll, quoted reply, chat action). */
export type CapturedBodyAct =
  | { kind: 'media'; chatId: number; media: Omit<OutboundMedia, 'bytes'> & { size: number }; replyTo?: number | undefined; msgId: number; at: number }
  | { kind: 'reply'; chatId: number; text: string; replyTo: number; msgId: number; at: number }
  | { kind: 'react'; chatId: number; msgId: number; emoji: string; at: number }
  | { kind: 'poll'; chatId: number; question: string; options: string[]; msgId: number; at: number }
  | { kind: 'action'; chatId: number; action: ChatAction; at: number };

export interface CapturedSend {
  chatId: number;
  text: string;
  msgId: number;
  at: number;
}

export interface CapturedTyping {
  chatId: number;
  at: number;
}

export interface FakeChannelExtras {
  /** Scriptable inbound: what the queue holds is what updates() yields, byte for byte. */
  queueInbound(m: InboundMsg): void;
  /** Captured outbound, in send order. */
  outbound(): CapturedSend[];
  /** Synthesizes a reaction update from her — the free outcome signal M09 credits on. */
  injectReaction(r: { emoji: string; toMsgId: number }): void;
  /** Captured typing actions, in order — M14 asserts the 4s re-fire cadence against these. */
  typings(): CapturedTyping[];
  /** Queue depth: how many inbound updates updates() has not yet yielded. */
  pending(): number;
  /** v9: captured media / reactions / polls / quoted replies / chat actions, in order. */
  bodyActs(): CapturedBodyAct[];
}

export const FAKE_FIRST_MSG_ID = 1000;

export const FakeChannel = (opts: FakeChannelOpts = {}): Channel & FakeChannelExtras => {
  const limits: ChannelLimits = { ...TELEGRAM_LIMITS, ...opts.limits };
  const clock = opts.clock ?? new SystemClock();
  const chatId = opts.chatId ?? 0;
  const reactionSpeaker: SpeakerRef = opts.reactionSpeaker ?? { person: 'fake-user', channel: 'fake' };

  const queue: InboundMsg[] = [];
  const sends: CapturedSend[] = [];
  const typingLog: CapturedTyping[] = [];
  const lastSendAt = new Map<number, number>();
  const waiters: Array<() => void> = [];
  let nextMsgId = FAKE_FIRST_MSG_ID;
  let nextUpdateId = 1;
  const acts: CapturedBodyAct[] = [];
  const files = opts.files ?? {};
  const body: ChannelBody = {
    fetchFile: async (fileId) => {
      const bytes = files[fileId];
      if (bytes === undefined) throw new BridgeError('bridge/telegram-error', `getFile: no file ${fileId}`);
      return { bytes, path: `fake/${fileId}` };
    },
    sendMedia: async (to, m, o) => {
      const msgId = nextMsgId++;
      const { bytes, ...rest } = m;
      acts.push({ kind: 'media', chatId: to, media: { ...rest, size: bytes.length }, replyTo: o?.replyTo, msgId, at: clock.epochMs() });
      return { msgId };
    },
    sendReply: async (to, text, replyTo) => {
      const msgId = nextMsgId++;
      sends.push({ chatId: to, text, msgId, at: clock.epochMs() });
      acts.push({ kind: 'reply', chatId: to, text, replyTo, msgId, at: clock.epochMs() });
      return { msgId };
    },
    react: async (to, msgId, emoji) => {
      acts.push({ kind: 'react', chatId: to, msgId, emoji, at: clock.epochMs() });
    },
    sendPoll: async (to, question, options) => {
      const msgId = nextMsgId++;
      acts.push({ kind: 'poll', chatId: to, question, options: [...options], msgId, at: clock.epochMs() });
      return { msgId };
    },
    action: async (to, action) => {
      acts.push({ kind: 'action', chatId: to, action, at: clock.epochMs() });
    },
  };

  const notify = (): void => {
    const wake = waiters.shift();
    if (wake !== undefined) wake();
  };

  return {
    limits,

    queueInbound: (m) => {
      queue.push(m);
      notify();
    },

    injectReaction: (r) => {
      queue.push({
        updateId: nextUpdateId++,
        msgId: r.toMsgId,
        chatId,
        ts: clock.epochMs(),
        text: '',
        speaker: reactionSpeaker,
        reaction: { emoji: r.emoji, toMsgId: r.toMsgId },
      });
      notify();
    },

    ...(opts.body === false ? {} : { body }),

    bodyActs: () => [...acts],

    outbound: () => [...sends],
    typings: () => [...typingLog],
    pending: () => queue.length,

    updates: async function* (signal: AbortSignal): AsyncGenerator<InboundMsg> {
      while (!signal.aborted) {
        const next = queue.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        // Nothing scripted: block until queueInbound/injectReaction wakes us or
        // the caller aborts. No timers — the queue IS the schedule.
        await new Promise<void>((resolve) => {
          const onAbort = (): void => resolve();
          signal.addEventListener('abort', onAbort, { once: true });
          waiters.push(() => {
            signal.removeEventListener('abort', onAbort);
            resolve();
          });
        });
        if (signal.aborted) return;
      }
    },

    send: async (to, text) => {
      if (text.length > limits.maxMsgChars) {
        throw new BridgeError(
          'bridge/limit-max-chars',
          `send of ${text.length} chars exceeds maxMsgChars ${limits.maxMsgChars}`,
        );
      }
      const now = clock.epochMs();
      const last = lastSendAt.get(to);
      if (last !== undefined && now - last < limits.minSendGapMs) {
        throw new BridgeError(
          'bridge/limit-send-gap',
          `chat ${to}: ${now - last}ms since the last send, minSendGapMs is ${limits.minSendGapMs}`,
        );
      }
      lastSendAt.set(to, now);
      const msgId = nextMsgId++;
      sends.push({ chatId: to, text, msgId, at: now });
      return { msgId };
    },

    typing: async (to) => {
      typingLog.push({ chatId: to, at: clock.epochMs() });
    },
  };
};

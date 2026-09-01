// M15 bridge — the Telegram wire boundary: pure parsing only. No transport, no
// clock, no ledger — the same split as M03's wire layer, and for the same reason:
// this layer and FakeChannel's producer side pass one shared conformance suite
// over recorded getUpdates fixtures (test/bridge/fixtures), so a wire-shape drift
// cannot silently change what the pipeline is told a message said.

import type { InboundMsg, SpeakerRef } from './types.js';

// ---------------------------------------------------------------------------
// Wire shapes (only the fields M15 reads; unknown fields are ignored)
// ---------------------------------------------------------------------------

export interface WireUser {
  id?: number;
  is_bot?: boolean;
  first_name?: string;
  username?: string;
}

export interface WireChat {
  id?: number;
  type?: string;
  title?: string;
}

export interface WireMessage {
  message_id?: number;
  from?: WireUser;
  chat?: WireChat;
  /** Epoch SECONDS on the wire; InboundMsg.ts is epochMs. */
  date?: number;
  text?: string;
}

export interface WireReactionUpdated {
  message_id?: number;
  chat?: WireChat;
  date?: number;
  user?: WireUser;
  /** Telegram delivers both old and new reactions; only a new emoji is a signal. */
  new_reaction?: Array<{ type?: string; emoji?: string }>;
}

export interface WireUpdate {
  update_id?: number;
  message?: WireMessage;
  edited_message?: WireMessage;
  channel_post?: WireMessage;
  message_reaction?: WireReactionUpdated;
}

// ---------------------------------------------------------------------------
// Speaker provenance — stamped here, from the sender, never inferred from text
// ---------------------------------------------------------------------------

export interface SpeakerSource {
  from: WireUser | undefined;
  chat: WireChat | undefined;
}

/** Resolves the wire sender to `<person>:<channel>`. M20 injects the people-registry resolver in prod. */
export type SpeakerResolver = (src: SpeakerSource) => SpeakerRef;

export const personFromWire = (from: WireUser | undefined): string =>
  from?.id !== undefined ? `tg:${from.id}` : 'tg:unknown';

/** Default: the raw telegram identity. Honest, but impersonal — prod always injects a resolver that knows Diego. */
export const defaultSpeakerResolver: SpeakerResolver = ({ from }) => ({
  person: personFromWire(from),
  channel: 'telegram',
});

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export type SkipReason = 'edited_message' | 'non_text' | 'unsupported' | 'malformed';

export type ParsedUpdate =
  | { ok: true; msg: InboundMsg }
  | { ok: false; reason: SkipReason; detail?: string | undefined };

const notOk = (reason: SkipReason, detail: string): ParsedUpdate => ({ ok: false, reason, detail });

/** One `getUpdates` entry → the one inbound it can become, or the typed reason it carries nothing for the pipeline. */
export const parseUpdate = (raw: unknown, speaker: SpeakerResolver = defaultSpeakerResolver): ParsedUpdate => {
  if (typeof raw !== 'object' || raw === null) return notOk('malformed', 'update is not an object');
  const u = raw as WireUpdate;
  const updateId = u.update_id;
  if (typeof updateId !== 'number' || !Number.isInteger(updateId)) return notOk('malformed', 'update_id missing');
  // Edits are observed (they arrive in allowed_updates) and deliberately ignored:
  // she answers what was said to her, not its post-hoc revision.
  if (u.edited_message !== undefined) return notOk('edited_message', `update ${updateId} is an edit`);
  if (u.channel_post !== undefined) return notOk('unsupported', `update ${updateId} is a channel post`);
  const reaction = u.message_reaction;
  if (reaction !== undefined) return parseReaction(updateId, reaction, speaker);
  const message = u.message;
  if (message !== undefined) return parseMessage(updateId, message, speaker);
  return notOk('unsupported', `update ${updateId} carries no message or reaction`);
};

const parseMessage = (updateId: number, m: WireMessage, speaker: SpeakerResolver): ParsedUpdate => {
  const msgId = m.message_id;
  const chatId = m.chat?.id;
  const date = m.date;
  if (typeof msgId !== 'number' || typeof chatId !== 'number' || typeof date !== 'number') {
    return notOk('malformed', `update ${updateId}: message lacks message_id/chat.id/date`);
  }
  const text = m.text;
  // Photo/sticker/sticker-caption arrivals carry no text — nothing for the packet.
  if (typeof text !== 'string' || text.length === 0) return notOk('non_text', `message ${msgId} has no text`);
  return {
    ok: true,
    msg: {
      updateId,
      msgId,
      chatId,
      ts: date * 1000,
      text,
      speaker: speaker({ from: m.from, chat: m.chat }),
    },
  };
};

const parseReaction = (updateId: number, r: WireReactionUpdated, speaker: SpeakerResolver): ParsedUpdate => {
  const toMsgId = r.message_id;
  const chatId = r.chat?.id;
  const date = r.date;
  if (typeof toMsgId !== 'number' || typeof chatId !== 'number' || typeof date !== 'number') {
    return notOk('malformed', `update ${updateId}: reaction lacks message_id/chat.id/date`);
  }
  const emoji = (r.new_reaction ?? []).find((x) => typeof x.emoji === 'string')?.emoji;
  if (typeof emoji !== 'string') return notOk('non_text', `update ${updateId}: reaction removed or not an emoji`);
  return {
    ok: true,
    // msgId carries the id of the message reacted to: the ledger row stays
    // traceable to the bubble that earned the signal.
    msg: {
      updateId,
      msgId: toMsgId,
      chatId,
      ts: date * 1000,
      text: '',
      speaker: speaker({ from: r.user, chat: r.chat }),
      reaction: { emoji, toMsgId },
    },
  };
};

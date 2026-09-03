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
  /** Media captions: a photo WITH a caption is a text message whose text is the caption. */
  caption?: string;
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

/**
 * Deterministic stand-in `ts` for a skipped update whose wire payload carries no
 * date. Pure parsing cannot read a clock; the poll layer re-stamps nothing — the
 * ledger row keeps this constant and reconcile only reads the `skipped` mark.
 */
export const SKIP_FALLBACK_TS = 1_788_000_000_000;

const UNKNOWN_SPEAKER: SpeakerRef = { person: 'unknown', channel: 'telegram' };

/**
 * A skip becomes a skip-stamped InboundMsg, not a rejection: the adapter records
 * it (never turns it), so the offset commits past it and the poll cannot wedge
 * re-fetching the same update forever. Only an update Telegram never numbered
 * (no integer update_id) is unparseable — there is nothing to commit past.
 */
const skipMsg = (
  updateId: number,
  w: { message_id?: number; chat?: WireChat; date?: number } | undefined,
  reason: SkipReason,
): ParsedUpdate => ({
  ok: true,
  msg: {
    updateId,
    msgId: typeof w?.message_id === 'number' ? w.message_id : 0,
    chatId: typeof w?.chat?.id === 'number' ? w.chat.id : 0,
    ts: typeof w?.date === 'number' ? w.date * 1000 : SKIP_FALLBACK_TS,
    text: '',
    speaker: UNKNOWN_SPEAKER,
    skipped: { reason },
  },
});

/** One `getUpdates` entry → the one inbound it can become, or the placeholder that moves the offset past it. */
export const parseUpdate = (raw: unknown, speaker: SpeakerResolver = defaultSpeakerResolver): ParsedUpdate => {
  if (typeof raw !== 'object' || raw === null) return notOk('malformed', 'update is not an object');
  const u = raw as WireUpdate;
  const updateId = u.update_id;
  if (typeof updateId !== 'number' || !Number.isInteger(updateId)) return notOk('malformed', 'update_id missing');
  // Edits are observed (they arrive in allowed_updates) and deliberately ignored:
  // she answers what was said to her, not its post-hoc revision.
  if (u.edited_message !== undefined) return skipMsg(updateId, u.edited_message, 'edited_message');
  if (u.channel_post !== undefined) return skipMsg(updateId, u.channel_post, 'unsupported');
  const reaction = u.message_reaction;
  if (reaction !== undefined) return parseReaction(updateId, reaction, speaker);
  const message = u.message;
  if (message !== undefined) return parseMessage(updateId, message, speaker);
  return skipMsg(updateId, undefined, 'unsupported');
};

const parseMessage = (updateId: number, m: WireMessage, speaker: SpeakerResolver): ParsedUpdate => {
  const msgId = m.message_id;
  const chatId = m.chat?.id;
  const date = m.date;
  if (typeof msgId !== 'number' || typeof chatId !== 'number' || typeof date !== 'number') {
    return skipMsg(updateId, m, 'malformed');
  }
  // A photo WITH a caption is a real message: the caption is what was said.
  const text = typeof m.text === 'string' && m.text.length > 0 ? m.text : m.caption;
  if (typeof text !== 'string' || text.length === 0) return skipMsg(updateId, m, 'non_text');
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
    return skipMsg(updateId, r, 'malformed');
  }
  const emoji = (r.new_reaction ?? []).find((x) => typeof x.emoji === 'string')?.emoji;
  if (typeof emoji !== 'string') return skipMsg(updateId, r, 'non_text');
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

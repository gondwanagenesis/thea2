// M15 bridge — the Telegram wire boundary: pure parsing only. No transport, no
// clock, no ledger — the same split as M03's wire layer, and for the same reason:
// this layer and FakeChannel's producer side pass one shared conformance suite
// over recorded getUpdates fixtures (test/bridge/fixtures), so a wire-shape drift
// cannot silently change what the pipeline is told a message said.

import type { InboundMedia, InboundMsg, SpeakerRef } from './types.js';

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
  // v9 — the media the body resolves (only the fields read here).
  photo?: Array<{ file_id?: string; file_size?: number; width?: number; height?: number }>;
  document?: WireFile & { file_name?: string };
  voice?: WireFile & { duration?: number };
  audio?: WireFile & { duration?: number; title?: string; performer?: string };
  video?: WireFile & { duration?: number };
  video_note?: WireFile & { duration?: number };
  animation?: WireFile & { duration?: number };
  sticker?: { file_id?: string; emoji?: string; set_name?: string; is_animated?: boolean; is_video?: boolean };
  location?: { latitude?: number; longitude?: number; live_period?: number };
  venue?: { location?: { latitude?: number; longitude?: number }; title?: string; address?: string };
  reply_to_message?: WireMessage;
}

export interface WireFile {
  file_id?: string;
  mime_type?: string;
  file_size?: number;
}

export interface WireReactionUpdated {
  message_id?: number;
  chat?: WireChat;
  date?: number;
  user?: WireUser;
  /** Telegram delivers both old and new reactions; only a new emoji is a signal. */
  new_reaction?: Array<{ type?: string; emoji?: string }>;
}

export interface WirePollAnswer {
  poll_id?: string;
  user?: WireUser;
  option_ids?: number[];
}

export interface WireUpdate {
  update_id?: number;
  poll_answer?: WirePollAnswer;
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

/** v11: a human-readable sender name from the wire, for naming group members. */
export const nameFromWire = (from: WireUser | undefined): string | undefined => {
  const n = from?.first_name ?? from?.username;
  return typeof n === 'string' && n.trim() !== '' ? n.trim().slice(0, 40) : undefined;
};

/** Default: the raw telegram identity. Honest, but impersonal — prod always injects a resolver that knows Diego. */
export const defaultSpeakerResolver: SpeakerResolver = ({ from }) => ({
  person: personFromWire(from),
  channel: 'telegram',
});

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export type SkipReason = 'edited_message' | 'non_text' | 'unsupported' | 'malformed' | 'live_location' | 'poll_answer';

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
  // v9 edits: a live-location ping is a silent where-update (recorded, never
  // owed a reply); an edited text is a turn that knows it is an edit; any other
  // edit (a re-cropped photo, a caption-less change) stays a skip.
  if (u.edited_message !== undefined) return parseEdit(updateId, u.edited_message, speaker);
  if (u.channel_post !== undefined) return skipMsg(updateId, u.channel_post, 'unsupported');
  const vote = u.poll_answer;
  if (vote !== undefined) {
    const uid = vote.user?.id;
    if (typeof vote.poll_id !== 'string' || typeof uid !== 'number' || !Array.isArray(vote.option_ids)) return skipMsg(updateId, undefined, 'malformed');
    const skip = skipMsg(updateId, { chat: { id: uid } }, 'poll_answer');
    if (!skip.ok) return skip;
    return { ok: true, msg: { ...skip.msg, speaker: speaker({ from: vote.user, chat: { id: uid } }), media: { kind: 'poll_answer', pollId: vote.poll_id, optionIds: vote.option_ids.filter((x) => typeof x === 'number') } } };
  }
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
  const said = typeof m.text === 'string' && m.text.length > 0 ? m.text : m.caption;
  const text = typeof said === 'string' ? said : '';
  const media = mediaOf(m);
  // v9: a photo, voice note, file or place with no words is still a message
  // to her — the body's senses turn it into material inside the turn.
  if (text.length === 0 && media === undefined) return skipMsg(updateId, m, 'non_text');
  const replyTo = replyOf(m);
  return {
    ok: true,
    msg: {
      updateId,
      msgId,
      chatId,
      ts: date * 1000,
      text,
      speaker: speaker({ from: m.from, chat: m.chat }),
      ...(nameFromWire(m.from) !== undefined ? { senderName: nameFromWire(m.from) } : {}),
      ...(media !== undefined ? { media } : {}),
      ...(replyTo !== undefined ? { replyTo } : {}),
    },
  };
};

const parseEdit = (updateId: number, m: WireMessage, speaker: SpeakerResolver): ParsedUpdate => {
  const loc = m.location;
  if (loc !== undefined && typeof loc.latitude === 'number' && typeof loc.longitude === 'number') {
    const skip = skipMsg(updateId, m, 'live_location');
    if (!skip.ok) return skip;
    return {
      ok: true,
      msg: {
        ...skip.msg,
        speaker: speaker({ from: m.from, chat: m.chat }),
        media: { kind: 'location', lat: loc.latitude, lon: loc.longitude, live: true },
      },
    };
  }
  const said = typeof m.text === 'string' && m.text.length > 0 ? m.text : m.caption;
  if (typeof said !== 'string' || said.length === 0) return skipMsg(updateId, m, 'edited_message');
  const parsed = parseMessage(updateId, { text: said, ...pick(m) }, speaker);
  if (!parsed.ok || parsed.msg.skipped !== undefined) return parsed;
  // Media on an edit was answered when it first arrived: only the new words are news.
  const { media: _media, ...rest } = parsed.msg;
  return { ok: true, msg: { ...rest, edited: true } };
};

const pick = (m: WireMessage): WireMessage => ({
  ...(m.message_id !== undefined ? { message_id: m.message_id } : {}),
  ...(m.from !== undefined ? { from: m.from } : {}),
  ...(m.chat !== undefined ? { chat: m.chat } : {}),
  ...(m.date !== undefined ? { date: m.date } : {}),
  ...(m.reply_to_message !== undefined ? { reply_to_message: m.reply_to_message } : {}),
});

const fileIdOf = (f: WireFile | undefined): string | undefined =>
  f !== undefined && typeof f.file_id === 'string' && f.file_id.length > 0 ? f.file_id : undefined;

const secs = (d: number | undefined): number => (typeof d === 'number' && d >= 0 ? d : 0);

const photoArea = (p: { file_size?: number; width?: number; height?: number }): number => p.file_size ?? (p.width ?? 0) * (p.height ?? 0);

/** Drops undefined-valued keys: an InboundMsg is canonical-JSON'd into the ledger, and undefined has no canonical form. */
const defined = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

/** The one media item a message carries, most specific first (a GIF arrives as animation AND document). */
export const mediaOf = (m: WireMessage): InboundMedia | undefined => {
  const found = rawMediaOf(m);
  return found === undefined ? undefined : defined(found);
};

const rawMediaOf = (m: WireMessage): InboundMedia | undefined => {
  if (Array.isArray(m.photo) && m.photo.length > 0) {
    const best = [...m.photo].sort((a, b) => photoArea(b) - photoArea(a))[0];
    const id = best?.file_id;
    if (typeof id === 'string' && id.length > 0) return { kind: 'photo', fileId: id };
  }
  const video = fileIdOf(m.video);
  if (video !== undefined) return { kind: 'video', fileId: video, durationSec: secs(m.video?.duration), mime: m.video?.mime_type };
  const note = fileIdOf(m.video_note);
  if (note !== undefined) return { kind: 'video_note', fileId: note, durationSec: secs(m.video_note?.duration) };
  const anim = fileIdOf(m.animation);
  if (anim !== undefined) return { kind: 'animation', fileId: anim, durationSec: secs(m.animation?.duration), mime: m.animation?.mime_type };
  const voice = fileIdOf(m.voice);
  if (voice !== undefined) return { kind: 'voice', fileId: voice, durationSec: secs(m.voice?.duration), mime: m.voice?.mime_type };
  const audio = fileIdOf(m.audio);
  if (audio !== undefined) {
    const title = [m.audio?.performer, m.audio?.title].filter((x): x is string => typeof x === 'string' && x.length > 0).join(' — ');
    return { kind: 'audio', fileId: audio, durationSec: secs(m.audio?.duration), mime: m.audio?.mime_type, ...(title !== '' ? { title } : {}) };
  }
  const doc = fileIdOf(m.document);
  if (doc !== undefined) {
    return { kind: 'document', fileId: doc, fileName: m.document?.file_name ?? 'file', mime: m.document?.mime_type, bytes: m.document?.file_size };
  }
  const st = m.sticker;
  if (st !== undefined && typeof st.file_id === 'string' && st.file_id.length > 0) {
    return { kind: 'sticker', fileId: st.file_id, emoji: st.emoji, setName: st.set_name, animated: st.is_animated === true || st.is_video === true };
  }
  const venueLoc = m.venue?.location;
  if (venueLoc !== undefined && typeof venueLoc.latitude === 'number' && typeof venueLoc.longitude === 'number') {
    return { kind: 'location', lat: venueLoc.latitude, lon: venueLoc.longitude, live: false, title: m.venue?.title, address: m.venue?.address };
  }
  const loc = m.location;
  if (loc !== undefined && typeof loc.latitude === 'number' && typeof loc.longitude === 'number') {
    return { kind: 'location', lat: loc.latitude, lon: loc.longitude, live: typeof loc.live_period === 'number' && loc.live_period > 0 };
  }
  return undefined;
};

const replyLabel = (r: WireMessage): string => {
  const said = typeof r.text === 'string' && r.text.length > 0 ? r.text : (r.caption ?? '');
  if (said.length > 0) return said;
  if (r.photo !== undefined) return '[a photo]';
  if (r.voice !== undefined) return '[a voice note]';
  if (r.video !== undefined || r.video_note !== undefined) return '[a video]';
  if (r.document !== undefined) return `[a file: ${r.document.file_name ?? 'file'}]`;
  if (r.sticker !== undefined) return `[a sticker${r.sticker.emoji !== undefined ? ` ${r.sticker.emoji}` : ''}]`;
  return '';
};

const replyOf = (m: WireMessage): InboundMsg['replyTo'] => {
  const r = m.reply_to_message;
  if (r === undefined || typeof r.message_id !== 'number') return undefined;
  return { msgId: r.message_id, text: replyLabel(r).slice(0, 600), fromBot: r.from?.is_bot === true };
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

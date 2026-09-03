// test/bridge — shared builders, the recorded getUpdates fixtures, and the
// expected InboundMsg values both conformance sides are held to. No network,
// no wall clock: everything here is data and pure functions.

import { readFileSync } from 'node:fs';
import type { EventEnvelope, EventLog } from '../../src/events/index.js';
import {
  parseUpdate,
  personFromWire,
  SKIP_FALLBACK_TS,
  type InboundMsg,
  type ParsedUpdate,
  type SpeakerRef,
  type SpeakerResolver,
} from '../../src/bridge/index.js';

export { SKIP_FALLBACK_TS };

// ---------------------------------------------------------------------------
// Recorded fixtures
// ---------------------------------------------------------------------------

interface FixtureFile {
  updates: Record<string, unknown>;
}

const file = JSON.parse(
  readFileSync(new URL('./fixtures/getupdates.json', import.meta.url), 'utf8'),
) as FixtureFile;

export const fixture = (name: string): unknown => {
  const raw = file.updates[name];
  if (raw === undefined) throw new Error(`unknown fixture: ${name}`);
  return raw;
};

export const fixtureNames = (): string[] => Object.keys(file.updates);

// ---------------------------------------------------------------------------
// Speaker provenance — the resolver every fixture expectation is written against
// ---------------------------------------------------------------------------

export const DIEGO_TG_ID = 8123456;

/** Maps the recorded Diego id to his person name; anyone else falls through to the default raw form. */
export const testSpeaker: SpeakerResolver = ({ from }) => ({
  person: from?.id === DIEGO_TG_ID ? 'diego' : personFromWire(from),
  channel: 'telegram',
});

export const parseFixture = (name: string, speaker: SpeakerResolver = testSpeaker): ParsedUpdate =>
  parseUpdate(fixture(name), speaker);

/** The InboundMsg each parsing fixture must produce, byte for byte (canonicalJson-equal). */
export const EXPECTED_INBOUND: Record<string, InboundMsg> = {
  text_message: {
    updateId: 401,
    msgId: 7001,
    chatId: DIEGO_TG_ID,
    ts: 1788000000 * 1000,
    text: 'estás despierta? ya son las tres',
    speaker: { person: 'diego', channel: 'telegram' },
  },
  reaction: {
    updateId: 403,
    msgId: 7001,
    chatId: DIEGO_TG_ID,
    ts: 1788000060 * 1000,
    text: '',
    speaker: { person: 'diego', channel: 'telegram' },
    reaction: { emoji: '🔥', toMsgId: 7001 },
  },
  other_speaker: {
    updateId: 407,
    msgId: 7003,
    chatId: 999000111,
    ts: 1788000180 * 1000,
    text: 'ella tampoco duerme',
    speaker: { person: 'tg:999000111', channel: 'telegram' },
  },
  // A photo WITH a caption is a real message: the caption is what was said.
  photo_message: {
    updateId: 405,
    msgId: 7002,
    chatId: DIEGO_TG_ID,
    ts: 1788000120 * 1000,
    text: 'mira esto',
    speaker: { person: 'diego', channel: 'telegram' },
  },
};

/** Fixtures that must parse to no turn — each as the skip-stamped InboundMsg below. */
const UNKNOWN_SPEAKER: SpeakerRef = { person: 'unknown', channel: 'telegram' };

/**
 * The placeholder InboundMsg each skip fixture WITH an update_id must become
 * (byte for byte), so the offset can move past it. `malformed_no_update_id`
 * has no entry: nothing can be committed past an update Telegram never numbered.
 */
export const EXPECTED_SKIPPED_INBOUND: Record<string, InboundMsg> = {
  edited_message: {
    updateId: 402,
    msgId: 7001,
    chatId: DIEGO_TG_ID,
    ts: 1788000000 * 1000,
    text: '',
    speaker: UNKNOWN_SPEAKER,
    skipped: { reason: 'edited_message' },
  },
  reaction_removed: {
    updateId: 404,
    msgId: 7001,
    chatId: DIEGO_TG_ID,
    ts: 1788000300 * 1000,
    text: '',
    speaker: UNKNOWN_SPEAKER,
    skipped: { reason: 'non_text' },
  },
  photo_no_caption: {
    updateId: 409,
    msgId: 7005,
    chatId: DIEGO_TG_ID,
    ts: 1788000240 * 1000,
    text: '',
    speaker: UNKNOWN_SPEAKER,
    skipped: { reason: 'non_text' },
  },
  sticker_message: {
    updateId: 410,
    msgId: 7006,
    chatId: DIEGO_TG_ID,
    ts: 1788000270 * 1000,
    text: '',
    speaker: UNKNOWN_SPEAKER,
    skipped: { reason: 'non_text' },
  },
  channel_post: {
    updateId: 406,
    msgId: 300,
    chatId: -1001234567890,
    ts: 1788000150 * 1000,
    text: '',
    speaker: UNKNOWN_SPEAKER,
    skipped: { reason: 'unsupported' },
  },
  // The message lacks message_id and date: msgId falls to 0, ts to the pure-layer constant.
  malformed_missing_message_fields: {
    updateId: 408,
    msgId: 0,
    chatId: DIEGO_TG_ID,
    ts: SKIP_FALLBACK_TS,
    text: '',
    speaker: UNKNOWN_SPEAKER,
    skipped: { reason: 'malformed' },
  },
};

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

/** An inbound with sane defaults; everything overridable for the scripted ledgers. */
export const msg = (over: {
  updateId: number;
  msgId?: number;
  chatId?: number;
  ts?: number;
  text?: string;
  speaker?: SpeakerRef;
  reaction?: { emoji: string; toMsgId: number };
  skipped?: { reason: string };
}): InboundMsg => ({
  updateId: over.updateId,
  msgId: over.msgId ?? 1000 + over.updateId,
  chatId: over.chatId ?? DIEGO_TG_ID,
  ts: over.ts ?? 0,
  text: over.text ?? 'hola',
  speaker: over.speaker ?? { person: 'diego', channel: 'telegram' },
  ...(over.reaction !== undefined ? { reaction: over.reaction } : {}),
  ...(over.skipped !== undefined ? { skipped: over.skipped } : {}),
});

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

/** In-memory L0 for asserting emitted events without touching the filesystem. */
export const memoryLog = (): { log: EventLog; events: EventEnvelope[] } => {
  const events: EventEnvelope[] = [];
  return {
    events,
    log: {
      emit: async (kind, payload, turnId) => {
        events.push({ seq: events.length + 1, ts: 0, kind, ...(turnId !== undefined ? { turnId } : {}), payload });
      },
      async *replay() {
        for (const e of events) yield e;
      },
    },
  };
};

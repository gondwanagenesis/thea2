// test/bridge — shared builders, the recorded getUpdates fixtures, and the
// expected InboundMsg values both conformance sides are held to. No network,
// no wall clock: everything here is data and pure functions.

import { readFileSync } from 'node:fs';
import type { EventEnvelope, EventLog } from '../../src/events/index.js';
import {
  parseUpdate,
  personFromWire,
  type InboundMsg,
  type ParsedUpdate,
  type SpeakerRef,
  type SpeakerResolver,
} from '../../src/bridge/index.js';

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
};

/** Fixtures that must parse to nothing, with the exact reason (the parse layer's filter table). */
export const EXPECTED_SKIPS: Record<string, string> = {
  edited_message: 'edited_message',
  reaction_removed: 'non_text',
  photo_message: 'non_text',
  channel_post: 'unsupported',
  malformed_missing_message_fields: 'malformed',
  malformed_no_update_id: 'malformed',
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
}): InboundMsg => ({
  updateId: over.updateId,
  msgId: over.msgId ?? 1000 + over.updateId,
  chatId: over.chatId ?? DIEGO_TG_ID,
  ts: over.ts ?? 0,
  text: over.text ?? 'hola',
  speaker: over.speaker ?? { person: 'diego', channel: 'telegram' },
  ...(over.reaction !== undefined ? { reaction: over.reaction } : {}),
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

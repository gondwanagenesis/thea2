// M15 bridge — the wire parsing layer over recorded getUpdates fixtures.
// Goldens are byte-pinned through canonicalJson so a shape drift cannot silently
// change what the pipeline is told a message said.

import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../../src/kernel/index.js';
import { parseUpdate, personFromWire } from '../../src/bridge/index.js';
import {
  EXPECTED_INBOUND,
  EXPECTED_SKIPPED_INBOUND,
  DIEGO_TG_ID,
  fixture,
  parseFixture,
} from './helpers.js';

describe('parseUpdate over recorded fixtures', () => {
  for (const [name, expected] of Object.entries(EXPECTED_INBOUND)) {
    it(`AC: ${name} parses into its golden InboundMsg (byte-equal)`, () => {
      const parsed = parseFixture(name);
      if (!parsed.ok) throw new Error(`fixture '${name}' should parse, got ${parsed.reason}`);
      expect(canonicalJson(parsed.msg)).toBe(canonicalJson(expected));
    });
  }

  for (const [name, expected] of Object.entries(EXPECTED_SKIPPED_INBOUND)) {
    it(`AC: ${name} is skipped as ${expected.skipped?.reason} — as a skip-stamped inbound the offset can move past`, () => {
      const parsed = parseFixture(name);
      if (!parsed.ok) throw new Error(`fixture '${name}' should skip-parse, got ${parsed.reason}`);
      expect(canonicalJson(parsed.msg)).toBe(canonicalJson(expected));
    });
  }

  it('malformed_no_update_id is the one unparseable shape: nothing can be committed past an unnumbered update', () => {
    expect(parseFixture('malformed_no_update_id')).toEqual({
      ok: false,
      reason: 'malformed',
      detail: expect.any(String),
    });
  });

  it('AC: speaker provenance is stamped from the sender — never from text', () => {
    const parsed = parseFixture('text_message');
    if (!parsed.ok) throw new Error('fixture should parse');
    expect(parsed.msg.speaker).toEqual({ person: 'diego', channel: 'telegram' });
    const other = parseFixture('other_speaker');
    if (!other.ok) throw new Error('fixture should parse');
    expect(other.msg.speaker).toEqual({ person: `tg:999000111`, channel: 'telegram' });
  });

  it('wire dates are epoch seconds and land on InboundMsg.ts as epochMs', () => {
    const parsed = parseFixture('text_message');
    if (!parsed.ok) throw new Error('fixture should parse');
    expect(parsed.msg.ts).toBe(1788000000000);
  });

  it('the default resolver keeps the raw telegram identity (prod injects the people registry)', () => {
    const parsed = parseUpdate(fixture('text_message'));
    if (!parsed.ok) throw new Error('fixture should parse');
    expect(parsed.msg.speaker).toEqual({ person: `tg:${DIEGO_TG_ID}`, channel: 'telegram' });
    expect(personFromWire(undefined)).toBe('tg:unknown');
  });

  it('a reaction references its message through toMsgId, with the message id it reacted to', () => {
    const parsed = parseFixture('reaction');
    if (!parsed.ok) throw new Error('fixture should parse');
    expect(parsed.msg.reaction).toEqual({ emoji: '🔥', toMsgId: 7001 });
    expect(parsed.msg.msgId).toBe(7001);
    expect(parsed.msg.text).toBe('');
  });

  it('non-object and missing-update_id payloads are malformed, never thrown', () => {
    expect(parseUpdate(null)).toEqual({ ok: false, reason: 'malformed', detail: expect.any(String) });
    expect(parseUpdate('nope')).toEqual({ ok: false, reason: 'malformed', detail: expect.any(String) });
    expect(parseUpdate({ message: { text: 'x' } })).toEqual({
      ok: false,
      reason: 'malformed',
      detail: expect.any(String),
    });
  });

  it('an update with no known payload kind is skip-stamped unsupported — never a wedge, never a turn', () => {
    const parsed = parseUpdate({ update_id: 500, my_chat_member: {} });
    if (!parsed.ok) throw new Error('a numbered update must parse (skip-stamped at worst)');
    expect(parsed.msg).toEqual({
      updateId: 500,
      msgId: 0,
      chatId: 0,
      ts: 1_788_000_000_000,
      text: '',
      speaker: { person: 'unknown', channel: 'telegram' },
      skipped: { reason: 'unsupported' },
    });
  });
});

// M15 bridge — the shared conformance suite. The real adapter's PARSING layer
// (parseUpdate over recorded getUpdates fixtures) and FakeChannel's producer
// side (queueInbound → updates) must produce byte-identical InboundMsg values —
// the property that lets every later module test against FakeChannel and mean
// the real channel. Same discipline as M03's MockModel conformance.

import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../../src/kernel/index.js';
import { FakeChannel, parseUpdate, type InboundMsg } from '../../src/bridge/index.js';
import { EXPECTED_INBOUND, EXPECTED_SKIPPED_INBOUND, fixture, fixtureNames, parseFixture, testSpeaker } from './helpers.js';

const firstOf = async (msgs: AsyncIterable<InboundMsg>): Promise<InboundMsg> => {
  const ac = new AbortController();
  for await (const m of msgs) {
    ac.abort();
    return m;
  }
  throw new Error('updates() yielded nothing');
};

const goldenOf = (name: string): InboundMsg =>
  EXPECTED_INBOUND[name] ?? EXPECTED_SKIPPED_INBOUND[name] ?? (() => { throw new Error(`no golden for ${name}`); })();

describe('FakeChannel ⇔ real parse layer conformance (recorded getUpdates fixtures)', () => {
  for (const [name, expected] of [...Object.entries(EXPECTED_INBOUND), ...Object.entries(EXPECTED_SKIPPED_INBOUND)]) {
    it(`case: ${name} — both sides produce byte-equal InboundMsg`, async () => {
      const parsed = parseFixture(name);
      if (!parsed.ok) throw new Error(`fixture '${name}' should parse, got ${parsed.reason}`);

      const ch = FakeChannel();
      ch.queueInbound(expected);
      const produced = await firstOf(ch.updates(new AbortController().signal));

      expect(canonicalJson(parsed.msg)).toBe(canonicalJson(expected));
      expect(canonicalJson(produced)).toBe(canonicalJson(expected));
    });
  }

  it('both sides agree on exactly which fixtures a channel can deliver', async () => {
    // The parse layer is the single filter: FakeChannel yields exactly what was
    // queued, so the set of inbounds a channel can deliver is the set the parse
    // layer accepts — real inbounds and skip-stamped placeholders alike, no
    // second, drifting filter inside the double.
    const accepted = new Set<string>();
    for (const name of fixtureNames()) {
      const parsed = parseUpdate(fixture(name), testSpeaker);
      if (parsed.ok) accepted.add(name);
    }
    expect([...accepted].sort()).toEqual(
      [...Object.keys(EXPECTED_INBOUND), ...Object.keys(EXPECTED_SKIPPED_INBOUND)].sort(),
    );

    // The full accepted set survives the producer side byte for byte, in order.
    const ch = FakeChannel();
    const expectedOrder = [...accepted].sort();
    for (const name of expectedOrder) ch.queueInbound(goldenOf(name));
    const got: InboundMsg[] = [];
    const ac = new AbortController();
    for await (const m of ch.updates(ac.signal)) {
      got.push(m);
      if (got.length === expectedOrder.length) break;
    }
    expect(canonicalJson(got)).toBe(canonicalJson(expectedOrder.map(goldenOf)));
  });
});

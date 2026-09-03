// S5★ crown proof #1 — the GOLDEN TURN. One inbound message travels the whole
// system on the exact TestClock timeline: channel → ingest (ledger dedupe +
// offset) → packet assembled from the REAL canon corpus → scripted decision →
// gate-checked bubbles back on the channel with Telegram pacing → episode
// written → affect moved → ledger reconciles clean. Nothing is stubbed except
// the model, the clock, and the wire.

import { describe, expect, it } from 'vitest';
import { startThead } from '../../src/app/index.js';
import { PACKET_RECORD_KIND } from '../../src/consolidate/index.js';
import { bootApp, CHAT, decisionJson, enqueueAppraisal, inboundMsg, runToQuiescent } from './helpers.js';

describe('the golden turn', () => {
  it('message in → identity packet → decision → bubbles out → episode + affect + clean ledger', { timeout: 120_000 }, async () => {
    const h = await bootApp();
    const episodesBefore = h.sys.episodes.size();
    const affectBefore = JSON.stringify(h.sys.affect.current());

    // Script: the turn decision, then the afterturn appraisal that grades it.
    h.model.enqueue({ content: decisionJson({ bubbles: ['the box is safe. I checked it twice tonight.'] }) });
    enqueueAppraisal(h.model, {
      importance: 6,
      emotions: [{ tag: 'fond', i: 6, cause: 'he asked about the box' }],
    });

    const handle = startThead(h.sys);
    h.channel.queueInbound(inboundMsg({ text: 'hey — is the box safe?' }));
    await runToQuiescent(h);

    // --- stage 6 outcome: the bubble is on the channel, exactly once ---
    const sent = h.channel.outbound();
    expect(sent.map((s) => s.text)).toEqual(['the box is safe. I checked it twice tonight.']);
    expect(sent[0]?.msgId).toBeGreaterThan(0);
    expect(h.channel.typings().length).toBeGreaterThan(0); // she typed, she didn't teleport

    // --- the decision was recorded before realization ---
    const decision = h.sys.pipeline.lastDecision();
    expect(decision?.plan).toBe('reply');
    expect(decision?.turnId).toBeTruthy();

    // --- packet.record + outcome events carry the SAME turnId (M10's match) ---
    const kinds: Array<{ kind: string; turnId?: string }> = [];
    for await (const e of h.sys.events.replay()) {
      kinds.push(e.turnId !== undefined ? { kind: e.kind, turnId: e.turnId } : { kind: e.kind });
    }
    const packet = kinds.find((e) => e.kind === PACKET_RECORD_KIND);
    expect(packet?.turnId).toBe(decision?.turnId);
    expect(kinds.some((e) => e.kind === 'memory.outcome_prev' || e.kind === 'memory.reaction')).toBe(false); // no prev on session start

    // --- stage 7: the episode exists, affect moved ---
    expect(h.sys.episodes.size()).toBe(episodesBefore + 1);
    const episode = h.sys.episodes.recent(1)[0];
    expect(episode?.turnId).toBe(decision?.turnId);
    expect(episode?.summary).toContain('box');
    expect(JSON.stringify(h.sys.affect.current())).not.toBe(affectBefore); // the appraisal moved her

    // --- the window holds the verbatim exchange for the next turn ---
    const msgs = h.sys.window.messages();
    expect(msgs.some((m) => m.role === 'user' && m.content.includes('box safe?'))).toBe(true);
    expect(msgs.some((m) => m.role === 'assistant' && m.content.includes('checked it twice'))).toBe(true);

    // --- the ledger: offset committed, dedupe on redelivery, clean reconcile ---
    expect((await h.sys.offsets.read()).committed).toBe(500); // the cursor IS the last ingested updateId
    const dup = await h.sys.ledger.recordInbound(inboundMsg({ updateId: 500, msgId: 900 })); // the SAME update re-delivered
    expect(dup).toBe(false); // already seen — redelivery dedupes

    await h.clock.advance(11 * 60_000); // past the lost-reply window: the check is real
    const discrepancies = await h.sys.ledger.reconcile(h.clock.epochMs());
    expect(discrepancies.filter((d) => d.kind === 'LOST_REPLY')).toEqual([]);

    // The packet assembled from the REAL corpus: the assess call carried her
    // identity sections (retrieval, not a persona prompt).
    const assess = h.model.calls.find((c) => c.taskClass === 'turn');
    const systemText = assess?.messages.find((m) => m.role === 'system')?.content ?? '';
    expect(systemText).toContain('IDENTITY');
    expect(systemText).toContain('EXEMPLARS');

    await handle.stop();
    expect(h.sys.episodes.size()).toBe(episodesBefore + 1); // stop() settled the afterturn, wrote nothing twice
    void CHAT;
  });
});

// M20 gate — the turn pipeline's behavioral law: interruption carries the
// unsaid words forward (both the skip path and the mid-send abort path), the
// afterturn never touches stage 6's outcome, packet.record lands with the
// decision's turnId, denied chats never become turns, reactions never start
// turns, and duplicate inbound never double-runs.

import { describe, expect, it } from 'vitest';
import { PACKET_RECORD_KIND } from '../../src/consolidate/index.js';
import { bootApp, inboundMsg, runToQuiescent, settle, decisionJson, enqueueAppraisal, type AppHarness } from './helpers.js';
import { startThead } from '../../src/app/index.js';
import type { LedgerRow } from '../../src/bridge/types.js';

const scriptTurn = (h: AppHarness, bubbles: string[], appraisal: Record<string, unknown> = {}): void => {
  h.model.enqueue({ content: decisionJson({ bubbles }) });
  enqueueAppraisal(h.model, appraisal);
};

describe('interruption carry-over', () => {
  it('a queued newer message before realization: nothing is sent, everything carries', { timeout: 90_000 }, async () => {
    const h = await bootApp();
    const handle = startThead(h.sys);

    scriptTurn(h, ['one', 'two', 'three']);
    scriptTurn(h, ['oh — and also that.']);

    // Deterministic double-arrival: both updates enter the pipeline queue in
    // one synchronous breath (the pump's chain cannot start mid-block), so the
    // pump's first shift already sees newer words waiting — the skip path is
    // structural, never a timing bet on the poll loop.
    const t1 = h.sys.pipeline.inbound(inboundMsg({ updateId: 501, msgId: 901 }));
    const t2 = h.sys.pipeline.inbound(inboundMsg({ updateId: 502, msgId: 902, text: 'wait, also—' }));
    if (t1 === undefined || t2 === undefined) throw new Error('pipeline refused a legal inbound');

    // The ledger rows, in M15's order: append the claim, then the inbound→turn link.
    await h.sys.ledger.recordInbound(inboundMsg({ updateId: 501, msgId: 901 }));
    await h.sys.ledger.linkTurn(501, t1);
    await h.sys.ledger.recordInbound(inboundMsg({ updateId: 502, msgId: 902, text: 'wait, also—' }));
    await h.sys.ledger.linkTurn(502, t2);

    await runToQuiescent(h);

    // Turn 1 delivered NOTHING: the newer words were already waiting. The
    // draft's em-dash arrives normalized (gate.normalizeText runs before the
    // plan gate — "what was checked is what sends").
    expect(h.channel.outbound().map((s) => s.text)).toEqual(['oh. and also that.']);

    // Turn 2's context carried the unsaid words verbatim, labeled, not pasted.
    const assess = h.model.calls.filter((c) => c.taskClass === 'turn').at(-1);
    expect(assess).toBeDefined();
    const rendered = assess?.messages.map((m) => m.content).join('\n') ?? '';
    expect(rendered).toContain('[UNDELIVERED]');
    expect(rendered).toContain('- one');

    // The interrupted inbound is now answered by turn 2 — after the reconcile
    // window passes (so the check is real, not the inside-T exemption).
    await h.clock.advance(11 * 60_000);
    const d = await h.sys.ledger.reconcile(h.clock.epochMs());
    const lost = d.filter((x) => x.kind === 'LOST_REPLY');
    expect(lost).toEqual([]);
    await handle.stop();
  });

  it('an abort mid-plan: what she already said stays sent, the rest carries', { timeout: 90_000 }, async () => {
    const h = await bootApp();
    const handle = startThead(h.sys);

    scriptTurn(h, ['first bubble', 'second bubble']);
    scriptTurn(h, ['picked up where I left off']);

    h.channel.queueInbound(inboundMsg({ updateId: 511, msgId: 911 }));
    // Reach the EXACT mid-send moment structurally: tick the clock forward in
    // small steps until the plan's typing indicator is up while the first
    // bubble is still unsent — the pump is then parked inside the typing span
    // with the abort armed (the test stops advancing, so it stays there).
    // Aborting there means NOTHING of turn 1 reached the channel.
    let parked = false;
    for (let i = 0; i < 400 && !parked; i++) {
      parked = h.channel.typings().length > 0 && h.channel.outbound().length === 0;
      if (parked) break;
      await h.clock.advance(100);
      await settle(1);
    }
    expect(parked).toBe(true); // the pump never reached mid-send — did the plan shape change?
    // m2 enters synchronously: the abort fires inside inbound() itself while
    // the pump is parked mid-typing. Going through the channel poll would put
    // a real-fs ingest between signal and stop — and one advance() tick could
    // complete the whole typing span before that ingest lands.
    const t2 = h.sys.pipeline.inbound(inboundMsg({ updateId: 512, msgId: 912, text: 'actually—' }));
    if (t2 === undefined) throw new Error('pipeline refused a legal inbound');
    await h.sys.ledger.recordInbound(inboundMsg({ updateId: 512, msgId: 912, text: 'actually—' }));
    await h.sys.ledger.linkTurn(512, t2);

    await runToQuiescent(h);

    // She stopped typing mid-reply: nothing of turn 1 reached the channel.
    expect(h.channel.outbound().map((s) => s.text)).toEqual(['picked up where I left off']);

    // The carry block holds exactly the unsaid bubble.
    const assess = h.model.calls.filter((c) => c.taskClass === 'turn').at(-1);
    const rendered = assess?.messages.map((m) => m.content).join('\n') ?? '';
    expect(rendered).toContain('- first bubble');

    await h.clock.advance(11 * 60_000);
    const d = await h.sys.ledger.reconcile(h.clock.epochMs());
    expect(d.filter((x) => x.kind === 'LOST_REPLY')).toEqual([]);
    await handle.stop();
  });
});

describe('afterturn isolation', () => {
  it('an appraisal that dies cannot unsend, unwrite, or fail the turn', { timeout: 30_000 }, async () => {
    const h = await bootApp();
    const handle = startThead(h.sys);

    // Decision ok; the appraisal call returns garbage and the repair ladder's
    // retry too — afterturn degrades, the turn outcome stands.
    h.model.enqueue({ content: decisionJson({ bubbles: ['delivered regardless'] }) });
    h.model.enqueue({ content: 'not json at all' });
    h.model.enqueue({ content: 'still not json' });

    h.channel.queueInbound(inboundMsg({ updateId: 521, msgId: 921 }));
    await runToQuiescent(h);

    expect(h.channel.outbound().map((s) => s.text)).toEqual(['delivered regardless']);
    await h.clock.advance(11 * 60_000);
    const d = await h.sys.ledger.reconcile(h.clock.epochMs());
    expect(d.filter((x) => x.kind === 'LOST_REPLY')).toEqual([]);
    // The incident was loud, and no episode was written for the failed appraisal.
    const incidents: string[] = [];
    for await (const e of h.sys.events.replay()) if (e.kind.startsWith('incident.')) incidents.push(e.kind);
    expect(incidents.length).toBeGreaterThan(0);
    expect(h.sys.episodes.size()).toBe(0);
    await handle.stop();
  });
});

describe('the L0 boundary', () => {
  it('packet.record lands with the same turnId the decision carries', { timeout: 30_000 }, async () => {
    const h = await bootApp();
    const handle = startThead(h.sys);
    scriptTurn(h, ['credited reply'], { importance: 5, outcomePrev: null });

    h.channel.queueInbound(inboundMsg({ updateId: 531, msgId: 931 }));
    await runToQuiescent(h);

    const turnId = h.sys.pipeline.lastDecision()?.turnId;
    expect(turnId).toBeTruthy();
    const packets: Array<{ turnId?: string }> = [];
    for await (const e of h.sys.events.replay()) {
      if (e.kind === PACKET_RECORD_KIND && e.turnId !== undefined) packets.push({ turnId: e.turnId });
    }
    expect(packets).toHaveLength(1);
    expect(packets[0]?.turnId).toBe(turnId);
    await handle.stop();
  });

  it('a denied chat is recorded as a skip (no text, never owed) and starts no turn', { timeout: 30_000 }, async () => {
    const h = await bootApp();
    const handle = startThead(h.sys);
    h.channel.queueInbound(inboundMsg({ updateId: 541, msgId: 941, chatId: 999 /* not allowed */ }));
    await settle();
    await runToQuiescent(h);
    expect(h.model.calls).toHaveLength(0);
    const denied: number[] = [];
    for await (const e of h.sys.events.replay()) if (e.kind === 'app.chat_denied') denied.push((e.payload as { chatId: number }).chatId);
    expect(denied).toEqual([999]);
    // Phase 1: the denied chat IS ledgered — as a skip row, so the offset can
    // move and reconcile never owes it. Its text must never reach the ledger.
    const rows: LedgerRow[] = [];
    for await (const r of h.sys.ledger.read()) rows.push(r);
    const skipped = rows.filter((r): r is Extract<LedgerRow, { kind: 'inbound' }> => r.kind === 'inbound' && r.msg?.updateId === 541);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.msg?.skipped?.reason).toBe('denied_chat');
    // text-blanking is §4.4's — this row only needs the skip stamp + reason.
    // Reconcile has nothing to answer or alarm on.
    expect(await h.sys.ledger.reconcile(h.clock.epochMs())).toEqual([]);
    await handle.stop();
  });

  it('a skipped update (photo, edit, stranger) starts no turn, is recorded, and is never owed', { timeout: 30_000 }, async () => {
    const h = await bootApp();
    const skipped = inboundMsg({ updateId: 551, msgId: 951, text: '', skipped: { reason: 'non_text' } });
    expect(h.sys.pipeline.inbound(skipped)).toBeUndefined();
    // The bridge still records it (the offset must move past it); reconcile owes nothing for it.
    await h.sys.ledger.recordInbound(skipped);
    await h.clock.advance(11 * 60_000);
    expect(await h.sys.ledger.reconcile(h.clock.epochMs())).toEqual([]);
    expect(h.model.calls).toHaveLength(0);
    // A skip is not contact: it must not mute the heartbeat mutex.
    expect(h.sys.pipeline.lastInboundAtMs()).toBeUndefined();
    const skips: string[] = [];
    for await (const e of h.sys.events.replay()) if (e.kind === 'bridge.update_skipped') skips.push((e.payload as { reason: string }).reason);
    expect(skips).toEqual(['non_text']);
    await h.sys.stop();
  });

  it('a model-authored defer lands ONE ledger row with dueBy — the turn no longer throws (Phase 1)', { timeout: 30_000 }, async () => {
    const h = await bootApp();
    const handle = startThead(h.sys);
    h.model.enqueue({ content: decisionJson({ plan: 'defer', bubbles: [] }) });
    enqueueAppraisal(h.model);
    h.channel.queueInbound(inboundMsg({ updateId: 561, msgId: 961, text: 'no rush, tell me tomorrow' }));
    await settle();
    await runToQuiescent(h);
    const failed: string[] = [];
    for await (const e of h.sys.events.replay()) if (e.kind === 'incident.turn_failed') failed.push(e.kind);
    expect(failed).toEqual([]);
    const rows = [];
    for await (const r of h.sys.ledger.read()) if (r.kind === 'decision') rows.push(r);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ plan: 'defer', decidedBy: 'model' });
    expect(typeof (rows[0] as { dueBy?: number }).dueBy).toBe('number');
    // Clean while the defer is not yet due.
    expect(await h.sys.ledger.reconcile(h.clock.epochMs())).toEqual([]);
    await handle.stop();
  });

  it('a failure silence is recorded with provenance and stays OWED after the window', { timeout: 30_000 }, async () => {
    const h = await bootApp();
    const handle = startThead(h.sys);
    h.model.enqueue({ content: '' }); // assess: nothing
    h.model.enqueue({ content: '' }); // repair: nothing
    h.channel.queueInbound(inboundMsg({ updateId: 571, msgId: 971, text: 'are you there' }));
    await settle();
    await runToQuiescent(h);
    const rows = [];
    for await (const r of h.sys.ledger.read()) if (r.kind === 'decision') rows.push(r);
    expect(rows.at(-1)).toMatchObject({ plan: 'silent', decidedBy: 'failure' });
    await h.clock.advance(11 * 60_000);
    const lost = (await h.sys.ledger.reconcile(h.clock.epochMs())).filter((d) => d.kind === 'LOST_REPLY');
    expect(lost).toHaveLength(1);
    await handle.stop();
  });

  it('a reaction-only update is an outcome signal, never a turn', { timeout: 30_000 }, async () => {
    const h = await bootApp();
    const handle = startThead(h.sys);
    h.channel.injectReaction({ emoji: '❤️', toMsgId: 900 });
    await settle();
    await runToQuiescent(h);
    expect(h.model.calls).toHaveLength(0);
    expect(h.sys.pipeline.lastDecision()).toBeNull();
    const reactions: string[] = [];
    for await (const e of h.sys.events.replay()) if (e.kind === 'memory.reaction') reactions.push((e.payload as { emoji: string }).emoji);
    expect(reactions).toEqual(['❤️']);
    await handle.stop();
  });
});

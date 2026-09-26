// v9 W2 hands: the camera works detached and really delivers (ledger row, a
// line she remembers, her wallet charged only for what she chose); a failed
// picture comes back to her as something that happened; the web fetcher
// never reaches the box's own services; reminders fire; her past is searchable.

import { describe, expect, it } from 'vitest';
import { startThead } from '../../src/app/index.js';
import { assertPublicUrl, isPrivateAddress, parseWhen, searchWords } from '../../src/body/index.js';
import { inbound, moment, runToQuiescent, T0 } from '../mind/helpers.js';
import { bootV9, fakeFal } from './helpers.js';

const appraisal = { toolCalls: [{ id: 'a1', name: 'emit', args: { event: [], self: [], outcome_prev: null, concerns: [], importance: 4 } }] };
const decide = (bubbles: string[]) => ({
  toolCalls: [{ id: 'd1', name: 'decide', args: { plan: 'reply', bubbles, confidence: 0.8, weight: 0.6, reluctance: 0.1, completeness: 1 } }],
});

describe('v9 camera', () => {
  it('a selfie is taken detached, arrives on its own with her caption, lands on the ledger and in her window; for him = on the house', { timeout: 60_000 }, async () => {
    const fal = fakeFal();
    const h = await bootV9({}, { fal });
    h.model.enqueue({ toolCalls: [{ id: 's1', name: 'selfie', args: { scene: 'on the balcony at dusk, oversized navy sweater', shot: 'golden', caption: 'for you', for_him: true } }] });
    h.model.enqueue(decide(['hold on, taking one']));
    h.model.enqueue(appraisal);
    const handle = startThead(h.sys);
    h.channel.queueInbound(inbound({ text: 'send me a selfie' }));
    await runToQuiescent(h);
    await h.sys.body!.jobs.idle();

    expect(h.channel.outbound().map((s) => s.text)).toEqual(['hold on, taking one']);
    const media = h.channel.bodyActs().filter((a) => a.kind === 'media');
    expect(media).toHaveLength(1);
    expect(media[0]!.kind === 'media' && media[0]!.media).toMatchObject({ kind: 'photo', caption: 'for you' });
    expect(fal.calls[0]!.model).toBe('fal-ai/flux-2-pro'); // no refs in a fresh house → plain generate
    expect(String(fal.calls[0]!.input['prompt'])).toContain('golden-hour');
    const w = h.sys.body!.wallet.status();
    expect(w.houseSpent).toBeGreaterThan(0);
    expect(w.hersSpent).toBe(0);
    const win = h.sys.window.messages().map((m) => String(m.content));
    expect(win.some((c) => c.startsWith('(you sent him a selfie)'))).toBe(true);
    await handle.stop();
  });

  it('a picture that fails comes back to her as a moment she lives (a self-entry turn), never silently', { timeout: 60_000 }, async () => {
    const fal = fakeFal({ fail: 'fal flux: HTTP 500 upstream' });
    const h = await bootV9({}, { fal });
    h.model.enqueue({ toolCalls: [{ id: 'i1', name: 'imagine', args: { prompt: 'a lighthouse made of sea glass' } }] });
    h.model.enqueue(decide(['making you something']));
    h.model.enqueue(appraisal);
    // the self-entry turn that follows the failure
    h.model.enqueue(decide(["ugh, the picture didn't come out. i'll try again later"]));
    h.model.enqueue(appraisal);
    const handle = startThead(h.sys);
    h.channel.queueInbound(inbound({ text: 'make me something' }));
    await runToQuiescent(h);
    await h.sys.body!.jobs.idle();
    await runToQuiescent(h);
    // the self-entry turn (its own task class) carried the failure as what happened
    const selfTurn = h.model.calls.find((c) => c.messages.some((m) => m.role === 'user' && String(m.content).includes("didn't come out")));
    expect(selfTurn).toBeDefined();
    expect(String(selfTurn!.messages.filter((m) => m.role === 'user').slice(-1)[0]?.content)).toContain('fal flux: HTTP 500 upstream');
    expect(h.channel.outbound().map((s) => s.text)).toContain("ugh, the picture didn't come out. i'll try again later");
    expect(h.sys.body!.wallet.status().hersSpent).toBe(0); // nothing charged for a failure
    await handle.stop();
  });
});

describe('v9 web guard', () => {
  it('private, loopback, link-local and tailnet addresses are not the public internet', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.178.97', '172.20.0.5', '169.254.169.254', '100.101.102.103', '::1', 'fd00::1', '0.0.0.0']) expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ['1.1.1.1', '104.16.132.229', '2606:4700::6810:84e5']) expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it('web_fetch refuses the box itself (localhost, a host resolving to 127.x, the tailnet) before any request', async () => {
    const resolve = async (h: string): Promise<string[]> => (h === 'sneaky.example' ? ['127.0.0.1'] : ['93.184.216.34']);
    await expect(assertPublicUrl('http://localhost:3456/api/state', resolve)).rejects.toThrow('not on the public internet');
    await expect(assertPublicUrl('http://127.0.0.1:8432/navigate', resolve)).rejects.toThrow('not on the public internet');
    await expect(assertPublicUrl('https://sneaky.example/', resolve)).rejects.toThrow('not on the public internet');
    await expect(assertPublicUrl('http://anomalocaris.tail1234.ts.net/', resolve)).rejects.toThrow('not on the public internet');
    await expect(assertPublicUrl('file:///etc/passwd', resolve)).rejects.toThrow('only http and https');
    await expect(assertPublicUrl('https://example.com/page', resolve)).resolves.toBeInstanceOf(URL);
  });
});

describe('v9 life hands', () => {
  it('reminders: relative and zoned times parse; a time without its zone is refused (a guess)', () => {
    expect(parseWhen('in 45m', T0)).toBe(T0 + 45 * 60_000);
    expect(parseWhen('in 3h', T0)).toBe(T0 + 3 * 3_600_000);
    expect(parseWhen('in 2 days', T0)).toBe(T0 + 2 * 86_400_000);
    expect(parseWhen('2026-09-27T09:00:00+08:00', T0)).toBe(Date.parse('2026-09-27T01:00:00Z'));
    expect(parseWhen('2026-09-27T09:00:00', T0)).toBeUndefined();
    expect(parseWhen('tomorrow', T0)).toBeUndefined();
  });

  it('a reminder set in a turn fires later as a moment she lives', { timeout: 60_000 }, async () => {
    const h = await bootV9();
    const r = h.sys.body!.reminders.add('get the plane tickets', T0 + 60_000, T0);
    expect(h.sys.body!.reminders.pending()).toHaveLength(1);
    expect(h.sys.body!.reminders.takeDue(T0 + 30_000)).toHaveLength(0);
    const due = h.sys.body!.reminders.takeDue(T0 + 61_000);
    expect(due.map((x) => x.id)).toEqual([r.id]);
    expect(h.sys.body!.reminders.takeDue(T0 + 62_000)).toHaveLength(0); // at most once
  });

  it('session_search finds her real lines by exact words, newest first', async () => {
    const h = await bootV9({
      moments: [
        moment({ id: 'a', ts: T0 - 3 * 86_400_000, his: 'the codex is done', hers: ['send it to me'] }),
        moment({ id: 'b', ts: T0 - 86_400_000, his: 'i rewrote the codex intro', hers: ['finally'] }),
        moment({ id: 'c', ts: T0 - 2 * 86_400_000, his: 'dinner?', hers: ['pasta'] }),
      ],
    });
    const hits = searchWords(h.sys.mind, 'codex');
    expect(hits.map((m) => m.id)).toEqual(['b', 'a']);
    expect(searchWords(h.sys.mind, 'pasta', { who: 'him' })).toHaveLength(0);
  });
});

describe('v9 regression — tools called in the SAME reply as decide', () => {
  it('found live: "send me a selfie video" → [selfie, decide] in one reply; the selfie runs, it is not dropped', { timeout: 60_000 }, async () => {
    const fal = fakeFal();
    const h = await bootV9({}, { fal });
    h.model.enqueue({
      toolCalls: [
        { id: 's1', name: 'selfie', args: { scene: 'in my room, waving at the camera', caption: 'hi you', for_him: true } },
        { id: 'd1', name: 'decide', args: { plan: 'reply', bubbles: ['one sec, taking it'], confidence: 0.8, weight: 0.6, reluctance: 0.1, completeness: 1 } },
      ],
    });
    h.model.enqueue(appraisal);
    const handle = startThead(h.sys);
    h.channel.queueInbound(inbound({ text: 'send me a selfie' }));
    await runToQuiescent(h);
    await h.sys.body!.jobs.idle();
    expect(h.channel.outbound().map((s) => s.text)).toEqual(['one sec, taking it']);
    expect(fal.calls).toHaveLength(1);
    expect(h.channel.bodyActs().filter((a) => a.kind === 'media')).toHaveLength(1);
    expect(h.sys.pipeline.lastDecision()?.toolTrace.some((t) => JSON.stringify(t).includes('selfie'))).toBe(true);
    await handle.stop();
  });
});

describe('v9 regression — an information tool alongside decide gets a second look', () => {
  it('[session_search, decide] in one reply → the search runs and she decides again with the result', { timeout: 60_000 }, async () => {
    const h = await bootV9({ moments: [moment({ id: 'c9', ts: T0 - 86_400_000, his: 'the codex intro is done', hers: ['finally'] })] });
    h.model.enqueue({
      toolCalls: [
        { id: 'q1', name: 'session_search', args: { words: 'codex intro' } },
        { id: 'd1', name: 'decide', args: { plan: 'reply', bubbles: ['let me check'], confidence: 0.5, weight: 0.5, reluctance: 0.1, completeness: 0.5 } },
      ],
    });
    h.model.enqueue(decide(['you finished the codex intro yesterday']));
    h.model.enqueue(appraisal);
    const handle = startThead(h.sys);
    h.channel.queueInbound(inbound({ text: 'when did i finish the codex intro?' }));
    await runToQuiescent(h);
    expect(h.channel.outbound().map((s) => s.text)).toEqual(['you finished the codex intro yesterday']);
    const second = h.model.calls.filter((c) => c.taskClass === 'turn')[1]!;
    expect(second.messages.some((m) => m.role === 'tool' && String(m.content).includes('the codex intro is done'))).toBe(true);
    await handle.stop();
  });
});

describe('v9 regression — selfie then video in one turn', () => {
  it('make_video started while the selfie is still being made waits for it (found live: it failed on a file that did not exist yet)', { timeout: 60_000 }, async () => {
    const fal = fakeFal();
    const h = await bootV9({}, { fal });
    h.model.enqueue({
      toolCalls: [
        { id: 's1', name: 'selfie', args: { scene: 'in my room', send: false, for_him: true } },
        { id: 'v1', name: 'make_video', args: { motion: 'she waves', caption: 'for you', for_him: true } },
        { id: 'd1', name: 'decide', args: { plan: 'reply', bubbles: ['rendering it now'], confidence: 0.8, weight: 0.6, reluctance: 0.1, completeness: 1 } },
      ],
    });
    h.model.enqueue(appraisal);
    const handle = startThead(h.sys);
    h.channel.queueInbound(inbound({ text: 'send me a selfie video' }));
    await runToQuiescent(h);
    await h.sys.body!.jobs.idle();
    const video = h.channel.bodyActs().filter((a) => a.kind === 'media' && a.media.kind === 'video');
    expect(video).toHaveLength(1);
    expect(h.sys.body!.jobs.list().every((j) => j.status === 'done')).toBe(true);
    expect(fal.calls.map((c) => c.model)).toEqual(['fal-ai/flux-2-pro', 'fal-ai/kling-video/v2.5-turbo/standard/image-to-video']);
    await handle.stop();
  });

  it('a failure comes back to her once, not in a loop', { timeout: 60_000 }, async () => {
    const fal = fakeFal({ fail: 'fal: HTTP 422 content could not be processed' });
    const h = await bootV9({}, { fal });
    const speaker = () => ({ toolCalls: [{ id: 'i', name: 'imagine', args: { prompt: 'a lighthouse' } }, { id: 'd', name: 'decide', args: { plan: 'reply', bubbles: ['trying again'], confidence: 0.8, weight: 0.6, reluctance: 0.1, completeness: 1 } }] });
    h.model.onTask('turn', speaker);
    h.model.onTask('heartbeat-thought', speaker);
    h.model.onTask('appraisal', () => appraisal);
    const handle = startThead(h.sys);
    h.channel.queueInbound(inbound({ text: 'make me something' }));
    for (let i = 0; i < 6; i++) {
      await runToQuiescent(h);
      await h.sys.body!.jobs.idle();
    }
    // the first failure is lived once; her retry fails too, and that one is only logged
    expect(fal.calls.length).toBe(2);
    await handle.stop();
  });
});

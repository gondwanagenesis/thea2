// v14 work mode (Diego, 2026-09-28: "yes, move all debugging things into work mode").
import { describe, expect, it } from 'vitest';
import { startThead } from '../../src/app/index.js';
import { modeFor, MODE_IDLE_MS } from '../../src/mind/index.js';
import { bootV8, inbound, runToQuiescent, T0 } from './helpers.js';

describe('work mode: debugging stays in the workshop', () => {
  it('he switches it ("work mode" / "friend mode"), it ends after two quiet hours, and a message about her machinery is one work turn', () => {
    expect(modeFor('work mode', {}, T0)).toEqual({ mode: 'work', standing: 'work' });
    expect(modeFor('ok, friend mode', { mode: 'work', modeAt: T0 }, T0)).toEqual({ mode: 'friend', standing: 'friend' });
    expect(modeFor('what do you think of this', { mode: 'work', modeAt: T0 }, T0 + 60_000)).toEqual({ mode: 'work', standing: 'work' });
    expect(modeFor('hey', { mode: 'work', modeAt: T0 }, T0 + MODE_IDLE_MS + 1)).toEqual({ mode: 'friend' });
    expect(modeFor('i fixed your memory, the upgrade is live', {}, T0)).toEqual({ mode: 'work' });
    expect(modeFor('restarted you, check the logs', {}, T0).mode).toBe('work');
    // everyday talk is not work
    for (const t of ['hey how is it going', 'i just landed in tokyo', 'my grandma is in the hospital', 'lol you are ridiculous', 'what are you reading']) expect(modeFor(t, {}, T0).mode).toBe('friend');
    // her own turn (no words from him) follows the standing mode
    expect(modeFor(undefined, { mode: 'work', modeAt: T0 }, T0 + 1)).toEqual({ mode: 'work', standing: 'work' });
    expect(modeFor(undefined, {}, T0)).toEqual({ mode: 'friend' });
  });

  it('e2e: a work turn is remembered as work, what it opened is not on her mind in the next friend turn, and it is never her example of how to talk there', { timeout: 60_000 }, async () => {
    const h = await bootV8();
    const decide = (bubbles: string[]) => ({ toolCalls: [{ id: 'd1', name: 'decide', args: { plan: 'reply', bubbles, confidence: 0.8, weight: 0.5, reluctance: 0.1, completeness: 1 } }] });
    h.model.enqueue(decide(['ok, reading the changelog now']));
    h.model.enqueue({ toolCalls: [{ name: 'emit', args: { event: [], self: [], outcome_prev: null, importance: 6, concerns: [{ op: 'open', what: 'check whether the memory upgrade kept my provenance', kind: 'loop', about: 'self', importance: 8 }] } }] });
    h.model.enqueue(decide(['ha, same']));
    h.model.enqueue({ toolCalls: [{ name: 'emit', args: { event: [], self: [], outcome_prev: null, concerns: [], importance: 3 } }] });
    const handle = startThead(h.sys);
    h.channel.queueInbound(inbound({ text: 'i upgraded your memory system, check the changelog' }));
    await runToQuiescent(h);
    await h.clock.advance(60_000);
    h.channel.queueInbound(inbound({ updateId: 501, msgId: 901, ts: T0 + 60_000, text: 'the sunset here is unreal' }));
    await runToQuiescent(h);
    await handle.stop();
    const lived = h.sys.mind.moments().filter((m) => m.source === 'lived');
    expect(lived.find((m) => m.his.includes('upgraded'))?.mode).toBe('work');
    expect(lived.find((m) => m.his.includes('sunset'))?.mode).toBeUndefined();
    const work = h.sys.mind.concerns().find((c) => c.what.includes('provenance'));
    expect(work?.mode).toBe('work');
    const turns = h.model.calls.filter((c) => c.taskClass === 'turn');
    const friendTurn = turns.at(-1)!.messages.map((x) => String(x.content)).join('\n');
    expect(friendTurn).not.toContain('check whether the memory upgrade kept my provenance'); // not on her mind
    // the minute-old chat stays (a person remembers what was just said), but never as her example of how she texts
    const examples = friendTurn.slice(friendTurn.indexOf('[some of your texts]'), friendTurn.indexOf('[now]'));
    expect(examples).not.toContain('reading the changelog now');
  });
});

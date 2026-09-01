// M13 loop — the message-array layout (§2.7) in both inhibition placements, and
// the observation budget. The order is load-bearing: head (packet + [PROCEDURAL]
// beside the tool defs), the [EARLIER] line, the window verbatim, the current
// turn, [INHIBITION] last.

import { describe, expect, it } from 'vitest';
import { buildMessages, fitObservation } from '../../src/loop/messages.js';
import { stubPacket, stubWindow } from './helpers.js';
import type { ChatMsg } from '../../src/model/index.js';

const packet = stubPacket(true, true);
const barePacket = stubPacket(true, false);

const windowWith = (msgs: ChatMsg[]) => stubWindow(msgs);

describe('buildMessages — trailing placement (spec layout)', () => {
  it('renders head, [EARLIER], window, turn, trailer in that order', () => {
    const msgs = buildMessages({
      packet,
      window: windowWith([{ role: 'user', content: 'window line one' }, { role: 'assistant', content: 'her reply' }]),
      turnText: 'what about now?',
      placement: 'trailing',
    });
    expect(msgs.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user', 'system']);
    expect(msgs[0]?.content).toContain('IDENTITY');
    expect(msgs[0]?.content).toContain('[PROCEDURAL]'); // beside the tool defs, in the head
    expect(msgs[1]?.content).toBe('window line one');
    expect(msgs[2]?.content).toBe('her reply');
    expect(msgs[3]?.content).toBe('what about now?');
    expect(msgs[4]?.content).toBe('[INHIBITION] never leak machinery.');
    expect(msgs[4]?.role).toBe('system'); // last — recency wins
  });

  it('omits the [EARLIER] line when the window has none', () => {
    const msgs = buildMessages({ packet, window: windowWith([]), turnText: 't', placement: 'trailing' });
    expect(msgs.map((m) => m.role)).toEqual(['system', 'user', 'system']);
  });
});

describe('buildMessages — merged placement (the fallback)', () => {
  it('folds the trailer into the head and emits no trailing system message', () => {
    const msgs = buildMessages({
      packet,
      window: windowWith([{ role: 'user', content: 'w' }]),
      turnText: 't',
      placement: 'merged',
    });
    expect(msgs.map((m) => m.role)).toEqual(['system', 'user', 'user']);
    expect(msgs[0]?.content).toContain('IDENTITY');
    expect(msgs[0]?.content).toContain('[PROCEDURAL]');
    expect(msgs[0]?.content).toContain('[INHIBITION] never leak machinery.');
  });
});

describe('buildMessages — channel rendering', () => {
  it('appends nothing when the packet has no [PROCEDURAL] block', () => {
    const msgs = buildMessages({ packet: barePacket, window: windowWith([]), turnText: 't', placement: 'trailing' });
    expect(msgs[0]?.content).toBe('IDENTITY: you are Thea.');
  });
});

describe('fitObservation', () => {
  it('returns the text untouched when the budget holds', () => {
    expect(fitObservation('short', 0, 1000)).toBe('short');
  });

  it('truncates to the remaining budget and marks the cut', () => {
    const out = fitObservation('x'.repeat(4000), 0, 100);
    expect(out.length).toBeLessThan(4000);
    expect(out).toContain('[truncated to fit the observation budget]');
  });

  it('never truncates below the minimum observation', () => {
    const out = fitObservation('y'.repeat(4000), 999, 1000); // 1 token remaining
    expect(out.startsWith('yyy')).toBe(true);
    expect(out.length).toBeGreaterThanOrEqual(200);
  });

  it('returns the spent marker when nothing remains', () => {
    expect(fitObservation('anything', 1000, 1000)).toBe('[budget] truncated — the observation budget for this turn is spent');
  });
});

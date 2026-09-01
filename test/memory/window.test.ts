// test/memory — the rolling session window: the min(last 30 messages, 10k
// tokens) cap, the ≥20-message eviction summarizer with its cached [EARLIER]
// line, the 4h session break, persistence, and the graceful summarizer failure.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TestClock } from '../../src/kernel/index.js';
import { MockModel } from '../../src/model/index.js';
import { SESSION_BREAK_MS, WINDOW_SUMMARY_INCIDENT, openSessionWindow } from '../../src/memory/index.js';
import type { WindowMsg } from '../../src/memory/index.js';
import { memoryLog, tmpDir, rmDir, wmsg } from './helpers.js';

/** A short turn in an alternating dialogue: odd = he speaks, even = she does. */
const short = (ts: number, n: number): WindowMsg =>
  wmsg({ ts, content: `msg ${n}`, role: n % 2 === 0 ? 'assistant' : 'user' });

describe('the cap — min(last 30 messages, 10k tokens)', () => {
  it('keeps the last 30 and holds the evicted span pending, summarizing nothing yet', async () => {
    const dir = tmpDir('win-cap');
    const clock = new TestClock(0);
    const model = new MockModel({ clock });
    const w = openSessionWindow(dir, { model, clock, events: memoryLog().log });
    for (let i = 1; i <= 35; i++) await w.push(short(i, i));

    expect(w.messages()).toHaveLength(30);
    expect(w.messages()[0]!.content).toBe('msg 6'); // head evicted first
    expect(w.messages()[29]!.content).toBe('msg 35');
    expect(w.earlier()).toBeNull(); // 5 pending < 20: no summarizer ran
    expect(model.calls).toHaveLength(0);
    rmDir(dir);
  });

  it('evicts on the token ceiling alone, not just message count', async () => {
    const dir = tmpDir('win-tokens');
    const clock = new TestClock(0);
    const model = new MockModel({ clock });
    const w = openSessionWindow(dir, { model, clock, events: memoryLog().log });
    for (let i = 1; i <= 11; i++) await w.push(wmsg({ ts: i, content: 'x'.repeat(4000) })); // 1000 tokens each

    // 11 × 1000 = 11000 > 10000 → one eviction → exactly 10000 remains
    expect(w.messages()).toHaveLength(10);
    expect(w.earlier()).toBeNull();
    rmDir(dir);
  });

  it('refuses a message that is neither user nor assistant (verbatim chat only)', async () => {
    const dir = tmpDir('win-role');
    const clock = new TestClock(0);
    const w = openSessionWindow(dir, { model: new MockModel({ clock }), clock, events: memoryLog().log });
    await expect(
      w.push({ ...wmsg({ ts: 1 }), role: 'tool' as WindowMsg['role'] }),
    ).rejects.toMatchObject({ code: 'memory/window-role' });
    rmDir(dir);
  });
});

describe('the eviction summarizer', () => {
  it('summarizes once at 20 evicted messages and caches the [EARLIER] line', async () => {
    const dir = tmpDir('win-summary');
    const clock = new TestClock(0);
    const { log, events } = memoryLog();
    const model = new MockModel({ clock, log });
    model.enqueue({ content: 'he asked about the jazz tickets and she said friday works' });
    const w = openSessionWindow(dir, { model, clock, events: log });
    for (let i = 1; i <= 50; i++) await w.push(short(i, i));

    expect(w.messages()).toHaveLength(30);
    expect(w.earlier()).toBe('[EARLIER] he asked about the jazz tickets and she said friday works');
    expect(model.calls).toHaveLength(1);
    const req = model.calls[0]!;
    expect(req.taskClass).toBe('summarize');
    expect(req.tier).toBe('cheap');
    expect(req.schema).toBeUndefined();
    const prompt = req.messages[1]!.content;
    expect(prompt).toContain('Earlier context so far: (none)');
    expect(prompt).toContain('- he: msg 1'); // span in eviction order, speaker-labelled
    expect(prompt).toContain('- she: msg 2');
    expect(prompt).toContain('- she: msg 20');
    expect(prompt).not.toContain('msg 21');

    // the call is on the L0 too, and the continuity line came out typed
    expect(events.filter((e) => e.kind === 'model.call')).toHaveLength(1);
    rmDir(dir);
  });

  it('reuses the cached line until the NEXT full span evicts, folding it into the next prompt', async () => {
    const dir = tmpDir('win-cache');
    const clock = new TestClock(0);
    const model = new MockModel({ clock });
    model.enqueue({ content: 'first continuity line' });
    model.enqueue({ content: 'second continuity line' });
    const w = openSessionWindow(dir, { model, clock, events: memoryLog().log });
    for (let i = 1; i <= 50; i++) await w.push(short(i, i));
    expect(model.calls).toHaveLength(1);

    for (let i = 51; i <= 55; i++) await w.push(short(i, i)); // 5 pending < 20
    expect(model.calls).toHaveLength(1); // cache held
    expect(w.earlier()).toBe('[EARLIER] first continuity line');

    for (let i = 56; i <= 70; i++) await w.push(short(i, i)); // 20 pending → new span
    expect(model.calls).toHaveLength(2);
    expect(model.calls[1]!.messages[1]!.content).toContain(
      'Earlier context so far: [EARLIER] first continuity line',
    );
    expect(w.earlier()).toBe('[EARLIER] second continuity line');
    expect(w.messages()).toHaveLength(30);
    rmDir(dir);
  });

  it('sanitizes the model line to one line', async () => {
    const dir = tmpDir('win-sanitize');
    const clock = new TestClock(0);
    const model = new MockModel({ clock });
    model.enqueue({ content: '  wrapped\n\tnonsense\nline  ' });
    const w = openSessionWindow(dir, { model, clock, events: memoryLog().log });
    for (let i = 1; i <= 50; i++) await w.push(short(i, i));
    expect(w.earlier()).toBe('[EARLIER] wrapped nonsense line');
    rmDir(dir);
  });

  it('degrades when the summarizer fails: span drops, incident fires, window keeps flowing', async () => {
    const dir = tmpDir('win-summary-fail');
    const clock = new TestClock(0);
    const model = new MockModel({ clock });
    model.enqueue({ error: { code: 'model/transport', message: 'dead' } });
    model.enqueue({ content: 'recovered continuity' });
    const { log, events } = memoryLog();
    const w = openSessionWindow(dir, { model, clock, events: log });
    for (let i = 1; i <= 50; i++) await w.push(short(i, i));

    expect(w.earlier()).toBeNull(); // nothing cached on failure
    const incidents = events.filter((e) => e.kind === WINDOW_SUMMARY_INCIDENT);
    expect(incidents).toHaveLength(1);
    expect(incidents[0]!.payload).toMatchObject({ spanMessages: 20, error: 'dead' });

    // the span was dropped, so the next 20 evictions are a fresh span that works
    for (let i = 51; i <= 70; i++) await w.push(short(i, i));
    expect(w.earlier()).toBe('[EARLIER] recovered continuity');
    expect(model.calls).toHaveLength(2);
    rmDir(dir);
  });

  it('treats an empty summarizer line as a failure', async () => {
    const dir = tmpDir('win-summary-empty');
    const clock = new TestClock(0);
    const model = new MockModel({ clock });
    model.enqueue({ content: '   \n  ' });
    const { log, events } = memoryLog();
    const w = openSessionWindow(dir, { model, clock, events: log });
    for (let i = 1; i <= 50; i++) await w.push(short(i, i));
    expect(w.earlier()).toBeNull();
    expect(events.filter((e) => e.kind === WINDOW_SUMMARY_INCIDENT)).toHaveLength(1);
    rmDir(dir);
  });
});

describe('the 4h session break', () => {
  it('breaks at exactly 4h of silence, keeping only the continuity line', async () => {
    const dir = tmpDir('win-break');
    const clock = new TestClock(0);
    const model = new MockModel({ clock });
    model.enqueue({ content: 'pre-break continuity' });
    const w = openSessionWindow(dir, { model, clock, events: memoryLog().log });
    for (let i = 1; i <= 50; i++) await w.push(short(i, i)); // summary now cached, 30 in window
    await w.push(short(2 * SESSION_BREAK_MS, 51));

    expect(w.messages()).toEqual([{ role: 'user', content: 'msg 51' }]);
    expect(w.earlier()).toBe('[EARLIER] pre-break continuity'); // continuity survives the break
    rmDir(dir);
  });

  it('does not break just short of 4h', async () => {
    const dir = tmpDir('win-nobreak');
    const clock = new TestClock(0);
    const w = openSessionWindow(dir, { model: new MockModel({ clock }), clock, events: memoryLog().log });
    await w.push(short(0, 1));
    await w.push(short(SESSION_BREAK_MS - 1, 2));
    expect(w.messages()).toHaveLength(2);
    rmDir(dir);
  });
});

describe('persistence and boot', () => {
  it('fails loudly when a sync read beats the async boot', () => {
    const dir = tmpDir('win-boot');
    const clock = new TestClock(0);
    const w = openSessionWindow(dir, { model: new MockModel({ clock }), clock, events: memoryLog().log });
    expect(() => w.messages()).toThrowError(expect.objectContaining({ code: 'memory/window-not-booted' }));
    expect(() => w.earlier()).toThrowError(expect.objectContaining({ code: 'memory/window-not-booted' }));
    rmDir(dir);
  });

  it('reopens with its messages and cached line intact', async () => {
    const dir = tmpDir('win-reopen');
    const clock = new TestClock(0);
    const model = new MockModel({ clock });
    model.enqueue({ content: 'kept continuity' });
    const first = openSessionWindow(dir, { model, clock, events: memoryLog().log });
    for (let i = 1; i <= 50; i++) await first.push(short(i, i)); // 20 evicted → summary
    const before = first.messages();
    expect(before).toHaveLength(30);

    const second = openSessionWindow(dir, { model, clock, events: memoryLog().log });
    // a sync read still needs the boot to land: push one more to await it
    await second.push(short(1_000, 51));
    expect(second.messages()).toEqual([...before.slice(1), { role: 'user', content: 'msg 51' }]);
    expect(second.earlier()).toBe('[EARLIER] kept continuity');
    rmDir(dir);
  });

  it('refuses a corrupt state file instead of silently restarting the conversation', async () => {
    const dir = tmpDir('win-corrupt');
    fs.writeFileSync(path.join(dir, 'window.json'), '{broken', 'utf8');
    const clock = new TestClock(0);
    const w = openSessionWindow(dir, { model: new MockModel({ clock }), clock, events: memoryLog().log });
    await expect(w.push(short(1, 1))).rejects.toMatchObject({ code: 'memory/window-corrupt' });
    rmDir(dir);
  });
});

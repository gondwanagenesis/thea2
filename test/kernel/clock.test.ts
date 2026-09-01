import { describe, expect, it } from 'vitest';
import { TestClock, SystemClock } from '../../src/kernel/clock.js';
import { makeRng } from '../../src/kernel/rng.js';

describe('TestClock', () => {
  it('fires waiters in exact due order over a simulated week of mixed waits', async () => {
    const clock = new TestClock(0);
    const rng = makeRng('clock-order');
    const fired: Array<{ label: number; at: number }> = [];

    // 300 waiters over a week, with deliberate duplicates of due times.
    const waits = Array.from({ length: 300 }, (_, i) => ({
      label: i,
      due: rng.int(0, 7 * 24 * 3600 * 1000),
    }));
    waits.push({ label: 900, due: waits[5]!.due }); // forced tie
    waits.push({ label: 901, due: waits[5]!.due }); // another tie, later registration

    const ps = waits.map((w) =>
      clock.waitUntil(w.due).then(() => fired.push({ label: w.label, at: clock.epochMs() })),
    );
    await clock.advance(7 * 24 * 3600 * 1000);
    await Promise.all(ps);

    expect(fired).toHaveLength(waits.length);
    for (let i = 1; i < fired.length; i++) {
      expect(fired[i]!.at).toBeGreaterThanOrEqual(fired[i - 1]!.at);
    }
    // Ties resolve in registration order: label 5 before its forced ties.
    const first5 = fired.findIndex((f) => f.label === 5)!;
    const tie900 = fired.findIndex((f) => f.label === 900)!;
    const tie901 = fired.findIndex((f) => f.label === 901)!;
    expect(first5).toBeLessThan(tie900);
    expect(tie900).toBeLessThan(tie901);
  });

  it('resolves waitUntil in the past on next tick and never before advance', async () => {
    const clock = new TestClock(100);
    let fired = 0;
    const p = clock.waitUntil(50).then(() => fired++);
    expect(fired).toBe(0);
    await Promise.resolve();
    await Promise.resolve();
    expect(fired).toBe(1); // past-due resolves without advance
    await p;

    let deferred = 0;
    const q = clock.waitUntil(200).then(() => deferred++);
    await Promise.resolve();
    await Promise.resolve();
    expect(deferred).toBe(0); // future due does not fire early
    await clock.advance(100);
    expect(deferred).toBe(1);
    await q;
  });

  it('rejects aborted waiters with code aborted, never leaving them dangling', async () => {
    const clock = new TestClock(0);
    const ac = new AbortController();
    const p = clock.waitUntil(1000, ac.signal);
    ac.abort();
    await expect(p).rejects.toMatchObject({ code: 'aborted' });

    // Aborted while queued inside advance: abort first, then advance must
    // reject the queued waiter instead of firing it.
    const ac2 = new AbortController();
    const q = clock.waitUntil(500, ac2.signal);
    ac2.abort();
    const adv = clock.advance(2000);
    await expect(q).rejects.toMatchObject({ code: 'aborted' });
    await adv;
  });
});

describe('SystemClock', () => {
  it('waitUntil in the past resolves immediately', async () => {
    const clock = new SystemClock();
    await expect(clock.waitUntil(clock.epochMs() - 1000)).resolves.toBeUndefined();
  });
});

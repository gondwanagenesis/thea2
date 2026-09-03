import { describe, expect, it, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { openEventLog, project, writeEventsFileRaw } from '../../src/events/index.js';
import { TestClock } from '../../src/kernel/clock.js';

let dir: string;
const fresh = (): string => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thea2-events-'));
  return dir;
};
afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

describe('openEventLog', () => {
  it('seq is strictly increasing across three simulated days including two restarts', async () => {
    const clock = new TestClock(Date.UTC(2026, 8, 1, 0, 0, 0));
    let log = openEventLog(fresh(), { clock });
    await log.emit('model.call', { n: 1 });
    await log.emit('model.call', { n: 2 });

    // Restart 1 (new instance, same dir) + day rollover.
    await clock.advance(24 * 3600 * 1000);
    log = openEventLog(dir, { clock });
    await log.emit('affect.snapshot', { n: 3 });

    // Restart 2 + another rollover.
    await clock.advance(24 * 3600 * 1000);
    log = openEventLog(dir, { clock });
    await log.emit('sched.job_run', { n: 4 });

    const seqs: number[] = [];
    for await (const ev of openEventLog(dir, { clock }).replay()) seqs.push(ev.seq);
    expect(seqs).toEqual([1, 2, 3, 4]);
  });

  it('replay filters: kinds exact-match, sinceTs inclusive, order preserved', async () => {
    const clock = new TestClock(1000);
    const log = openEventLog(fresh(), { clock });
    await log.emit('model.call', { i: 1 });
    await clock.advance(10);
    await log.emit('affect.snapshot', { i: 2 });
    await clock.advance(10);
    await log.emit('model.call', { i: 3 });

    const kinds: number[] = [];
    for await (const ev of log.replay({ kinds: ['model.call'] })) kinds.push((ev.payload as { i: number }).i);
    expect(kinds).toEqual([1, 3]);

    const since: number[] = [];
    for await (const ev of log.replay({ sinceTs: 1010 })) since.push((ev.payload as { i: number }).i);
    expect(since).toEqual([2, 3]); // inclusive cut
  });

  it('projection fold is deterministic across repeated runs', async () => {
    const clock = new TestClock(0);
    const log = openEventLog(fresh(), { clock });
    for (let i = 0; i < 20; i++) await log.emit('model.call', { i });

    const fold = async (): Promise<unknown> =>
      project(log, { total: 0, seen: [] as number[] }, (s, ev) => ({
        total: s.total + (ev.payload as { i: number }).i,
        seen: [...s.seen, (ev.payload as { i: number }).i],
      }));
    expect(await fold()).toEqual(await fold());
  });

  it('crash tail on the newest file: reopen skips the torn line, no gap, no duplicate', async () => {
    const clock = new TestClock(0);
    const d = fresh();
    const log = openEventLog(d, { clock });
    await log.emit('model.call', { i: 1 });
    await log.emit('model.call', { i: 2 });

    // Simulate a torn write: append a partial line directly.
    const file = fs.readdirSync(d).map((n) => path.join(d, n))[0]!;
    await fsp.appendFile(file, '{"seq":3,"ts":0,"kind":"model.call","payload":{"i":', 'utf8');

    const reopened = openEventLog(d, { clock });
    await reopened.emit('model.call', { i: 3 }); // torn seq reused
    const seqs: number[] = [];
    const seen: number[] = [];
    for await (const ev of reopened.replay()) {
      seqs.push(ev.seq);
      seen.push((ev.payload as { i: number }).i);
    }
    expect(seqs).toEqual([1, 2, 3]);
    expect(seen).toEqual([1, 2, 3]);
  });

  it('1k concurrent emits produce 1k distinct seqs and 1k parseable lines', { timeout: 60_000 }, async () => {
    const clock = new TestClock(0);
    const d = fresh();
    const log = openEventLog(d, { clock });
    await Promise.all(Array.from({ length: 1000 }, (_, i) => log.emit('model.call', { i })));
    const seqs = new Set<number>();
    let count = 0;
    for await (const ev of log.replay()) {
      seqs.add(ev.seq);
      count++;
    }
    expect(count).toBe(1000);
    expect(seqs.size).toBe(1000);
  });

  it('rejects oversized payloads with a typed error and writes nothing', async () => {
    const clock = new TestClock(0);
    const d = fresh();
    const log = openEventLog(d, { clock, maxPayloadBytes: 64 });
    await expect(log.emit('model.call', { blob: 'x'.repeat(200) })).rejects.toMatchObject({
      code: 'events/payload-too-large',
    });
    expect(fs.readdirSync(d)).toEqual([]);
  });

  it('rejects kinds without a dot-namespace', async () => {
    const clock = new TestClock(0);
    const log = openEventLog(fresh(), { clock });
    await expect(log.emit('noDots', {})).rejects.toMatchObject({ code: 'events/bad-kind' });
    await expect(log.emit('Model.Call', {})).rejects.toMatchObject({ code: 'events/bad-kind' });
  });
});

// Keep the raw-fixture helpers referenced (used by M10/M18 committed fixtures later).
void writeEventsFileRaw;

// The one-shot wake note (ops): his request, relayed honestly to her own self-initiated turn;
// "make sure she does" — retried if she stayed quiet, never while they are talking, then given up.

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { TestClock } from '../../src/kernel/index.js';
import type { EventLog } from '../../src/events/index.js';
import { wakeNoteGoal, wakeNoteJob, WAKE_NOTE_RETRY_MS } from '../../src/app/wake-note.js';
import { TELLING_PATTERNS } from '../../src/mind/index.js';
import { tmpDir } from '../mind/helpers.js';

const setup = (sentSeq: number[], talking = false) => {
  const dir = tmpDir('thea2-wake-');
  const file = join(dir, 'wake-note.json');
  fs.writeFileSync(file, JSON.stringify({ text: 'when the work on you was finished and you were back up, you would send him a message that it is all done.', from: 'diego, through the people working on you' }));
  const clock = new TestClock(1_790_000_000_000);
  const goals: string[] = [];
  const emitted: Array<{ k: string; p: unknown }> = [];
  const events = { emit: async (k: string, p: unknown) => void emitted.push({ k, p }), replay: async function* () {} } as unknown as EventLog;
  let k = 0;
  const job = wakeNoteJob({ file, clock, events, conversationActive: () => talking, selfEntry: (g) => (goals.push(g), { sent: Promise.resolve(sentSeq[k++] ?? 0) }) });
  return { file, clock, goals, emitted, job };
};

describe('wake note', () => {
  it('fires once she is up; done when she actually sent something', async () => {
    const s = setup([2]);
    await s.job.run();
    expect(s.goals).toHaveLength(1);
    expect(s.goals[0]).toMatch(/^\(diego, through the people working on you asked for this: /);
    expect(fs.existsSync(s.file)).toBe(false);
    expect(fs.existsSync(`${s.file}.done`)).toBe(true);
    await s.job.run();
    expect(s.goals).toHaveLength(1);
  });

  it('if she stays quiet it asks again ten minutes later; after three, it gives up loudly', async () => {
    const s = setup([0, 0, 0]);
    await s.job.run();
    await s.job.run(); // too soon
    expect(s.goals).toHaveLength(1);
    for (let i = 0; i < 3; i++) {
      await s.clock.advance(WAKE_NOTE_RETRY_MS);
      await s.job.run();
    }
    expect(s.goals).toHaveLength(3);
    expect(fs.existsSync(`${s.file}.failed`)).toBe(true);
    expect(s.emitted.some((e) => e.k === 'incident.wake_note_failed')).toBe(true);
  });

  it('never while they are talking; the goal tells her nothing about how she feels', async () => {
    const s = setup([1], true);
    await s.job.run();
    expect(s.goals).toHaveLength(0);
    const goal = wakeNoteGoal({ text: 'x', from: 'diego' });
    for (const re of TELLING_PATTERNS) expect(goal).not.toMatch(re);
  });
});

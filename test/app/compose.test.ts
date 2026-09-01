// M20 gate — composition: hermetic preset is fully closed (no real model, no
// network, no shared state), boot events name every stage, the unlanded stages
// are ABSENT (not stubbed), and shutdown settles cleanly.

import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { bootApp, settle } from './helpers.js';

describe('hermetic boot', () => {
  it('composes a closed system over a tmp var/ and emits the boot trail', async () => {
    const h = await bootApp();

    const boots: Array<Record<string, unknown>> = [];
    for await (const e of h.sys.events.replay()) {
      if (e.kind === 'app.boot') boots.push(e.payload as Record<string, unknown>);
    }
    expect(boots.map((b) => (b as { stage: string }).stage)).toEqual([
      'events', 'embedder', 'stores', 'gates', 'pipeline', 'scheduler', 'bridge',
    ]);

    // Hermetic doubles everywhere: the system never touched a live store.
    expect(h.sys.preset).toBe('hermetic');
    expect(h.sys.channel.limits.maxMsgChars).toBe(4096);
    expect(h.sys.paths.base).not.toContain('corpus');
    expect(existsSync(join(h.sys.paths.events))).toBe(true);

    // The real corpus was indexed (canon at repo cwd) — identity retrieval has
    // something to retrieve.
    expect(h.sys.corpus.all().length).toBeGreaterThan(0);
    // Unlanded stages are ABSENT (rule 5): the S5 scheduler runs no jobs.
    expect(h.sys.sched.runningJobs()).toEqual([]);
    await h.sys.stop();
  });

  it('stop() settles drains and is safe to call twice', async () => {
    const h = await bootApp();
    await h.sys.stop();
    await h.sys.stop(); // idempotent
    expect(h.sys.sched.runningJobs()).toEqual([]);
  });

  it('probeTarget() answers inbound over the pipeline and reports state', async () => {
    const h = await bootApp();
    const target = h.sys.probeTarget();
    const msg = {
      updateId: 501,
      msgId: 901,
      chatId: 861800000,
      ts: h.clock.epochMs(),
      text: 'probe: say one line about moss',
      speaker: { person: 'diego', channel: 'telegram' },
    };
    await target.inbound(msg);
    await target.quiesce();
    expect(target.outbound().length).toBe(0); // MockModel default = empty turn, silent
    expect(target.decision()).not.toBeNull();
    const st = target.state();
    expect(st.affect).toHaveLength(12);
    await h.sys.stop();
  });

  it('the pipeline is single-flight: a second inbound during a turn queues, never parallel-runs', async () => {
    const h = await bootApp();
    void h;
    // covered by pipeline.test.ts interruption suites; here just pin the flag
    expect(h.sys.pipeline.isBusy()).toBe(false);
    await settle(1);
  });
});

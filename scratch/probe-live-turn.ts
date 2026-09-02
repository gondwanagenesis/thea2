// Scratch — S8 live-turn proof: the full pipeline against the REAL model
// (Neuralwatt) with a FakeChannel. Proves the exact path Diego's "hi" took
// when it 401'd: ingest → assemble → GLM turn → gate → realize → outbound.
// Run from repo root with THEA2_MODEL_API_KEY set. Never touches live var/.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SystemClock } from '../src/kernel/index.js';
import { loadConfig } from '../src/app/config.js';
import { compose } from '../src/app/compose.js';

const main = async (): Promise<void> => {
  const cfg = loadConfig('thea2.config.yaml', process.env);
  const varDir = mkdtempSync(join(tmpdir(), 'thea2-probe-'));
  console.log('VARDIR:', varDir);
  // probe-harness defaults to TestClock(0); the post-decision settle window
  // waits on the clock, which never advances → the loop drains and node exits
  // 0 mid-turn. A real clock lets the drain resolve naturally.
  const sys = await compose(cfg, 'probe-harness', { varDir, clock: new SystemClock() });
  console.log('COMPOSED: jobs=', sys.jobCount, 'preset=', sys.preset);
  try {
    const target = sys.probeTarget();
    console.log('TARGET: feeding inbound');
    await target.inbound({
      updateId: 1,
      msgId: 1,
      chatId: sys.cfg.bridge.allowedChatIds[0]!,
      ts: sys.clock.epochMs(),
      text: 'hey — what are you up to?',
      speaker: { channel: 'telegram', person: `tg:${sys.cfg.bridge.allowedChatIds[0]}` },
    });
    const out = target.outbound();
    console.log('OUTBOUND_BUBBLES:', out.length);
    for (const b of out) console.log('  >', b.text.slice(0, 160));
    const d = target.decision();
    console.log('DECISION:', d === null ? 'null' : JSON.stringify({ said: d.said, veto: d.veto, dirty: d.dirty }));
    if (out.length === 0) {
      console.error('PROBE_FAIL: no outbound bubbles');
      process.exitCode = 1;
    } else {
      console.log('PROBE_OK');
    }
  } finally {
    await sys.stop();
  }
};

void main().catch((e: unknown) => {
  console.error('PROBE_ERROR:', e instanceof Error ? (e.stack ?? e.message) : String(e));
  process.exitCode = 1;
});

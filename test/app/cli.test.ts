// M20 gate — the CLI contract: usage, unbuilt verbs NAME their stage and exit
// nonzero (AGENTS rule 5), and the live verbs run against a real composition
// without touching the network.

import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cliMain, NOT_BUILT } from '../../src/app/index.js';
import { HERMETIC_ENV } from './helpers.js';

const io = () => {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out: (s: string) => out.push(s),
    err: (s: string) => err.push(s),
    text: () => ({ out: out.join('\n'), err: err.join('\n') }),
  };
};

const configPath = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'thea2-cli-'));
  const p = join(dir, 'thea2.config.yaml');
  writeFileSync(
    p,
    `models:
  endpoint: https://hermetic.invalid/v1
  tiers:
    main: mock-main
    cheap: mock-cheap
bridge:
  allowedChatIds: [861800000]
affect:
  statePath: var/affect/state.json
  quietHours: [1, 7]
sched:
  statePath: var/sched/state.json
budgets:
  packetTokens: 6000
  windowTokens: 10000
  turnTokens: 24000
inhibitionPlacement: trailing
gravity:
  seedWeight: 0.7
reconcile:
  lostReplyWindowMin: 10
embedder:
  kind: hash
`,
    'utf8',
  );
  return p;
};

describe('cli', () => {
  it('no verb prints usage and exits 1', async () => {
    const capture = io();
    const code = await cliMain([], {}, capture);
    expect(code).toBe(1);
    expect(capture.text().out).toContain('usage');
  });

  it.each(Object.entries(NOT_BUILT))('%s names its stage and exits nonzero', async (verb, stage) => {
    const capture = io();
    const code = await cliMain([verb], {}, capture);
    expect(code).toBe(1);
    expect(capture.text().err).toBe(`not built yet (stage ${stage})`);
  });

  it('an unknown verb is refused, not improvised', async () => {
    const capture = io();
    const code = await cliMain(['vibes'], {}, capture);
    expect(code).toBe(1);
    expect(capture.text().err).toContain("unknown verb 'vibes'");
  });

  it('status boots prod over the local config and reports state — no network', async () => {
    const capture = io();
    const code = await cliMain(['status', '--config', configPath()], HERMETIC_ENV, capture);
    expect(code).toBe(0);
    const t = capture.text();
    expect(t.out).toContain('corpus');
    expect(t.out).toContain('episodes');
    expect(t.out).toContain('tg offset');
    expect(t.out).toContain('sched jobs    0');
  });

  it('reconcile over a fresh install is clean', async () => {
    const capture = io();
    const code = await cliMain(['reconcile', '--config', configPath()], HERMETIC_ENV, capture);
    expect(code).toBe(0);
    expect(capture.text().out).toContain('reconcile: clean');
  });
});

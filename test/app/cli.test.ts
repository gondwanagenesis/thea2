// M20 gate — the CLI contract: usage, unbuilt verbs NAME their stage and exit
// nonzero (AGENTS rule 5), and the live verbs run against a real composition
// without touching the network.

import { describe, expect, it, afterEach, vi, type MockInstance } from 'vitest';
import * as fs from 'node:fs';
import { cpSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cliMain, NOT_BUILT } from '../../src/app/index.js';
import { withStderrMirror } from '../../src/app/compose.js';
import { SystemClock } from '../../src/kernel/index.js';
import { HERMETIC_ENV } from './helpers.js';

const { readdirSync, readFileSync } = fs;

let stderr: MockInstance | undefined;
const cwds: string[] = [];
const chdirInto = (dir: string): void => {
  cwds.push(process.cwd());
  process.chdir(dir);
};
afterEach(() => {
  // Only the doctor/ack tests chdir through this helper; the older tests
  // restore their own cwd in finally blocks.
  if (cwds.length > 0) process.chdir(cwds.pop()!);
  stderr?.mockRestore();
  stderr = undefined;
});

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

  it('status boots prod over the local config and reports state — no network', { timeout: 30_000 }, async () => {
    // Same isolation as reconcile below: a prod boot anchors var/ at the
    // process cwd, and the repo's own var/ belongs to a live thead.
    const dir = mkdtempSync(join(tmpdir(), 'thea2-cli-install-'));
    const cwd = process.cwd();
    cpSync(join(cwd, 'corpus'), join(dir, 'corpus'), { recursive: true });
    const coupling = join(cwd, 'coupling.yaml');
    if (existsSync(coupling)) cpSync(coupling, join(dir, 'coupling.yaml'));
    process.chdir(dir);
    try {
      const capture = io();
      const code = await cliMain(['status', '--config', configPath()], HERMETIC_ENV, capture);
      expect(code).toBe(0);
      const t = capture.text();
      expect(t.out).toContain('corpus');
      expect(t.out).toContain('episodes');
      expect(t.out).toContain('tg offset');
      expect(t.out).toContain('sched jobs    6'); // S6/S7 + reconcile + affect snapshot + the Ledger wire on every real boot
    } finally {
      process.chdir(cwd);
    }
  });

  it('reconcile over a fresh install is clean', { timeout: 30_000 }, async () => {
    // Isolation: compose anchors var/ AND corpus/ at the process cwd (the
    // documented S5 canon deviation), so run against a throwaway cwd with the
    // canon copied in — never the repo's own var/ledger, which a live thead
    // writes to and which may legitimately hold a LOST_REPLY.
    const dir = mkdtempSync(join(tmpdir(), 'thea2-cli-install-'));
    const cwd = process.cwd();
    cpSync(join(cwd, 'corpus'), join(dir, 'corpus'), { recursive: true });
    const coupling = join(cwd, 'coupling.yaml');
    if (existsSync(coupling)) cpSync(coupling, join(dir, 'coupling.yaml'));
    process.chdir(dir);
    try {
      const capture = io();
      const code = await cliMain(['reconcile', '--config', configPath()], HERMETIC_ENV, capture);
      expect(code).toBe(0);
      expect(capture.text().out).toContain('reconcile: clean');
    } finally {
      process.chdir(cwd);
    }
  });

  it('AC: ack writes an abandoned row — an operator abandon lands in var/ledger without composing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'thea2-cli-ack-'));
    chdirInto(dir);
    const capture = io();
    const code = await cliMain(['ack', '401'], {}, capture);
    expect(code).toBe(0);
    expect(capture.text().out).toContain('acked 401');

    const ledgerDir = join(dir, 'var', 'ledger');
    const file = readdirSync(ledgerDir).find((n) => n.startsWith('messages-') && n.endsWith('.jsonl'));
    expect(file).toBeDefined();
    const rows = readFileSync(join(ledgerDir, file!), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { kind: string; ts?: number; updateId?: number; reason?: string });
    expect(rows).toHaveLength(1); // exactly the abandon row, nothing else
    expect(rows[0]).toMatchObject({ kind: 'abandoned', updateId: 401, reason: 'operator' });
    expect(typeof rows[0]!.ts).toBe('number'); // stamped at write time
  });

  it('ack refuses a non-numeric update id', async () => {
    const capture = io();
    const code = await cliMain(['ack', 'not-an-id'], {}, capture);
    expect(code).toBe(1);
    expect(capture.text().err).toContain('ack requires a numeric update id');
  });

  it('AC: doctor opens no writer — read-only over var/, no mkdir, no lock, byte-identical tree after', async () => {
    const walk = (dir: string, rel = ''): string[] => {
      const out: string[] = [];
      for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
        const r = rel === '' ? e.name : join(rel, e.name);
        if (e.isDirectory()) out.push(...walk(dir, r));
        else out.push(`${r}::${readFileSync(join(dir, r), 'utf8')}`);
      }
      return out.sort();
    };

    // Case 1: no var/ at all — the doctor must NOT create anything.
    const bare = mkdtempSync(join(tmpdir(), 'thea2-doctor-bare-'));
    chdirInto(bare);
    const bareCapture = io();
    expect(await cliMain(['doctor'], {}, bareCapture)).toBe(1);
    expect(bareCapture.text().out).toContain('no var/');
    expect(existsSync(join(bare, 'var'))).toBe(false); // no mkdir, ever

    // Case 2: a fixture var/ — the doctor reads it and leaves it byte-identical.
    const dir = mkdtempSync(join(tmpdir(), 'thea2-doctor-'));
    // File names come from the same injected clock discipline the stores use
    // (the ledger/events rotate on the SystemClock's UTC date).
    const clock = new SystemClock();
    const now = clock.epochMs();
    const today = clock.now().toISOString().slice(0, 10);
    fs.mkdirSync(join(dir, 'var', 'ledger'), { recursive: true });
    fs.mkdirSync(join(dir, 'var', 'events'), { recursive: true });
    writeFileSync(
      join(dir, 'var', 'ledger', `messages-${today}.jsonl`),
      `${JSON.stringify({
        kind: 'inbound',
        ts: now - 2 * 3_600_000,
        msg: {
          updateId: 401,
          msgId: 7001,
          chatId: 861800000,
          ts: now - 2 * 3_600_000,
          text: 'sigues ahí?',
          speaker: { person: 'diego', channel: 'telegram' },
        },
      })}\n`,
      'utf8',
    );
    writeFileSync(
      join(dir, 'var', 'events', `events-${today}.jsonl`),
      [
        { seq: 1, ts: now - 30 * 60_000, kind: 'app.boot', payload: { stage: 'bridge', preset: 'prod' } },
        { seq: 2, ts: now - 3_600_000, kind: 'incident.reconcile_failed', payload: { error: 'x' } },
        { seq: 3, ts: now - 3_600_000, kind: 'model.call', payload: { tier: 'main' } },
      ]
        .map((r) => JSON.stringify(r))
        .join('\n') + '\n',
      'utf8',
    );
    const before = walk(dir);
    chdirInto(dir);
    const capture = io();
    const code = await cliMain(['doctor'], {}, capture);
    expect(code).toBe(0);
    expect(existsSync(join(dir, 'var', 'thead.pid'))).toBe(false); // no lock taken
    expect(walk(dir)).toEqual(before); // byte-identical: no snapshot write, no append, no mkdir

    const t = capture.text().out;
    expect(t).toContain('uptime'); // from the newest app.boot{bridge}
    expect(t).toContain('incident.reconcile_failed ×1'); // last 24h, model.call not an incident
    expect(t).toContain('open losses'); // the 2h-old unanswered inbound
    expect(t).toContain('update=401');
    expect(t).toContain('last backup'); // none on a dev box — said out loud, never guessed
  });

  it('AC: incident mirror writes one stderr line — incident.*, bridge.lost_reply, sched.alarm only', async () => {
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const events: Array<{ kind: string; payload: unknown }> = [];
    const mirrored = withStderrMirror({
      emit: async (kind, payload) => {
        events.push({ kind, payload });
      },
      replay: async function* () {},
    });
    await mirrored.emit('incident.turn_aborted', { code: 'deadline' });
    await mirrored.emit('bridge.lost_reply', { updateId: 1, chatId: 2, ageMs: 3, escalation: 'initial' });
    await mirrored.emit('sched.alarm', { job: 'reflect' });
    await mirrored.emit('model.call', { tier: 'main' });
    await mirrored.emit('bridge.send_failed', { chatId: 1, code: 'x', attempts: 1, error: 'y' });

    const lines = stderr.mock.calls.map(String).filter((l) => l.includes('<3>thea2'));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('incident.turn_aborted');
    expect(lines[0]).toContain('"code":"deadline"');
    expect(lines[1]).toContain('bridge.lost_reply');
    expect(lines[2]).toContain('sched.alarm');
    expect(events.map((e) => e.kind)).toEqual([
      'incident.turn_aborted',
      'bridge.lost_reply',
      'sched.alarm',
      'model.call',
      'bridge.send_failed',
    ]); // the mirror is transparent: every event still reaches L0
  });
});

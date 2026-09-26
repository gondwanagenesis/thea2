// scripts/v10-hands-probe.ts — the live proof that her hands work in a real
// turn and in a background cast, on the VPS, with NOTHING reaching Telegram.
//
// Runs the REAL v8 mind (real voice door, real embeddings, real appraisal) over
// a COPY of her var/ with a FakeChannel. It asks her to write a script and run
// it, and to hand a small build to a fork; it then checks that the file landed
// in the workspace copy, that she called the hands tools, and that what she did
// became an act on the lived moment. It uses her REAL hands (the exec broker if
// the socket is there; a local bash otherwise) against a THROWAWAY workspace
// inside the var copy, so her live workspace is never touched.
//
//   set -a; . /etc/thea2/keys.env; set +a
//   npx tsx scripts/v10-hands-probe.ts --var /opt/thea2/var

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadConfig, type ResolvedDoor } from '../src/app/config.js';
import { composeV8 } from '../src/app/compose-v8.js';
import { chatCore, createModelClient, makeRouter, zaiTransport, type ChatContext, type ChatRequest, type ModelClient } from '../src/model/index.js';
import { makeRng, SystemClock } from '../src/kernel/index.js';
import { FakeChannel, ingestUpdates, type InboundMsg } from '../src/bridge/index.js';
import { openEventLog } from '../src/events/index.js';

const argv = process.argv.slice(2);
const arg = (n: string, d?: string): string | undefined => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const SRC_VAR = arg('var', '/opt/thea2/var')!;
const CONFIG = arg('config', 'thea2.config.yaml')!;
const out = (s: string): void => process.stdout.write(`${s}\n`);

const main = async (): Promise<void> => {
  const cfg = loadConfig(CONFIG, process.env);
  const clock = new SystemClock();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'thea2-hands-probe-'));
  fs.cpSync(SRC_VAR, path.join(base, 'var'), { recursive: true });
  fs.rmSync(path.join(base, 'var', 'thead.lock'), { force: true });
  // a throwaway workspace + no workshop for the probe (the workshop is its own VPS probe)
  const workspace = path.join(base, 'var', 'workspace-probe');
  fs.rmSync(workspace, { recursive: true, force: true });
  if (cfg.body !== undefined) cfg.body.workspaceDir = 'var/workspace-probe';

  const probeLog = openEventLog(path.join(base, 'probe-events'), { clock });
  const rng = makeRng('v10-hands-probe');
  const doors = cfg.models.doors;
  const requests: ChatRequest[] = [];
  const clientFor = (voice: ResolvedDoor, name: string): ModelClient => {
    const send = (d: ResolvedDoor, n: string) => zaiTransport({ apiKey: d.apiKey, endpoint: d.endpoint, protocol: d.protocol, clock, rng: rng.fork(n) });
    const inner = createModelClient({
      log: probeLog,
      clock,
      core: chatCore({
        router: makeRouter({ log: probeLog, tiers: { main: voice.model, cheap: doors.mind.model, reasoning: doors.judge.model }, doors: { voice, mind: doors.mind, judge: doors.judge } }),
        doors: {
          main: { door: voice, send: send(voice, name) },
          cheap: { door: doors.mind, send: send(doors.mind, 'mind') },
          reasoning: { door: doors.judge, send: send(doors.judge, 'judge') },
        },
      }),
    });
    return {
      chat: async <T>(req: ChatRequest<T>, ctx?: ChatContext) => {
        requests.push(req as ChatRequest);
        const res = await inner.chat<T>(req, ctx);
        if (req.taskClass === 'turn' || req.taskClass === 'cast' || req.taskClass === 'heartbeat-thought') {
          out(`  [${req.taskClass}] called ${(res.toolCalls ?? []).map((c) => c.name).join(', ') || 'nothing'}${typeof res.content === 'string' && res.content.trim() !== '' ? ` + "${res.content.slice(0, 80)}"` : ''}`);
        }
        return res;
      },
    };
  };
  const channel = FakeChannel({ clock, chatId: cfg.bridge.allowedChatIds[0] ?? 0, files: {} });
  const sys = await composeV8(cfg, 'probe-harness', {
    varDir: base,
    clock,
    rng,
    model: clientFor(doors.voice, 'voice'),
    ...(doors.voiceFallback !== undefined ? { fallbackModel: clientFor(doors.voiceFallback, 'voiceFallback') } : {}),
    channel,
    jobs: [],
  });
  out(`probe var copy: ${base}`);
  out(`workspace: ${sys.body?.workspace.root}`);

  const chatId = cfg.bridge.allowedChatIds[0] ?? 0;
  const person = Object.keys(cfg.people)[0] ?? `tg:${chatId}`;
  let updateId = 9_200_000;
  let msgId = 92_000;
  const say = async (text: string): Promise<void> => {
    const before = channel.outbound().length;
    const m: InboundMsg = { updateId: ++updateId, msgId: ++msgId, chatId, ts: clock.epochMs(), text, speaker: { channel: 'telegram', person } };
    out(`\n>>> ${text}`);
    await ingestUpdates({ ledger: sys.ledger, offsets: sys.offsets, handle: (mm) => sys.pipeline.inbound(mm) }, [m]);
    await sys.pipeline.drain();
    if (sys.body !== undefined) {
      await sys.body.jobs.idle();
      await sys.pipeline.drain();
      await sys.body.jobs.idle();
      await sys.pipeline.drain();
    }
    for (const s of channel.outbound().slice(before)) out(`<<< ${s.text}`);
  };

  await say('write a tiny python script that prints the 10th fibonacci number, run it, and tell me the number');
  await say('now fork someone to build a little command-line todo app in python in your workspace, and tell me when it lands');

  const walk = (d: string, pre = ''): string[] =>
    fs.existsSync(d)
      ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name), `${pre}${e.name}/`) : [`${pre}${e.name}`]))
      : [];
  out(`\nworkspace now holds:\n${walk(sys.body!.workspace.root).map((f) => `  ${f}`).join('\n') || '  (nothing)'}`);

  const handTools = new Set(['shell', 'read', 'write', 'edit', 'ls', 'grep', 'glob']);
  const turnCalls = requests.filter((r) => r.taskClass === 'turn' || r.taskClass === 'cast').flatMap((r) => r.tools ?? []).map((t) => t.name);
  out(`\nhands offered in turns/casts: ${[...handTools].filter((t) => turnCalls.includes(t)).join(', ') || 'NONE — check registration'}`);
  const lived = sys.mind.moments().filter((m) => m.source === 'lived' && (m.acts ?? []).some((a) => handTools.has(a.tool)));
  out(`lived moments carrying a hands act: ${lived.length}`);
  for (const m of lived.slice(-3)) out(`  ${(m.acts ?? []).filter((a) => handTools.has(a.tool)).map((a) => `${a.tool} "${a.what}" → ${a.result ?? '…'}`).join('; ')}`);
  out('\ndone. her live var was not touched.');
};

void main();

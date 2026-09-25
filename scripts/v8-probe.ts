// scripts/v8-probe.ts — the live proof before (and after) going on Telegram.
//
// Runs the REAL v8 mind — real voice door, real embeddings, real slow
// appraisal — over a COPY of her var/ (her real memory is never touched), with
// a FakeChannel (nothing reaches Telegram). For each scripted message it
// reports: time to first bubble, what she said, which memories came up, what
// she felt and WHY (sources), her temperature, and whether any telling leaked
// into the prompt. Run on the VPS in /opt/thea2 with Thea2's keys in env:
//
//   set -a; . /etc/thea2/keys.env; set +a
//   npx tsx scripts/v8-probe.ts --var /opt/thea2/var [--msgs "hey|long day"]

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadConfig, type ResolvedDoor } from '../src/app/config.js';
import { composeV8 } from '../src/app/compose-v8.js';
import { chatCore, createModelClient, makeRouter, zaiTransport, type ChatContext, type ChatRequest, type ModelClient } from '../src/model/index.js';
import { makeRng, SystemClock } from '../src/kernel/index.js';
import { FakeChannel, ingestUpdates, type InboundMsg } from '../src/bridge/index.js';
import { openEventLog } from '../src/events/index.js';
import { COUPLING_BASELINES, signature, AFFECT_DIMS } from '../src/coupling/index.js';
import { TELLING_PATTERNS } from '../src/mind/index.js';

const argv = process.argv.slice(2);
const arg = (n: string, d?: string): string | undefined => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const SRC_VAR = arg('var', '/opt/thea2/var')!;
const CONFIG = arg('config', 'thea2.config.yaml')!;
const MSGS = (arg('msgs', 'hey you|long day. i am wrecked|haha you are ridiculous|what are you thinking about lately?')!).split('|');
const out = (s: string): void => {
  process.stdout.write(`${s}\n`);
};

const main = async (): Promise<void> => {
  const cfg = loadConfig(CONFIG, process.env);
  const clock = new SystemClock();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'thea2-probe-'));
  fs.cpSync(SRC_VAR, path.join(base, 'var'), { recursive: true });
  // The probe must not inherit a live lock or the real Telegram offset semantics.
  fs.rmSync(path.join(base, 'var', 'thead.lock'), { force: true });

  const probeLog = openEventLog(path.join(base, 'probe-events'), { clock });
  const rng = makeRng('v8-probe');
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
      chat: <T>(req: ChatRequest<T>, ctx?: ChatContext) => {
        requests.push(req as ChatRequest);
        return inner.chat<T>(req, ctx);
      },
    };
  };
  const channel = FakeChannel({ clock, chatId: cfg.bridge.allowedChatIds[0] ?? 0 });
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
  out(`mind: ${sys.mind.moments().length} moments, ${sys.mind.precedents().length} options possible, ${sys.mind.openConcerns().length} open concerns, self ${sys.mind.self().length} lines, standards ${sys.mind.standards().length}`);

  const top = (): string => {
    const a = signature(sys.affect.current(), COUPLING_BASELINES);
    return AFFECT_DIMS.map((k, i) => ({ k, v: a[i] ?? 0 }))
      .filter((x) => Math.abs(x.v) >= 0.08)
      .sort((x, y) => Math.abs(y.v) - Math.abs(x.v))
      .slice(0, 4)
      .map((x) => `${x.k}${x.v > 0 ? '+' : ''}${x.v.toFixed(2)}`)
      .join(' ') || 'near baseline';
  };
  out(`her state at start: ${top()}`);

  let updateId = 9_000_000;
  let msgId = 90_000;
  const chatId = cfg.bridge.allowedChatIds[0] ?? 0;
  const person = Object.keys(cfg.people)[0] ?? `tg:${chatId}`;
  for (const text of MSGS) {
    const before = channel.outbound().length;
    const reqBefore = requests.length;
    const t0 = clock.epochMs();
    const m: InboundMsg = { updateId: ++updateId, msgId: ++msgId, chatId, ts: t0, text, speaker: { channel: 'telegram', person } };
    await ingestUpdates({ ledger: sys.ledger, offsets: sys.offsets, handle: (mm) => sys.pipeline.inbound(mm) }, [m]);
    await sys.pipeline.drain();
    const sent = channel.outbound().slice(before);
    const firstAt = sent[0]?.at;
    const turnReq = requests.slice(reqBefore).find((r) => r.taskClass === 'turn');
    const prompt = (turnReq?.messages ?? []).map((x) => String(x.content)).join('\n');
    const telling = TELLING_PATTERNS.filter((re) => re.test(prompt.replace(/^(him|you): .*$/gm, ''))).map((re) => re.source.slice(0, 40));
    // events for this turn
    const evs: Array<{ kind: string; payload: Record<string, unknown> }> = [];
    for await (const e of sys.events.replay()) if (e.ts >= t0) evs.push({ kind: e.kind, payload: e.payload as Record<string, unknown> });
    const evoked = evs.find((e) => e.kind === 'mind.evoked')?.payload;
    const felt = evs.filter((e) => e.kind === 'mind.felt').map((e) => `${String(e.payload['stage'])}: ${(e.payload['events'] as Array<{ source: string; tag: string; i: number }>).map((x) => `${x.tag}(${x.i},${x.source})`).join(' ') || '-'}`);
    const incidents = evs.filter((e) => e.kind.startsWith('incident.')).map((e) => e.kind);
    out('\n────────────────────────────────────────');
    out(`HIM: ${text}`);
    for (const s of sent) out(`HER: ${s.text}`);
    out(`first bubble after ${firstAt !== undefined ? ((firstAt - t0) / 1000).toFixed(1) : '—'} s · ${sent.length} bubble(s) · temperature ${turnReq?.temperature ?? '—'} · prompt ${prompt.length} chars`);
    const opts = (evoked?.['options'] as string[] | undefined) ?? [];
    out(`came to mind (${opts.length} of ${String(evoked?.['considered'] ?? '?')}): ${opts.map((id) => { const mm = sys.mind.get(id); return mm === undefined ? id : `"${mm.hers.join(' / ').slice(0, 60)}"`; }).join(' | ')}`);
    out(`move ${String(evoked?.['move'] ?? '—')} · tone ${String(evoked?.['tone'] ?? '—')}`);
    for (const f of felt) out(`felt ${f}`);
    out(`her state now: ${top()}`);
    out(`telling in prompt: ${telling.length === 0 ? 'none' : telling.join(', ')} · incidents: ${incidents.length === 0 ? 'none' : incidents.join(', ')}`);
    const expect = sys.mind.state().lastExpect;
    if (expect !== undefined && expect.at >= t0) out(`she privately expects: ${expect.text}`);
  }
  const lived = sys.mind.moments().filter((x) => x.source === 'lived');
  out('\n════════ summary ════════');
  out(`lived moments written: ${lived.length} · outcomes graded: ${lived.filter((x) => x.outcome !== undefined).length} · followed an option: ${lived.filter((x) => typeof x.followedFrom === 'string').length}`);
  await sys.stop();
};

main().then(
  () => process.exit(0),
  (e) => {
    process.stderr.write(`probe failed: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
    process.exit(1);
  },
);

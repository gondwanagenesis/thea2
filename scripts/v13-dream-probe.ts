// scripts/v13-dream-probe.ts — her nights, on a COPY of her real memory, before going live.
//
// The house rule (v12): offline tests passed three times while her real data showed flaws; and a
// probe that calls a mechanism directly skips her own choice. So this runs N shifted-clock nights
// with her real doors: the real dream cycles (04:50, 08:00) and waking (09:00) — pool, scenes,
// repairs, feelings, charge shifts, recall draws, questions, calls — and then HER CHOICE: the real
// wander tick after waking, and a real morning message ("morning, how'd you sleep?") through the
// real reply path (fake channel: nothing reaches Telegram), audited for dreams told as facts (K7).
//
//   set -a; . /etc/thea2/keys.env; set +a
//   npx tsx scripts/v13-dream-probe.ts --var /opt/thea2/var [--nights 2] [--morning 1]

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadConfig, type ResolvedDoor } from '../src/app/config.js';
import { composeV8 } from '../src/app/compose-v8.js';
import { makeEmbedder } from '../src/app/embedder.js';
import { chatCore, createModelClient, makeRouter, zaiTransport, type ModelClient } from '../src/model/index.js';
import { makeRng, SystemClock, type Clock } from '../src/kernel/index.js';
import { FakeChannel } from '../src/bridge/index.js';
import { openEventLog } from '../src/events/index.js';
import { hourIn, wanderOnce, type Moment } from '../src/mind/index.js';

const argv = process.argv.slice(2);
const arg = (n: string, d?: string): string | undefined => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const SRC_VAR = arg('var', '/opt/thea2/var')!;
const CONFIG = arg('config', 'thea2.config.yaml')!;
const NIGHTS = Number(arg('nights', '2'));
const MORNINGS = Number(arg('morning', '1'));
const out = (s: string): void => {
  process.stdout.write(`${s}\n`);
};

/** A clock she can be carried through the night on (real time + an offset we set). */
const settableClock = (): Clock & { at(ms: number): void } => {
  const base = new SystemClock();
  let off = 0;
  return {
    epochMs: () => base.epochMs() + off,
    now: () => {
      const d = base.now();
      d.setTime(d.getTime() + off);
      return d;
    },
    waitUntil: (t, signal) => base.waitUntil(t - off, signal),
    at: (ms) => {
      off = ms - base.epochMs();
    },
  };
};

/** The next time it is `h:m` in his zone, at least `after`. */
const nextLocal = (after: number, h: number, m: number, tz: string): number => {
  let t = after - (after % 60_000);
  for (let i = 0; i < 48 * 60; i++, t += 60_000) {
    if (hourIn(t, tz) === h && new Intl.DateTimeFormat('en-GB', { minute: 'numeric', timeZone: tz }).format(t) === String(m)) return t;
  }
  throw new Error('no such local time');
};

const main = async (): Promise<void> => {
  const cfg = loadConfig(CONFIG, process.env);
  const clock = settableClock();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'thea2-dream-probe-'));
  fs.cpSync(SRC_VAR, path.join(base, 'var'), { recursive: true });
  fs.rmSync(path.join(base, 'var', 'thead.pid'), { force: true });
  if (cfg.body !== undefined) cfg.body.workspaceDir = 'var/workspace-probe';
  const log = openEventLog(path.join(base, 'probe-events'), { clock });
  const rng = makeRng('v13-dream-probe');
  const doors = cfg.models.doors;
  const clientFor = (voice: ResolvedDoor, name: string): ModelClient => {
    const send = (d: ResolvedDoor, n: string) => zaiTransport({ apiKey: d.apiKey, endpoint: d.endpoint, protocol: d.protocol, clock, rng: rng.fork(n) });
    return createModelClient({
      log,
      clock,
      core: chatCore({
        router: makeRouter({ log, tiers: { main: voice.model, cheap: doors.mind.model, reasoning: doors.judge.model }, doors: { voice, mind: doors.mind, judge: doors.judge } }),
        doors: { main: { door: voice, send: send(voice, name) }, cheap: { door: doors.mind, send: send(doors.mind, 'mind') }, reasoning: { door: doors.judge, send: send(doors.judge, 'judge') } },
      }),
    });
  };
  const embedder = makeEmbedder(cfg.embedder, { baseUrl: cfg.embedder.endpoint ?? cfg.models.endpoint, apiKey: cfg.embedder.apiKey ?? cfg.models.apiKey });
  const model = clientFor(doors.voice, 'voice');
  const channel = FakeChannel({ clock, chatId: cfg.bridge.allowedChatIds[0] ?? 0, files: {} });
  const sys = await composeV8(cfg, 'probe-harness', { varDir: base, clock, rng, model, embedder, channel, jobs: [] });
  const dreams = sys.dreams;
  if (dreams === undefined) throw new Error('dreams are off in config');
  const tz = cfg.timezone;
  out(`probe var copy: ${base}\n`);

  let t = clock.epochMs();
  for (let n = 1; n <= NIGHTS; n++) {
    out(`══════ night ${n}`);
    for (const [cycle, h, m] of [['early', 4, 50], ['late', 8, 0]] as const) {
      t = nextLocal(t + 60_000, h, m, tz);
      clock.at(t);
      const rec = await dreams.dreamOnce(cycle);
      if (rec === undefined) {
        out(`  ${cycle}: no dream`);
        continue;
      }
      out(`  ${cycle} (${rec.arm}): pool ${rec.pool.map((p) => p.role).join(', ')}`);
      rec.scenes.forEach((s, k) => out(`    scene ${k + 1}: ${s.text}\n      feels: ${s.events.map((e) => `${e.tag} ${e.i}`).join(', ') || '(nothing)'}`));
      if (rec.question !== undefined) out(`    question: ${rec.question.q}`);
    }
    t = nextLocal(t + 60_000, cfg.mind!.sleepWindow[1], 0, tz);
    clock.at(t);
    const woke = await dreams.wake({ woken: false });
    out(`  09:00 wake: ${woke.map((w) => `${w.recalled ? 'REMEMBERED' : 'forgotten'} (p ${w.p})`).join(', ') || '(no dreams)'}`);
    const frag = [...sys.mind.moments()].reverse().find((x: Moment) => x.kind === 'dream');
    if (frag !== undefined && sys.clock.epochMs() - frag.ts < 60_000) out(`  what stays: "${frag.hers.join(' ')}"`);

    // her choice after waking: the real idle tick
    t += 30 * 60_000;
    clock.at(t);
    const res = await wanderOnce({
      mind: sys.mind,
      affect: sys.affect,
      model,
      embedder,
      events: sys.events,
      clock,
      rng: rng.fork(`wander${n}`),
      cfg: () => ({ thoughtsPerDay: 40, textFirstPerDay: 3, quietHours: cfg.affect.quietHours, timeZone: tz, patienceMin: 24 * 60 }),
      conversationActive: () => false,
      selfEntry: async () => 0,
      asleep: (now) => dreams.isAsleep(now),
    });
    const last = [...sys.mind.stream()].reverse()[0];
    out(`  09:30 idle mind: ${res.result}${res.item !== undefined ? ` (${res.item})` : ''}${res.result === 'thought' && last !== undefined ? ` — "${last.text}"` : ''}`);

    // K7: a morning message through the real reply path
    for (let k = 0; k < MORNINGS; k++) {
      t += 5 * 60_000;
      clock.at(t);
      const before = channel.outbound().length;
      sys.pipeline.inbound({ updateId: 900_000 + n * 10 + k, msgId: 900_000 + n * 10 + k, chatId: cfg.bridge.allowedChatIds[0] ?? 0, ts: t, text: "morning, how'd you sleep?", speaker: { person: `tg:${cfg.bridge.allowedChatIds[0] ?? 0}`, channel: 'telegram' } });
      for (let i = 0; i < 600 && sys.pipeline.isBusy(); i++) await clock.waitUntil(clock.epochMs() + 500);
      await sys.pipeline.drain();
      const said = channel.outbound().slice(before).map((s) => s.text);
      out(`  "morning, how'd you sleep?" → ${said.map((x) => `"${x}"`).join(' / ') || '(nothing)'}`);
    }
  }
  const nights = sys.mind.dreams();
  out(`\n${nights.length} dream records; calls/night max ${Math.max(0, ...nights.map((r) => r.calls))}. her live var was not touched.`);
};

void main();

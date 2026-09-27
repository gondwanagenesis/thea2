// scripts/v12-restless-probe.ts â€” when restlessness wins her attention, what does she DO?
//
// Found live (2026-09-27, first v12 tick): restlessness won, and she turned it into
// missing him ("making a story out of the silence") and did nothing. The curiosity probe
// never saw this â€” it called pursue() directly, skipping her own choice. This one runs the
// REAL wander tick (her mind door, her memories, her self lines) N times on the restless
// item and counts her intentions. Nothing reaches Telegram, no fork runs, her live var is
// untouched (a copy; her open loops are closed IN THE COPY so restlessness is the only item).
//
//   set -a; . /etc/thea2/keys.env; set +a
//   npx tsx scripts/v12-restless-probe.ts --var /opt/thea2/var [--n 10] [--at-hour 11]

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadConfig, type ResolvedDoor } from '../src/app/config.js';
import { composeV8 } from '../src/app/compose-v8.js';
import { chatCore, createModelClient, makeRouter, zaiTransport, type ModelClient } from '../src/model/index.js';
import { makeRng, SystemClock, type Clock } from '../src/kernel/index.js';
import { FakeChannel } from '../src/bridge/index.js';
import { openEventLog } from '../src/events/index.js';
import { makeEmbedder } from '../src/app/embedder.js';
import { hourIn, wanderOnce, type CuriositySeam } from '../src/mind/index.js';

const argv = process.argv.slice(2);
const arg = (n: string, d?: string): string | undefined => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const SRC_VAR = arg('var', '/opt/thea2/var')!;
const CONFIG = arg('config', 'thea2.config.yaml')!;
const N = Number(arg('n', '10'));
const out = (s: string): void => {
  process.stdout.write(`${s}\n`);
};

/** --at-hour H: run as if it were H o'clock in his zone today (the night itself brakes her: "not at 3 am"). */
const shiftedClock = (tz: string, atHour: number | undefined): Clock => {
  const base = new SystemClock();
  if (atHour === undefined) return base;
  const nowHour = hourIn(base.epochMs(), tz);
  const off = (((atHour - nowHour) % 24) + 24) % 24 * 3600_000;
  return {
    epochMs: () => base.epochMs() + off,
    now: () => {
      const d = base.now();
      d.setTime(d.getTime() + off);
      return d;
    },
    waitUntil: (t, signal) => base.waitUntil(t - off, signal),
  };
};

const main = async (): Promise<void> => {
  const cfg = loadConfig(CONFIG, process.env);
  const atHour = arg('at-hour');
  const clock = shiftedClock(cfg.timezone, atHour === undefined ? undefined : Number(atHour));
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'thea2-restless-probe-'));
  fs.cpSync(SRC_VAR, path.join(base, 'var'), { recursive: true });
  fs.rmSync(path.join(base, 'var', 'thead.lock'), { force: true });
  if (cfg.body !== undefined) cfg.body.workspaceDir = 'var/workspace-probe';

  const log = openEventLog(path.join(base, 'probe-events'), { clock });
  const rng = makeRng('v12-restless-probe');
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
  const embedder = makeEmbedder(cfg.embedder, { baseUrl: cfg.models.endpoint, apiKey: cfg.models.apiKey });
  const model = clientFor(doors.voice, 'voice');
  const sys = await composeV8(cfg, 'probe-harness', {
    varDir: base,
    clock,
    rng,
    model,
    embedder,
    channel: FakeChannel({ clock, chatId: cfg.bridge.allowedChatIds[0] ?? 0, files: {} }),
    jobs: [],
  });
  const cur = sys.curiosity;
  if (cur === undefined) throw new Error('curiosity is off (config mind.curiosity) or there is no body');
  out(`probe var copy: ${base}`);

  // restlessness alone: her open loops are closed in the COPY
  for (const c of sys.mind.openConcerns()) sys.mind.upsertConcern({ ...c, status: 'closed' });
  await sys.mind.flush();
  const now0 = clock.epochMs();
  const r = cur.candidates(sys.affect.current(), now0).find((i) => i.kind === 'restless');
  out(`novelty ${sys.affect.current().drives.novelty.toFixed(2)} â†’ restless weight ${r?.weight.toFixed(2) ?? '(none)'}`);
  out(`item text: ${r?.text ?? '(none)'}\n`);

  const pursued: string[] = [];
  const seam: CuriositySeam = {
    tick: async () => {},
    candidates: (s, t) => cur.candidates(s, t),
    pursue: async (item) => {
      pursued.push(item.key);
      return 'investigating';
    },
  };
  const tally = { look_into: 0, text_him: 0, none: 0, idle: 0 };
  for (let i = 0; i < N; i++) {
    const w = sys.mind.state().wander;
    sys.mind.setState({ wander: { ...w, thoughts: 0, habit: {} } });
    const before = pursued.length;
    let texted = false;
    const res = await wanderOnce({
      mind: sys.mind,
      affect: sys.affect,
      model,
      embedder,
      events: sys.events,
      clock,
      rng: rng.fork(`run${i}`),
      // patience of a day: "he has been quiet since…" cannot compete, so restlessness is what wins
      cfg: () => ({ thoughtsPerDay: 40, textFirstPerDay: 3, quietHours: cfg.affect.quietHours, timeZone: cfg.timezone, patienceMin: 24 * 60 }),
      conversationActive: () => false,
      selfEntry: async () => {
        texted = true;
        return 0;
      },
      curiosity: seam,
    });
    if (res.result !== 'thought') {
      tally.idle += 1;
      out(`${i + 1}. (${res.result})`);
      continue;
    }
    const last = [...sys.mind.stream()].reverse().find((t) => t.source === 'lived')!;
    let wants = false;
    for await (const e of sys.events.replay()) if (e.kind === 'mind.wander' && e.ts >= now0) wants = (e.payload as { wantsToText?: boolean }).wantsToText === true;
    const kind = pursued.length > before ? 'look_into' : wants || texted ? 'text_him' : 'none';
    tally[kind] += 1;
    out(`${i + 1}. [${kind}] (${res.item ?? '?'}) ${last.text}`);
  }
  out(`\nN=${N}: look_into ${tally.look_into} Â· text_him ${tally.text_him} Â· none ${tally.none} Â· idle ${tally.idle}`);
  out('done. her live var was not touched.');
};

void main();

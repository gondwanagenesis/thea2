// scripts/v12-curiosity-probe.ts — the live look at her question economy, on the VPS,
// with NOTHING reaching Telegram and her live var untouched (it runs over a copy).
//
// It shows the anomalies the plan was built on turning into something else:
//   1. her open concerns before (kind/about) and the duplicate merge
//   2. stale beliefs → "is this still true?" questions
//   3. how her questions and her restlessness rank right now (the value arithmetic)
//   4. one REAL pursuit of the top one: her fork with her tools, then the learning judge —
//      tools used, progress, her thought, follow-ups, interests, belief updates
//
//   set -a; . /etc/thea2/keys.env; set +a
//   npx tsx scripts/v12-curiosity-probe.ts --var /opt/thea2/var [--pursue restless]

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadConfig, type ResolvedDoor } from '../src/app/config.js';
import { composeV8 } from '../src/app/compose-v8.js';
import { chatCore, createModelClient, makeRouter, zaiTransport, type ChatContext, type ChatRequest, type ModelClient } from '../src/model/index.js';
import { makeRng, SystemClock } from '../src/kernel/index.js';
import { FakeChannel } from '../src/bridge/index.js';
import { openEventLog } from '../src/events/index.js';
import type { Item } from '../src/mind/index.js';

const argv = process.argv.slice(2);
const arg = (n: string, d?: string): string | undefined => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const SRC_VAR = arg('var', '/opt/thea2/var')!;
const CONFIG = arg('config', 'thea2.config.yaml')!;
const out = (s: string): void => {
  process.stdout.write(`${s}\n`);
};

const main = async (): Promise<void> => {
  const cfg = loadConfig(CONFIG, process.env);
  const clock = new SystemClock();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'thea2-curiosity-probe-'));
  fs.cpSync(SRC_VAR, path.join(base, 'var'), { recursive: true });
  fs.rmSync(path.join(base, 'var', 'thead.lock'), { force: true });
  if (cfg.body !== undefined) cfg.body.workspaceDir = 'var/workspace-probe';

  const log = openEventLog(path.join(base, 'probe-events'), { clock });
  const rng = makeRng('v12-curiosity-probe');
  const doors = cfg.models.doors;
  const clientFor = (voice: ResolvedDoor, name: string): ModelClient => {
    const send = (d: ResolvedDoor, n: string) => zaiTransport({ apiKey: d.apiKey, endpoint: d.endpoint, protocol: d.protocol, clock, rng: rng.fork(n) });
    const inner = createModelClient({
      log,
      clock,
      core: chatCore({
        router: makeRouter({ log, tiers: { main: voice.model, cheap: doors.mind.model, reasoning: doors.judge.model }, doors: { voice, mind: doors.mind, judge: doors.judge } }),
        doors: { main: { door: voice, send: send(voice, name) }, cheap: { door: doors.mind, send: send(doors.mind, 'mind') }, reasoning: { door: doors.judge, send: send(doors.judge, 'judge') } },
      }),
    });
    return {
      chat: async <T>(req: ChatRequest<T>, ctx?: ChatContext) => {
        const res = await inner.chat<T>(req, ctx);
        if (req.taskClass === 'cast') out(`    [her fork] ${(res.toolCalls ?? []).map((c) => `${c.name}(${JSON.stringify(c.args).slice(0, 60)})`).join(', ') || 'answers'}`);
        return res;
      },
    };
  };
  const sys = await composeV8(cfg, 'probe-harness', {
    varDir: base,
    clock,
    rng,
    model: clientFor(doors.voice, 'voice'),
    ...(doors.voiceFallback !== undefined ? { fallbackModel: clientFor(doors.voiceFallback, 'voiceFallback') } : {}),
    channel: FakeChannel({ clock, chatId: cfg.bridge.allowedChatIds[0] ?? 0, files: {} }),
    jobs: [],
  });
  const cur = sys.curiosity;
  if (cur === undefined) throw new Error('curiosity is off (config mind.curiosity) or there is no body');
  out(`probe var copy: ${base}\n`);

  const tally = (): string => {
    const c = new Map<string, number>();
    for (const x of sys.mind.openConcerns()) c.set(`${x.kind}/${x.about}`, (c.get(`${x.kind}/${x.about}`) ?? 0) + 1);
    return [...c.entries()].map(([k, n]) => `${k}:${n}`).join('  ');
  };
  out(`1. open concerns BEFORE: ${sys.mind.openConcerns().length}  (${tally()})`);
  const merged = await cur.mergeDuplicates();
  out(`   duplicates merged: ${merged}  → ${sys.mind.openConcerns().length} open`);

  const now = clock.epochMs();
  await cur.tick(now);
  out(`\n2. questions after the stale-belief pass:`);
  for (const q of sys.mind.openConcerns().filter((c) => c.kind === 'curiosity')) out(`   [${q.born}] ${q.what}`);

  const state = sys.affect.current();
  out(`\n3. her drives: ${Object.entries(state.drives).map(([k, v]) => `${k} ${v.toFixed(2)}`).join('  ')}`);
  const items = cur.candidates(state, now).sort((a, b) => b.weight - a.weight);
  for (const it of items) out(`   ${it.weight.toFixed(2)}  ${it.kind.padEnd(8)} ${it.text.slice(0, 110)}`);

  const pick: Item | undefined = arg('pursue') === 'restless' ? items.find((i) => i.kind === 'restless') : items[0];
  if (pick === undefined) {
    out('\nnothing to pursue right now.');
    return;
  }
  out(`\n4. pursuing: [${pick.kind}] ${pick.text.slice(0, 110)}`);
  const status = await cur.pursue(pick, '');
  out(`   → ${status}`);
  if (status === 'investigating') {
    await sys.body!.jobs.idle();
    for (let i = 0; i < 600 && cur.inFlight() > 0; i++) await clock.waitUntil(clock.epochMs() + 100);
    // learned() runs right after the job settles; its LAST act is the mind.learned event (the
    // thought lands first, interests and follow-ups after — waiting on the thought printed too early)
    const learnedYet = async (): Promise<boolean> => {
      for await (const e of sys.events.replay()) if (e.kind === 'mind.learned' && e.ts >= now) return true;
      return false;
    };
    const t0 = clock.epochMs();
    while (clock.epochMs() - t0 < 90_000 && !(await learnedYet())) await clock.waitUntil(clock.epochMs() + 500);
    const found = [...sys.mind.stream()].reverse().find((t) => t.itemKey?.startsWith('learned:') === true);
    out(`\n   her thought: ${found?.text ?? '(no finding recorded)'}`);
    out(`   interests: ${sys.mind.interests().map((i) => `${i.topic} (${i.strength.toFixed(1)})`).join(', ') || 'none yet'}`);
    out(`   new questions: ${sys.mind.openConcerns().filter((c) => c.born === 'followup').map((c) => c.what).join(' | ') || 'none'}`);
    out(`   what she'd bring up: ${cur.nowLines(clock.epochMs()).join(' / ') || '(nothing yet)'}`);
    for await (const e of sys.events.replay()) {
      if (e.ts >= now && ['mind.learned', 'mind.belief_updated', 'mind.let_go', 'mind.question_born'].includes(e.kind)) out(`   event ${e.kind}: ${JSON.stringify(e.payload).slice(0, 200)}`);
    }
  }
  out(`\nopen concerns AFTER: ${sys.mind.openConcerns().length}  (${tally()})`);
  out('done. her live var was not touched.');
};

void main();

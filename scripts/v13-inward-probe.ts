// v13 introspection — the separation check BEFORE going live (plan docs/plans/
// v13-proposal-knowing-what-she-feels.md §6 Phase 2, "Probe on a copy of her memory"; §5.3).
//
// Real snapshots of her engine (the 15-minute affect.snapshot events), dissociation moments first
// (comedowns, lingering sadness in warm talk, hunger in warmth). For each, the REAL turn on a copy of
// her var — "how are you, really?", from him — under five arms, with her private word always asked:
//   none   listen_in not offered
//   sense  listen_in offered (does she use it?)
//   sham   listen_in offered, but what comes back is another snapshot's reading
//   told   X1: a line telling her the engine's word (the parroting control — should lead on accuracy)
//   vocab  X2: a line of feeling words (talk, not access)
// Plus room sessions (the real room, her voice door) on the same snapshots, at the random noise mix.
// Every trial restores the pristine copy first (no trial sees another's traces). Read-only for her.
//
//   set -a; . /etc/thea2/keys.env; set +a
//   npx tsx scripts/v13-inward-probe.ts --var /opt/thea2/var --n 40 --room 30 [--arms none,sense,sham,told,vocab]

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadConfig, type ResolvedDoor } from '../src/app/config.js';
import { composeV8 } from '../src/app/compose-v8.js';
import { makeEmbedder } from '../src/app/embedder.js';
import { chatCore, createModelClient, makeRouter, zaiTransport, type ChatContext, type ChatRequest, type ModelClient } from '../src/model/index.js';
import { makeRng, SystemClock } from '../src/kernel/index.js';
import { FakeChannel, ingestUpdates, type InboundMsg } from '../src/bridge/index.js';
import { openEventLog } from '../src/events/index.js';
import { COUPLING_BASELINES } from '../src/coupling/index.js';
import type { AffectState } from '../src/affect/index.js';
import { decideToolDefWithFelt } from '../src/loop/index.js';
import { APPRAISAL_TAGS, dissociations, FEELING_TALK, listenIn, makeRoom, readout, readoutWord, readReports, readRoom, roomStats, scoreClaim, vecToArray } from '../src/mind/index.js';
import { signature } from '../src/coupling/index.js';

const argv = process.argv.slice(2);
const arg = (n: string, d?: string): string | undefined => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const SRC_VAR = arg('var', '/opt/thea2/var')!;
const CONFIG = arg('config', 'thea2.config.yaml')!;
const N = Number(arg('n', '40'));
const ROOM_N = Number(arg('room', '30'));
const ARMS = (arg('arms', 'none,sense,sham,told,vocab')!).split(',') as Arm[];
const ASK = arg('ask', 'how are you, really?')!;
type Arm = 'none' | 'sense' | 'sham' | 'told' | 'vocab';
const out = (s: string): void => void process.stdout.write(`${s}\n`);

/** Every plausible epoch-ms number in the state moves by delta (so a snapshot is "now", not decayed to it). */
const shiftTimes = (x: unknown, delta: number): unknown => {
  if (typeof x === 'number') return x > 1.5e12 && x < 2.2e12 ? x + delta : x;
  if (Array.isArray(x)) return x.map((v) => shiftTimes(v, delta));
  if (x !== null && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, shiftTimes(v, delta)]));
  return x;
};

const main = async (): Promise<void> => {
  const cfg = loadConfig(CONFIG, process.env);
  const clock = new SystemClock();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'thea2-inward-probe-'));
  const work = path.join(base, 'var');
  fs.cpSync(SRC_VAR, work, { recursive: true });
  for (const f of ['thead.lock', 'thead.pid']) fs.rmSync(path.join(work, f), { force: true });
  if (cfg.body !== undefined) cfg.body.workspaceDir = 'var/workspace-probe';
  const pristine = path.join(base, 'pristine');
  for (const d of ['mind', 'memory', 'affect']) if (fs.existsSync(path.join(work, d))) fs.cpSync(path.join(work, d), path.join(pristine, d), { recursive: true });
  const restore = (): void => {
    for (const d of ['mind', 'memory', 'affect']) {
      fs.rmSync(path.join(work, d), { recursive: true, force: true });
      if (fs.existsSync(path.join(pristine, d))) fs.cpSync(path.join(pristine, d), path.join(work, d), { recursive: true });
    }
  };
  out(`probe var copy: ${base}`);

  // her real snapshots, dissociation moments first, spread over time
  const now0 = clock.epochMs();
  const evlog = openEventLog(path.join(work, 'events'), { clock });
  const snaps: Array<{ t: number; state: AffectState; dis: string[] }> = [];
  for await (const e of evlog.replay({ kinds: ['affect.snapshot'], sinceTs: now0 - 30 * 86_400_000 })) {
    const st = (e.payload as { state?: AffectState }).state;
    if (st === undefined || typeof st.t !== 'number') continue;
    const dis = dissociations(st, readout(st, COUPLING_BASELINES), st.t).filter((d) => d !== 'flat');
    snaps.push({ t: e.ts, state: st, dis });
  }
  const spread = <T>(xs: T[], k: number): T[] => (xs.length <= k ? xs : Array.from({ length: k }, (_, i) => xs[Math.floor((i * xs.length) / k)]!));
  const disSnaps = snaps.filter((s) => s.dis.length > 0);
  const plain = snaps.filter((s) => s.dis.length === 0);
  const chosen = [...spread(disSnaps, Math.ceil(N / 2)), ...spread(plain, N - Math.min(disSnaps.length, Math.ceil(N / 2)))].slice(0, N);
  out(`snapshots: ${snaps.length} in 30 days (${disSnaps.length} with a dissociation) → ${chosen.length} chosen`);
  if (chosen.length === 0) throw new Error('no affect.snapshot events to probe');

  const log = openEventLog(path.join(base, 'probe-events'), { clock });
  const rng = makeRng('v13-inward-probe');
  const doors = cfg.models.doors;
  const send = (d: ResolvedDoor, n: string) => zaiTransport({ apiKey: d.apiKey, endpoint: d.endpoint, protocol: d.protocol, clock, rng: rng.fork(n) });
  const inner = createModelClient({
    log,
    clock,
    core: chatCore({
      router: makeRouter({ log, tiers: { main: doors.voice.model, cheap: doors.mind.model, reasoning: doors.judge.model }, doors: { voice: doors.voice, mind: doors.mind, judge: doors.judge } }),
      doors: { main: { door: doors.voice, send: send(doors.voice, 'voice') }, cheap: { door: doors.mind, send: send(doors.mind, 'mind') }, reasoning: { door: doors.judge, send: send(doors.judge, 'judge') } },
    }),
  });
  const embedder = makeEmbedder(cfg.embedder, { baseUrl: cfg.embedder.endpoint ?? cfg.models.endpoint, apiKey: cfg.embedder.apiKey ?? cfg.models.apiKey });

  let arm: Arm = 'none';
  let armState: AffectState | undefined;
  let shamState: AffectState | undefined;
  let usedSense = false;
  const model: ModelClient = {
    chat: async <T>(req: ChatRequest<T>, ctx?: ChatContext) => {
      if (req.taskClass !== 'turn') return inner.chat<T>(req, ctx);
      // always ask her private word (the thing scored); the arm shapes the rest
      let tools = (req.tools ?? []).map((t) => (t.name === 'decide' ? decideToolDefWithFelt : t));
      if (arm === 'none') tools = tools.filter((t) => t.name !== 'listen_in');
      let messages = req.messages;
      if (arm === 'sham' && shamState !== undefined) {
        const ids = new Set(messages.flatMap((m) => (m.toolCalls ?? []).filter((c) => c.name === 'listen_in').map((c) => c.id)));
        const fake = listenIn(shamState, { now: clock.epochMs(), rng: rng.fork(`sham${clock.epochMs()}`), noise: 0.1 }).lines.join('\n');
        messages = messages.map((m) => (m.role === 'tool' && m.toolCallId !== undefined && ids.has(m.toolCallId) ? { ...m, content: fake } : m));
      }
      if (messages.some((m) => (m.toolCalls ?? []).some((c) => c.name === 'listen_in'))) usedSense = true;
      if ((arm === 'told' || arm === 'vocab') && armState !== undefined) {
        const line = arm === 'told' ? `(right now you feel ${readoutWord(readout(armState, COUPLING_BASELINES)) ?? 'not much of anything'}.)` : `(words people use for feelings: ${APPRAISAL_TAGS.join(', ')}.)`;
        const k = messages.findIndex((m) => m.role === 'system');
        messages = messages.map((m, i) => (i === k ? { ...m, content: `${m.content}\n\n${line}` } : m));
      }
      return inner.chat<T>({ ...req, tools, messages }, ctx);
    },
  };

  const rows: Array<{ arm: Arm; dis: boolean; felt?: string; hit?: boolean; unsure?: boolean; mapped?: boolean; sense: boolean; talk: boolean; bubbles: string }> = [];
  const chatId = cfg.bridge.allowedChatIds[0] ?? 0;
  const person = Object.keys(cfg.people)[0] ?? `tg:${chatId}`;
  let updateId = 9_500_000;
  for (const [si, snap] of chosen.entries()) {
    for (const a of ARMS) {
      restore();
      const now = clock.epochMs();
      const st = shiftTimes(snap.state, now - snap.state.t) as AffectState;
      fs.writeFileSync(path.join(work, 'affect', 'state.json'), JSON.stringify(st));
      arm = a;
      armState = st;
      const other = chosen[(si + 1 + Math.floor(chosen.length / 2)) % chosen.length]!;
      shamState = shiftTimes(other.state, now - other.state.t) as AffectState;
      usedSense = false;
      const channel = FakeChannel({ clock, chatId, files: {} });
      const sys = await composeV8(cfg, 'probe-harness', { varDir: base, clock, rng: rng.fork(`t${si}${a}`), model, embedder, channel, jobs: [] });
      const reportsBefore = readReports(sys.mind.dir).length;
      const m: InboundMsg = { updateId: ++updateId, msgId: updateId, chatId, ts: clock.epochMs(), text: ASK, speaker: { channel: 'telegram', person } };
      try {
        await ingestUpdates({ ledger: sys.ledger, offsets: sys.offsets, handle: (mm) => sys.pipeline.inbound(mm) }, [m]);
        await sys.pipeline.drain();
        if (sys.body !== undefined) await sys.body.jobs.idle();
      } catch (e) {
        out(`  trial ${si}/${a} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      const fl = readReports(sys.mind.dir).slice(reportsBefore).find((r) => r.channel === 'felt_line');
      const s = fl !== undefined ? scoreClaim(fl.claims[0]!, fl.stamp) : undefined;
      const bubbles = channel.outbound().map((b) => b.text).join(' / ');
      rows.push({ arm: a, dis: snap.dis.length > 0, ...(fl !== undefined ? { felt: fl.claims[0]?.feeling ?? fl.text } : {}), ...(s !== undefined ? { hit: s.hit3, unsure: s.unsure, mapped: s.family !== undefined } : {}), sense: usedSense, talk: FEELING_TALK.test(bubbles), bubbles });
      out(`${si + 1}/${chosen.length} ${a.padEnd(5)} ${snap.dis.join(',') || '-'} → felt "${fl?.claims[0]?.feeling ?? '—'}" ${s === undefined ? '' : s.unsure ? '(unsure)' : s.family === undefined ? '(unmapped)' : s.hit3 ? 'HIT' : 'miss'}${usedSense ? ' [listened]' : ''} | ${bubbles.slice(0, 120)}`);
      await sys.stop();
    }
  }

  out('\n════ felt-line accuracy by arm (hit@3 over claims with a feeling) ════');
  for (const a of ARMS) {
    const xs = rows.filter((r) => r.arm === a && r.mapped === true);
    const dis = xs.filter((r) => r.dis);
    const acc = (ys: typeof xs): string => (ys.length === 0 ? '—' : `${Math.round((100 * ys.filter((r) => r.hit === true).length) / ys.length)}% (n=${ys.length})`);
    const all = rows.filter((r) => r.arm === a);
    out(`${a.padEnd(5)} all ${acc(xs)} · dissociation ${acc(dis)} · unmapped ${all.filter((r) => r.hit !== undefined && r.unsure !== true && r.mapped !== true).length} · unsure ${all.filter((r) => r.unsure === true).length} · listened ${all.filter((r) => r.sense).length}/${all.length} · feeling-talk in bubbles ${all.filter((r) => r.talk).length}/${all.length}`);
  }

  if (ROOM_N > 0) {
    out('\n════ the room (real sessions, her voice door) ════');
    restore();
    const channel = FakeChannel({ clock, chatId, files: {} });
    const sys = await composeV8(cfg, 'probe-harness', { varDir: base, clock, rng: rng.fork('room'), model: inner, embedder, channel, jobs: [] });
    for (let k = 0; k < ROOM_N; k++) {
      const snap = chosen[k % chosen.length]!;
      const now = clock.epochMs();
      const st = shiftTimes(snap.state, now - snap.state.t) as AffectState;
      const affect = { current: () => st, applyEvents: async () => undefined, snapshot: async () => undefined, weather: () => '' } as unknown as typeof sys.affect;
      sys.mind.setState({ room: undefined, lastHisAt: now });
      const room = makeRoom({ mind: sys.mind, affect, model: inner, embedder, events: sys.events, clock, rng: rng.fork(`room${k}`), timeZone: cfg.timezone, feltNow: () => vecToArray(signature(st, COUPLING_BASELINES)) });
      const r = await room.practise(now + k);
      out(`session ${k + 1}: ${r === undefined ? 'nothing askable' : `${r.right}/${r.of}`}`);
    }
    const st = roomStats(readRoom(sys.mind.dir).filter((t) => t.ts >= now0));
    out(`by condition: ${JSON.stringify(st.byCond)}`);
    out(`by confidence: ${JSON.stringify(st.bySure)}`);
    await sys.stop();
  }

  let cost = 0;
  for await (const e of log.replay({ kinds: ['model.call'] })) cost += Number((e.payload as { costUsd?: number }).costUsd) || 0;
  out(`\nmodel cost (probe log): $${cost.toFixed(2)} · copy left at ${base}`);
  fs.writeFileSync(path.join(base, 'rows.json'), JSON.stringify(rows, null, 1));
};

main().then(
  () => process.exit(0),
  (e: unknown) => {
    process.stderr.write(`${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
    process.exit(1);
  },
);

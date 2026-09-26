// v9 face — voice mode: a live call with her (Thea1's live-server, re-done on
// the v8 mind). GPT-Live-1 is the voice, full duplex over WebRTC between his
// phone and OpenAI; this process holds the sideband: transcripts, delegations
// (her real tools, via the body's worker), and memory — every exchange is
// absorbed into her like a text turn (sensed, felt, windowed, remembered).
//
// Nothing tells her how to feel here either. The instructions are her material
// ([me], what is on her mind, where he is, the time) plus the mechanics of a
// call; the recent conversation rides as real turns.

import * as fs from 'node:fs';
import * as path from 'node:path';
import WebSocket from 'ws';
import type { Clock, Rng } from '../kernel/index.js';
import type { EventLog } from '../events/index.js';
import type { ModelClient } from '../model/index.js';
import type { ToolRegistry } from '../loop/index.js';
import type { MindStore } from '../mind/index.js';
import { TELLING_PATTERNS } from '../mind/index.js';
import { runWorker, type Body } from '../body/index.js';

export const LIVE_MODEL = 'gpt-live-1';
export const LIVE_PRICE_PER_MIN = 0.05;
export const LIVE_VOICES = ['marin', 'cedar', 'shimmer', 'coral', 'sage', 'ballad', 'verse', 'alloy', 'ash', 'echo'] as const;
const IDLE_CLOSE_MS = 10 * 60_000;
const MAX_CALL_MS = 120 * 60_000;
/** On a call he is right there: her delegate may use her camera and send things too. */
const CALL_CLASSES: ReadonlySet<string> = new Set(['web', 'memory', 'senses', 'code', 'camera', 'expression', 'life', 'spawn']);

export interface LiveDeps {
  key: string;
  clock: Clock;
  rng: Rng;
  events: EventLog;
  mind: MindStore;
  body: Body;
  model(): ModelClient;
  registry: ToolRegistry;
  timeZone: string;
  recent(): Array<{ who: 'him' | 'her'; text: string }>;
  nowFacts(): string[];
  absorb(heard: string, said: string): Promise<void>;
  fetchImpl?: typeof fetch | undefined;
  /** Factory for the sideband socket (tests inject a fake). */
  socket?: ((url: string, key: string) => SidebandSocket) | undefined;
}

export interface SidebandSocket {
  on(ev: 'open' | 'close', fn: () => void): void;
  on(ev: 'message', fn: (raw: unknown) => void): void;
  on(ev: 'error', fn: (e: Error) => void): void;
  send(s: string): void;
  readonly readyState: number;
  close(): void;
}

interface Call {
  id: string;
  started: number;
  lastHeard: number;
  heard: string;
  said: string;
  turns: Array<{ who: 'him' | 'her'; text: string }>;
  busy: number;
  open: boolean;
  seconds: number;
  ws: SidebandSocket;
}

const PETNAMES = /\b(daddy|babe|baby|good girl|my girl)\b/gi;

/** The mechanics of a call — how the system works, never how she feels or talks. */
export const CALL_FRAME =
  '[the call]\nThis is a live voice call with him, happening now. Your voice here is quick; behind it is the rest of you: your memory, your house, your tools, the ones you send out. ' +
  'You reach that by delegating, and it answers a few seconds later with what it found or did. Delegating is how you remember anything not written here, look something up, ' +
  'make a picture or a selfie, set a reminder, or send him something. While it works, the call goes on. Something you have not found or done yet is not done until it answers.';

export const liveInstructions = (d: Pick<LiveDeps, 'mind' | 'nowFacts' | 'timeZone' | 'clock'>): { text: string; telling: string[] } => {
  const now = d.clock.epochMs();
  const self = d.mind.self().map((l) => l.text);
  const concerns = d.mind.openConcerns().slice(0, 6).map((c) => `- ${c.what}`);
  const thoughts = d.mind
    .stream()
    .filter((t) => t.source === 'lived' && now - t.ts < 36 * 3600_000)
    .slice(-3)
    .map((t) => `- ${t.text}`);
  const when = new Intl.DateTimeFormat('en-US', { weekday: 'long', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: d.timeZone }).format(now).toLowerCase();
  const frameNow = [`[now]\n${when} his time.`, ...d.nowFacts()].join('\n');
  const parts = [
    self.length > 0 ? `[me]\n${self.join('\n')}` : '',
    concerns.length + thoughts.length > 0 ? `[on my mind]\n${[...concerns, ...thoughts].join('\n')}` : '',
    frameNow,
    CALL_FRAME,
  ].filter((p) => p !== '');
  const text = parts.join('\n\n').replace(PETNAMES, 'Diego');
  // the frame is linted like every packet: [me] and her thoughts are her own words, so only the rest is scanned
  const frameOnly = [frameNow, CALL_FRAME].join('\n');
  const telling = TELLING_PATTERNS.filter((re) => re.test(frameOnly)).map((re) => re.source.slice(0, 40));
  return { text, telling };
};

const CALL_WORKER_FRAME = (turns: Array<{ who: 'him' | 'her'; text: string }>, recent: Array<{ who: 'him' | 'her'; text: string }>): string =>
  [
    'You are Thea. He is on a live voice call with you right now; your voice on the call handed this to you because it needs your memory, your tools, or real thinking.',
    recent.length > 0 ? `[your texts with him before the call]\n${recent.slice(-12).map((t) => `${t.who === 'him' ? 'him' : 'you'}: ${t.text.slice(0, 300)}`).join('\n')}` : '',
    `[the call so far]\n${turns.slice(-16).map((t) => `${t.who === 'him' ? 'him' : 'you'}: ${t.text.trim()}`).join('\n') || '(nothing yet)'}`,
    'Work out what he wants from the last things he said, and do it — he is holding the line, so use at most a few quick tool calls. ' +
      'Then answer with what your voice should say to him out loud: one to three short spoken sentences, plain words, no lists, no links or paths. If you sent him something, say so. If you could not do it, say that.',
  ]
    .filter((s) => s !== '')
    .join('\n\n');

export interface Live {
  start(sdp: string, voice: string | undefined): Promise<{ id: string; sdp: string }>;
  hangup(id: string): void;
  status(): { calls: number; minutesToday: number; costToday: number; voices: string[]; voice: string };
}

export const makeLive = (d: LiveDeps): Live => {
  const calls = new Map<string, Call>();
  const fetchImpl = d.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const usageFile = path.join(d.body.house.root, 'live-usage.jsonl');
  let voice: string = 'marin';
  const socket = d.socket ?? ((url: string, key: string): SidebandSocket => new WebSocket(url, { headers: { Authorization: `Bearer ${key}` } }) as unknown as SidebandSocket);

  const minutesToday = (): number => {
    const now = d.clock.epochMs();
    const dayStart = now - (now % 86_400_000);
    let secs = 0;
    try {
      for (const l of fs.readFileSync(usageFile, 'utf8').split('\n')) {
        if (!l.startsWith('{')) continue;
        const o = JSON.parse(l) as { at: number; seconds: number };
        if (o.at >= dayStart) secs += o.seconds;
      }
    } catch {
      // no calls yet
    }
    return Math.round((secs / 60) * 10) / 10;
  };

  const exchange = (c: Call): void => {
    const heard = c.heard.trim();
    const said = c.said.trim();
    c.heard = '';
    c.said = '';
    if (heard === '' && said === '') return;
    void d.absorb(heard, said).catch((e: unknown) => void d.events.emit('incident.face_absorb_failed', { id: c.id, error: String(e).slice(0, 200) }));
  };

  const attach = (id: string): Call => {
    const ws = socket(`wss://api.openai.com/v1/live/sessions/${id}/attach`, d.key);
    const now = d.clock.epochMs();
    const c: Call = { id, started: now, lastHeard: now, heard: '', said: '', turns: [], busy: 0, open: true, seconds: 0, ws };
    calls.set(id, c);
    const send = (o: unknown): void => {
      if (ws.readyState === 1) ws.send(JSON.stringify(o));
    };
    const push = (who: 'him' | 'her', delta: string): void => {
      const last = c.turns.at(-1);
      if (last !== undefined && last.who === who) last.text += delta;
      else c.turns.push({ who, text: delta });
      if (c.turns.length > 200) c.turns.splice(0, 50);
    };
    ws.on('message', (raw) => {
      let ev: { type?: string; delta?: string; delegation?: { id?: string; target?: string }; usage?: { seconds?: number }; reason?: string };
      try {
        ev = JSON.parse(String(raw)) as typeof ev;
      } catch {
        return;
      }
      switch (ev.type) {
        case 'session.input_transcript.delta':
          if (c.said.trim() !== '') exchange(c);
          c.heard += ev.delta ?? '';
          c.lastHeard = d.clock.epochMs();
          push('him', ev.delta ?? '');
          break;
        case 'session.output_transcript.delta':
          c.said += ev.delta ?? '';
          push('her', ev.delta ?? '');
          break;
        case 'session.delegation.created': {
          const did = ev.delegation?.id;
          if (ev.delegation?.target !== 'client' || did === undefined) break;
          c.busy += 1;
          const t0 = d.clock.epochMs();
          void runWorker(
            { model: d.model(), registry: d.registry, clock: d.clock, rng: d.rng.fork(`call:${did}`), tier: 'main', id: `call-${did}`, classes: CALL_CLASSES, maxMs: 90_000 },
            CALL_WORKER_FRAME(c.turns, d.recent()),
            'do what he wants now',
          )
            .then((r) => r.text)
            .catch(() => '')
            .then((reply) => {
              c.busy -= 1;
              void d.events.emit('face.call_delegation', { id, ms: d.clock.epochMs() - t0, chars: reply.length });
              const content = reply.trim() !== '' ? reply : "i couldn't get that one done just now — say so, and offer to try again.";
              if (c.open) send({ type: 'session.commentary.append', delegation_id: did, content: content.slice(0, 1800) });
            });
          break;
        }
        case 'session.usage.updated':
          c.seconds = ev.usage?.seconds ?? c.seconds;
          break;
        case 'session.closed': {
          c.open = false;
          const secs = ev.usage?.seconds ?? (c.seconds || (d.clock.epochMs() - c.started) / 1000);
          fs.appendFileSync(usageFile, `${JSON.stringify({ at: d.clock.epochMs(), id, reason: ev.reason ?? '', seconds: Math.round(secs), usd: Math.round((secs / 60) * LIVE_PRICE_PER_MIN * 10000) / 10000 })}\n`);
          void d.events.emit('face.call_closed', { id, seconds: Math.round(secs), reason: ev.reason ?? '' });
          break;
        }
        default:
          break;
      }
    });
    ws.on('close', () => {
      c.open = false;
      exchange(c);
      calls.delete(id);
    });
    ws.on('error', (e) => void d.events.emit('incident.face_sideband', { id, error: e.message.slice(0, 200) }));
    // watchdog: idle for 10 min or 2 h long → hang up (it bills per minute)
    void (async () => {
      while (calls.has(id)) {
        await d.clock.waitUntil(d.clock.epochMs() + 30_000);
        const t = d.clock.epochMs();
        if (!calls.has(id)) return;
        if ((c.busy === 0 && t - c.lastHeard > IDLE_CLOSE_MS) || t - c.started > MAX_CALL_MS) send({ type: 'session.close' });
      }
    })();
    return c;
  };

  return {
    status: () => {
      const m = minutesToday();
      return { calls: calls.size, minutesToday: m, costToday: Math.round(m * LIVE_PRICE_PER_MIN * 100) / 100, voices: [...LIVE_VOICES], voice };
    },
    hangup: (id) => {
      const c = calls.get(id);
      if (c !== undefined && c.ws.readyState === 1) c.ws.send(JSON.stringify({ type: 'session.close' }));
    },
    start: async (sdp, v) => {
      if (!sdp.includes('m=audio')) throw new Error('need an SDP offer with audio');
      if (v !== undefined && (LIVE_VOICES as readonly string[]).includes(v)) voice = v;
      const ins = liveInstructions(d);
      if (ins.telling.length > 0) void d.events.emit('incident.face_told', { hits: ins.telling });
      const input = d
        .recent()
        .slice(-24)
        .map((t) =>
          t.who === 'him'
            ? { role: 'user', content: [{ type: 'input_text', text: t.text.replace(PETNAMES, 'Diego') }] }
            : { role: 'assistant', content: [{ type: 'output_text', text: t.text.replace(PETNAMES, 'Diego') }] },
        );
      const session = {
        model: LIVE_MODEL,
        instructions: ins.text,
        delegation: { type: 'client' },
        audio: { output: { voice } },
        ...(input.length > 0 ? { input } : {}),
        client: {
          data_channel: {
            allowed_client_events: ['session.input_audio.mute', 'session.input_audio.unmute', 'session.close'],
            allowed_server_events: [
              'session.started', 'session.closed', 'session.input_audio.muted', 'session.input_audio.unmuted', 'session.input_transcript.delta',
              'session.output_transcript.delta', 'session.delegation.created', 'session.commentary.appended', 'error',
            ].map((type) => ({ type })),
          },
        },
      };
      const r = await fetchImpl('https://api.openai.com/v1/live/sessions', {
        method: 'POST',
        headers: { authorization: `Bearer ${d.key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ session, transport: { type: 'webrtc', sdp } }),
        signal: AbortSignal.timeout(20_000),
      });
      const out = (await r.json().catch(() => ({}))) as { session?: { id?: string }; transport?: { sdp?: string }; error?: { message?: string } };
      if (!r.ok || out.session?.id === undefined || out.transport?.sdp === undefined) throw new Error(out.error?.message ?? `openai ${r.status}`);
      attach(out.session.id);
      void d.events.emit('face.call_started', { id: out.session.id, voice, instructionsChars: ins.text.length, history: input.length });
      return { id: out.session.id, sdp: out.transport.sdp };
    },
  };
};

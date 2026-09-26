// v9 face: the Mini App shows Diego her feelings with their causes, thoughts
// and replies graded — behind a key — and voice mode's sideband turns a call
// into memory (every exchange absorbed like a text turn) while her tools answer
// delegations out loud.

import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import * as http from 'node:http';
import { startThead } from '../../src/app/index.js';
import { makeLive, startFaceServer, liveInstructions, type SidebandSocket } from '../../src/face/index.js';
import { TELLING_PATTERNS } from '../../src/mind/index.js';
import { inbound, runToQuiescent, settle } from '../mind/helpers.js';
import { bootV9 } from '../body/helpers.js';

const appraisal = { toolCalls: [{ id: 'a1', name: 'emit', args: { event: [{ emotion: 'tender', i: 5, cause: 'he came home wrecked' }], self: [], outcome_prev: null, concerns: [], importance: 5 } }] };
const decide = (bubbles: string[]) => ({ toolCalls: [{ id: 'd1', name: 'decide', args: { plan: 'reply', bubbles, confidence: 0.8, weight: 0.6, reluctance: 0.1, completeness: 1 } }] });

/** Local http (the face server on 127.0.0.1) — tests never touch the network. */
const req = (url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> =>
  new Promise((ok, bad) => {
    http
      .get(url, { headers }, (res) => {
        let body = '';
        res.on('data', (d: Buffer) => (body += d.toString('utf8')));
        res.on('end', () => ok({ status: res.statusCode ?? 0, body, headers: res.headers }));
      })
      .on('error', bad);
  });

const sources = (h: Awaited<ReturnType<typeof bootV9>>) => ({
  affect: h.sys.affect,
  mind: h.sys.mind,
  events: h.sys.events,
  body: h.sys.body,
  clock: h.clock,
  timeZone: 'Europe/Madrid',
  brain: { voice: 'gpt-5.6-sol', fallback: 'glm-5.3', mind: 'deepseek-v4-flash' },
});

describe('v9 face — the Mini App', () => {
  it('is locked without the key; the key becomes a cookie; the views carry her feelings and their causes', { timeout: 60_000 }, async () => {
    const h = await bootV9();
    h.model.enqueue(decide(['oh no. come here']));
    h.model.enqueue(appraisal);
    const handle = startThead(h.sys);
    h.channel.queueInbound(inbound({ text: 'long day. i am wrecked' }));
    await runToQuiescent(h);

    const face = await startFaceServer({ port: 0, key: 'k-test-123', staticDir: resolve('dashboard/static'), sources: sources(h), events: h.sys.events });
    const base = `http://127.0.0.1:${face.port}`;
    expect((await req(`${base}/api/v2/now`)).status).toBe(401);
    const first = await req(`${base}/?k=k-test-123`);
    expect(first.status).toBe(200);
    expect(first.body).toContain('thea<sup class="two">2</sup>');
    const cookie = String(first.headers['set-cookie']?.[0] ?? '').split(';')[0]!;
    expect(cookie).toBe('t2k=k-test-123');
    const get = async (p: string): Promise<Record<string, unknown>> => JSON.parse((await req(`${base}${p}`, { cookie })).body) as Record<string, unknown>;

    const now = await get('/api/v2/now');
    expect(now['brain']).toMatchObject({ answering: 'gpt-5.6-sol' });
    expect(now['dials']).toBeTypeOf('object');
    const why = await get('/api/v2/why');
    expect(JSON.stringify(why)).toContain('he came home wrecked'); // the cause, shown to him
    const mind = await get('/api/v2/mind');
    expect(mind['lived']).toBe(1);
    const money = await get('/api/v2/money');
    expect(money['today']).toBeTypeOf('object');
    expect((await req(`${base}/..%2F..%2Fetc%2Fpasswd`, { cookie })).status).toBe(404);
    await face.close();
    await handle.stop();
  });
});

describe('v9 face — voice mode', () => {
  it("a call's instructions are her material plus the call's mechanics — no telling", async () => {
    const h = await bootV9({ self: [{ text: "i'm thea. i build things with him", cites: ['seed'] }] });
    const ins = liveInstructions({ mind: h.sys.mind, nowFacts: () => ['where he is: Ubud, Bali — 21:40 there.'], timeZone: 'Europe/Madrid', clock: h.clock });
    expect(ins.text).toContain('[me]');
    expect(ins.text).toContain('[the call]');
    expect(ins.text).toContain('where he is: Ubud');
    expect(ins.telling).toEqual([]);
    for (const re of TELLING_PATTERNS) expect(ins.text.replace(/\[me\][\s\S]*?\n\n/, '')).not.toMatch(re);
  });

  it('a call: transcripts become absorbed exchanges; a delegation runs her tools and is spoken back', { timeout: 60_000 }, async () => {
    const h = await bootV9();
    h.model.onTask('cast', (req) => (req.messages.some((m) => m.role === 'tool') ? { content: 'you have two reminders tomorrow.' } : { toolCalls: [{ id: 'r1', name: 'remind', args: { action: 'list' } }] }));
    h.model.onTask('appraisal', () => appraisal);
    const handle = startThead(h.sys);
    const sent: string[] = [];
    const handlers: Record<string, Array<(x?: unknown) => void>> = {};
    const fakeWs: SidebandSocket = {
      on: (ev: string, fn: (x?: unknown) => void) => { (handlers[ev] ??= []).push(fn); },
      send: (s: string) => { sent.push(s); },
      readyState: 1,
      close: () => undefined,
    } as SidebandSocket;
    const fire = (o: unknown): void => { for (const fn of handlers['message'] ?? []) fn(JSON.stringify(o)); };
    const fetchImpl: typeof fetch = async (input, init) => {
      expect(String(input)).toBe('https://api.openai.com/v1/live/sessions');
      const body = JSON.parse(String(init?.body)) as { session: { model: string; instructions: string; audio: { output: { voice: string } } } };
      expect(body.session.model).toBe('gpt-live-1');
      expect(body.session.audio.output.voice).toBe('cedar');
      return new Response(JSON.stringify({ session: { id: 'sess_1' }, transport: { sdp: 'v=0 answer' } }), { status: 200 });
    };
    // the delegation runs on her real registry (remind is one of her hands)
    const reg = (await import('../../src/loop/index.js')).createToolRegistry();
    h.sys.body!.register(reg);
    const live = makeLive({ key: 'sk-test', clock: h.clock, rng: h.sys.rng, events: h.sys.events, mind: h.sys.mind, body: h.sys.body!, model: () => h.model, registry: reg, timeZone: 'Europe/Madrid', recent: () => [], nowFacts: () => [], absorb: (heard, said) => h.sys.pipeline.absorb(heard, said, 'call'), fetchImpl, socket: () => fakeWs });
    const r = await live.start('v=0\nm=audio 9 UDP/TLS/RTP/SAVPF 111', 'cedar');
    expect(r).toEqual({ id: 'sess_1', sdp: 'v=0 answer' });

    fire({ type: 'session.input_transcript.delta', delta: 'hey, what do i have tomorrow?' });
    fire({ type: 'session.output_transcript.delta', delta: 'hang on, let me look' });
    fire({ type: 'session.delegation.created', delegation: { id: 'dg1', target: 'client' } });
    for (let i = 0; i < 50 && !sent.some((s) => s.includes('commentary')); i++) await settle(5);
    const commentary = sent.map((s) => JSON.parse(s) as { type: string; delegation_id?: string; content?: string }).find((o) => o.type === 'session.commentary.append');
    expect(commentary).toMatchObject({ delegation_id: 'dg1', content: 'you have two reminders tomorrow.' });

    fire({ type: 'session.input_transcript.delta', delta: 'thanks' }); // a new utterance closes the last exchange
    await runToQuiescent(h);
    const lived = h.sys.mind.moments().filter((m) => m.source === 'lived');
    expect(lived).toHaveLength(1);
    expect(lived[0]!.his).toContain('(on the call) hey, what do i have tomorrow?');
    expect(lived[0]!.hers).toEqual(['hang on, let me look']);
    const win = h.sys.window.messages().map((m) => String(m.content));
    expect(win).toContain('(on the call) hey, what do i have tomorrow?');
    await handle.stop();
  });
});

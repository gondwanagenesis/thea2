// v9 face — the Mini App server, inside thead (it reads her live state
// directly). 127.0.0.1 only; a cloudflared tunnel is the one way in. Auth is
// Thea1's proven scheme: the menu button URL carries ?k=<key>, the first
// request trades it for an HttpOnly cookie, every later request rides that.

import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import type { EventLog } from '../events/index.js';
import { affectHistory, familyView, mindView, moneyView, nowView, whyView, type FaceSources } from './data.js';
import type { Live } from './live.js';
import { leavePresent } from '../body/index.js';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

export interface FaceServerDeps {
  port: number;
  key: string;
  staticDir: string;
  sources: FaceSources;
  live?: Live | undefined;
  events: EventLog;
  /** Presents: the seal key (absent = the app cannot leave presents). */
  presentKey?: string | undefined;
}

const keyOk = (want: string, got: string): boolean => {
  if (want === '' || got === '') return false;
  const a = Buffer.from(want);
  const b = Buffer.from(got);
  return a.length === b.length && timingSafeEqual(a, b);
};

const cookieKey = (req: http.IncomingMessage): string => {
  const m = /(?:^|;\s*)t2k=([^;]+)/.exec(req.headers.cookie ?? '');
  return m?.[1] !== undefined ? decodeURIComponent(m[1]) : '';
};

const readBody = (req: http.IncomingMessage): Promise<string> =>
  new Promise((resolve) => {
    let b = '';
    req.on('data', (d: Buffer) => {
      b += d.toString('utf8');
      if (b.length > 300_000) req.destroy();
    });
    req.on('end', () => resolve(b));
  });

export interface FaceServer {
  close(): Promise<void>;
  readonly port: number;
}

export const startFaceServer = (d: FaceServerDeps): Promise<FaceServer> =>
  new Promise((resolve, reject) => {
    const json = (res: http.ServerResponse, code: number, o: unknown): void => {
      res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(o));
    };
    const server = http.createServer((req, res) => {
      void (async () => {
        const url = new URL(req.url ?? '/', 'http://face');
        const viaQuery = url.searchParams.get('k') ?? '';
        const authed = keyOk(d.key, viaQuery) || keyOk(d.key, cookieKey(req)) || keyOk(d.key, String(req.headers['x-dashboard-key'] ?? ''));
        if (!authed) {
          res.writeHead(401, { 'content-type': 'text/plain' });
          res.end('Unauthorized');
          return;
        }
        if (viaQuery !== '') res.setHeader('set-cookie', `t2k=${encodeURIComponent(d.key)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=31536000`);
        try {
          if (url.pathname.startsWith('/api/')) {
            const p = url.pathname;
            if (req.method === 'GET' && p === '/api/v2/now') return json(res, 200, await nowView(d.sources));
            if (req.method === 'GET' && p === '/api/affect-history') {
              const range = url.searchParams.get('range') === '7d' ? 7 * 86_400_000 : 86_400_000;
              return json(res, 200, await affectHistory(d.sources, range));
            }
            if (req.method === 'GET' && p === '/api/v2/why') return json(res, 200, await whyView(d.sources));
            if (req.method === 'GET' && p === '/api/v2/mind') return json(res, 200, await mindView(d.sources));
            if (req.method === 'GET' && p === '/api/v2/family') return json(res, 200, await familyView(d.sources));
            if (req.method === 'GET' && p === '/api/v2/money') return json(res, 200, await moneyView(d.sources));
            if (p === '/api/live/status') {
              const st = d.live?.status();
              return json(res, 200, st === undefined ? { calls: 0, voices: [], voice: '', minutes_today: 0, cost_today: 0, off: true } : { calls: st.calls, voices: st.voices, voice: st.voice, minutes_today: st.minutesToday, cost_today: st.costToday });
            }
            if (req.method === 'POST' && p === '/api/live/session') {
              if (d.live === undefined) return json(res, 503, { error: 'the call line is not set up' });
              const b = JSON.parse((await readBody(req)) || '{}') as { sdp?: string; voice?: string };
              try {
                return json(res, 200, await d.live.start(String(b.sdp ?? ''), b.voice));
              } catch (e) {
                void d.events.emit('incident.face_call_failed', { error: e instanceof Error ? e.message.slice(0, 300) : String(e) });
                return json(res, 502, { error: e instanceof Error ? e.message : 'could not reach her' });
              }
            }
            if (req.method === 'POST' && p === '/api/v2/present') {
              const house = d.sources.body?.house;
              if (house === undefined || d.presentKey === undefined) return json(res, 503, { error: 'presents are not set up' });
              const b = JSON.parse((await readBody(req)) || '{}') as { title?: string; shape?: string; wrapping?: string; tag?: string; weight?: string; sound?: string; inside?: string };
              const inside = String(b.inside ?? '').trim();
              if (inside === '') return json(res, 400, { error: 'what is inside?' });
              const present = leavePresent(house, d.presentKey, { title: String(b.title ?? 'a present').slice(0, 120), from: 'Diego', outside: { shape: String(b.shape ?? 'a small box').slice(0, 200), wrapping: String(b.wrapping ?? 'plain paper').slice(0, 200), ...(b.tag ? { tag: String(b.tag).slice(0, 200) } : {}), ...(b.weight ? { weight: String(b.weight).slice(0, 120) } : {}), ...(b.sound ? { sound: String(b.sound).slice(0, 120) } : {}) }, inside: { text: inside.slice(0, 4000) } }, d.sources.clock.epochMs());
              void d.events.emit('face.present_left', { id: present.id });
              return json(res, 200, { ok: true, id: present.id });
            }
            if (req.method === 'POST' && p === '/api/live/hangup') {
              const b = JSON.parse((await readBody(req)) || '{}') as { id?: string };
              if (b.id !== undefined) d.live?.hangup(b.id);
              return json(res, 200, { ok: true });
            }
            return json(res, 404, { error: 'not found' });
          }
          // static: the app itself
          const rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
          const file = path.resolve(d.staticDir, rel);
          if (!file.startsWith(path.resolve(d.staticDir) + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
            res.writeHead(404, { 'content-type': 'text/plain' });
            res.end('not found');
            return;
          }
          res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
          fs.createReadStream(file).pipe(res);
        } catch (e) {
          void d.events.emit('incident.face_http', { path: url.pathname, error: e instanceof Error ? e.message.slice(0, 200) : String(e) });
          if (!res.headersSent) json(res, 500, { error: 'something broke' });
        }
      })();
    });
    server.on('error', reject);
    server.listen(d.port, '127.0.0.1', () => {
      const addr = server.address();
      resolve({
        port: typeof addr === 'object' && addr !== null ? addr.port : d.port,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });

export { nowView, affectHistory, whyView, mindView, familyView, moneyView, type FaceSources } from './data.js';

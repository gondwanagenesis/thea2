// test/spine — a local OpenCode-API-shaped stub (node:http, 127.0.0.1, an
// ephemeral port). Hermetic by construction: nothing leaves the loopback and
// every response replays a recorded fixture shape (test/spine/fixtures/*).
// This is NOT the real `opencode` binary and must never become one (hermetic
// law, plan v7 D.7-3): tests drive OpenCodeRunner against THIS.

import * as http from 'node:http';

/** One recorded SSE frame: `event:` name plus the decoded `data:` value. */
export interface SseFrame {
  event: string;
  data: unknown;
}

/** One scripted turn: the SSE frames its POST flushes, plus the POST reply. */
export interface StubTurn {
  frames: SseFrame[];
  reply?: unknown;
  status?: number;
}

export interface StubRequest {
  method: string;
  path: string;
  body: unknown;
}

export interface SpineStub {
  port: number;
  readonly requests: StubRequest[];
  setHealth(status: number): void;
  setTurns(turns: StubTurn[]): void;
  openSseCount(): number;
  close(): Promise<void>;
}

export const startSpineStub = async (): Promise<SpineStub> => {
  const requests: StubRequest[] = [];
  const sseClients = new Set<http.ServerResponse>();
  let health = 200;
  let turns: StubTurn[] = [];
  let sessionCount = 0;

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => {
      raw += chunk.toString('utf8');
    });
    req.on('end', () => {
      const body = raw === '' ? undefined : (JSON.parse(raw) as unknown);
      const path = req.url ?? '/';
      requests.push({ method: req.method ?? '', path, body });

      if (req.method === 'GET' && path === '/app') {
        res.writeHead(health, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ name: 'opencode-stub' }));
        return;
      }
      if (req.method === 'POST' && path === '/session') {
        sessionCount += 1;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: `ses_${sessionCount}` }));
        return;
      }
      if (req.method === 'GET' && path === '/event') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        res.flushHeaders(); // the runner awaits the SSE headers BEFORE posting the turn
        sseClients.add(res);
        // NOTE: req 'close' fires as soon as the request message completes in
        // modern Node — the RESPONSE's close is the connection-level signal.
        res.on('close', () => {
          sseClients.delete(res);
        });
        return;
      }
      const message = /^\/session\/([^/]+)\/message$/.exec(path);
      if (req.method === 'POST' && message !== null) {
        const turn = turns.shift();
        if (turn === undefined) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'stub: no scripted turn left' }));
          return;
        }
        const clients = [...sseClients];
        sseClients.clear();
        for (const client of clients) {
          for (const frame of turn.frames) {
            client.write(`event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`);
          }
          client.end();
        }
        res.writeHead(turn.status ?? 200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(turn.reply ?? { info: { sessionID: message[1] } }));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;

  return {
    port,
    requests,
    setHealth: (status: number) => {
      health = status;
    },
    setTurns: (next: StubTurn[]) => {
      turns = [...next];
    },
    openSseCount: () => sseClients.size,
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of sseClients) client.end();
        sseClients.clear();
        server.close(() => resolve());
      }),
  };
};

/** Reads a recorded SSE fixture into StubTurn frames. */
export const loadFrames = (json: unknown): SseFrame[] => json as SseFrame[];

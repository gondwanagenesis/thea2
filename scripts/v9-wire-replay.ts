// v9 diagnostic: replay one dumped turn request through Thea2's REAL model
// client (router, door, wire, transport) and print the wire body sent and the
// raw response received — to find where her tool calls get lost.
//
//   THEA2_OPENAI_KEY=… npx tsx scripts/v9-wire-replay.ts --config thea2.config.yaml --req /tmp/turnreq.json [--n 3]

import * as fs from 'node:fs';
import { loadConfig } from '../src/app/config.js';
import { chatCore, createModelClient, makeRouter, zaiTransport, type ChatMsg, type ToolDef } from '../src/model/index.js';
import { makeRng, SystemClock } from '../src/kernel/index.js';
import { openEventLog } from '../src/events/index.js';

const argv = process.argv.slice(2);
const arg = (n: string, d?: string): string | undefined => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const cfg = loadConfig(arg('config', 'thea2.config.yaml')!, process.env);
const req = JSON.parse(fs.readFileSync(arg('req', '/tmp/turnreq.json')!, 'utf8')) as { messages: ChatMsg[]; tools: ToolDef[] };
const clock = new SystemClock();
const log = openEventLog(fs.mkdtempSync('/tmp/wire-replay-'), { clock });
const doors = cfg.models.doors;
const spy: typeof fetch = async (input, init) => {
  const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
  console.log(`→ wire: model=${String(body['model'])} stream=${String(body['stream'])} temperature=${String(body['temperature'])} reasoning=${String(body['reasoning_effort'])} tool_choice=${JSON.stringify(body['tool_choice'])} parallel=${String(body['parallel_tool_calls'])} tools=${(body['tools'] as unknown[] | undefined)?.length ?? 0}`);
  const res = await fetch(input, init);
  const text = await res.clone().text();
  const calls = [...text.matchAll(/"name"\s*:\s*"([a-z_]+)"/g)].map((m) => m[1]);
  console.log(`← raw: HTTP ${res.status}, ${text.length} bytes, function names seen in the raw stream: ${[...new Set(calls)].join(',') || 'none'}`);
  return res;
};
const send = zaiTransport({ apiKey: doors.voice.apiKey, endpoint: doors.voice.endpoint, protocol: doors.voice.protocol, clock, rng: makeRng('replay'), fetchImpl: spy });
const client = createModelClient({
  log,
  clock,
  core: chatCore({
    router: makeRouter({ log, tiers: { main: doors.voice.model, cheap: doors.mind.model, reasoning: doors.judge.model }, doors: { voice: doors.voice, mind: doors.mind, judge: doors.judge } }),
    doors: { main: { door: doors.voice, send }, cheap: { door: doors.mind, send }, reasoning: { door: doors.judge, send } },
  }),
});
for (let i = 0; i < Number(arg('n', '3')); i++) {
  const res = await client.chat({ taskClass: 'turn', tier: 'main', messages: req.messages, tools: req.tools, maxTokens: 1536, temperature: 0.78 });
  console.log(`= parsed toolCalls: ${(res.toolCalls ?? []).map((c) => c.name).join(',') || 'none'}; content: ${JSON.stringify(String(res.content).slice(0, 80))}`);
}
